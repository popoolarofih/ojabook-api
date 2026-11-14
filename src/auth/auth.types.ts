import { MemberRole } from '@prisma/client';
import { Permission } from '../common/permissions';

export interface AuthUser {
  id: string;
  sessionId: string;
}

export interface TenantMember {
  memberId: string;
  userId: string;
  businessId: string;
  role: MemberRole;
  permissions: ReadonlySet<Permission>;
  timezone: string;
  currency: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
    member?: TenantMember;
  }
}
