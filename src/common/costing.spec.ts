import { blendAverageCost, costOfGoods, inventoryValue } from './costing';
import { D } from './decimal';

describe('weighted average costing', () => {
  it('blends incoming cost into the average', () => {
    // 10 units at 100 kobo plus 10 units at 200 kobo averages 150
    expect(blendAverageCost(D(10), D(100), D(10), D(200)).toString()).toBe('150');
  });

  it('weights by quantity', () => {
    // 30 at 100 and 10 at 200 gives (3000 + 2000) / 40 = 125
    expect(blendAverageCost(D(30), D(100), D(10), D(200)).toString()).toBe('125');
  });

  it('adopts the incoming cost when stock was empty', () => {
    expect(blendAverageCost(D(0), D(999), D(5), D(250)).toString()).toBe('250');
  });

  it('keeps 4 decimal places of kobo', () => {
    // 1000 kobo for 3 units is 333.3333 per unit
    expect(blendAverageCost(D(0), D(0), D(3), D(333.3333)).toString()).toBe('333.3333');
    expect(blendAverageCost(D(1), D(100), D(2), D(101)).toString()).toBe('100.6667');
  });

  it('computes cost of goods in whole kobo', () => {
    expect(costOfGoods(D('2.5'), D('333.3333'))).toBe(833n); // 833.33325
    expect(costOfGoods(D(12), D(100))).toBe(1200n);
  });

  it('values inventory', () => {
    expect(inventoryValue(D('7.5'), D('200'))).toBe(1500n);
  });
});
