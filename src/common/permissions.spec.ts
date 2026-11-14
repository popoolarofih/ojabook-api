import { PERMISSIONS, resolvePermissions } from './permissions';

describe('permission matrix', () => {
  it('gives the owner everything and cannot be restricted', () => {
    const p = resolvePermissions('OWNER', [], ['sales.reverse', 'business.update']);
    expect(p.size).toBe(PERMISSIONS.length);
  });

  it('keeps cashiers away from profit, cost and settings', () => {
    const p = resolvePermissions('CASHIER');
    expect(p.has('sales.create')).toBe(true);
    expect(p.has('sales.read_own')).toBe(true);
    for (const denied of [
      'cost.read',
      'reports.financial',
      'business.update',
      'sales.read_all',
      'sales.reverse',
      'sales.price_override',
    ] as const) {
      expect(p.has(denied)).toBe(false);
    }
  });

  it('gives inventory managers stock control but no financial access', () => {
    const p = resolvePermissions('INVENTORY_MANAGER');
    expect(p.has('inventory.adjust')).toBe(true);
    expect(p.has('sales.create')).toBe(false);
    expect(p.has('reports.financial')).toBe(false);
    expect(p.has('members.manage')).toBe(false);
  });

  it('requires the owner for sensitive manager actions by default', () => {
    const p = resolvePermissions('MANAGER');
    expect(p.has('sales.reverse')).toBe(false);
    expect(p.has('expenses.reverse')).toBe(false);
    expect(p.has('members.manage')).toBe(false);
    expect(p.has('business.update')).toBe(false);
  });

  it('applies per member refinements and ignores unknown values', () => {
    const p = resolvePermissions('CASHIER', ['receivables.repay', 'not.real'], ['customers.write']);
    expect(p.has('receivables.repay')).toBe(true);
    expect(p.has('customers.write')).toBe(false);
    expect([...p].some((x) => (x as string) === 'not.real')).toBe(false);
  });
});
