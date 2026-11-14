import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { TenantMember } from '../auth/auth.types';
import { CurrentMember, RequirePermissions, Tenant } from '../auth/decorators';
import { idempotencyKey, respond } from '../common/idempotency-header';
import { CreateSaleDto, ListSalesQuery, ReverseSaleDto, SaleDto, SalePage } from './sales.dto';
import { SalesService } from './sales.service';

@ApiTags('sales')
@Tenant()
@Controller('sales')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @RequirePermissions('sales.create')
  @Post()
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({ summary: 'Record a sale. Stock, payments, receivable and ledger post atomically.' })
  @ApiOkResponse({ type: SaleDto })
  async create(
    @CurrentMember() m: TenantMember,
    @Body() dto: CreateSaleDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return respond(res, await this.sales.create(m, dto, idempotencyKey(req)));
  }

  @Get()
  @ApiOperation({ summary: 'Search sales. Cashiers only see their own.' })
  @ApiOkResponse({ type: SalePage })
  list(@CurrentMember() m: TenantMember, @Query() q: ListSalesQuery) {
    return this.sales.list(m, q);
  }

  @Get(':id')
  @ApiOkResponse({ type: SaleDto })
  get(@CurrentMember() m: TenantMember, @Param('id', ParseUUIDPipe) id: string) {
    return this.sales.get(m, id);
  }

  @RequirePermissions('sales.reverse')
  @Post(':id/reversals')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({ summary: 'Reverse a sale with a reason. The original records stay untouched.' })
  @ApiOkResponse({ type: SaleDto })
  async reverse(
    @CurrentMember() m: TenantMember,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReverseSaleDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return respond(res, await this.sales.reverse(m, id, dto.reason, idempotencyKey(req)));
  }
}
