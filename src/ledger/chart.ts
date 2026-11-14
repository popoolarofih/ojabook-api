import { AccountType } from '@prisma/client';

/**
 * Built in chart of accounts. Created for every new business. Expense categories add
 * their own EXPENSE accounts (codes 6000 and up) when they are created.
 */
export const SYSTEM_ACCOUNTS = {
  CASH: { code: '1000', name: 'Cash on hand', type: AccountType.ASSET },
  BANK: { code: '1010', name: 'Bank', type: AccountType.ASSET },
  PENDING_TRANSFERS: {
    code: '1020',
    name: 'Transfers awaiting verification',
    type: AccountType.ASSET,
  },
  RECEIVABLES: { code: '1100', name: 'Accounts receivable', type: AccountType.ASSET },
  INVENTORY: { code: '1200', name: 'Inventory', type: AccountType.ASSET },
  OPENING_EQUITY: { code: '3000', name: 'Opening balance equity', type: AccountType.EQUITY },
  SALES_REVENUE: { code: '4000', name: 'Sales revenue', type: AccountType.REVENUE },
  COGS: { code: '5000', name: 'Cost of goods sold', type: AccountType.COST_OF_SALES },
  STOCK_ADJUSTMENTS: {
    code: '6900',
    name: 'Stock adjustments and damaged goods',
    type: AccountType.EXPENSE,
  },
} as const;

export type SystemAccountKey = keyof typeof SYSTEM_ACCOUNTS;

export const DEFAULT_EXPENSE_CATEGORIES = [
  'Rent',
  'Transport',
  'Salaries and wages',
  'Utilities and power',
  'Fuel and generator',
  'Packaging',
  'Marketing',
  'Repairs and maintenance',
  'Other expenses',
] as const;

export const EXPENSE_ACCOUNT_CODE_START = 6000;
