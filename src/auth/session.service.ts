import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { unauthorized } from '../common/errors';
import { APP_CONFIG, AppConfig } from '../config/env';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

export interface SessionMeta {
  ip?: string;
  userAgent?: string;
  deviceName?: string;
}

export interface IssuedSession {
  accessToken: string;
  expiresInSeconds: number;
  refreshToken: string;
  refreshExpiresAt: Date;
  sessionId: string;
}

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/**
 * Short lived access JWTs and rotating, single use refresh tokens (guide section 10.4).
 * Refresh tokens are opaque, stored only as hashes, and grouped in a family per login.
 * Presenting a token that was already rotated is treated as theft: the family is revoked.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private signAccess(userId: string, sessionId: string): Promise<string> {
    return this.jwt.signAsync(
      { sub: userId, sid: sessionId },
      { expiresIn: this.config.accessTokenTtlSeconds, algorithm: 'HS256' },
    );
  }

  private newRefreshToken() {
    const raw = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.config.refreshTokenTtlDays * 86_400_000);
    return { raw, hash: sha256(raw), expiresAt };
  }

  async issue(userId: string, meta: SessionMeta): Promise<IssuedSession> {
    const familyId = randomUUID();
    const token = this.newRefreshToken();
    await this.prisma.refreshToken.create({
      data: {
        userId,
        familyId,
        tokenHash: token.hash,
        expiresAt: token.expiresAt,
        ip: meta.ip,
        userAgent: meta.userAgent?.slice(0, 300),
        deviceName: meta.deviceName?.slice(0, 80),
        lastUsedAt: new Date(),
      },
    });
    return {
      accessToken: await this.signAccess(userId, familyId),
      expiresInSeconds: this.config.accessTokenTtlSeconds,
      refreshToken: token.raw,
      refreshExpiresAt: token.expiresAt,
      sessionId: familyId,
    };
  }

  async rotate(rawToken: string, meta: SessionMeta): Promise<IssuedSession> {
    const existing = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(rawToken) } });
    const invalid = () => unauthorized('REFRESH_INVALID', 'Your session has ended. Sign in again.');
    if (!existing) throw invalid();

    if (existing.revokedAt) {
      // A rotated token was presented again: assume it leaked and end the whole session.
      await this.revokeFamily(existing.familyId);
      await this.audit.record(this.prisma, {
        actorUserId: existing.userId,
        action: 'auth.refresh_reuse_detected',
        entityType: 'session',
        entityId: existing.familyId,
      });
      throw invalid();
    }
    if (existing.expiresAt <= new Date()) throw invalid();

    const next = this.newRefreshToken();
    const nextId = randomUUID();
    const rotated = await this.prisma.$transaction(async (tx) => {
      // Atomic: only one concurrent request can rotate a given token.
      const claimed = await tx.refreshToken.updateMany({
        where: { id: existing.id, revokedAt: null },
        data: { revokedAt: new Date(), replacedById: nextId, lastUsedAt: new Date() },
      });
      if (claimed.count !== 1) return false;
      await tx.refreshToken.create({
        data: {
          id: nextId,
          userId: existing.userId,
          familyId: existing.familyId,
          tokenHash: next.hash,
          expiresAt: next.expiresAt,
          ip: meta.ip,
          userAgent: meta.userAgent?.slice(0, 300),
          deviceName: existing.deviceName,
          lastUsedAt: new Date(),
        },
      });
      return true;
    });
    if (!rotated) throw invalid();

    return {
      accessToken: await this.signAccess(existing.userId, existing.familyId),
      expiresInSeconds: this.config.accessTokenTtlSeconds,
      refreshToken: next.raw,
      refreshExpiresAt: next.expiresAt,
      sessionId: existing.familyId,
    };
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeByRawToken(rawToken: string): Promise<void> {
    const token = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(rawToken) } });
    if (token) await this.revokeFamily(token.familyId);
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async listActive(userId: string, currentSessionId: string) {
    const rows = await this.prisma.refreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.familyId,
      deviceName: r.deviceName ?? null,
      userAgent: r.userAgent ?? null,
      lastUsedAt: (r.lastUsedAt ?? r.createdAt).toISOString(),
      current: r.familyId === currentSessionId,
    }));
  }

  async revokeOwnSession(userId: string, familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
