import { D } from './decimal';
import { parseFactor, parseQuantity, qtyToString, toBaseQuantity } from './quantity';

describe('quantities and unit conversion', () => {
  it('parses exact decimals', () => {
    expect(parseQuantity('2.5').toString()).toBe('2.5');
    expect(parseQuantity('0.0001').toString()).toBe('0.0001');
  });

  it.each(['0', '-1', 'abc', '1.00001', '', '1e3', '.5'])('rejects %p', (raw) => {
    expect(() => parseQuantity(raw)).toThrow();
  });

  it('converts cartons to pieces exactly', () => {
    expect(toBaseQuantity(D(3), parseFactor('12')).toString()).toBe('36');
    expect(toBaseQuantity(D('0.5'), parseFactor('12')).toString()).toBe('6');
  });

  it('converts bags to kilograms', () => {
    expect(toBaseQuantity(D('0.25'), parseFactor('50')).toString()).toBe('12.5');
  });

  it('refuses conversions that need silent rounding', () => {
    expect(() => toBaseQuantity(D('0.3333'), parseFactor('0.3333'))).toThrow(/whole number/);
  });

  it('formats with four decimal places', () => {
    expect(qtyToString(D('12.5'))).toBe('12.5000');
  });
});
