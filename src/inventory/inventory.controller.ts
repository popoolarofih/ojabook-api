import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { TenantMember } from '../auth/auth.types';
import { CurrentMember, RequirePermissions, Tenant } from '../auth/decorators';
import { idempotencyKey, respond } from '../common/idempotency-header';
import {
  CreateStockAdjustmentDto,
  CreateStockReceiptDto,
  InventorySummary,
  StockAdjustmentResult,
  StockMovementPage,
  StockMovementQuery,
  StockReceiptResult,
} from './inventory.dto';
import { InventoryService } from './inventory.service';

const IdemHeader = () =>
  ApiHeader({ name: 'Idempotency-Key', required: true, description: 'Makes retries safe.' });

@ApiTags('inventory')
@Tenant()
@Controller()
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @RequirePermissions('inventory.read')
  @Get('inventory/summary')
  @ApiOkResponse({ type: InventorySummary })
  summary(@CurrentMember() m: TenantMember) {
    return this.inventory.summary(m);
  }

  @RequirePermissions('inventory.read')
  @Get('stock-movements')
  @ApiOperation({ summary: 'Append only stock movement history' })
  @ApiOkResponse({ type: StockMovementPage })
  movements(@CurrentMember() m: TenantMember, @Query() q: StockMovementQuery) {
    return this.inventory.movements(m, q);
  }

  @RequirePermissions('inventory.receive')
  @Post('stock-receipts')
  @IdemHeader()
  @ApiOperation({ summary: 'Record purchased stock. Blends the weighted average cost.' })
  @ApiOkResponse({ type: StockReceiptResult })
  async receive(
    @CurrentMember() m: TenantMember,
    @Body() dto: CreateStockReceiptDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return respond(res, await this.inventory.receive(m, dto, idempotencyKey(req)));
  }

  @RequirePermissions('inventory.adjust')
  @Post('stock-adjustments')
  @IdemHeader()
  @ApiOperation({ summary: 'Add or remove stock with a reason. Audited.' })
  @ApiOkResponse({ type: StockAdjustmentResult })
  async adjust(
    @CurrentMember() m: TenantMember,
    @Body() dto: CreateStockAdjustmentDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return respond(res, await this.inventory.adjust(m, dto, idempotencyKey(req)));
  }
}
