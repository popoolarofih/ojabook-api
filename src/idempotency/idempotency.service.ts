import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { conflict } from '../common/errors';
import { canonicalJson, jsonSafe } from '../common/json';
import { PrismaService } from '../prisma/prisma.service';

export interface IdempotentParams {
  businessId: string;
  userId: string;
  /** The operation, for example sales.create. Keys are scoped per operation. */
  scope: string;
  key: string;
  /** Anything that defines the request. Different payload with the same key is a conflict. */
  payload: unknown;
}

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

/**
 * Safe retries for financial mutations (guide section 10.3).
 *
 * The idempotency record is inserted inside the same database transaction as the work.
 *  - First request: inserts the record, runs the work, stores the response, commits.
 *  - Concurrent duplicate: its INSERT waits on the unique index until the first
 *    transaction ends, then sees the committed record and replays the stored response.
 *  - Failed first attempt: the transaction rolls back, the record disappears, and a retry
 *    runs the work normally.
 *  - Same key with a materially different request: 409 IDEMPOTENCY_KEY_REUSED.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async run<T>(
    params: IdempotentParams,
    work: (tx: Prisma.TransactionClient) => Promise<{ status: number; body: T }>,
  ): Promise<IdempotentResult<T>> {
    const requestHash = createHash('sha256').update(canonicalJson(params.payload)).digest('hex');

    return this.prisma.transaction(async (tx) => {
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO idempotency_records (id, "businessId", "userId", scope, key, "requestHash", "createdAt")
        VALUES (gen_random_uuid(), ${params.businessId}::uuid, ${params.userId}::uuid,
                ${params.scope}, ${params.key}, ${requestHash}, now())
        ON CONFLICT ("businessId", "userId", scope, key) DO NOTHING
        RETURNING id`;

      if (inserted.length === 0) {
        const existing = await tx.idempotencyRecord.findUnique({
          where: {
            businessId_userId_scope_key: {
              businessId: params.businessId,
              userId: params.userId,
              scope: params.scope,
              key: params.key,
            },
          },
        });
        if (!existing || existing.requestHash !== requestHash) {
          throw conflict(
            'IDEMPOTENCY_KEY_REUSED',
            'This idempotency key was already used for a different request.',
          );
        }
        if (existing.responseStatus === null) {
          throw conflict('IDEMPOTENCY_IN_PROGRESS', 'This request is still being processed. Retry shortly.');
        }
        return { status: existing.responseStatus, body: existing.responseBody as T, replayed: true };
      }

      const result = await work(tx);
      await tx.idempotencyRecord.update({
        where: { id: inserted[0].id },
        data: {
          responseStatus: result.status,
          responseBody: jsonSafe(result.body) as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });
      return { ...result, replayed: false };
    });
  }
}

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;
