import { Injectable } from '@nestjs/common';
import { jsonSafe } from '../common/json';
import { RequestContextStore } from '../common/request-context';
import { Db } from '../prisma/prisma.service';

export interface AuditEvent {
  businessId?: string | null;
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  reason?: string;
  before?: unknown;
  after?: unknown;
}

/**
 * Append only audit trail (guide section 11.1). Always pass the active transaction so
 * the audit record commits or rolls back together with the change it describes.
 */
@Injectable()
export class AuditService {
  async record(db: Db, e: AuditEvent): Promise<void> {
    const ctx = RequestContextStore.get();
    await db.auditLog.create({
      data: {
        businessId: e.businessId ?? null,
        actorUserId: e.actorUserId ?? ctx?.userId ?? null,
        action: e.action,
        entityType: e.entityType,
        entityId: e.entityId,
        reason: e.reason,
        before: e.before === undefined ? undefined : jsonSafe(e.before as object),
        after: e.after === undefined ? undefined : jsonSafe(e.after as object),
        requestId: ctx?.requestId,
        ip: ctx?.ip,
        userAgent: ctx?.userAgent?.slice(0, 300),
      },
    });
  }
}
