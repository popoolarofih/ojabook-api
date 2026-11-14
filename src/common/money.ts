import { D, Decimal } from './decimal';
import { unprocessable } from './errors';

/**
 * Money rules (guide section 8.1):
 *  - NGN is stored as integer kobo (1 NGN = 100 kobo).
 *  - Authoritative arithmetic uses bigint or Decimal, never floating point.
 *  - Rounding is centralised here: round half up to the nearest kobo.
 */
export const KOBO_PER_NAIRA = 100n;

/** Convert a JSON number received from a client into kobo. Must be a safe integer. */
export function koboFromNumber(value: number, field = 'amount'): bigint {
  if (!Number.isSafeInteger(value)) {
    throw unprocessable('INVALID_AMOUNT', `${field} must be a whole number of kobo.`);
  }
  return BigInt(value);
}

/** Convert kobo to a JSON number. Throws rather than losing precision. */
export function koboToNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError('Amount exceeds the safe integer range for JSON.');
  }
  return Number(value);
}

/** Round a Decimal amount of kobo to a whole kobo, half up. */
export function roundKobo(value: Decimal | string | number): bigint {
  const rounded = D(value).toDecimalPlaces(0, 4 /* ROUND_HALF_UP */);
  return BigInt(rounded.toFixed(0));
}

/** quantity x unit price (kobo) rounded to a whole kobo. */
export function lineAmount(quantity: Decimal, unitPriceKobo: bigint): bigint {
  return roundKobo(D(quantity).mul(D(unitPriceKobo.toString())));
}

export const sumKobo = (values: Iterable<bigint>): bigint => {
  let total = 0n;
  for (const v of values) total += v;
  return total;
};

/** Format kobo for plain text receipts and logs, for example 123450n -> "NGN 1,234.50". */
export function formatNgn(kobo: bigint): string {
  const negative = kobo < 0n;
  const abs = negative ? -kobo : kobo;
  const naira = abs / KOBO_PER_NAIRA;
  const rest = (abs % KOBO_PER_NAIRA).toString().padStart(2, '0');
  const grouped = naira.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}NGN ${grouped}.${rest}`;
}
