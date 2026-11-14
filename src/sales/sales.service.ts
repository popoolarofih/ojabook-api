import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { AuditService } from '../audit/audit.service';
import { TenantMember } from '../auth/auth.types';
import { parseClientTime } from '../common/client-time';
import { costOfGoods } from '../common/costing';
import { resolveRange } from '../common/date-range';
import { D, Decimal } from '../common/decimal';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../common/errors';
import { koboToNumber, lineAmount } from '../common/money';
import { Paged, skipTake } from '../common/pagination';
import { parseFactor, parseQuantity, qtyToString, toBaseQuantity } from '../common/quantity';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { StockService } from '../inventory/stock.service';
import { LedgerService } from '../ledger/ledger.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSaleDto, ListSalesQuery, SaleDto } from './sales.dto';

const saleInclude = {
  items: { orderBy: { createdAt: 'asc' } },
  payments: { orderBy: { createdAt: 'asc' } },
  customer: { select: { id: true, name: true } },
  receivable: true,
  reversal: true,
} satisfies Prisma.SaleInclude;

type SaleRow = Prisma.SaleGetPayload<{ include: typeof saleInclude }>;

@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  // ───────────── create ─────────────

  /**
   * Records a sale atomically on the server (guide section 4.3):
   * stock movements, payments, receivable, double entry ledger and audit all commit
   * together or not at all. The server recalculates every amount. Client totals are never trusted.
   */
  create(member: TenantMember, dto: CreateSaleDto, key: string) {
    return this.idempotency.run<SaleDto>(
      { businessId: member.businessId, userId: member.userId, scope: 'sales.create', key, payload: dto },
      async (tx) => ({ status: 201, body: await this.createInTx(tx, member, dto) }),
    );
  }

  private async createInTx(tx: Prisma.TransactionClient, member: TenantMember, dto: CreateSaleDto): Promise<SaleDto> {
    const saleId = dto.id ?? randomUUID();
    const occurredAt = this.parseOccurredAt(dto.occurredAt);

    const customer = dto.customerId
      ? await tx.customer.findFirst({ where: { id: dto.customerId, businessId: member.businessId } })
      : null;
    if (dto.customerId && (!customer || customer.status !== 'ACTIVE')) {
      throw unprocessable('CUSTOMER_NOT_FOUND', 'The selected customer does not exist or is archived.');
    }

    const products = await tx.product.findMany({
      where: { id: { in: dto.items.map((i) => i.productId) }, businessId: member.businessId },
      include: { conversions: true },
    });
    const byId = new Map(products.map((p) => [p.id, p]));

    // 1. Price every line on the server.
    let subtotal = 0n;
    let discountTotal = 0n;
    const overrides: { productId: string; listPriceKobo: bigint; unitPriceKobo: bigint; discountKobo: bigint; reason?: string }[] = [];
    const lines = dto.items.map((item) => {
      const product = byId.get(item.productId);
      if (!product) throw unprocessable('PRODUCT_NOT_FOUND', 'One of the products does not exist.');
      if (product.status !== 'ACTIVE') {
        throw unprocessable('PRODUCT_ARCHIVED', `${product.name} is archived and cannot be sold.`);
      }
      const quantity = parseQuantity(item.quantity);

      let unitName = product.baseUnit;
      let factor: Decimal = D(1);
      let listPrice = product.sellingPriceKobo;
      if (item.unitId) {
        const c = product.conversions.find((x) => x.id === item.unitId && !x.archivedAt);
        if (!c) throw unprocessable('UNIT_NOT_FOUND', `That unit does not exist for ${product.name}.`);
        unitName = c.name;
        factor = parseFactor(D(c.factor).toString());
        listPrice = c.sellingPriceKobo ?? BigInt(D(product.sellingPriceKobo.toString()).mul(factor).toDecimalPlaces(0, 4).toFixed(0));
      }
      const baseQuantity = toBaseQuantity(quantity, factor);

      const unitPrice = item.unitPriceKobo === undefined ? listPrice : BigInt(item.unitPriceKobo);
      if (unitPrice !== listPrice && !member.permissions.has('sales.price_override')) {
        throw forbidden('PRICE_OVERRIDE_DENIED', 'You do not have permission to change prices.');
      }
      const discount = BigInt(item.discountKobo ?? 0);
      if (discount > 0n && !member.permissions.has('sales.discount')) {
        throw forbidden('DISCOUNT_DENIED', 'You do not have permission to give discounts.');
      }
      const gross = lineAmount(quantity, unitPrice);
      if (discount > gross) {
        throw unprocessable('DISCOUNT_TOO_LARGE', `The discount on ${product.name} is more than the line amount.`);
      }
      if (unitPrice !== listPrice || discount > 0n) {
        overrides.push({ productId: product.id, listPriceKobo: listPrice, unitPriceKobo: unitPrice, discountKobo: discount, reason: item.overrideReason });
      }
      subtotal += gross;
      discountTotal += discount;
      return { product, quantity, unitName, factor, baseQuantity, listPrice, unitPrice, discount, gross, reason: item.overrideReason };
    });
    const total = subtotal - discountTotal;
    if (total <= 0n) throw unprocessable('EMPTY_SALE', 'The sale total must be greater than zero.');

    // 2. Payments must add up exactly.
    const methods = new Set(dto.payments.map((p) => p.method));
    if (methods.size !== dto.payments.length) {
      throw unprocessable('DUPLICATE_PAYMENT_METHOD', 'Use each payment method at most once.');
    }
    const paid = dto.payments.reduce((s, p) => s + BigInt(p.amountKobo), 0n);
    if (paid !== total) {
      throw unprocessable('PAYMENT_TOTAL_MISMATCH', 'The payments must add up to the sale total.', {
        totalKobo: koboToNumber(total),
        paidKobo: koboToNumber(paid),
      });
    }
    const amountOf = (m: 'CASH' | 'TRANSFER' | 'CREDIT') => BigInt(dto.payments.find((p) => p.method === m)?.amountKobo ?? 0);
    const cash = amountOf('CASH');
    const transfer = amountOf('TRANSFER');
    const credit = amountOf('CREDIT');
    if (credit > 0n && !customer) {
      throw unprocessable('CREDIT_REQUIRES_CUSTOMER', 'Choose a customer to sell on credit.');
    }

    // 3. Take stock under row locks, snapshotting the cost of every line.
    const positions = await this.stock.lock(tx, member.businessId, lines.map((l) => l.product.id));
    const costed = [];
    let cogsTotal = 0n;
    for (const l of lines) {
      const issued = await this.stock.issue(tx, positions, {
        type: 'SALE',
        businessId: member.businessId,
        productId: l.product.id,
        productName: l.product.name,
        baseQuantity: l.baseQuantity,
        occurredAt,
        userId: member.userId,
        sourceType: 'SALE',
        sourceId: saleId,
      });
      const cogs = costOfGoods(l.baseQuantity, issued.unitCostKobo);
      cogsTotal += cogs;
      costed.push({ ...l, unitCostKobo: issued.unitCostKobo, cogs });
    }

    // 4. Receipt number last, so the per business counter lock is held briefly.
    const { lastReceiptNumber } = await tx.business.update({
      where: { id: member.businessId },
      data: { lastReceiptNumber: { increment: 1 } },
      select: { lastReceiptNumber: true },
    });
    const receiptNumber = `R-${String(lastReceiptNumber).padStart(6, '0')}`;

    const dueDate = dto.dueDate ? this.parseLocalDate(dto.dueDate, member.timezone) : null;
    await tx.sale.create({
      data: {
        id: saleId,
        businessId: member.businessId,
        receiptNumber,
        customerId: customer?.id,
        cashierId: member.userId,
        subtotalKobo: subtotal,
        discountKobo: discountTotal,
        totalKobo: total,
        creditKobo: credit,
        dueDate: credit > 0n ? dueDate : null,
        note: dto.note?.trim() || null,
        occurredAt,
      },
    });
    await tx.saleItem.createMany({
      data: costed.map((l) => ({
        saleId,
        businessId: member.businessId,
        productId: l.product.id,
        productName: l.product.name,
        sku: l.product.sku,
        unitName: l.unitName,
        unitFactor: l.factor,
        quantity: l.quantity,
        baseQuantity: l.baseQuantity,
        listPriceKobo: l.listPrice,
        unitPriceKobo: l.unitPrice,
        discountKobo: l.discount,
        lineTotalKobo: l.gross - l.discount,
        unitCostKobo: l.unitCostKobo,
        cogsKobo: l.cogs,
        overrideReason: l.reason,
      })),
    });

    // Cash is settled. A transfer entered by hand stays PENDING until trusted verification exists.
    const payments: Prisma.PaymentCreateManyInput[] = [];
    if (cash > 0n) payments.push(this.payment(member, saleId, 'CASH', 'PAID', cash, occurredAt, customer?.id));
    if (transfer > 0n) payments.push(this.payment(member, saleId, 'TRANSFER', 'PENDING', transfer, occurredAt, customer?.id));
    if (payments.length) await tx.payment.createMany({ data: payments });
    if (credit > 0n) {
      await tx.receivable.create({
        data: { businessId: member.businessId, customerId: customer!.id, saleId, originalKobo: credit, outstandingKobo: credit, dueDate },
      });
    }

    // 5. Double entry. Revenue is recognised in full. Collections are only the settled part.
    await this.ledger.post(tx, {
      businessId: member.businessId,
      entryDate: occurredAt,
      memo: `Sale ${receiptNumber}`,
      sourceType: 'SALE',
      sourceId: saleId,
      createdById: member.userId,
      lines: [
        { account: 'CASH', debit: cash },
        { account: 'PENDING_TRANSFERS', debit: transfer },
        { account: 'RECEIVABLES', debit: credit },
        { account: 'SALES_REVENUE', credit: total },
      ],
    });
    if (cogsTotal > 0n) {
      await this.ledger.post(tx, {
        businessId: member.businessId,
        entryDate: occurredAt,
        memo: `Cost of goods for ${receiptNumber}`,
        sourceType: 'SALE_COGS',
        sourceId: saleId,
        createdById: member.userId,
        lines: [
          { account: 'COGS', debit: cogsTotal },
          { account: 'INVENTORY', credit: cogsTotal },
        ],
      });
    }

    await this.audit.record(tx, {
      businessId: member.businessId,
      actorUserId: member.userId,
      action: 'sale.create',
      entityType: 'sale',
      entityId: saleId,
      after: { receiptNumber, totalKobo: total, cash, transfer, credit, items: lines.length },
    });
    for (const o of overrides) {
      await this.audit.record(tx, {
        businessId: member.businessId,
        actorUserId: member.userId,
        action: o.discountKobo > 0n ? 'sale.discount' : 'sale.price_override',
        entityType: 'sale',
        entityId: saleId,
        reason: o.reason,
        before: { listPriceKobo: o.listPriceKobo },
        after: { productId: o.productId, unitPriceKobo: o.unitPriceKobo, discountKobo: o.discountKobo },
      });
    }

    return this.toDto(await this.load(tx, member.businessId, saleId), member);
  }

  private payment(
    member: TenantMember,
    saleId: string,
    method: 'CASH' | 'TRANSFER',
    status: 'PAID' | 'PENDING',
    amountKobo: bigint,
    occurredAt: Date,
    customerId?: string,
  ): Prisma.PaymentCreateManyInput {
    return {
      businessId: member.businessId,
      kind: 'SALE_PAYMENT',
      saleId,
      customerId,
      method,
      status,
      amountKobo,
      occurredAt,
      createdById: member.userId,
    };
  }

  private parseOccurredAt(value?: string): Date {
    return parseClientTime(value, 'sale time');
  }

  private parseLocalDate(date: string, timezone: string): Date {
    const d = DateTime.fromISO(date, { zone: timezone }).startOf('day');
    if (!d.isValid) throw badRequest('INVALID_DATE', 'The due date is not a valid date.');
    return d.toJSDate();
  }

  // ───────────── reversal ─────────────

  /**
   * Posted sales are never deleted or edited (guide section 4.3). A reversal returns the
   * stock at the cost it left at, mirrors the ledger entries, and keeps the original intact.
   * A sale with repayments cannot be reversed until those are resolved.
   */
  reverse(member: TenantMember, saleId: string, reason: string, key: string) {
    return this.idempotency.run<SaleDto>(
      { businessId: member.businessId, userId: member.userId, scope: 'sales.reverse', key, payload: { saleId, reason } },
      async (tx) => {
        // Serialise concurrent reversals of the same sale.
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM sales WHERE id = ${saleId}::uuid AND "businessId" = ${member.businessId}::uuid FOR UPDATE`;
        if (locked.length === 0) throw notFound('Sale');
        const sale = await this.load(tx, member.businessId, saleId);
        if (sale.status === 'REVERSED') throw conflict('SALE_ALREADY_REVERSED', 'This sale was already reversed.');

        if (sale.receivable) {
          const [rec] = await tx.$queryRaw<{ outstandingKobo: bigint; originalKobo: bigint }[]>`
            SELECT "outstandingKobo", "originalKobo" FROM receivables WHERE id = ${sale.receivable.id}::uuid FOR UPDATE`;
          if (rec.outstandingKobo !== rec.originalKobo) {
            throw conflict('SALE_HAS_REPAYMENTS', 'This sale has customer repayments. Resolve them before reversing the sale.');
          }
          await tx.receivable.update({ where: { id: sale.receivable.id }, data: { status: 'VOIDED', voidedAt: new Date() } });
        }

        const productIds = sale.items.filter((i) => i.productId).map((i) => i.productId!);
        const positions = await this.stock.lock(tx, member.businessId, productIds);
        const now = new Date();
        for (const item of sale.items) {
          if (!item.productId) continue;
          await this.stock.receive(tx, positions, {
            type: 'SALE_REVERSAL',
            businessId: member.businessId,
            productId: item.productId,
            baseQuantity: D(item.baseQuantity),
            unitCostKobo: D(item.unitCostKobo), // back in at the cost it left at
            occurredAt: now,
            userId: member.userId,
            sourceType: 'SALE_REVERSAL',
            sourceId: saleId,
            note: reason,
          });
        }
        for (const type of ['SALE', 'SALE_COGS'] as const) {
          await this.ledger.reverseSource(tx, {
            businessId: member.businessId,
            sourceType: type,
            sourceId: saleId,
            reversalSourceType: type === 'SALE' ? 'SALE_REVERSAL' : 'SALE_COGS_REVERSAL',
            reversalSourceId: saleId,
            reason,
            entryDate: now,
            createdById: member.userId,
          }).catch((e) => {
            if (type === 'SALE_COGS' && e?.status === 404) return []; // zero cost sales have no COGS entry
            throw e;
          });
        }
        await tx.payment.updateMany({ where: { saleId }, data: { status: 'REVERSED' } });
        await tx.saleReversal.create({ data: { saleId, businessId: member.businessId, reason, createdById: member.userId } });
        await tx.sale.update({ where: { id: saleId }, data: { status: 'REVERSED' } });
        await this.audit.record(tx, {
          businessId: member.businessId,
          actorUserId: member.userId,
          action: 'sale.reverse',
          entityType: 'sale',
          entityId: saleId,
          reason,
          before: { status: 'COMPLETED', totalKobo: sale.totalKobo },
          after: { status: 'REVERSED' },
        });
        return { status: 201, body: this.toDto(await this.load(tx, member.businessId, saleId), member) };
      },
    );
  }

  // ───────────── reads ─────────────

  private async load(db: Prisma.TransactionClient | PrismaService, businessId: string, id: string): Promise<SaleRow> {
    const row = await db.sale.findFirst({ where: { id, businessId }, include: saleInclude });
    if (!row) throw notFound('Sale');
    return row;
  }

  async get(member: TenantMember, id: string): Promise<SaleDto> {
    const sale = await this.load(this.prisma, member.businessId, id);
    if (!member.permissions.has('sales.read_all') && sale.cashierId !== member.userId) throw notFound('Sale');
    return this.toDto(sale, member);
  }

  async list(member: TenantMember, q: ListSalesQuery): Promise<Paged<SaleDto>> {
    const readAll = member.permissions.has('sales.read_all');
    if (!readAll && !member.permissions.has('sales.read_own')) {
      throw forbidden('PERMISSION_DENIED', 'You do not have permission to view sales.');
    }
    const where: Prisma.SaleWhereInput = { businessId: member.businessId };
    if (!readAll) where.cashierId = member.userId; // cashiers only ever see their own
    else if (q.cashierId) where.cashierId = q.cashierId;
    if (q.customerId) where.customerId = q.customerId;
    if (q.status) where.status = q.status;
    if (q.receipt?.trim()) where.receiptNumber = { contains: q.receipt.trim(), mode: 'insensitive' };
    if (q.from || q.to) {
      const r = resolveRange({ from: q.from ?? q.to, to: q.to ?? q.from }, member.timezone);
      where.occurredAt = { gte: r.from, lt: r.to };
    }
    const { skip, take, page, pageSize } = skipTake(q);
    const [rows, total] = await Promise.all([
      this.prisma.sale.findMany({ where, include: saleInclude, orderBy: { occurredAt: 'desc' }, skip, take }),
      this.prisma.sale.count({ where }),
    ]);
    return { items: rows.map((r) => this.toDto(r, member)), page, pageSize, total };
  }

  private toDto(s: SaleRow, member: TenantMember): SaleDto {
    const cost = member.permissions.has('cost.read');
    const cogs = s.items.reduce((sum, i) => sum + i.cogsKobo, 0n);
    const dto: SaleDto = {
      id: s.id,
      receiptNumber: s.receiptNumber,
      status: s.status,
      customer: s.customer,
      cashier: { id: s.cashierId, name: null },
      items: s.items.map((i) => ({
        id: i.id,
        productId: i.productId,
        productName: i.productName,
        sku: i.sku,
        unitName: i.unitName,
        unitFactor: D(i.unitFactor).toString(),
        quantity: qtyToString(D(i.quantity)),
        baseQuantity: qtyToString(D(i.baseQuantity)),
        listPriceKobo: koboToNumber(i.listPriceKobo),
        unitPriceKobo: koboToNumber(i.unitPriceKobo),
        discountKobo: koboToNumber(i.discountKobo),
        lineTotalKobo: koboToNumber(i.lineTotalKobo),
        ...(cost ? { unitCostKobo: D(i.unitCostKobo).toFixed(4), cogsKobo: koboToNumber(i.cogsKobo) } : {}),
      })),
      payments: s.payments.map((p) => ({
        id: p.id,
        method: p.method,
        status: p.status,
        amountKobo: koboToNumber(p.amountKobo),
        verified: p.status === 'PAID',
      })),
      subtotalKobo: koboToNumber(s.subtotalKobo),
      discountKobo: koboToNumber(s.discountKobo),
      totalKobo: koboToNumber(s.totalKobo),
      creditKobo: koboToNumber(s.creditKobo),
      outstandingKobo: s.receivable && s.receivable.status !== 'VOIDED' ? koboToNumber(s.receivable.outstandingKobo) : 0,
      dueDate: s.dueDate ? s.dueDate.toISOString() : null,
      note: s.note,
      occurredAt: s.occurredAt.toISOString(),
      reversal: s.reversal ? { reason: s.reversal.reason, at: s.reversal.createdAt.toISOString() } : null,
    };
    if (cost) {
      dto.cogsKobo = koboToNumber(cogs);
      dto.grossProfitKobo = koboToNumber(s.totalKobo - cogs);
    }
    return dto;
  }
}
