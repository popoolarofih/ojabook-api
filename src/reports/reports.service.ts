import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { TenantMember } from '../auth/auth.types';
import { inventoryValue } from '../common/costing';
import { RangeType, resolveRange, ResolvedRange } from '../common/date-range';
import { D } from '../common/decimal';
import { koboToNumber } from '../common/money';
import { qtyToString } from '../common/quantity';
import { PrismaService } from '../prisma/prisma.service';
import {
  CollectionsReport,
  ExpensesReport,
  InventoryReport,
  OverviewReport,
  ProductPerformanceReport,
  ProfitReport,
  RangeInfo,
  RangeQuery,
  ReceivablesReport,
  SalesReport,
  SeriesPoint,
  StaffReport,
} from './reports.dto';

interface LedgerRow {
  accountId: string;
  systemKey: string | null;
  sourceType: string;
  debit: bigint;
  credit: bigint;
}

/** Sum debit minus credit for a system account, optionally restricted to source types. */
const net = (
  rows: LedgerRow[],
  key: string,
  side: 'debit' | 'credit',
  sources?: string[],
): bigint =>
  rows
    .filter((r) => r.systemKey === key && (!sources || sources.includes(r.sourceType)))
    .reduce((s, r) => s + (side === 'debit' ? r.debit : r.credit), 0n);

const DEFINITIONS: Record<string, string> = {
  revenue:
    'Value of sales recorded in the period, including credit sales, minus reversals. It is not money received.',
  collected:
    'Cash actually received in the period from sales and customer repayments, minus cash refunded on reversals. Unverified transfers are excluded.',
  pendingTransfers: 'Bank transfers entered by staff that have not been verified yet.',
  outstandingDebt:
    'Money customers still owe from credit sales, at the end of the selected period.',
  expenses: 'Operating expenses posted in the period. Buying stock is not an expense.',
  cogs: 'Cost of the goods that were sold, using the cost recorded at the time of each sale.',
  grossProfit: 'Revenue minus cost of goods sold.',
  netOperatingProfit:
    'Gross profit minus operating expenses and stock write offs. An operational figure, not audited statutory profit.',
  inventoryValue: 'Stock on hand now, multiplied by its weighted average cost.',
  lowStock: 'Active products at or below their reorder level.',
};

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private range(member: TenantMember, q: RangeQuery): ResolvedRange {
    return resolveRange(
      { preset: q.preset as RangeType | undefined, from: q.from, to: q.to },
      member.timezone,
    );
  }

  private info(member: TenantMember, r: ResolvedRange): RangeInfo {
    return {
      preset: r.preset,
      fromDate: r.fromDate,
      toDate: r.toDate,
      timezone: r.timezone,
      currency: member.currency,
    };
  }

  private async ledger(businessId: string, from: Date, to: Date): Promise<LedgerRow[]> {
    return this.prisma.$queryRaw<LedgerRow[]>`
      SELECT a.id AS "accountId", a."systemKey", e."sourceType",
             COALESCE(SUM(l."debitKobo"), 0)::bigint AS debit, COALESCE(SUM(l."creditKobo"), 0)::bigint AS credit
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l."entryId"
      JOIN accounts a ON a.id = l."accountId"
      WHERE e."businessId" = ${businessId}::uuid AND e."entryDate" >= ${from} AND e."entryDate" < ${to}
      GROUP BY a.id, a."systemKey", e."sourceType"`;
  }

  private async expenseAccountTotals(businessId: string, from: Date, to: Date) {
    return this.prisma.$queryRaw<{ accountId: string; total: bigint; entries: bigint }[]>`
      SELECT a.id AS "accountId",
             COALESCE(SUM(l."debitKobo" - l."creditKobo"), 0)::bigint AS total,
             COUNT(*) FILTER (WHERE e."sourceType" = 'EXPENSE')::bigint AS entries
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l."entryId"
      JOIN accounts a ON a.id = l."accountId"
      WHERE e."businessId" = ${businessId}::uuid AND a.type = 'EXPENSE' AND a."systemKey" IS NULL
        AND e."entryDate" >= ${from} AND e."entryDate" < ${to}
      GROUP BY a.id`;
  }

  /** Debt owed at an instant, rebuilt from receivables and allocations so past dates are exact. */
  private async outstandingAt(businessId: string, asOf: Date): Promise<bigint> {
    const [charged] = await this.prisma.$queryRaw<{ v: bigint }[]>`
      SELECT COALESCE(SUM(r."originalKobo"), 0)::bigint AS v
      FROM receivables r JOIN sales s ON s.id = r."saleId"
      WHERE r."businessId" = ${businessId}::uuid AND s."occurredAt" < ${asOf}
        AND (r."voidedAt" IS NULL OR r."voidedAt" >= ${asOf})`;
    const [paid] = await this.prisma.$queryRaw<{ v: bigint }[]>`
      SELECT COALESCE(SUM(pa."amountKobo"), 0)::bigint AS v
      FROM payment_allocations pa
      JOIN payments p ON p.id = pa."paymentId"
      JOIN receivables r ON r.id = pa."receivableId"
      WHERE pa."businessId" = ${businessId}::uuid AND p."occurredAt" < ${asOf}
        AND (r."voidedAt" IS NULL OR r."voidedAt" >= ${asOf})`;
    return charged.v - paid.v;
  }

  private async revenueSeries(member: TenantMember, r: ResolvedRange): Promise<SeriesPoint[]> {
    const rows = await this.prisma.$queryRaw<{ d: string; v: bigint }[]>`
      SELECT to_char(e."entryDate" AT TIME ZONE ${member.timezone}::text, 'YYYY-MM-DD') AS d,
             COALESCE(SUM(l."creditKobo" - l."debitKobo"), 0)::bigint AS v
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l."entryId"
      JOIN accounts a ON a.id = l."accountId"
      WHERE e."businessId" = ${member.businessId}::uuid AND a."systemKey" = 'SALES_REVENUE'
        AND e."entryDate" >= ${r.from} AND e."entryDate" < ${r.to}
      GROUP BY d`;
    const byDay = new Map(rows.map((x) => [x.d, x.v]));
    const out: SeriesPoint[] = [];
    for (
      let d = DateTime.fromISO(r.fromDate);
      d <= DateTime.fromISO(r.toDate);
      d = d.plus({ days: 1 })
    ) {
      const key = d.toISODate()!;
      out.push({ date: key, valueKobo: koboToNumber(byDay.get(key) ?? 0n) });
    }
    return out;
  }

  private async topProducts(businessId: string, from: Date, to: Date, limit: number) {
    return this.prisma.$queryRaw<
      { productId: string; name: string; units: string; sales: bigint; cogs: bigint }[]
    >`
      SELECT si."productId", MAX(si."productName") AS name, SUM(si."baseQuantity")::text AS units,
             COALESCE(SUM(si."lineTotalKobo"), 0)::bigint AS sales, COALESCE(SUM(si."cogsKobo"), 0)::bigint AS cogs
      FROM sale_items si JOIN sales s ON s.id = si."saleId"
      WHERE si."businessId" = ${businessId}::uuid AND s.status = 'COMPLETED' AND si."productId" IS NOT NULL
        AND s."occurredAt" >= ${from} AND s."occurredAt" < ${to}
      GROUP BY si."productId" ORDER BY sales DESC LIMIT ${limit}`;
  }

  // ───────────── overview ─────────────

  async overview(member: TenantMember, q: RangeQuery): Promise<OverviewReport> {
    const r = this.range(member, q);
    const financial = member.permissions.has('reports.financial');
    const [rows, expenseRows, debt, salesCount, series, top, lowStock, valueRows, recent] =
      await Promise.all([
        this.ledger(member.businessId, r.from, r.to),
        this.expenseAccountTotals(member.businessId, r.from, r.to),
        this.outstandingAt(member.businessId, r.to),
        this.prisma.sale.count({
          where: {
            businessId: member.businessId,
            status: 'COMPLETED',
            occurredAt: { gte: r.from, lt: r.to },
          },
        }),
        this.revenueSeries(member, r),
        this.topProducts(member.businessId, r.from, r.to, 5),
        this.prisma.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(*)::bigint AS n FROM products p JOIN stock_balances b ON b."productId" = p.id
        WHERE p."businessId" = ${member.businessId}::uuid AND p.status = 'ACTIVE' AND b.quantity <= p."reorderThreshold"`,
        member.permissions.has('cost.read')
          ? this.prisma.stockBalance.findMany({
              where: { businessId: member.businessId, product: { status: 'ACTIVE' } },
              select: { quantity: true, avgCostKobo: true },
            })
          : Promise.resolve(null),
        this.recentActivity(member),
      ]);

    const revenue = net(rows, 'SALES_REVENUE', 'credit') - net(rows, 'SALES_REVENUE', 'debit');
    const cogs = net(rows, 'COGS', 'debit') - net(rows, 'COGS', 'credit');
    const expenses = expenseRows.reduce((s, x) => s + x.total, 0n);
    const stockAdj =
      net(rows, 'STOCK_ADJUSTMENTS', 'debit') - net(rows, 'STOCK_ADJUSTMENTS', 'credit');
    const collected =
      net(rows, 'CASH', 'debit', ['SALE', 'REPAYMENT']) -
      net(rows, 'CASH', 'credit', ['SALE_REVERSAL']);
    const pending =
      net(rows, 'PENDING_TRANSFERS', 'debit', ['SALE']) -
      net(rows, 'PENDING_TRANSFERS', 'credit', ['SALE_REVERSAL']);

    const report: OverviewReport = {
      range: this.info(member, r),
      revenueKobo: koboToNumber(revenue),
      salesCount,
      collectedKobo: koboToNumber(collected),
      pendingTransfersKobo: koboToNumber(pending),
      outstandingDebtKobo: koboToNumber(debt),
      lowStockCount: Number(lowStock[0].n),
      revenueSeries: series,
      topProducts: top.map((t) => ({
        productId: t.productId,
        name: t.name,
        salesKobo: koboToNumber(t.sales),
        units: qtyToString(D(t.units)),
      })),
      recent,
      definitions: DEFINITIONS,
    };
    if (financial) {
      report.expensesKobo = koboToNumber(expenses);
      report.cogsKobo = koboToNumber(cogs);
      report.grossProfitKobo = koboToNumber(revenue - cogs);
      report.netOperatingProfitKobo = koboToNumber(revenue - cogs - expenses - stockAdj);
    }
    if (valueRows) {
      report.inventoryValueKobo = koboToNumber(
        valueRows.reduce((s, b) => s + inventoryValue(D(b.quantity), D(b.avgCostKobo)), 0n),
      );
    }
    return report;
  }

  private async recentActivity(member: TenantMember): Promise<OverviewReport['recent']> {
    const own = !member.permissions.has('sales.read_all');
    const [sales, expenses, repayments] = await Promise.all([
      this.prisma.sale.findMany({
        where: { businessId: member.businessId, ...(own ? { cashierId: member.userId } : {}) },
        orderBy: { occurredAt: 'desc' },
        take: 6,
      }),
      member.permissions.has('expenses.read')
        ? this.prisma.expense.findMany({
            where: { businessId: member.businessId, status: 'POSTED' },
            include: { category: true },
            orderBy: { createdAt: 'desc' },
            take: 4,
          })
        : Promise.resolve([]),
      member.permissions.has('receivables.read')
        ? this.prisma.payment.findMany({
            where: { businessId: member.businessId, kind: 'REPAYMENT', status: 'PAID' },
            orderBy: { occurredAt: 'desc' },
            take: 4,
          })
        : Promise.resolve([]),
    ]);
    return [
      ...sales.map((s) => ({
        type: 'SALE' as const,
        id: s.id,
        label: `${s.receiptNumber}${s.status === 'REVERSED' ? ' (reversed)' : ''}`,
        amountKobo: koboToNumber(s.totalKobo),
        at: s.occurredAt.toISOString(),
      })),
      ...expenses.map((e) => ({
        type: 'EXPENSE' as const,
        id: e.id,
        label: e.category.name,
        amountKobo: koboToNumber(e.amountKobo),
        at: e.expenseDate.toISOString(),
      })),
      ...repayments.map((p) => ({
        type: 'REPAYMENT' as const,
        id: p.id,
        label: 'Customer repayment',
        amountKobo: koboToNumber(p.amountKobo),
        at: p.occurredAt.toISOString(),
      })),
    ]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 10);
  }

  // ───────────── sales ─────────────

  async sales(member: TenantMember, q: RangeQuery): Promise<SalesReport> {
    const r = this.range(member, q);
    const where = { businessId: member.businessId, occurredAt: { gte: r.from, lt: r.to } };
    const [agg, reversedCount, rows, series, payments] = await Promise.all([
      this.prisma.sale.aggregate({
        where,
        _sum: { subtotalKobo: true, discountKobo: true, creditKobo: true },
        _count: true,
      }),
      this.prisma.sale.count({ where: { ...where, status: 'REVERSED' } }),
      this.ledger(member.businessId, r.from, r.to),
      this.revenueSeries(member, r),
      this.prisma.payment.groupBy({
        by: ['method'],
        where: {
          businessId: member.businessId,
          kind: 'SALE_PAYMENT',
          occurredAt: where.occurredAt,
          status: { in: ['PAID', 'PENDING'] },
        },
        _sum: { amountKobo: true },
      }),
    ]);
    const gross = agg._sum.subtotalKobo ?? 0n;
    const discounts = agg._sum.discountKobo ?? 0n;
    const reversals = net(rows, 'SALES_REVENUE', 'debit', ['SALE_REVERSAL']);
    const mix = (m: 'CASH' | 'TRANSFER') =>
      payments.find((p) => p.method === m)?._sum.amountKobo ?? 0n;
    return {
      range: this.info(member, r),
      grossSalesKobo: koboToNumber(gross),
      discountsKobo: koboToNumber(discounts),
      reversalsKobo: koboToNumber(reversals),
      netSalesKobo: koboToNumber(gross - discounts - reversals),
      transactionCount: agg._count,
      reversedCount,
      paymentMix: {
        cashKobo: koboToNumber(mix('CASH')),
        transferKobo: koboToNumber(mix('TRANSFER')),
        creditKobo: koboToNumber(agg._sum.creditKobo ?? 0n),
      },
      series,
    };
  }

  // ───────────── collections ─────────────

  async collections(member: TenantMember, q: RangeQuery): Promise<CollectionsReport> {
    const r = this.range(member, q);
    const [rows, pendingRepay] = await Promise.all([
      this.ledger(member.businessId, r.from, r.to),
      this.prisma.payment.aggregate({
        where: {
          businessId: member.businessId,
          kind: 'REPAYMENT',
          status: 'PENDING',
          occurredAt: { gte: r.from, lt: r.to },
        },
        _sum: { amountKobo: true },
        _count: true,
      }),
    ]);
    const fromSales = net(rows, 'CASH', 'debit', ['SALE']);
    const fromRepay = net(rows, 'CASH', 'debit', ['REPAYMENT']);
    const refunds = net(rows, 'CASH', 'credit', ['SALE_REVERSAL']);
    return {
      range: this.info(member, r),
      cashFromSalesKobo: koboToNumber(fromSales),
      cashFromRepaymentsKobo: koboToNumber(fromRepay),
      refundsKobo: koboToNumber(refunds),
      netCollectedKobo: koboToNumber(fromSales + fromRepay - refunds),
      pendingTransfersKobo: koboToNumber(
        net(rows, 'PENDING_TRANSFERS', 'debit', ['SALE']) -
          net(rows, 'PENDING_TRANSFERS', 'credit', ['SALE_REVERSAL']),
      ),
      pendingRepayments: {
        count: pendingRepay._count,
        amountKobo: koboToNumber(pendingRepay._sum.amountKobo ?? 0n),
      },
    };
  }

  // ───────────── receivables ─────────────

  async receivables(member: TenantMember, q: RangeQuery): Promise<ReceivablesReport> {
    const r = this.range(member, q);
    const today = DateTime.now().setZone(member.timezone).startOf('day');
    const open = await this.prisma.receivable.findMany({
      where: { businessId: member.businessId, status: { in: ['OPEN', 'PARTIAL'] } },
      include: { customer: { select: { name: true, phone: true } } },
    });
    const buckets = {
      current: 0n,
      noDueDate: 0n,
      days1to30: 0n,
      days31to60: 0n,
      days61to90: 0n,
      days90plus: 0n,
    };
    const byCustomer = new Map<string, ReceivablesReport['customers'][number]>();
    let overdue = 0n;
    for (const rec of open) {
      const amount = rec.outstandingKobo;
      if (!rec.dueDate) buckets.noDueDate += amount;
      else {
        const late = Math.floor(
          today.diff(
            DateTime.fromJSDate(rec.dueDate).setZone(member.timezone).startOf('day'),
            'days',
          ).days,
        );
        if (late <= 0) buckets.current += amount;
        else {
          overdue += amount;
          if (late <= 30) buckets.days1to30 += amount;
          else if (late <= 60) buckets.days31to60 += amount;
          else if (late <= 90) buckets.days61to90 += amount;
          else buckets.days90plus += amount;
        }
      }
      const row = byCustomer.get(rec.customerId) ?? {
        customerId: rec.customerId,
        name: rec.customer.name,
        phone: rec.customer.phone,
        outstandingKobo: 0,
        oldestDueDate: null,
        openInvoices: 0,
      };
      row.outstandingKobo += koboToNumber(amount);
      row.openInvoices += 1;
      if (rec.dueDate && (!row.oldestDueDate || rec.dueDate.toISOString() < row.oldestDueDate))
        row.oldestDueDate = rec.dueDate.toISOString();
      byCustomer.set(rec.customerId, row);
    }
    const repaid = await this.prisma.payment.aggregate({
      where: {
        businessId: member.businessId,
        kind: 'REPAYMENT',
        status: 'PAID',
        occurredAt: { gte: r.from, lt: r.to },
      },
      _sum: { amountKobo: true },
    });
    const total = open.reduce((s, x) => s + x.outstandingKobo, 0n);
    return {
      range: this.info(member, r),
      asOf: new Date().toISOString(),
      totalOutstandingKobo: koboToNumber(total),
      overdueKobo: koboToNumber(overdue),
      buckets: Object.fromEntries(
        Object.entries(buckets).map(([k, v]) => [k, koboToNumber(v)]),
      ) as ReceivablesReport['buckets'],
      customers: [...byCustomer.values()].sort((a, b) => b.outstandingKobo - a.outstandingKobo),
      repaymentsInPeriodKobo: koboToNumber(repaid._sum.amountKobo ?? 0n),
    };
  }

  // ───────────── expenses ─────────────

  async expenses(member: TenantMember, q: RangeQuery): Promise<ExpensesReport> {
    const r = this.range(member, q);
    const [totals, categories] = await Promise.all([
      this.expenseAccountTotals(member.businessId, r.from, r.to),
      this.prisma.expenseCategory.findMany({ where: { businessId: member.businessId } }),
    ]);
    const byAccount = new Map(categories.map((c) => [c.accountId, c]));
    const byCategory = totals
      .filter((t) => t.total !== 0n)
      .map((t) => ({
        categoryId: byAccount.get(t.accountId)?.id ?? null,
        name: byAccount.get(t.accountId)?.name ?? 'Other',
        totalKobo: koboToNumber(t.total),
        count: Number(t.entries),
      }))
      .sort((a, b) => b.totalKobo - a.totalKobo);
    return {
      range: this.info(member, r),
      totalKobo: byCategory.reduce((s, c) => s + c.totalKobo, 0),
      count: byCategory.reduce((s, c) => s + c.count, 0),
      byCategory,
    };
  }

  // ───────────── profit ─────────────

  async profit(member: TenantMember, q: RangeQuery): Promise<ProfitReport> {
    const r = this.range(member, q);
    const [rows, exp] = await Promise.all([
      this.ledger(member.businessId, r.from, r.to),
      this.expenseAccountTotals(member.businessId, r.from, r.to),
    ]);
    const revenue = net(rows, 'SALES_REVENUE', 'credit') - net(rows, 'SALES_REVENUE', 'debit');
    const cogs = net(rows, 'COGS', 'debit') - net(rows, 'COGS', 'credit');
    const opex = exp.reduce((s, x) => s + x.total, 0n);
    const adj = net(rows, 'STOCK_ADJUSTMENTS', 'debit') - net(rows, 'STOCK_ADJUSTMENTS', 'credit');
    return {
      range: this.info(member, r),
      revenueKobo: koboToNumber(revenue),
      cogsKobo: koboToNumber(cogs),
      grossProfitKobo: koboToNumber(revenue - cogs),
      operatingExpensesKobo: koboToNumber(opex),
      stockAdjustmentsKobo: koboToNumber(adj),
      netOperatingProfitKobo: koboToNumber(revenue - cogs - opex - adj),
      note: 'An operational measure from your records. It is not audited statutory profit.',
    };
  }

  // ───────────── inventory ─────────────

  async inventory(member: TenantMember): Promise<InventoryReport> {
    const cost = member.permissions.has('cost.read');
    const products = await this.prisma.product.findMany({
      where: { businessId: member.businessId, status: 'ACTIVE' },
      include: { balance: true },
      orderBy: { name: 'asc' },
    });
    let total = 0n;
    let low = 0;
    const items = products.map((p) => {
      const qty = D(p.balance?.quantity ?? 0);
      const avg = D(p.balance?.avgCostKobo ?? 0);
      const isLow = qty.lte(D(p.reorderThreshold));
      if (isLow) low += 1;
      const value = inventoryValue(qty, avg);
      total += value;
      return {
        productId: p.id,
        name: p.name,
        sku: p.sku,
        baseUnit: p.baseUnit,
        quantity: qtyToString(qty),
        reorderThreshold: qtyToString(D(p.reorderThreshold)),
        isLowStock: isLow,
        ...(cost ? { avgCostKobo: avg.toFixed(4), valueKobo: koboToNumber(value) } : {}),
      };
    });
    return {
      asOf: new Date().toISOString(),
      items,
      lowStockCount: low,
      ...(cost ? { totalValueKobo: koboToNumber(total) } : {}),
    };
  }

  // ───────────── products and staff ─────────────

  async products(member: TenantMember, q: RangeQuery): Promise<ProductPerformanceReport> {
    const r = this.range(member, q);
    const rows = await this.topProducts(member.businessId, r.from, r.to, 200);
    const cost = member.permissions.has('cost.read');
    return {
      range: this.info(member, r),
      items: rows.map((x) => ({
        productId: x.productId,
        name: x.name,
        unitsSold: qtyToString(D(x.units)),
        salesKobo: koboToNumber(x.sales),
        ...(cost
          ? { cogsKobo: koboToNumber(x.cogs), grossProfitKobo: koboToNumber(x.sales - x.cogs) }
          : {}),
      })),
    };
  }

  async staff(member: TenantMember, q: RangeQuery): Promise<StaffReport> {
    const r = this.range(member, q);
    const rows = await this.prisma.$queryRaw<
      { userId: string; name: string | null; phone: string; count: bigint; total: bigint }[]
    >`
      SELECT u.id AS "userId", u.name, u.phone, COUNT(*)::bigint AS count, COALESCE(SUM(s."totalKobo"), 0)::bigint AS total
      FROM sales s JOIN users u ON u.id = s."cashierId"
      WHERE s."businessId" = ${member.businessId}::uuid AND s.status = 'COMPLETED'
        AND s."occurredAt" >= ${r.from} AND s."occurredAt" < ${r.to}
      GROUP BY u.id ORDER BY total DESC`;
    return {
      range: this.info(member, r),
      items: rows.map((x) => ({
        userId: x.userId,
        name: x.name,
        phone: x.phone,
        salesCount: Number(x.count),
        salesKobo: koboToNumber(x.total),
      })),
    };
  }
}
