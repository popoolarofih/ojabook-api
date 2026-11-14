import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { unauthorized } from '../common/errors';
import { RequestContextStore } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { IS_PUBLIC } from './decorators';

interface AccessTokenPayload {
  sub: string;
  sid: string;
}

/** Global guard. Every route needs a valid access token unless marked @Public(). */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw unauthorized('UNAUTHENTICATED', 'Sign in to continue.');
    }

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(header.slice(7), {
        algorithms: ['HS256'],
      });
    } catch {
      throw unauthorized('TOKEN_INVALID', 'Your session has expired. Sign in again.');
    }

    // Sessions can be revoked at any time (logout, reuse detection), so check the family.
    const active = await this.prisma.refreshToken.findFirst({
      where: {
        familyId: payload.sid,
        userId: payload.sub,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    if (!active) throw unauthorized('SESSION_REVOKED', 'Your session has ended. Sign in again.');

    req.user = { id: payload.sub, sessionId: payload.sid };
    RequestContextStore.setUser(payload.sub);
    return true;
  }
}
