import { D, Decimal } from './decimal';
import { roundKobo } from './money';

/**
 * Weighted average costing (guide section 8.4).
 *
 *  - A receipt blends the incoming unit cost into the average.
 *  - A sale does not change the average. It consumes stock at the current average and
 *    that cost is snapshotted on the sale item, so later cost changes never rewrite history.
 *  - A reversal returns stock at the snapshotted cost, which is a receipt at that cost.
 *  - Damaged stock and negative adjustments leave the average unchanged and write the
 *    value off to the stock adjustments account.
 *  - Average cost is stored per base unit with 4 decimal places of kobo.
 */
export const COST_SCALE = 4;

export function blendAverageCost(
  onHandQty: Decimal,
  onHandAvgKobo: Decimal,
  receivedQty: Decimal,
  receivedUnitCostKobo: Decimal,
): Decimal {
  const newQty = onHandQty.add(receivedQty);
  if (newQty.lte(0)) return D(0);
  const totalValue = onHandQty.mul(onHandAvgKobo).add(receivedQty.mul(receivedUnitCostKobo));
  return totalValue.div(newQty).toDecimalPlaces(COST_SCALE, 4);
}

/** Cost of goods for a quantity of base units at a given average, in whole kobo. */
export function costOfGoods(baseQty: Decimal, avgCostKobo: Decimal): bigint {
  return roundKobo(baseQty.mul(avgCostKobo));
}

/** Value of stock on hand in whole kobo. */
export function inventoryValue(qty: Decimal, avgCostKobo: Decimal): bigint {
  return roundKobo(qty.mul(avgCostKobo));
}
