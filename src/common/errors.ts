import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Every business rule failure is a DomainError with a stable machine readable code
 * and a human readable message (guide section 10.1).
 */
export class DomainError extends HttpException {
  constructor(
    readonly code: string,
    message: string,
    status: HttpStatus,
    readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new DomainError(code, message, HttpStatus.BAD_REQUEST, details);
export const unauthorized = (code: string, message: string) =>
  new DomainError(code, message, HttpStatus.UNAUTHORIZED);
export const forbidden = (code: string, message: string) =>
  new DomainError(code, message, HttpStatus.FORBIDDEN);
export const notFound = (what: string) =>
  new DomainError('NOT_FOUND', `${what} was not found.`, HttpStatus.NOT_FOUND);
export const conflict = (code: string, message: string, details?: unknown) =>
  new DomainError(code, message, HttpStatus.CONFLICT, details);
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new DomainError(code, message, HttpStatus.UNPROCESSABLE_ENTITY, details);
export const tooManyRequests = (code: string, message: string, details?: unknown) =>
  new DomainError(code, message, HttpStatus.TOO_MANY_REQUESTS, details);
