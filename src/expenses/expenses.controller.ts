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
  CreateExpenseCategoryDto,
  CreateExpenseDto,
  ExpenseCategoryDto,
  ExpenseDto,
  ExpensePage,
  ListExpensesQuery,
  ReverseExpenseDto,
  UpdateExpenseDto,
} from './expenses.dto';
import { ExpensesService } from './expenses.service';

@ApiTags('expenses')
@Tenant()
@Controller()
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @RequirePermissions('expenses.read')
  @Get('expense-categories')
  @ApiOkResponse({ type: [ExpenseCategoryDto] })
  categories(@CurrentMember() m: TenantMember) {
    return this.expenses.categories(m);
  }

  @RequirePermissions('expenses.write')
  @Post('expense-categories')
  @ApiOkResponse({ type: ExpenseCategoryDto })
  createCategory(@CurrentMember() m: TenantMember, @Body() dto: CreateExpenseCategoryDto) {
    return this.expenses.createCategory(m, dto);
  }

  @RequirePermissions('expenses.read')
  @Get('expenses')
  @ApiOkResponse({ type: ExpensePage })
  list(@CurrentMember() m: TenantMember, @Query() q: ListExpensesQuery) {
    return this.expenses.list(m, q);
  }

  @RequirePermissions('expenses.write')
  @Post('expenses')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOkResponse({ type: ExpenseDto })
  async create(
    @CurrentMember() m: TenantMember,
    @Body() dto: CreateExpenseDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return respond(res, await this.expenses.create(m, dto, idempotencyKey(req)));
  }

  @RequirePermissions('expenses.write')
  @Patch('expenses/:id')
  @ApiOkResponse({ type: ExpenseDto })
  update(
    @CurrentMember() m: TenantMember,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateExpenseDto,
  ) {
    return this.expenses.updateDescription(m, id, dto.description);
  }

  @RequirePermissions('expenses.reverse')
  @Post('expenses/:id/reversals')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOkResponse({ type: ExpenseDto })
  async reverse(
    @CurrentMember() m: TenantMember,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReverseExpenseDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return respond(res, await this.expenses.reverse(m, id, dto.reason, idempotencyKey(req)));
  }
}
