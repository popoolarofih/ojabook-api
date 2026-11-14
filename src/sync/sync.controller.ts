import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TenantMember } from '../auth/auth.types';
import { CurrentMember, Tenant } from '../auth/decorators';
import {
  ResolveOperationDto,
  SyncBatchDto,
  SyncBatchResult,
  SyncOperationResult,
  SyncStatusDto,
} from './sync.dto';
import { SyncService } from './sync.service';

@ApiTags('sync')
@Tenant()
@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Post('operations')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send operations recorded offline. Safe to retry.' })
  @ApiOkResponse({ type: SyncBatchResult })
  submit(@CurrentMember() m: TenantMember, @Body() dto: SyncBatchDto) {
    return this.sync.submit(m, dto);
  }

  @Get('status')
  @ApiOkResponse({ type: SyncStatusDto })
  status(@CurrentMember() m: TenantMember) {
    return this.sync.status(m);
  }

  @Post('operations/:id/resolve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Decide what happens to a conflicting or rejected offline operation' })
  @ApiOkResponse({ type: SyncOperationResult })
  resolve(
    @CurrentMember() m: TenantMember,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveOperationDto,
  ) {
    return this.sync.resolve(m, id, dto);
  }
}
