import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { forbidden } from '../common/errors';
import { Permission } from '../common/permissions';
import { PERMISSIONS_KEY } from './decorators';

/** Server side permission check on every request. Hiding UI is never a security boundary. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;
    const member = context.switchToHttp().getRequest<Request>().member;
    const missing = required.filter((p) => !member?.permissions.has(p));
    if (missing.length > 0) {
      throw forbidden('PERMISSION_DENIED', 'You do not have permission to do this.');
    }
    return true;
  }
}
