import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { TenantMember } from '../auth/auth.types';
import { CurrentMember, CurrentUser, RequirePermissions, Tenant } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { forbidden } from '../common/errors';
import { BUSINESS_CATEGORIES } from './business-categories';
import {
  AcceptInvitationDto,
  BusinessCategoryDto,
  BusinessDto,
  CreateBusinessDto,
  CreatedInvitationDto,
  InvitationDto,
  InviteMemberDto,
  MemberDto,
  TransferOwnershipDto,
  UpdateBusinessDto,
  UpdateMemberDto,
} from './businesses.dto';
import { BusinessesService } from './businesses.service';

/** Routes that carry :id must match the active business from X-Business-Id. */
function assertActive(member: TenantMember, id: string) {
  if (member.businessId !== id) {
    throw forbidden('BUSINESS_MISMATCH', 'The business in the path does not match the active business.');
  }
}

@ApiTags('businesses')
@ApiBearerAuth()
@Controller()
export class BusinessesController {
  constructor(private readonly service: BusinessesService) {}

  @Get('businesses/categories')
  @ApiOperation({ summary: 'Business types with onboarding suggestions' })
  @ApiOkResponse({ type: [BusinessCategoryDto] })
  categories(): BusinessCategoryDto[] {
    return BUSINESS_CATEGORIES.map((c) => ({ id: c.id, label: c.label, suggestedUnits: [...c.suggestedUnits] }));
  }

  @Post('businesses')
  @ApiOperation({ summary: 'Create a business. The caller becomes its owner.' })
  @ApiOkResponse({ type: BusinessDto })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateBusinessDto): Promise<BusinessDto> {
    return this.service.create(user.id, dto);
  }

  @Get('businesses')
  @ApiOkResponse({ type: [BusinessDto] })
  list(@CurrentUser() user: AuthUser): Promise<BusinessDto[]> {
    return this.service.listForUser(user.id);
  }

  @Post('invitations/accept')
  @HttpCode(200)
  @ApiOperation({ summary: 'Accept a staff invitation. Must be signed in with the invited phone number.' })
  @ApiOkResponse({ type: BusinessDto })
  accept(@CurrentUser() user: AuthUser, @Body() dto: AcceptInvitationDto): Promise<BusinessDto> {
    return this.service.acceptInvitation(user.id, dto.token);
  }

  @Tenant()
  @RequirePermissions('business.read')
  @Get('businesses/:id')
  @ApiOkResponse({ type: BusinessDto })
  get(@CurrentMember() m: TenantMember, @Param('id', ParseUUIDPipe) id: string): Promise<BusinessDto> {
    assertActive(m, id);
    return this.service.get(m);
  }

  @Tenant()
  @RequirePermissions('business.update')
  @Patch('businesses/:id')
  @ApiOkResponse({ type: BusinessDto })
  update(
    @CurrentMember() m: TenantMember,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBusinessDto,
  ): Promise<BusinessDto> {
    assertActive(m, id);
    return this.service.update(m, dto);
  }

  @Tenant()
  @RequirePermissions('members.read')
  @Get('businesses/:id/members')
  @ApiOkResponse({ type: [MemberDto] })
  members(@CurrentMember() m: TenantMember, @Param('id', ParseUUIDPipe) id: string): Promise<MemberDto[]> {
    assertActive(m, id);
    return this.service.listMembers(m);
  }

  @Tenant()
  @RequirePermissions('members.invite')
  @Post('businesses/:id/invitations')
  @ApiOkResponse({ type: CreatedInvitationDto })
  invite(
    @CurrentMember() m: TenantMember,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InviteMemberDto,
  ): Promise<CreatedInvitationDto> {
    assertActive(m, id);
    return this.service.invite(m, dto);
  }

  @Tenant()
  @RequirePermissions('members.read')
  @Get('businesses/:id/invitations')
  @ApiOkResponse({ type: [InvitationDto] })
  invitations(@CurrentMember() m: TenantMember, @Param('id', ParseUUIDPipe) id: string): Promise<InvitationDto[]> {
    assertActive(m, id);
    return this.service.listInvitations(m);
  }

  @Tenant()
  @RequirePermissions('members.invite')
  @Delete('businesses/:id/invitations/:invitationId')
  @HttpCode(204)
  async revokeInvitation(
    @CurrentMember() m: TenantMember,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('invitationId', ParseUUIDPipe) invitationId: string,
  ): Promise<void> {
    assertActive(m, id);
    await this.service.revokeInvitation(m, invitationId);
  }

  @Tenant()
  @RequirePermissions('members.manage')
  @Patch('members/:memberId')
  @ApiOperation({ summary: 'Change a member role, status or permission refinements' })
  @ApiOkResponse({ type: [MemberDto] })
  updateMember(
    @CurrentMember() m: TenantMember,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() dto: UpdateMemberDto,
  ): Promise<MemberDto[]> {
    return this.service.updateMember(m, memberId, dto);
  }

  @Tenant()
  @RequirePermissions('members.manage')
  @Delete('members/:memberId')
  @HttpCode(204)
  async removeMember(
    @CurrentMember() m: TenantMember,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Query('reason') reason = 'Removed by owner',
  ): Promise<void> {
    await this.service.removeMember(m, memberId, reason);
  }

  @Tenant()
  @RequirePermissions('members.manage')
  @Post('businesses/:id/transfer-ownership')
  @HttpCode(200)
  @ApiOkResponse({ type: [MemberDto] })
  transfer(
    @CurrentMember() m: TenantMember,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransferOwnershipDto,
  ): Promise<MemberDto[]> {
    assertActive(m, id);
    return this.service.transferOwnership(m, dto.memberId, dto.reason);
  }

  @Tenant()
  @RequirePermissions('audit.read')
  @SkipThrottle()
  @Get('audit-logs')
  @ApiOperation({ summary: 'Recent audit events for the active business' })
  audit(@CurrentMember() m: TenantMember) {
    return this.service.auditTrail(m);
  }
}
