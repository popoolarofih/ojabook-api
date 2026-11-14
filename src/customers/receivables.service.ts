import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { AuditService } from '../audit/audit.service';
import { TenantMember } from '../auth/auth.types';
import { parseClientTime } from '../common/client-time';
import { notFound, unprocessable } from '../common/errors';
import { koboToNumber } from '../common/money';
import { Paged, skipTake } from '../common/pagination';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { LedgerService } from '../ledger/ledger.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ListReceivablesQuery,
  ReceivableDto,
  RepaymentDto,
  RepaymentResult,
} from './customers.dto';

const OPEN: ('OPEN' | 'PARTIAL')[] = ['OPEN', 'PARTIAL'];

@Injectable()
export class ReceivablesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async list(member: TenantMember, q: ListReceivablesQuery): Promise<Paged<ReceivableDto>> {
    const today = DateTime.now().setZone(member.timezone).startOf('day');
    const view = q.view ?? 'open';
    const where: Prisma.ReceivableWhereInput = { businessId: member.businessId };
    if (q.customerId) where.customerId = q.customerId;
    if (view === 'settled') where.status = 'SETTLED';
    else {
      where.status = { in: OPEN };
      if (view === 'overdue') where.dueDate = { lt: today.toJSDate() };
    }
    const { skip, take, page, pageSize } = skipTake(q);
    const [rows, total] = await Promise.all([
      this.prisma.receivable.findMany({
        where,
        include: {
          customer: { select: { name: true } },
          sale: { select: { receiptNumber: true, occurredAt: true } },
        },
        orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
        skip,
        take,
      }),
      this.prisma.receivable.count({ where }),
    ]);
    return {
      page,
      pageSize,
      total,
      items: rows.map((r): ReceivableDto => {
        const open = OPEN.includes(r.status as 'OPEN' | 'PARTIAL');
        const daysOverdue =
          open && r.dueDate && r.dueDate < today.toJSDate()
            ? Math.floor(
                today.diff(
                  DateTime.fromJSDate(r.dueDate).setZone(member.timezone).startOf('day'),
                  'days',
                ).days,
              )
            : 0;
        return {
          id: r.id,
          customerId: r.customerId,
          customerName: r.customer.name,
          saleId: r.saleId,
          receiptNumber: r.sale.receiptNumber,
          originalKobo: koboToNumber(r.originalKobo),
          outstandingKobo: koboToNumber(r.outstandingKobo),
          dueDate: r.dueDate?.toISOString() ?? null,
          status: r.status,
          isOverdue: daysOverdue > 0,
          daysOverdue,
          saleDate: r.sale.occurredAt.toISOString(),
        };
      }),
    };
  }

  /** Repay one receivable (the invoice). */
  repayReceivable(member: TenantMember, receivableId: string, dto: RepaymentDto, key: string) {
    return this.idempotency.run<RepaymentResult>(
      {
        businessId: member.businessId,
        userId: member.userId,
        scope: 'receivables.repay',
        key,
        payload: { receivableId, ...dto },
      },
      async (tx) => ({ status: 201, body: await this.repay(tx, member, dto, { receivableId }) }),
    );
  }

  /** Repay a customer account. The amount is applied to the oldest debts first. */
  repayCustomer(member: TenantMember, customerId: string, dto: RepaymentDto, key: string) {
    return this.idempotency.run<RepaymentResult>(
      {
        businessId: member.businessId,
        userId: member.userId,
        scope: 'customers.repay',
        key,
        payload: { customerId, ...dto },
      },
      async (tx) => ({ status: 201, body: await this.repay(tx, member, dto, { customerId }) }),
    );
  }

  /**
   * Allocates money to open receivables under row locks, so two repayments at the same
   * moment can never push a balance below zero (guide section 4.5: no overpayment).
   */
  async repay(
    tx: Prisma.TransactionClient,
    member: TenantMember,
    dto: RepaymentDto,
    target: { receivableId?: string; customerId?: string },
  ): Promise<RepaymentResult> {
    const paymentId = dto.id ?? randomUUID();
    const occurredAt = parseClientTime(dto.occurredAt, 'repayment time');
    const amount = BigInt(dto.amountKobo);

    let customerId = target.customerId;
    if (target.receivableId) {
      const r = await tx.receivable.findFirst({
        where: { id: target.receivableId, businessId: member.businessId },
      });
      if (!r) throw notFound('Receivable');
      customerId = r.customerId;
    }
    const customer = await tx.customer.findFirst({
      where: { id: customerId, businessId: member.businessId },
    });
    if (!customer) throw notFound('Customer');

    const locked = await tx.$queryRaw<{ id: string; outstandingKobo: bigint }[]>`
      SELECT id, "outstandingKobo" FROM receivables
      WHERE "businessId" = ${member.businessId}::uuid AND "customerId" = ${customer.id}::uuid
        AND status IN ('OPEN', 'PARTIAL')
        AND (${target.receivableId ?? null}::uuid IS NULL OR id = ${target.receivableId ?? null}::uuid)
      ORDER BY "dueDate" ASC NULLS LAST, "createdAt" ASC, id ASC
      FOR UPDATE`;
    const owed = locked.reduce((s, r) => s + r.outstandingKobo, 0n);
    if (locked.length === 0)
      throw unprocessable('NOTHING_OWED', 'There is nothing outstanding to repay.');
    if (amount > owed) {
      throw unprocessable(
        'OVERPAYMENT_NOT_ALLOWED',
        'The repayment is more than the amount owed.',
        { outstandingKobo: koboToNumber(owed) },
      );
    }

    const verified = dto.method === 'CASH';
    await tx.payment.create({
      data: {
        id: paymentId,
        businessId: member.businessId,
        kind: 'REPAYMENT',
        customerId: customer.id,
        method: dto.method,
        status: verified ? 'PAID' : 'PENDING',
        amountKobo: amount,
        occurredAt,
        createdById: member.userId,
        note: dto.note ?? undefined,
      },
    });

    const allocations: RepaymentResult['allocations'] = [];
    if (verified) {
      let left = amount;
      for (const r of locked) {
        if (left === 0n) break;
        const part = left < r.outstandingKobo ? left : r.outstandingKobo;
        const remaining = r.outstandingKobo - part;
        left -= part;
        const updated = await tx.receivable.update({
          where: { id: r.id },
          data: { outstandingKobo: remaining, status: remaining === 0n ? 'SETTLED' : 'PARTIAL' },
          include: { sale: { select: { receiptNumber: true } } },
        });
        await tx.paymentAllocation.create({
          data: { businessId: member.businessId, paymentId, receivableId: r.id, amountKobo: part },
        });
        allocations.push({
          receivableId: r.id,
          receiptNumber: updated.sale.receiptNumber,
          amountKobo: koboToNumber(part),
          remainingKobo: koboToNumber(remaining),
        });
      }
      await this.ledger.post(tx, {
        businessId: member.businessId,
        entryDate: occurredAt,
        memo: `Repayment from ${customer.name}`,
        sourceType: 'REPAYMENT',
        sourceId: paymentId,
        createdById: member.userId,
        lines: [
          { account: 'CASH', debit: amount },
          { account: 'RECEIVABLES', credit: amount },
        ],
      });
    }
    await this.audit.record(tx, {
      businessId: member.businessId,
      actorUserId: member.userId,
      action: 'receivable.repay',
      entityType: 'payment',
      entityId: paymentId,
      after: { customerId: customer.id, amountKobo: amount, method: dto.method, settled: verified },
    });

    const after = await tx.receivable.aggregate({
      where: { businessId: member.businessId, customerId: customer.id, status: { in: OPEN } },
      _sum: { outstandingKobo: true },
    });
    return {
      paymentId,
      status: verified ? 'PAID' : 'PENDING',
      verified,
      amountKobo: koboToNumber(amount),
      allocations,
      customerOutstandingKobo: koboToNumber(after._sum.outstandingKobo ?? 0n),
    };
  }
}
