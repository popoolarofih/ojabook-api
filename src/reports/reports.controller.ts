import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TenantMember } from '../auth/auth.types';
import { CurrentMember, RequirePermissions, Tenant } from '../auth/decorators';
import {
  CollectionsReport,
  ExpensesReport,
  InventoryReport,
  OverviewReport,
  ProductPerformanceReport,
  ProfitReport,
  RangeQuery,
  ReceivablesReport,
  SalesReport,
  StaffReport,
} from './reports.dto';
import { ReportsService } from './reports.service';

/** Authoritative figures are aggregated on the server from the ledger (guide section 4.7). */
@ApiTags('reports')
@Tenant()
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @RequirePermissions('reports.sales')
  @Get('overview')
  @ApiOperation({
    summary: 'Dashboard metrics. Profit and cost figures appear only with reports.financial.',
  })
  @ApiOkResponse({ type: OverviewReport })
  overview(@CurrentMember() m: TenantMember, @Query() q: RangeQuery) {
    return this.reports.overview(m, q);
  }

  @RequirePermissions('reports.sales')
  @Get('sales')
  @ApiOkResponse({ type: SalesReport })
  sales(@CurrentMember() m: TenantMember, @Query() q: RangeQuery) {
    return this.reports.sales(m, q);
  }

  @RequirePermissions('reports.sales')
  @Get('collections')
  @ApiOkResponse({ type: CollectionsReport })
  collections(@CurrentMember() m: TenantMember, @Query() q: RangeQuery) {
    return this.reports.collections(m, q);
  }

  @RequirePermissions('receivables.read')
  @Get('receivables')
  @ApiOkResponse({ type: ReceivablesReport })
  receivables(@CurrentMember() m: TenantMember, @Query() q: RangeQuery) {
    return this.reports.receivables(m, q);
  }

  @RequirePermissions('expenses.read')
  @Get('expenses')
  @ApiOkResponse({ type: ExpensesReport })
  expenses(@CurrentMember() m: TenantMember, @Query() q: RangeQuery) {
    return this.reports.expenses(m, q);
  }

  @RequirePermissions('reports.financial')
  @Get('profit')
  @ApiOkResponse({ type: ProfitReport })
  profit(@CurrentMember() m: TenantMember, @Query() q: RangeQuery) {
    return this.reports.profit(m, q);
  }

  @RequirePermissions('reports.inventory')
  @Get('inventory')
  @ApiOkResponse({ type: InventoryReport })
  inventory(@CurrentMember() m: TenantMember) {
    return this.reports.inventory(m);
  }

  @RequirePermissions('reports.sales')
  @Get('products')
  @ApiOkResponse({ type: ProductPerformanceReport })
  products(@CurrentMember() m: TenantMember, @Query() q: RangeQuery) {
    return this.reports.products(m, q);
  }

  @RequirePermissions('reports.staff')
  @Get('staff')
  @ApiOkResponse({ type: StaffReport })
  staff(@CurrentMember() m: TenantMember, @Query() q: RangeQuery) {
    return this.reports.staff(m, q);
  }
}
