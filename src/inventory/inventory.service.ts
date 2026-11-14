import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma, StockMovementType } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { TenantMember } from '../auth/auth.types';
import { costOfGoods, inventoryValue } from '../common/costing';
import { resolveRange } from '../common/date-range';
import { D } from '../common/decimal';
import { badRequest, notFound, unprocessable } from '../common/errors';
import { koboToNumber, lineAmount } from '../common/money';
import { Paged, skipTake } from '../common/pagination';
import { parseFactor, parseQuantity, qtyToString, toBaseQuantity } from '../common/quantity';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { LedgerService } from '../ledger/ledger.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateStockAdjustmentDto,
  CreateStockReceiptDto,
  InventorySummary,
  StockAdjustmentResult,
  StockMovementDto,
  StockMovementQuery,
  StockReceiptResult,
} from './inventory.dto';
import { StockService } from './stock.service';

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  // ───────────── stock receipts (purchases) ─────────────

  /**
   * Buying stock is a stock acquisition, not an operating expense (guide section 4.6):
   *   Dr Inventory, Cr Cash or Bank.
   * The weighted average cost is blended per product.
   */
  receive(member: TenantMember, dto: CreateStockReceiptDto, key: string) {
    return this.idempotency.run<StockReceiptResult>(
      {
        businessId: member.businessId,
        userId: member.userId,
        scope: 'stock-receipts.create',
        key,
        payload: dto,
      },
      async (tx) => {
        const receiptId = dto.id ?? randomUUID();
        const occurredAt = dto.receivedAt ? new Date(dto.receivedAt) : new Date();
        if (occurredAt.getTime() > Date.now() + 5 * 60_000) {
          throw badRequest('INVALID_DATE', 'The receipt date cannot be in the future.');
        }

        const productIds = dto.lines.map((l) => l.productId);
        const products = await tx.product.findMany({
          where: { id: { in: productIds }, businessId: member.businessId },
          include: { conversions: true },
        });
        const byId = new Map(products.map((p) => [p.id, p]));
        const positions = await this.stock.lock(tx, member.businessId, productIds).catch(() => {
          throw notFound('One of the products');
        });

        let total = 0n;
        const results: StockReceiptResult['lines'] = [];
        for (const line of dto.lines) {
          const product = byId.get(line.productId);
          if (!product) throw notFound('Product');
          if (product.status !== 'ACTIVE') {
            throw unprocessable(
              'PRODUCT_ARCHIVED',
              `${product.name} is archived. Restore it before receiving stock.`,
            );
          }
          const quantity = parseQuantity(line.quantity);
          const factor = this.resolveFactor(product, line.unitId);
          const baseQuantity = toBaseQuantity(quantity, factor);
          const lineTotal = lineAmount(quantity, BigInt(line.unitCostKobo));
          if (lineTotal <= 0n)
            throw unprocessable('INVALID_COST', `Enter the cost for ${product.name}.`);
          // Cost per base unit derived from what was actually paid, to 4 decimal places.
          const unitCostKobo = D(lineTotal.toString()).div(baseQuantity).toDecimalPlaces(4, 4);

          const after = await this.stock.receive(tx, positions, {
            type: 'RECEIPT',
            businessId: member.businessId,
            productId: product.id,
            baseQuantity,
            unitCostKobo,
            occurredAt,
            userId: member.userId,
            sourceType: 'STOCK_RECEIPT',
            sourceId: receiptId,
            note: [dto.supplier, dto.note].filter(Boolean).join(' | ') || undefined,
          });
          total += lineTotal;
          results.push({
            productId: product.id,
            baseQuantity: qtyToString(baseQuantity),
            unitCostKobo: unitCostKobo.toFixed(4),
            lineTotalKobo: koboToNumber(lineTotal),
            quantityAfter: qtyToString(after.quantity),
          });
        }

        await this.ledger.post(tx, {
          businessId: member.businessId,
          entryDate: occurredAt,
          memo: `Stock receipt${dto.supplier ? ` from ${dto.supplier}` : ''}`,
          sourceType: 'STOCK_RECEIPT',
          sourceId: receiptId,
          createdById: member.userId,
          lines: [
            { account: 'INVENTORY', debit: total },
            { account: dto.paymentMethod === 'CASH' ? 'CASH' : 'BANK', credit: total },
          ],
        });
        await this.audit.record(tx, {
          businessId: member.businessId,
          actorUserId: member.userId,
          action: 'stock.receive',
          entityType: 'stock_receipt',
          entityId: receiptId,
          after: {
            totalCostKobo: total,
            lines: dto.lines.length,
            paymentMethod: dto.paymentMethod,
          },
        });
        return {
          status: 201,
          body: { id: receiptId, totalCostKobo: koboToNumber(total), lines: results },
        };
      },
    );
  }

  private resolveFactor(
    product: {
      id: string;
      name: string;
      conversions: { id: string; factor: Prisma.Decimal; archivedAt: Date | null }[];
    },
    unitId?: string,
  ) {
    if (!unitId) return D(1);
    const c = product.conversions.find((x) => x.id === unitId && !x.archivedAt);
    if (!c) throw unprocessable('UNIT_NOT_FOUND', `That unit does not exist for ${product.name}.`);
    return parseFactor(D(c.factor).toString());
  }

  // ───────────── adjustments ─────────────

  /**
   * Manual stock changes need a reason and are audited. They never change the average cost.
   * Losses are written off to "Stock adjustments and damaged goods" at the current average cost.
   */
  adjust(member: TenantMember, dto: CreateStockAdjustmentDto, key: string) {
    return this.idempotency.run<StockAdjustmentResult>(
      {
        businessId: member.businessId,
        userId: member.userId,
        scope: 'stock-adjustments.create',
        key,
        payload: dto,
      },
      async (tx) => {
        const id = dto.id ?? randomUUID();
        const quantity = parseQuantity(dto.quantity);
        const direction = dto.direction;
        if (
          (dto.reason === 'DAMAGED' ||
            dto.reason === 'EXPIRED' ||
            dto.reason === 'LOST_OR_STOLEN') &&
          direction === 'IN'
        ) {
          throw unprocessable(
            'INVALID_ADJUSTMENT',
            'Damaged, expired or lost stock can only be taken out.',
          );
        }
        if (dto.reason === 'FOUND' && direction === 'OUT') {
          throw unprocessable('INVALID_ADJUSTMENT', 'Found stock can only be added.');
        }
        const product = await tx.product.findFirst({
          where: { id: dto.productId, businessId: member.businessId },
        });
        if (!product) throw notFound('Product');

        const positions = await this.stock.lock(tx, member.businessId, [product.id]);
        const occurredAt = new Date();
        const common = {
          businessId: member.businessId,
          productId: product.id,
          baseQuantity: quantity,
          occurredAt,
          userId: member.userId,
          sourceType: 'STOCK_ADJUSTMENT',
          sourceId: id,
          reasonCode: dto.reason,
          note: dto.note,
        };

        let movementType: StockMovementType;
        let value: bigint;
        let quantityAfter;
        if (direction === 'IN') {
          movementType = 'ADJUSTMENT_IN';
          const avg = positions.get(product.id)!.avgCostKobo;
          const after = await this.stock.receive(tx, positions, {
            ...common,
            type: 'ADJUSTMENT_IN',
            unitCostKobo: avg,
          });
          value = costOfGoods(quantity, avg);
          quantityAfter = after.quantity;
          if (value > 0n) {
            await this.post(tx, member, id, `Stock adjustment in: ${product.name}`, dto.note, [
              { account: 'INVENTORY' as const, debit: value },
              { account: 'STOCK_ADJUSTMENTS' as const, credit: value },
            ]);
          }
        } else {
          movementType =
            dto.reason === 'DAMAGED' || dto.reason === 'EXPIRED' ? 'DAMAGED' : 'ADJUSTMENT_OUT';
          const issued = await this.stock.issue(tx, positions, {
            ...common,
            type: movementType as 'ADJUSTMENT_OUT' | 'DAMAGED',
            productName: product.name,
          });
          value = costOfGoods(quantity, issued.unitCostKobo);
          quantityAfter = issued.position.quantity;
          if (value > 0n) {
            await this.post(tx, member, id, `Stock written off: ${product.name}`, dto.note, [
              { account: 'STOCK_ADJUSTMENTS' as const, debit: value },
              { account: 'INVENTORY' as const, credit: value },
            ]);
          }
        }
        await this.audit.record(tx, {
          businessId: member.businessId,
          actorUserId: member.userId,
          action: 'stock.adjust',
          entityType: 'product',
          entityId: product.id,
          reason: `${dto.reason}: ${dto.note}`,
          after: { direction, quantity: dto.quantity, valueKobo: value },
        });
        return {
          status: 201,
          body: {
            id,
            productId: product.id,
            movementType,
            quantityAfter: qtyToString(quantityAfter),
            valueKobo: koboToNumber(value),
          },
        };
      },
    );
  }

  private post(
    tx: Prisma.TransactionClient,
    member: TenantMember,
    sourceId: string,
    memo: string,
    reason: string,
    lines: { account: 'INVENTORY' | 'STOCK_ADJUSTMENTS'; debit?: bigint; credit?: bigint }[],
  ) {
    return this.ledger.post(tx, {
      businessId: member.businessId,
      entryDate: new Date(),
      memo,
      reason,
      sourceType: 'STOCK_ADJUSTMENT',
      sourceId,
      createdById: member.userId,
      lines,
    });
  }

  // ───────────── reads ─────────────

  async movements(member: TenantMember, q: StockMovementQuery): Promise<Paged<StockMovementDto>> {
    const where: Prisma.StockMovementWhereInput = { businessId: member.businessId };
    if (q.productId) where.productId = q.productId;
    if (q.type) where.type = q.type;
    if (q.from || q.to) {
      const r = resolveRange({ from: q.from ?? q.to, to: q.to ?? q.from }, member.timezone);
      where.occurredAt = { gte: r.from, lt: r.to };
    }
    const { skip, take, page, pageSize } = skipTake(q);
    const [rows, total] = await Promise.all([
      this.prisma.stockMovement.findMany({
        where,
        include: { product: { select: { name: true } } },
        orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
        skip,
        take,
      }),
      this.prisma.stockMovement.count({ where }),
    ]);
    const cost = member.permissions.has('cost.read');
    return {
      page,
      pageSize,
      total,
      items: rows.map((m) => ({
        id: m.id,
        productId: m.productId,
        productName: m.product.name,
        type: m.type,
        quantityDelta: qtyToString(D(m.quantityDelta)),
        balanceAfter: qtyToString(D(m.balanceAfter)),
        reasonCode: m.reasonCode,
        note: m.note,
        sourceType: m.sourceType,
        sourceId: m.sourceId,
        occurredAt: m.occurredAt.toISOString(),
        ...(cost ? { unitCostKobo: D(m.unitCostKobo).toFixed(4) } : {}),
      })),
    };
  }

  async summary(member: TenantMember): Promise<InventorySummary> {
    const rows = await this.prisma.product.findMany({
      where: { businessId: member.businessId, status: 'ACTIVE' },
      include: { balance: true },
      orderBy: { name: 'asc' },
    });
    let value = 0n;
    const low: InventorySummary['lowStock'] = [];
    let out = 0;
    for (const p of rows) {
      const qty = D(p.balance?.quantity ?? 0);
      value += inventoryValue(qty, D(p.balance?.avgCostKobo ?? 0));
      if (qty.lte(0)) out += 1;
      if (qty.lte(D(p.reorderThreshold))) {
        low.push({
          productId: p.id,
          name: p.name,
          quantity: qtyToString(qty),
          reorderThreshold: qtyToString(D(p.reorderThreshold)),
          baseUnit: p.baseUnit,
        });
      }
    }
    return {
      activeProducts: rows.length,
      lowStockCount: low.length,
      outOfStockCount: out,
      lowStock: low.slice(0, 20),
      ...(member.permissions.has('cost.read') ? { stockValueKobo: koboToNumber(value) } : {}),
    };
  }
}
