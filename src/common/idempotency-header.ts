import { Request, Response } from 'express';
import { badRequest } from './errors';
import { IDEMPOTENCY_KEY_PATTERN, IdempotentResult } from '../idempotency/idempotency.service';

/** Financial mutations must carry a client generated Idempotency-Key (guide section 10.3). */
export function idempotencyKey(req: Request): string {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length === 0) {
    throw badRequest(
      'IDEMPOTENCY_KEY_REQUIRED',
      'Send an Idempotency-Key header with this request.',
    );
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw badRequest(
      'IDEMPOTENCY_KEY_INVALID',
      'The Idempotency-Key must be 8 to 128 letters, digits, or . _ : characters.',
    );
  }
  return key;
}

/** Applies the stored status and flags replays, then returns the body. */
export function respond<T>(res: Response, result: IdempotentResult<T>): T {
  res.status(result.status);
  res.setHeader('Idempotent-Replayed', String(result.replayed));
  return result.body;
}
