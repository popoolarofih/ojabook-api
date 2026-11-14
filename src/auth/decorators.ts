import {
  applyDecorators,
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader } from '@nestjs/swagger';
import { Request } from 'express';
import { Permission } from '../common/permissions';
import { BusinessGuard } from './business.guard';
import { PermissionsGuard } from './permissions.guard';
import { AuthUser, TenantMember } from './auth.types';

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const PERMISSIONS_KEY = 'requiredPermissions';
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/** Class or route level: the route needs an active business membership (X-Business-Id). */
export const Tenant = () =>
  applyDecorators(
    ApiBearerAuth(),
    ApiHeader({ name: 'X-Business-Id', required: true, description: 'The active business.' }),
    UseGuards(BusinessGuard, PermissionsGuard),
  );

export const CurrentUser = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): AuthUser =>
    ctx.switchToHttp().getRequest<Request>().user as AuthUser,
);

export const CurrentMember = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): TenantMember =>
    ctx.switchToHttp().getRequest<Request>().member as TenantMember,
);
