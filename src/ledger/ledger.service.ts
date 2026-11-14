import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { conflict, notFound, unprocessable } from '../common/errors';
import {
  DEFAULT_EXPENSE_CATEGORIES,
  EXPENSE_ACCOUNT_CODE_START,
  SYSTEM_ACCOUNTS,
  SystemAccountKey,
} from './chart';

export interface PostingLine {
  account: SystemAccountKey | { accountId: string };
  debit?: bigint;
  credit?: bigint;
}

export interface PostEntryInput {
  businessId: string;
  entryDate: Date;
  memo: string;
  sourceType: string;
  sourceId: string;
  createdById: string;
  reason?: string;
  reversesEntryId?: string;
  lines: PostingLine[];
}

/**
 * Double entry posting (guide section 8.2). Entries are immutable. A correction is a
 * new entry that mirrors the original and references it. The database also enforces
 * balance (deferred constraint trigger) and append only behaviour.
 */
@Injectable()
export class LedgerService {
  async seedChartOfAccounts(tx: Prisma.TransactionClient, businessId: string): Promise<void> {
    await tx.account.createMany({
      data: Object.entries(SYSTEM_ACCOUNTS).map(([systemKey, a]) => ({
        businessId,
        systemKey,
        code: a.code,
        name: a.name,
        type: a.type,
      })),
      skipDuplicates: true,
    });
    for (const name of DEFAULT_EXPENSE_CATEGORIES) {
      await this.createExpenseCategory(tx, businessId, name);
    }
  }

  /** Creates an expense category together with its own ledger account (codes 6000 to 6890). */
  async createExpenseCategory(tx: Prisma.TransactionClient, businessId: string, name: string) {
    const last = await tx.account.findFirst({
      where: { businessId, type: 'EXPENSE', code: { gte: String(EXPENSE_ACCOUNT_CODE_START), lt: '6900' } },
      orderBy: { code: 'desc' },
      select: { code: true },
    });
    const next = last ? Number(last.code) + 10 : EXPENSE_ACCOUNT_CODE_START;
    if (next >= 6900) {
      throw unprocessable('TOO_MANY_EXPENSE_CATEGORIES', 'This business has reached the expense category limit.');
    }
    const account = await tx.account.create({
      data: { businessId, code: String(next), name, type: 'EXPENSE' },
    });
    return tx.expenseCategory.create({ data: { businessId, name, accountId: account.id } });
  }

  async systemAccountIds(
    tx: Prisma.TransactionClient,
    businessId: string,
  ): Promise<Record<SystemAccountKey, string>> {
    const rows = await tx.account.findMany({
      where: { businessId, systemKey: { not: null } },
      select: { id: true, systemKey: true },
    });
    const map = Object.fromEntries(rows.map((r) => [r.systemKey, r.id])) as Record<
      SystemAccountKey,
      string
    >;
    for (const key of Object.keys(SYSTEM_ACCOUNTS) as SystemAccountKey[]) {
      if (!map[key]) throw conflict('CHART_NOT_SEEDED', `Account ${key} is missing for this business.`);
    }
    return map;
  }

  async post(tx: Prisma.TransactionClient, input: PostEntryInput): Promise<string> {
    const lines = input.lines.filter((l) => (l.debit ?? 0n) !== 0n || (l.credit ?? 0n) !== 0n);
    assertBalanced(lines);

    const system = await this.systemAccountIds(tx, input.businessId);
    const entry = await tx.journalEntry.create({
      data: {
        businessId: input.businessId,
        entryDate: input.entryDate,
        memo: input.memo,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        reason: input.reason,
        reversesEntryId: input.reversesEntryId,
        createdById: input.createdById,
      },
    });
    await tx.journalLine.createMany({
      data: lines.map((l) => ({
        entryId: entry.id,
        businessId: input.businessId,
        accountId: typeof l.account === 'string' ? system[l.account] : l.account.accountId,
        debitKobo: l.debit ?? 0n,
        creditKobo: l.credit ?? 0n,
      })),
    });
    return entry.id;
  }

  /** Post a mirror image of every entry for a source. Used by sale and expense reversals. */
  async reverseSource(
    tx: Prisma.TransactionClient,
    args: {
      businessId: string;
      sourceType: string;
      sourceId: string;
      reversalSourceType: string;
      reversalSourceId: string;
      reason: string;
      entryDate: Date;
      createdById: string;
    },
  ): Promise<string[]> {
    const originals = await tx.journalEntry.findMany({
      where: { businessId: args.businessId, sourceType: args.sourceType, sourceId: args.sourceId },
      include: { lines: true },
      orderBy: { createdAt: 'asc' },
    });
    if (originals.length === 0) throw notFound('Ledger entries for this record');

    const ids: string[] = [];
    for (const original of originals) {
      const reversalId = await this.postMirror(tx, original, args);
      ids.push(reversalId);
    }
    return ids;
  }

  private async postMirror(
    tx: Prisma.TransactionClient,
    original: Prisma.JournalEntryGetPayload<{ include: { lines: true } }>,
    args: {
      businessId: string;
      reversalSourceType: string;
      reversalSourceId: string;
      reason: string;
      entryDate: Date;
      createdById: string;
    },
  ): Promise<string> {
    const entry = await tx.journalEntry.create({
      data: {
        businessId: args.businessId,
        entryDate: args.entryDate,
        memo: `Reversal of: ${original.memo}`,
        sourceType: args.reversalSourceType,
        sourceId: args.reversalSourceId,
        reversesEntryId: original.id,
        reason: args.reason,
        createdById: args.createdById,
      },
    });
    await tx.journalLine.createMany({
      data: original.lines.map((l) => ({
        entryId: entry.id,
        businessId: args.businessId,
        accountId: l.accountId,
        debitKobo: l.creditKobo,
        creditKobo: l.debitKobo,
      })),
    });
    return entry.id;
  }
}

export function assertBalanced(lines: PostingLine[]): void {
  let debit = 0n;
  let credit = 0n;
  for (const l of lines) {
    const d = l.debit ?? 0n;
    const c = l.credit ?? 0n;
    if (d < 0n || c < 0n || (d > 0n && c > 0n)) {
      throw new Error('A journal line must carry either a positive debit or a positive credit.');
    }
    debit += d;
    credit += c;
  }
  if (lines.length < 2 || debit !== credit || debit === 0n) {
    throw new Error(`Journal entry is not balanced (debit ${debit}, credit ${credit}).`);
  }
}
