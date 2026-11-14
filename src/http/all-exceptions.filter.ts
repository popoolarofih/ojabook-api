import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';
import { DomainError } from '../common/errors';
import { RequestContextStore } from '../common/request-context';

interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

/**
 * One error envelope for the whole API (guide section 10.1):
 *   { "error": { "code": "...", "message": "...", "details": ..., "requestId": "..." } }
 * Internal details never reach the client. Unexpected errors are logged with the request id.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    const requestId =
      RequestContextStore.get()?.requestId ?? (req.headers['x-request-id'] as string);

    const { status, body } = this.map(exception);
    if (status >= 500) {
      this.logger.error({ requestId, path: req.path, err: exception }, 'Unhandled error');
    }
    res.status(status).json({ error: { ...body, requestId } });
  }

  private map(exception: unknown): { status: number; body: ErrorBody } {
    if (exception instanceof DomainError) {
      return {
        status: exception.getStatus(),
        body: { code: exception.code, message: exception.message, details: exception.details },
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const r = exception.getResponse();
      const message =
        typeof r === 'string'
          ? r
          : ((r as { message?: string | string[] }).message ?? exception.message);
      const code =
        status === HttpStatus.TOO_MANY_REQUESTS
          ? 'RATE_LIMITED'
          : status === HttpStatus.NOT_FOUND
            ? 'NOT_FOUND'
            : status === HttpStatus.UNAUTHORIZED
              ? 'UNAUTHENTICATED'
              : status === HttpStatus.FORBIDDEN
                ? 'FORBIDDEN'
                : 'REQUEST_ERROR';
      return {
        status,
        body: { code, message: Array.isArray(message) ? message.join(', ') : message },
      };
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        return {
          status: 409,
          body: { code: 'ALREADY_EXISTS', message: 'A record with these details already exists.' },
        };
      }
      if (exception.code === 'P2025') {
        return { status: 404, body: { code: 'NOT_FOUND', message: 'The record was not found.' } };
      }
      if (exception.code === 'P2034') {
        return {
          status: 409,
          body: {
            code: 'RETRY_TRANSACTION',
            message: 'The request collided with another change. Retry.',
          },
        };
      }
    }
    return {
      status: 500,
      body: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side. Try again.' },
    };
  }
}
