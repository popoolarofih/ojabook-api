import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { TenantMember } from '../auth/auth.types';
import { CurrentMember, RequirePermissions, Tenant } from '../auth/decorators';
import { idempotencyKey, respond } from '../common/idempotency-header';
import {
  CreateCustomerDto,
  CustomerDto,
  CustomerPage,
  ListCustomersQuery,
  ListReceivablesQuery,
  ReceivablePage,
  RepaymentDto,
  RepaymentResult,
  StatementDto,
  StatementQuery,
  UpdateCustomerDto,
} from './customers.dto';
import { CustomersService } from './customers.service';
import { ReceivablesService } from './receivables.service';

@ApiTags('customers')
@Tenant()
@Controller()
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly receivables: ReceivablesService,
  ) {}

  @RequirePermissions('customers.read')
  @Get('customers')
  @ApiOkResponse({ type: CustomerPage })
  list(@CurrentMember() m: TenantMember, @Query() q: ListCustomersQuery) {
    return this.customers.list(m, q);
  }

  @RequirePermissions('customers.write')
  @Post('customers')
  @ApiOkResponse({ type: CustomerDto })
  create(@CurrentMember() m: TenantMember, @Body() dto: CreateCustomerDto) {
    return this.customers.create(m, dto);
  }

  @RequirePermissions('customers.read')
  @Get('customers/:id')
  @ApiOkResponse({ type: CustomerDto })
  get(@CurrentMember() m: TenantMember, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.get(m, id);
  }

  @RequirePermissions('customers.write')
  @Patch('customers/:id')
  @ApiOkResponse({ type: CustomerDto })
  update(
    @CurrentMember() m: TenantMember,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    return this.customers.update(m, id, dto);
  }

  @RequirePermissions('customers.read', 'receivables.read')
  @Get('customers/:id/statement')
  @ApiOkResponse({ type: StatementDto })
  statement(
    @CurrentMember() m: TenantMember,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: StatementQuery,
  ) {
    return this.customers.statement(m, id, q.from, q.to);
  }

  @RequirePermissions('receivables.repay')
  @Post('customers/:id/repayments')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOkResponse({ type: RepaymentResult })
  async repayCustomer(
    @CurrentMember() m: TenantMember,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RepaymentDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return respond(res, await this.receivables.repayCustomer(m, id, dto, idempotencyKey(req)));
  }

  @RequirePermissions('receivables.read')
  @Get('receivables')
  @ApiOkResponse({ type: ReceivablePage })
  listReceivables(@CurrentMember() m: TenantMember, @Query() q: ListReceivablesQuery) {
    return this.receivables.list(m, q);
  }

  @RequirePermissions('receivables.repay')
  @Post('receivables/:id/repayments')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOkResponse({ type: RepaymentResult })
  async repay(
    @CurrentMember() m: TenantMember,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RepaymentDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return respond(res, await this.receivables.repayReceivable(m, id, dto, idempotencyKey(req)));
  }
}
