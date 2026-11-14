import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { AuditService } from '../audit/audit.service';
import { TenantMember } from '../auth/auth.types';
import { resolveRange } from '../common/date-range';
import { badRequest, conflict, notFound } from '../common/errors';
import { koboToNumber } from '../common/money';
import { Paged, skipTake } from '../common/pagination';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { LedgerService } from '../ledger/ledger.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateExpenseCategoryDto,
  CreateExpenseDto,
  ExpenseCategoryDto,
  ExpenseDto,
  ExpensePage,
  ListExpensesQuery,
} from './expenses.dto';

type Row = Prisma.ExpenseGetPayload<{ include: { category: true } }>;

const toDto = (e: Row): ExpenseDto => ({
  id: e.id,
  categoryId: e.categoryId,
  categoryName: e.category.name,
  amountKobo: koboToNumber(e.amountKobo),
  method: e.method,
  expenseDate: e.expenseDate.toISOString(),
  description: e.description,
  status: e.status,
  reversalReason: e.reversalReason,
  createdById: e.createdById,
  createdAt: e.createdAt.toISOString(),
});

/**
 * Operating expenses (guide section 4.6). Buying stock is NOT an expense: it goes through
 * stock receipts (Dr Inventory) and only reaches profit as COGS when sold.
 */
@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async categories(member: TenantMember): Promise<ExpenseCategoryDto[]> {
    const rows = await this.prisma.expenseCategory.findMany({
      where: { businessId: member.businessId, archivedAt: null },
      orderBy: { name: 'asc' },
    });
    return rows.map((c) => ({ id: c.id, name: c.name }));
  }

  async createCategory(
    member: TenantMember,
    dto: CreateExpenseCategoryDto,
  ): Promise<ExpenseCategoryDto> {
    const name = dto.name.trim();
    const dup = await this.prisma.expenseCategory.findFirst({
      where: { businessId: member.businessId, name: { equals: name, mode: 'insensitive' } },
    });
    if (dup)
      throw conflict('CATEGORY_EXISTS', 'You already have an expense category with this name.');
    return this.prisma.transaction(async (tx) => {
      const c = await this.ledger.createExpenseCategory(tx, member.businessId, name);
      await this.audit.record(tx, {
        businessId: member.businessId,
        actorUserId: member.userId,
        action: 'expense_category.create',
        entityType: 'expense_category',
        entityId: c.id,
        after: { name },
      });
      return { id: c.id, name: c.name };
    });
  }

  create(member: TenantMember, dto: CreateExpenseDto, key: string) {
    return this.idempotency.run<ExpenseDto>(
      {
        businessId: member.businessId,
        userId: member.userId,
        scope: 'expenses.create',
        key,
        payload: dto,
      },
      async (tx) => {
        const id = dto.id ?? randomUUID();
        const category = await tx.expenseCategory.findFirst({
          where: { id: dto.categoryId, businessId: member.businessId, archivedAt: null },
        });
        if (!category)
          throw badRequest('CATEGORY_NOT_FOUND', 'The selected expense category does not exist.');

        // Noon local time keeps the entry on the intended calendar day in every timezone.
        const local = dto.expenseDate
          ? DateTime.fromISO(dto.expenseDate, { zone: member.timezone }).set({ hour: 12 })
          : DateTime.now().setZone(member.timezone);
        if (!local.isValid) throw badRequest('INVALID_DATE', 'The expense date is not valid.');
        if (local.toMillis() > Date.now() + 86_400_000)
          throw badRequest('INVALID_DATE', 'The expense date cannot be in the future.');
        const expenseDate = local.toJSDate();
        const amount = BigInt(dto.amountKobo);

        const expense = await tx.expense.create({
          data: {
            id,
            businessId: member.businessId,
            categoryId: category.id,
            amountKobo: amount,
            method: dto.method,
            expenseDate,
            description: dto.description.trim(),
            createdById: member.userId,
          },
          include: { category: true },
        });
        await this.ledger.post(tx, {
          businessId: member.businessId,
          entryDate: expenseDate,
          memo: `${category.name}: ${expense.description}`,
          sourceType: 'EXPENSE',
          sourceId: id,
          createdById: member.userId,
          lines: [
            { account: { accountId: category.accountId }, debit: amount },
            { account: dto.method === 'CASH' ? 'CASH' : 'BANK', credit: amount },
          ],
        });
        await this.audit.record(tx, {
          businessId: member.businessId,
          actorUserId: member.userId,
          action: 'expense.create',
          entityType: 'expense',
          entityId: id,
          after: { categoryId: category.id, amountKobo: amount, method: dto.method },
        });
        return { status: 201, body: toDto(expense) };
      },
    );
  }

  /** Posted amounts never change. This only corrects the wording. */
  async updateDescription(
    member: TenantMember,
    id: string,
    description: string,
  ): Promise<ExpenseDto> {
    const e = await this.prisma.expense.findFirst({ where: { id, businessId: member.businessId } });
    if (!e) throw notFound('Expense');
    const updated = await this.prisma.expense.update({
      where: { id },
      data: { description: description.trim() },
      include: { category: true },
    });
    await this.audit.record(this.prisma, {
      businessId: member.businessId,
      actorUserId: member.userId,
      action: 'expense.update',
      entityType: 'expense',
      entityId: id,
      before: { description: e.description },
      after: { description: updated.description },
    });
    return toDto(updated);
  }

  reverse(member: TenantMember, id: string, reason: string, key: string) {
    return this.idempotency.run<ExpenseDto>(
      {
        businessId: member.businessId,
        userId: member.userId,
        scope: 'expenses.reverse',
        key,
        payload: { id, reason },
      },
      async (tx) => {
        const locked = await tx.$queryRaw<{ status: string }[]>`
          SELECT status FROM expenses WHERE id = ${id}::uuid AND "businessId" = ${member.businessId}::uuid FOR UPDATE`;
        if (locked.length === 0) throw notFound('Expense');
        if (locked[0].status === 'REVERSED')
          throw conflict('EXPENSE_ALREADY_REVERSED', 'This expense was already reversed.');
        await this.ledger.reverseSource(tx, {
          businessId: member.businessId,
          sourceType: 'EXPENSE',
          sourceId: id,
          reversalSourceType: 'EXPENSE_REVERSAL',
          reversalSourceId: id,
          reason,
          entryDate: new Date(),
          createdById: member.userId,
        });
        const updated = await tx.expense.update({
          where: { id },
          data: {
            status: 'REVERSED',
            reversalReason: reason,
            reversedAt: new Date(),
            reversedById: member.userId,
          },
          include: { category: true },
        });
        await this.audit.record(tx, {
          businessId: member.businessId,
          actorUserId: member.userId,
          action: 'expense.reverse',
          entityType: 'expense',
          entityId: id,
          reason,
          before: { status: 'POSTED' },
          after: { status: 'REVERSED' },
        });
        return { status: 201, body: toDto(updated) };
      },
    );
  }

  async list(member: TenantMember, q: ListExpensesQuery): Promise<ExpensePage> {
    const where: Prisma.ExpenseWhereInput = { businessId: member.businessId };
    if (q.categoryId) where.categoryId = q.categoryId;
    if (q.status) where.status = q.status;
    if (q.q?.trim()) where.description = { contains: q.q.trim(), mode: 'insensitive' };
    if (q.from || q.to) {
      const r = resolveRange({ from: q.from ?? q.to, to: q.to ?? q.from }, member.timezone);
      where.expenseDate = { gte: r.from, lt: r.to };
    }
    const { skip, take, page, pageSize } = skipTake(q);
    const [rows, total, sum] = await Promise.all([
      this.prisma.expense.findMany({
        where,
        include: { category: true },
        orderBy: [{ expenseDate: 'desc' }, { createdAt: 'desc' }],
        skip,
        take,
      }),
      this.prisma.expense.count({ where }),
      this.prisma.expense.aggregate({
        where: { ...where, status: 'POSTED' },
        _sum: { amountKobo: true },
      }),
    ]);
    return {
      items: rows.map(toDto),
      page,
      pageSize,
      total,
      totalPostedKobo: koboToNumber(sum._sum.amountKobo ?? 0n),
    } as Paged<ExpenseDto> & { totalPostedKobo: number };
  }
}
