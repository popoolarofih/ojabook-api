import { D } from './decimal';
import { formatNgn, koboFromNumber, koboToNumber, lineAmount, roundKobo, sumKobo } from './money';

describe('money', () => {
  it('rounds half up to the nearest kobo', () => {
    expect(roundKobo('10.4999')).toBe(10n);
    expect(roundKobo('10.5')).toBe(11n);
    expect(roundKobo('0.5')).toBe(1n);
    expect(roundKobo('1234567.5000')).toBe(1234568n);
  });

  it('multiplies quantity by price without floating point drift', () => {
    // 0.1 + 0.2 style problems must not exist: 3 x 0.1 kg at 10_000 kobo = 3000 kobo exactly
    expect(lineAmount(D('0.3'), 10_000n)).toBe(3000n);
    expect(lineAmount(D('2.5'), 3333n)).toBe(8333n); // 8332.5 rounds half up
    expect(lineAmount(D('12'), 125_000n)).toBe(1_500_000n);
  });

  it('rejects non integer kobo from clients', () => {
    expect(() => koboFromNumber(10.5)).toThrow();
    expect(() => koboFromNumber(Number.MAX_SAFE_INTEGER + 2)).toThrow();
    expect(koboFromNumber(1500)).toBe(1500n);
  });

  it('refuses to export amounts that would lose precision', () => {
    expect(koboToNumber(123n)).toBe(123);
    expect(() => koboToNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(RangeError);
  });

  it('sums bigint amounts exactly', () => {
    expect(sumKobo([1n, 2n, 3_000_000_000_000n])).toBe(3_000_000_000_003n);
  });

  it('formats naira', () => {
    expect(formatNgn(123450n)).toBe('NGN 1,234.50');
    expect(formatNgn(5n)).toBe('NGN 0.05');
    expect(formatNgn(-100_000_000n)).toBe('-NGN 1,000,000.00');
  });
});
