import { assertBalanced } from './ledger.service';

describe('assertBalanced', () => {
  it('accepts a balanced entry', () => {
    expect(() =>
      assertBalanced([
        { account: 'CASH', debit: 500n },
        { account: 'RECEIVABLES', debit: 300n },
        { account: 'SALES_REVENUE', credit: 800n },
      ]),
    ).not.toThrow();
  });

  it('rejects unbalanced entries', () => {
    expect(() =>
      assertBalanced([
        { account: 'CASH', debit: 500n },
        { account: 'SALES_REVENUE', credit: 499n },
      ]),
    ).toThrow(/not balanced/);
  });

  it('rejects lines that are both debit and credit, negative or empty entries', () => {
    expect(() =>
      assertBalanced([
        { account: 'CASH', debit: 5n, credit: 5n },
        { account: 'SALES_REVENUE', credit: 5n },
      ]),
    ).toThrow();
    expect(() =>
      assertBalanced([
        { account: 'CASH', debit: -5n },
        { account: 'SALES_REVENUE', credit: -5n },
      ]),
    ).toThrow();
    expect(() => assertBalanced([])).toThrow();
  });
});
