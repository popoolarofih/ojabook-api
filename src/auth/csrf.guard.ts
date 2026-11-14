import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { forbidden } from '../common/errors';
import { APP_CONFIG, AppConfig } from '../config/env';

/**
 * CSRF protection for the cookie authenticated routes (refresh and logout).
 * Layered: SameSite=Strict cookie, an allow listed Origin, and a custom header that a
 * cross site form cannot send and that forces a CORS preflight from other origins.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const origin = req.headers.origin;
    if (origin && !this.config.webOrigins.includes(origin)) {
      throw forbidden('CSRF_ORIGIN', 'This origin is not allowed.');
    }
    if (req.headers['x-requested-with'] !== 'ojabook-web') {
      throw forbidden('CSRF_HEADER', 'Missing required request header.');
    }
    return true;
  }
}
