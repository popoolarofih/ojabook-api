import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { resolvePermissions } from '../common/permissions';
import { PrismaService } from '../prisma/prisma.service';
import { MeResponse } from './auth.dto';
import { OtpService } from './otp/otp.service';
import { IssuedSession, SessionMeta, SessionService } from './session.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  /** Verify the code, create the user on first sign in, and open a session. */
  async verifyOtp(rawPhone: string, code: string, meta: SessionMeta) {
    const phone = await this.otp.verify(rawPhone, code);
    const user = await this.prisma.user.upsert({
      where: { phone },
      create: { phone, lastLoginAt: new Date() },
      update: { lastLoginAt: new Date() },
    });
    const session = await this.sessions.issue(user.id, meta);
    await this.audit.record(this.prisma, {
      actorUserId: user.id,
      action: 'auth.sign_in',
      entityType: 'session',
      entityId: session.sessionId,
    });
    return { session, me: await this.me(user.id) };
  }

  async me(userId: string): Promise<MeResponse> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: {
        memberships: {
          where: { status: 'ACTIVE' },
          include: { business: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    return {
      user: { id: user.id, phone: user.phone, name: user.name },
      memberships: user.memberships.map((m) => ({
        businessId: m.businessId,
        businessName: m.business.name,
        role: m.role,
        permissions: [...resolvePermissions(m.role, m.extraPermissions, m.revokedPermissions)],
        currency: m.business.currency,
        timezone: m.business.timezone,
      })),
    };
  }

  async refresh(rawToken: string, meta: SessionMeta): Promise<IssuedSession> {
    return this.sessions.rotate(rawToken, meta);
  }

  async updateProfile(userId: string, name: string) {
    await this.prisma.user.update({ where: { id: userId }, data: { name: name.trim() } });
    return this.me(userId);
  }
}
