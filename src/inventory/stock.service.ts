import { Injectable } from '@nestjs/common';
import { Prisma, StockMovementType } from '@prisma/client';
import { blendAverageCost } from '../common/costing';
import { D, Decimal } from '../common/decimal';
import { conflict, notFound } from '../common/errors';
import { qtyToString } from '../common/quantity';

export interface StockPosition {
  quantity: Decimal;
  avgCostKobo: Decimal;
}

interface MovementBase {
  businessId: string;
  productId: string;
  occurredAt: Date;
  userId: string;
  sourceType: string;
  sourceId: string;
  reasonCode?: string;
  note?: string;
}

/**
 * The only code allowed to change stock (guide sections 4.4 and 8.4).
 *
 * Every change locks the product's balance row, validates, updates the balance and
 * appends an immutable StockMovement in the same transaction. Rows are locked in a
 * stable order (by product id) so concurrent sales cannot deadlock.
 */
@Injectable()
export class StockService {
  /** Lock balance rows for update, in product id order. Call once at the start of a transaction. */
  async lock(
    tx: Prisma.TransactionClient,
    businessId: string,
    productIds: string[],
  ): Promise<Map<string, StockPosition>> {
    const ids = [...new Set(productIds)].sort();
    const rows = await tx.$queryRaw<
      { productId: string; quantity: Prisma.Decimal; avgCostKobo: Prisma.Decimal }[]
    >`
      SELECT "productId", quantity, "avgCostKobo"
      FROM stock_balances
      WHERE "businessId" = ${businessId}::uuid AND "productId" = ANY(${ids}::uuid[])
      ORDER BY "productId"
      FOR UPDATE`;
    if (rows.length !== ids.length) throw notFound('Product');
    return new Map(
      rows.map((r) => [r.productId, { quantity: D(r.quantity), avgCostKobo: D(r.avgCostKobo) }]),
    );
  }

  /** Adds stock at a known cost per base unit and blends the weighted average. */
  async receive(
    tx: Prisma.TransactionClient,
    positions: Map<string, StockPosition>,
    args: MovementBase & {
      type: 'OPENING' | 'RECEIPT' | 'SALE_REVERSAL' | 'ADJUSTMENT_IN';
      baseQuantity: Decimal;
      unitCostKobo: Decimal;
    },
  ): Promise<StockPosition> {
    const pos = this.position(positions, args.productId);
    const quantity = pos.quantity.add(args.baseQuantity);
    const avgCostKobo = blendAverageCost(
      pos.quantity,
      pos.avgCostKobo,
      args.baseQuantity,
      args.unitCostKobo,
    );
    return this.write(
      tx,
      positions,
      args,
      quantity,
      avgCostKobo,
      args.baseQuantity,
      args.unitCostKobo,
    );
  }

  /**
   * Removes stock at the current weighted average. The average does not change.
   * Fails with INSUFFICIENT_STOCK instead of ever going negative.
   */
  async issue(
    tx: Prisma.TransactionClient,
    positions: Map<string, StockPosition>,
    args: MovementBase & {
      type: 'SALE' | 'ADJUSTMENT_OUT' | 'DAMAGED';
      baseQuantity: Decimal;
      productName?: string;
    },
  ): Promise<{ position: StockPosition; unitCostKobo: Decimal }> {
    const pos = this.position(positions, args.productId);
    if (pos.quantity.lt(args.baseQuantity)) {
      throw conflict(
        'INSUFFICIENT_STOCK',
        `Not enough stock${args.productName ? ` for ${args.productName}` : ''}.`,
        {
          productId: args.productId,
          productName: args.productName,
          available: qtyToString(pos.quantity),
          requested: qtyToString(args.baseQuantity),
        },
      );
    }
    const unitCostKobo = pos.avgCostKobo;
    const position = await this.write(
      tx,
      positions,
      args,
      pos.quantity.sub(args.baseQuantity),
      pos.avgCostKobo,
      args.baseQuantity.neg(),
      unitCostKobo,
    );
    return { position, unitCostKobo };
  }

  private position(positions: Map<string, StockPosition>, productId: string): StockPosition {
    const pos = positions.get(productId);
    if (!pos) throw new Error(`Stock for product ${productId} was not locked before use.`);
    return pos;
  }

  private async write(
    tx: Prisma.TransactionClient,
    positions: Map<string, StockPosition>,
    args: MovementBase & { type: StockMovementType },
    quantity: Decimal,
    avgCostKobo: Decimal,
    delta: Decimal,
    movementCost: Decimal,
  ): Promise<StockPosition> {
    await tx.stockBalance.update({
      where: { productId: args.productId },
      data: { quantity, avgCostKobo },
    });
    await tx.stockMovement.create({
      data: {
        businessId: args.businessId,
        productId: args.productId,
        type: args.type,
        quantityDelta: delta,
        unitCostKobo: movementCost,
        balanceAfter: quantity,
        reasonCode: args.reasonCode,
        note: args.note,
        sourceType: args.sourceType,
        sourceId: args.sourceId,
        occurredAt: args.occurredAt,
        createdById: args.userId,
      },
    });
    const next = { quantity, avgCostKobo };
    positions.set(args.productId, next);
    return next;
  }
}
