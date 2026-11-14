import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, Matches } from 'class-validator';

export class RangeQuery {
  @ApiPropertyOptional({
    enum: ['today', 'yesterday', 'last7', 'last30', 'custom'],
    default: 'today',
  })
  @IsOptional()
  @IsIn(['today', 'yesterday', 'last7', 'last30', 'custom'])
  preset?: 'today' | 'yesterday' | 'last7' | 'last30' | 'custom';
  @ApiPropertyOptional({ description: 'YYYY-MM-DD, needed for custom.' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;
  @ApiPropertyOptional({ description: 'YYYY-MM-DD, needed for custom.' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;
}

export class RangeInfo {
  preset: string;
  fromDate: string;
  toDate: string;
  timezone: string;
  currency: string;
}

export class SeriesPoint {
  date: string;
  valueKobo: number;
}

export class OverviewReport {
  range: RangeInfo;
  /** Net recognised sales in the period, credit sales included, reversals deducted. */
  revenueKobo: number;
  salesCount: number;
  /** Settled cash in the period. Not the same as revenue. */
  collectedKobo: number;
  /** Transfers entered but not verified. Not counted as collected. */
  pendingTransfersKobo: number;
  /** Unpaid customer credit at the end of the period. */
  outstandingDebtKobo: number;
  @ApiPropertyOptional({ description: 'Needs reports.financial.' }) expensesKobo?: number;
  @ApiPropertyOptional({ description: 'Needs reports.financial.' }) cogsKobo?: number;
  @ApiPropertyOptional({ description: 'Needs reports.financial.' }) grossProfitKobo?: number;
  @ApiPropertyOptional({
    description: 'Operational figure, not audited statutory profit. Needs reports.financial.',
  })
  netOperatingProfitKobo?: number;
  @ApiPropertyOptional({ description: 'On hand quantity x average cost, now. Needs cost.read.' })
  inventoryValueKobo?: number;
  lowStockCount: number;
  revenueSeries: SeriesPoint[];
  topProducts: { productId: string; name: string; salesKobo: number; units: string }[];
  recent: {
    type: 'SALE' | 'EXPENSE' | 'REPAYMENT';
    id: string;
    label: string;
    amountKobo: number;
    at: string;
  }[];
  definitions: Record<string, string>;
}

export class SalesReport {
  range: RangeInfo;
  grossSalesKobo: number;
  discountsKobo: number;
  reversalsKobo: number;
  netSalesKobo: number;
  transactionCount: number;
  reversedCount: number;
  paymentMix: { cashKobo: number; transferKobo: number; creditKobo: number };
  series: SeriesPoint[];
}

export class CollectionsReport {
  range: RangeInfo;
  cashFromSalesKobo: number;
  cashFromRepaymentsKobo: number;
  refundsKobo: number;
  netCollectedKobo: number;
  pendingTransfersKobo: number;
  pendingRepayments: { count: number; amountKobo: number };
}

export class ReceivablesReport {
  asOf: string;
  totalOutstandingKobo: number;
  overdueKobo: number;
  buckets: {
    current: number;
    noDueDate: number;
    days1to30: number;
    days31to60: number;
    days61to90: number;
    days90plus: number;
  };
  customers: {
    customerId: string;
    name: string;
    phone: string | null;
    outstandingKobo: number;
    oldestDueDate: string | null;
    openInvoices: number;
  }[];
  repaymentsInPeriodKobo: number;
  range: RangeInfo;
}

export class ExpensesReport {
  range: RangeInfo;
  totalKobo: number;
  count: number;
  byCategory: { categoryId: string | null; name: string; totalKobo: number; count: number }[];
}

export class ProfitReport {
  range: RangeInfo;
  revenueKobo: number;
  cogsKobo: number;
  grossProfitKobo: number;
  operatingExpensesKobo: number;
  stockAdjustmentsKobo: number;
  netOperatingProfitKobo: number;
  note: string;
}

export class InventoryReport {
  asOf: string;
  items: {
    productId: string;
    name: string;
    sku: string | null;
    baseUnit: string;
    quantity: string;
    reorderThreshold: string;
    isLowStock: boolean;
    avgCostKobo?: string;
    valueKobo?: number;
  }[];
  lowStockCount: number;
  @ApiPropertyOptional() totalValueKobo?: number;
}

export class ProductPerformanceReport {
  range: RangeInfo;
  items: {
    productId: string;
    name: string;
    unitsSold: string;
    salesKobo: number;
    cogsKobo?: number;
    grossProfitKobo?: number;
  }[];
}

export class StaffReport {
  range: RangeInfo;
  items: {
    userId: string;
    name: string | null;
    phone: string;
    salesCount: number;
    salesKobo: number;
  }[];
}
