import { D, Decimal } from './decimal';
import { unprocessable } from './errors';

/** Quantities are exact decimals with at most 4 decimal places. Never rounded silently. */
export const QUANTITY_SCALE = 4;
export const FACTOR_SCALE = 6;

export function parseQuantity(raw: string, field = 'quantity'): Decimal {
  if (!/^\d{1,14}(\.\d{1,4})?$/.test(raw)) {
    throw unprocessable(
      'INVALID_QUANTITY',
      `${field} must be a positive decimal with at most ${QUANTITY_SCALE} decimal places.`,
    );
  }
  const value = D(raw);
  if (value.lte(0)) throw unprocessable('INVALID_QUANTITY', `${field} must be greater than zero.`);
  return value;
}

export function parseFactor(raw: string, field = 'factor'): Decimal {
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(raw)) {
    throw unprocessable(
      'INVALID_FACTOR',
      `${field} must be a positive decimal with at most ${FACTOR_SCALE} decimal places.`,
    );
  }
  const value = D(raw);
  if (value.lte(0)) throw unprocessable('INVALID_FACTOR', `${field} must be greater than zero.`);
  return value;
}

/**
 * Convert a quantity in a sold unit to the product base unit.
 * The result must be exactly representable with 4 decimal places, otherwise the
 * request is rejected instead of silently rounding stock.
 */
export function toBaseQuantity(quantity: Decimal, factor: Decimal): Decimal {
  const base = quantity.mul(factor);
  if (base.decimalPlaces() > QUANTITY_SCALE) {
    throw unprocessable(
      'QUANTITY_PRECISION',
      'This quantity does not convert to a whole number of base unit parts. Use a smaller unit or adjust the quantity.',
    );
  }
  return base;
}

export const qtyToString = (value: Decimal): string => D(value).toFixed(QUANTITY_SCALE);
