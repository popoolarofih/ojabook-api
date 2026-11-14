import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Business, MemberRole } from '@prisma/client';
import { DateTime } from 'luxon';
import { AuditService } from '../audit/audit.service';
import { TenantMember } from '../auth/auth.types';
import { badRequest, conflict, forbidden, notFound } from '../common/errors';
import { normalizeNigerianPhone } from '../common/phone';
import { isPermission, resolvePermissions } from '../common/permissions';
import { LedgerService } from '../ledger/ledger.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  BusinessDto,
  CreateBusinessDto,
  CreatedInvitationDto,
  InvitationDto,
  InviteMemberDto,
  MemberDto,
  UpdateBusinessDto,
  UpdateMemberDto,
} from './businesses.dto';

const INVITATION_TTL_DAYS = 7;
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

const toDto = (b: Business): BusinessDto => ({
  id: b.id,
  name: b.name,
  category: b.category,
  phone: b.phone,
  email: b.email,
  address: b.address,
  city: b.city,
  state: b.state,
  currency: b.currency,
  timezone: b.timezone,
});

function assertTimezone(zone: string | undefined) {
  if (zone && !DateTime.local().setZone(zone).isValid) {
    throw badRequest('INVALID_TIMEZONE', 'Choose a valid timezone, for example Africa/Lagos.');
  }
}

@Injectable()
export class BusinessesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  async create(userId: string, dto: CreateBusinessDto): Promise<BusinessDto> {
    assertTimezone(dto.timezone);
    return this.prisma.transaction(async (tx) => {
      const business = await tx.business.create({
        data: {
          name: dto.name.trim(),
          category: dto.category,
          phone: dto.phone ? normalizeNigerianPhone(dto.phone) : undefined,
          email: dto.email,
          address: dto.address,
          city: dto.city,
          state: dto.state,
          currency: dto.currency ?? 'NGN',
          timezone: dto.timezone ?? 'Africa/Lagos',
          createdById: userId,
        },
      });
      await tx.businessMember.create({ data: { businessId: business.id, userId, role: 'OWNER' } });
      await this.ledger.seedChartOfAccounts(tx, business.id);
      await this.audit.record(tx, {
        businessId: business.id,
        actorUserId: userId,
        action: 'business.create',
        entityType: 'business',
        entityId: business.id,
        after: toDto(business),
      });
      return toDto(business);
    });
  }

  async listForUser(userId: string): Promise<BusinessDto[]> {
    const rows = await this.prisma.business.findMany({
      where: { members: { some: { userId, status: 'ACTIVE' } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toDto);
  }

  async get(member: TenantMember): Promise<BusinessDto> {
    const business = await this.prisma.business.findUnique({ where: { id: member.businessId } });
    if (!business) throw notFound('Business');
    return toDto(business);
  }

  async update(member: TenantMember, dto: UpdateBusinessDto): Promise<BusinessDto> {
    assertTimezone(dto.timezone);
    return this.prisma.transaction(async (tx) => {
      const before = await tx.business.findUniqueOrThrow({ where: { id: member.businessId } });
      const after = await tx.business.update({
        where: { id: member.businessId },
        data: { ...dto, phone: dto.phone ? normalizeNigerianPhone(dto.phone) : dto.phone },
      });
      await this.audit.record(tx, {
        businessId: member.businessId,
        actorUserId: member.userId,
        action: 'business.update',
        entityType: 'business',
        entityId: member.businessId,
        before: toDto(before),
        after: toDto(after),
      });
      return toDto(after);
    });
  }

  // ───────────── members ─────────────

  async listMembers(member: TenantMember): Promise<MemberDto[]> {
    const rows = await this.prisma.businessMember.findMany({
      where: { businessId: member.businessId, status: { not: 'REMOVED' } },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((m) => ({
      id: m.id,
      userId: m.userId,
      name: m.user.name,
      phone: m.user.phone,
      role: m.role,
      status: m.status,
      permissions: [...resolvePermissions(m.role, m.extraPermissions, m.revokedPermissions)],
      extraPermissions: m.extraPermissions,
      revokedPermissions: m.revokedPermissions,
    }));
  }

  async updateMember(member: TenantMember, memberId: string, dto: UpdateMemberDto): Promise<MemberDto[]> {
    const target = await this.prisma.businessMember.findFirst({
      where: { id: memberId, businessId: member.businessId, status: { not: 'REMOVED' } },
    });
    if (!target) throw notFound('Member');
    if (target.role === 'OWNER') {
      throw forbidden('OWNER_PROTECTED', 'The owner cannot be changed. Transfer ownership instead.');
    }
    if ((dto.role as string) === 'OWNER') {
      throw badRequest('OWNER_ASSIGN_FORBIDDEN', 'Use ownership transfer to make someone the owner.');
    }
    for (const p of [...(dto.extraPermissions ?? []), ...(dto.revokedPermissions ?? [])]) {
      if (!isPermission(p)) throw badRequest('UNKNOWN_PERMISSION', `"${p}" is not a known permission.`);
    }
    if (!dto.reason || dto.reason.trim().length < 3) {
      throw badRequest('REASON_REQUIRED', 'Give a short reason for this change. It is kept in the audit trail.');
    }

    await this.prisma.transaction(async (tx) => {
      const updated = await tx.businessMember.update({
        where: { id: target.id },
        data: {
          role: dto.role,
          status: dto.status,
          extraPermissions: dto.extraPermissions,
          revokedPermissions: dto.revokedPermissions,
        },
      });
      await this.audit.record(tx, {
        businessId: member.businessId,
        actorUserId: member.userId,
        action: 'member.update',
        entityType: 'business_member',
        entityId: target.id,
        reason: dto.reason,
        before: { role: target.role, status: target.status, extra: target.extraPermissions, revoked: target.revokedPermissions },
        after: { role: updated.role, status: updated.status, extra: updated.extraPermissions, revoked: updated.revokedPermissions },
      });
    });
    return this.listMembers(member);
  }

  async removeMember(member: TenantMember, memberId: string, reason: string): Promise<void> {
    const target = await this.prisma.businessMember.findFirst({
      where: { id: memberId, businessId: member.businessId, status: { not: 'REMOVED' } },
    });
    if (!target) throw notFound('Member');
    if (target.role === 'OWNER') throw forbidden('OWNER_PROTECTED', 'The owner cannot be removed.');
    await this.prisma.transaction(async (tx) => {
      await tx.businessMember.update({ where: { id: target.id }, data: { status: 'REMOVED' } });
      await this.audit.record(tx, {
        businessId: member.businessId,
        actorUserId: member.userId,
        action: 'member.remove',
        entityType: 'business_member',
        entityId: target.id,
        reason,
        before: { role: target.role, status: target.status },
      });
    });
  }

  async transferOwnership(member: TenantMember, targetMemberId: string, reason: string): Promise<MemberDto[]> {
    if (member.role !== 'OWNER') throw forbidden('OWNER_ONLY', 'Only the owner can transfer ownership.');
    const target = await this.prisma.businessMember.findFirst({
      where: { id: targetMemberId, businessId: member.businessId, status: 'ACTIVE' },
    });
    if (!target || target.id === member.memberId) throw notFound('Member');
    await this.prisma.transaction(async (tx) => {
      await tx.businessMember.update({
        where: { id: member.memberId },
        data: { role: 'MANAGER', extraPermissions: [], revokedPermissions: [] },
      });
      await tx.businessMember.update({
        where: { id: target.id },
        data: { role: 'OWNER', extraPermissions: [], revokedPermissions: [] },
      });
      await this.audit.record(tx, {
        businessId: member.businessId,
        actorUserId: member.userId,
        action: 'business.transfer_ownership',
        entityType: 'business',
        entityId: member.businessId,
        reason,
        before: { ownerMemberId: member.memberId },
        after: { ownerMemberId: target.id },
      });
    });
    return this.listMembers(member);
  }

  // ───────────── invitations ─────────────

  async invite(member: TenantMember, dto: InviteMemberDto): Promise<CreatedInvitationDto> {
    if (dto.role === 'OWNER') throw badRequest('OWNER_ASSIGN_FORBIDDEN', 'Staff cannot be invited as owner.');
    const phone = normalizeNigerianPhone(dto.phone);

    const existingUser = await this.prisma.user.findUnique({ where: { phone } });
    if (existingUser) {
      const existing = await this.prisma.businessMember.findUnique({
        where: { businessId_userId: { businessId: member.businessId, userId: existingUser.id } },
      });
      if (existing && existing.status !== 'REMOVED') {
        throw conflict('ALREADY_MEMBER', 'This person is already part of the business.');
      }
    }

    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 86_400_000);
    return this.prisma.transaction(async (tx) => {
      // Only one live invitation per phone and business.
      await tx.invitation.updateMany({
        where: { businessId: member.businessId, phone, status: 'PENDING' },
        data: { status: 'REVOKED' },
      });
      const inv = await tx.invitation.create({
        data: {
          businessId: member.businessId,
          phone,
          role: dto.role,
          tokenHash: sha256(token),
          expiresAt,
          invitedById: member.userId,
        },
      });
      await this.audit.record(tx, {
        businessId: member.businessId,
        actorUserId: member.userId,
        action: 'invitation.create',
        entityType: 'invitation',
        entityId: inv.id,
        after: { phone, role: dto.role },
      });
      return { ...this.invitationDto(inv), token };
    });
  }

  private invitationDto(inv: { id: string; phone: string; role: MemberRole; expiresAt: Date; status: string }): InvitationDto {
    const expired = inv.status === 'PENDING' && inv.expiresAt <= new Date();
    return {
      id: inv.id,
      phone: inv.phone,
      role: inv.role,
      expiresAt: inv.expiresAt.toISOString(),
      status: expired ? 'EXPIRED' : inv.status,
    };
  }

  async listInvitations(member: TenantMember): Promise<InvitationDto[]> {
    const rows = await this.prisma.invitation.findMany({
      where: { businessId: member.businessId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.invitationDto(r));
  }

  async revokeInvitation(member: TenantMember, id: string): Promise<void> {
    const res = await this.prisma.invitation.updateMany({
      where: { id, businessId: member.businessId, status: 'PENDING' },
      data: { status: 'REVOKED' },
    });
    if (res.count === 0) throw notFound('Invitation');
  }

  /** Single use, expiring token, bound to the invited phone number. */
  async acceptInvitation(userId: string, token: string): Promise<BusinessDto> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const invalid = () => badRequest('INVITATION_INVALID', 'This invitation is invalid or has expired.');

    return this.prisma.transaction(async (tx) => {
      const inv = await tx.invitation.findUnique({ where: { tokenHash: sha256(token) } });
      if (!inv || inv.status !== 'PENDING' || inv.expiresAt <= new Date() || inv.phone !== user.phone) {
        throw invalid();
      }
      // Atomic single use.
      const claimed = await tx.invitation.updateMany({
        where: { id: inv.id, status: 'PENDING' },
        data: { status: 'ACCEPTED', acceptedAt: new Date(), acceptedByUserId: userId },
      });
      if (claimed.count !== 1) throw invalid();

      await tx.businessMember.upsert({
        where: { businessId_userId: { businessId: inv.businessId, userId } },
        create: { businessId: inv.businessId, userId, role: inv.role },
        update: { role: inv.role, status: 'ACTIVE', extraPermissions: [], revokedPermissions: [] },
      });
      await this.audit.record(tx, {
        businessId: inv.businessId,
        actorUserId: userId,
        action: 'invitation.accept',
        entityType: 'invitation',
        entityId: inv.id,
        after: { role: inv.role },
      });
      return toDto(await tx.business.findUniqueOrThrow({ where: { id: inv.businessId } }));
    });
  }

  async auditTrail(member: TenantMember, limit = 100) {
    const rows = await this.prisma.auditLog.findMany({
      where: { businessId: member.businessId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
    });
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      actorUserId: r.actorUserId,
      reason: r.reason,
      requestId: r.requestId,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
