import { MemberRole } from '@prisma/client';

/**
 * Permission matrix (guide section 3). Business logic checks permissions, never
 * role names, so access can be refined per member without code changes.
 * Roles only provide defaults. A member may have extra or revoked permissions.
 */
export const PERMISSIONS = [
  'business.read',
  'business.update',
  'members.read',
  'members.invite',
  'members.manage',
  'audit.read',
  'products.read',
  'products.write',
  'cost.read', // purchase cost, average cost and profit figures
  'inventory.read',
  'inventory.receive',
  'inventory.adjust',
  'sales.create',
  'sales.read_own',
  'sales.read_all',
  'sales.discount',
  'sales.price_override',
  'sales.reverse',
  'customers.read',
  'customers.write',
  'receivables.read',
  'receivables.repay',
  'expenses.read',
  'expenses.write',
  'expenses.reverse',
  'reports.sales',
  'reports.financial',
  'reports.inventory',
  'reports.staff',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const MANAGER: Permission[] = [
  'business.read',
  'members.read',
  'products.read',
  'products.write',
  'cost.read',
  'inventory.read',
  'inventory.receive',
  'inventory.adjust',
  'sales.create',
  'sales.read_own',
  'sales.read_all',
  'sales.discount',
  'sales.price_override',
  'customers.read',
  'customers.write',
  'receivables.read',
  'receivables.repay',
  'expenses.read',
  'expenses.write',
  'reports.sales',
  'reports.financial',
  'reports.inventory',
  'reports.staff',
];

const CASHIER: Permission[] = [
  'business.read',
  'products.read',
  'inventory.read',
  'sales.create',
  'sales.read_own',
  'customers.read',
  'customers.write',
];

const INVENTORY_MANAGER: Permission[] = [
  'business.read',
  'products.read',
  'products.write',
  'cost.read',
  'inventory.read',
  'inventory.receive',
  'inventory.adjust',
  'reports.inventory',
];

export const ROLE_DEFAULTS: Record<MemberRole, readonly Permission[]> = {
  OWNER: PERMISSIONS,
  MANAGER,
  CASHIER,
  INVENTORY_MANAGER,
};

const KNOWN = new Set<string>(PERMISSIONS);
export const isPermission = (value: string): value is Permission => KNOWN.has(value);

export function resolvePermissions(
  role: MemberRole,
  extra: readonly string[] = [],
  revoked: readonly string[] = [],
): ReadonlySet<Permission> {
  if (role === 'OWNER') return new Set(PERMISSIONS); // the owner can never be locked out
  const set = new Set<Permission>(ROLE_DEFAULTS[role]);
  for (const p of extra) if (isPermission(p)) set.add(p);
  for (const p of revoked) if (isPermission(p)) set.delete(p);
  return set;
}
