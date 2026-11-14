import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { AuditService } from '../audit/audit.service';
import { TenantMember } from '../auth/auth.types';
import { resolveRange } from '../common/date-range';
import { conflict, notFound } from '../common/errors';
import { koboToNumber } from '../common/money';
import { skipTake } from '../common/pagination';
import { normalizeNigerianPhone } from '../common/phone';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateCustomerDto,
  CustomerDto,
  CustomerPage,
  ListCustomersQuery,
  StatementDto,
  StatementRow,
  UpdateCustomerDto,
} from './customers.dto';

const OPEN: ('OPEN' | 'PARTIAL')[] = ['OPEN', 'PARTIAL'];

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private dto(c: Prisma.CustomerGetPayload<object>, outstanding = 0n, overdue = 0n): CustomerDto {
    return {
      id: c.id,
      name: c.name,
      phone: c.phone,
      notes: c.notes,
      status: c.status,
      outstandingKobo: koboToNumber(outstanding),
      overdueKobo: koboToNumber(overdue),
      createdAt: c.createdAt.toISOString(),
    };
  }

  private startOfToday(member: TenantMember): Date {
    return DateTime.now().setZone(member.timezone).startOf('day').toJSDate();
  }

  async create(member: TenantMember, dto: CreateCustomerDto): Promise<CustomerDto> {
    const phone = dto.phone ? normalizeNigerianPhone(dto.phone) : null;
    // Offline retries reuse the client id, so return the existing record instead of failing.
    if (dto.id) {
      const existing = await this.prisma.customer.findFirst({
        where: { id: dto.id, businessId: member.businessId },
      });
      if (existing) return this.dto(existing);
    }
    const c = await this.prisma.customer.create({
      data: {
        id: dto.id,
        businessId: member.businessId,
        name: dto.name.trim(),
        phone,
        notes: dto.notes?.trim(),
        createdById: member.userId,
      },
    });
    await this.audit.record(this.prisma, {
      businessId: member.businessId,
      actorUserId: member.userId,
      action: 'customer.create',
      entityType: 'customer',
      entityId: c.id,
    });
    return this.dto(c);
  }

  async update(member: TenantMember, id: string, dto: UpdateCustomerDto): Promise<CustomerDto> {
    const before = await this.prisma.customer.findFirst({
      where: { id, businessId: member.businessId },
    });
    if (!before) throw notFound('Customer');
    if (dto.status === 'ARCHIVED') {
      const owed = await this.prisma.receivable.count({
        where: { customerId: id, status: { in: OPEN } },
      });
      if (owed > 0)
        throw conflict(
          'CUSTOMER_HAS_DEBT',
          'This customer still owes money. Settle the balance before archiving.',
        );
    }
    const c = await this.prisma.customer.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        phone: dto.phone === undefined ? undefined : normalizeNigerianPhone(dto.phone),
        notes: dto.notes?.trim(),
        status: dto.status,
      },
    });
    await this.audit.record(this.prisma, {
      businessId: member.businessId,
      actorUserId: member.userId,
      action: 'customer.update',
      entityType: 'customer',
      entityId: id,
      before: { name: before.name, phone: before.phone, status: before.status },
      after: { name: c.name, phone: c.phone, status: c.status },
    });
    return this.get(member, id);
  }

  async get(member: TenantMember, id: string): Promise<CustomerDto> {
    const c = await this.prisma.customer.findFirst({
      where: { id, businessId: member.businessId },
    });
    if (!c) throw notFound('Customer');
    const [total, overdue] = await this.balances(member, [id]);
    return this.dto(c, total.get(id), overdue.get(id));
  }

  private async balances(member: TenantMember, ids: string[]) {
    const base = { businessId: member.businessId, customerId: { in: ids }, status: { in: OPEN } };
    const [all, late] = await Promise.all([
      this.prisma.receivable.groupBy({
        by: ['customerId'],
        where: base,
        _sum: { outstandingKobo: true },
      }),
      this.prisma.receivable.groupBy({
        by: ['customerId'],
        where: { ...base, dueDate: { lt: this.startOfToday(member) } },
        _sum: { outstandingKobo: true },
      }),
    ]);
    return [
      new Map(all.map((r) => [r.customerId, r._sum.outstandingKobo ?? 0n])),
      new Map(late.map((r) => [r.customerId, r._sum.outstandingKobo ?? 0n])),
    ] as const;
  }

  async list(member: TenantMember, q: ListCustomersQuery): Promise<CustomerPage> {
    const where: Prisma.CustomerWhereInput = {
      businessId: member.businessId,
      status: q.status ?? 'ACTIVE',
    };
    if (q.q?.trim()) {
      where.OR = [
        { name: { contains: q.q.trim(), mode: 'insensitive' } },
        { phone: { contains: q.q.replace(/\s/g, '') } },
      ];
    }
    if (q.hasBalance) where.receivables = { some: { status: { in: OPEN } } };
    const { skip, take, page, pageSize } = skipTake(q);
    const [rows, total, owed] = await Promise.all([
      this.prisma.customer.findMany({ where, orderBy: { name: 'asc' }, skip, take }),
      this.prisma.customer.count({ where }),
      this.prisma.receivable.aggregate({
        where: { businessId: member.businessId, status: { in: OPEN } },
        _sum: { outstandingKobo: true },
      }),
    ]);
    const [totals, overdue] = await this.balances(
      member,
      rows.map((r) => r.id),
    );
    return {
      items: rows.map((r) => this.dto(r, totals.get(r.id), overdue.get(r.id))),
      page,
      pageSize,
      total,
      totalOutstandingKobo: koboToNumber(owed._sum.outstandingKobo ?? 0n),
    };
  }

  /**
   * Opening balance, charges, repayments and closing balance for a period (guide section 4.5).
   * Built only from posted records. Transfers awaiting verification are listed but do not
   * change the balance.
   */
  async statement(
    member: TenantMember,
    id: string,
    from: string,
    to: string,
  ): Promise<StatementDto> {
    const customer = await this.prisma.customer.findFirst({
      where: { id, businessId: member.businessId },
    });
    if (!customer) throw notFound('Customer');
    const range = resolveRange({ from, to }, member.timezone);
    const business = await this.prisma.business.findUniqueOrThrow({
      where: { id: member.businessId },
      select: { name: true },
    });

    const receivables = await this.prisma.receivable.findMany({
      where: { businessId: member.businessId, customerId: id },
      include: {
        sale: {
          select: {
            receiptNumber: true,
            occurredAt: true,
            reversal: { select: { createdAt: true } },
          },
        },
      },
    });
    const allocations = await this.prisma.paymentAllocation.findMany({
      where: { businessId: member.businessId, receivable: { customerId: id } },
      include: {
        payment: { select: { id: true, occurredAt: true } },
        receivable: { select: { sale: { select: { receiptNumber: true } } } },
      },
    });
    const pending = await this.prisma.payment.findMany({
      where: {
        businessId: member.businessId,
        customerId: id,
        kind: 'REPAYMENT',
        status: 'PENDING',
      },
    });

    interface Ev {
      at: Date;
      type: StatementRow['type'];
      reference: string;
      description: string;
      charged: bigint;
      paid: bigint;
      affects: boolean;
    }
    const events: Ev[] = [];
    for (const r of receivables) {
      events.push({
        at: r.sale.occurredAt,
        type: 'SALE',
        reference: r.sale.receiptNumber,
        description: 'Sold on credit',
        charged: r.originalKobo,
        paid: 0n,
        affects: true,
      });
      if (r.voidedAt && r.sale.reversal) {
        events.push({
          at: r.sale.reversal.createdAt,
          type: 'SALE_REVERSAL',
          reference: r.sale.receiptNumber,
          description: 'Sale reversed',
          charged: 0n,
          paid: r.originalKobo,
          affects: true,
        });
      }
    }
    for (const a of allocations) {
      events.push({
        at: a.payment.occurredAt,
        type: 'REPAYMENT',
        reference: a.receivable.sale.receiptNumber,
        description: 'Repayment received',
        charged: 0n,
        paid: a.amountKobo,
        affects: true,
      });
    }
    for (const p of pending) {
      events.push({
        at: p.occurredAt,
        type: 'PENDING_TRANSFER',
        reference: p.note ?? 'Transfer',
        description: 'Transfer awaiting verification',
        charged: 0n,
        paid: p.amountKobo,
        affects: false,
      });
    }
    events.sort((a, b) => a.at.getTime() - b.at.getTime());

    const net = (e: Ev) => (e.affects ? e.charged - e.paid : 0n);
    const opening = events.filter((e) => e.at < range.from).reduce((s, e) => s + net(e), 0n);
    let running = opening;
    const rows: StatementRow[] = events
      .filter((e) => e.at >= range.from && e.at < range.to)
      .map((e) => {
        running += net(e);
        return {
          date: e.at.toISOString(),
          type: e.type,
          reference: e.reference,
          description: e.description,
          chargedKobo: koboToNumber(e.charged),
          paidKobo: koboToNumber(e.paid),
          balanceKobo: koboToNumber(running),
        };
      });
    return {
      customer: { id: customer.id, name: customer.name, phone: customer.phone },
      businessName: business.name,
      fromDate: range.fromDate,
      toDate: range.toDate,
      openingBalanceKobo: koboToNumber(opening),
      rows,
      closingBalanceKobo: koboToNumber(running),
      generatedAt: new Date().toISOString(),
    };
  }
}
