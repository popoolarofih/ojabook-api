import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { forbidden } from '../common/errors';
import { resolvePermissions } from '../common/permissions';
import { PrismaService } from '../prisma/prisma.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves the active business from X-Business-Id and proves membership. The client
 * supplied id is never trusted on its own (guide section 11). A business that does not
 * exist and a business the user does not belong to are indistinguishable on purpose.
 */
@Injectable()
export class BusinessGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const businessId = req.headers['x-business-id'];
    const denied = () =>
      forbidden('BUSINESS_ACCESS_DENIED', 'You do not have access to this business.');

    if (typeof businessId !== 'string' || !UUID.test(businessId) || !req.user) throw denied();

    const member = await this.prisma.businessMember.findUnique({
      where: { businessId_userId: { businessId, userId: req.user.id } },
      include: { business: { select: { timezone: true, currency: true } } },
    });
    if (!member || member.status !== 'ACTIVE') throw denied();

    req.member = {
      memberId: member.id,
      userId: member.userId,
      businessId,
      role: member.role,
      permissions: resolvePermissions(
        member.role,
        member.extraPermissions,
        member.revokedPermissions,
      ),
      timezone: member.business.timezone,
      currency: member.business.currency,
    };
    return true;
  }
}
