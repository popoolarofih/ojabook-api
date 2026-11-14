import { HttpException, Injectable, Logger } from '@nestjs/common';
import { Prisma, SyncStatus } from '@prisma/client';
import { ClassConstructor, plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { TenantMember } from '../auth/auth.types';
import { Permission } from '../common/permissions';
import { canonicalJson, jsonSafe } from '../common/json';
import { DomainError, badRequest, conflict, forbidden, notFound } from '../common/errors';
import { CustomersService } from '../customers/customers.service';
import { CreateCustomerDto, RepaymentDto } from '../customers/customers.dto';
import { ReceivablesService } from '../customers/receivables.service';
import { CreateExpenseDto } from '../expenses/expenses.dto';
import { ExpensesService } from '../expenses/expenses.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSaleDto } from '../sales/sales.dto';
import { SalesService } from '../sales/sales.service';
import {
  ResolveOperationDto,
  SyncBatchDto,
  SyncBatchResult,
  SyncOperationInput,
  SyncOperationResult,
  SyncOperationType,
  SyncStatusDto,
} from './sync.dto';

const REQUIRED: Record<SyncOperationType, Permission> = {
  'customer.create': 'customers.write',
  'sale.create': 'sales.create',
  'repayment.create': 'receivables.repay',
  'expense.create': 'expenses.write',
};

/**
 * Offline operations (guide section 9). Each operation is:
 *  - applied with its own id as the idempotency key, so retries never duplicate;
 *  - stored with its outcome. A conflict (for example two devices sold the last item) is
 *    kept and surfaced for an explicit decision. Nothing is ever last write wins or silently dropped.
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sales: SalesService,
    private readonly customers: CustomersService,
    private readonly receivables: ReceivablesService,
    private readonly expenses: ExpensesService,
    private readonly audit: AuditService,
  ) {}

  async submit(member: TenantMember, batch: SyncBatchDto): Promise<SyncBatchResult> {
    const ordered = [...batch.operations].sort((a, b) =>
      a.clientCreatedAt.localeCompare(b.clientCreatedAt),
    );
    const results: SyncOperationResult[] = [];
    for (const op of ordered) results.push(await this.processOne(member, op, batch.deviceId));
    return { results, serverTime: new Date().toISOString() };
  }

  private async processOne(
    member: TenantMember,
    op: SyncOperationInput,
    deviceId?: string,
  ): Promise<SyncOperationResult> {
    const existing = await this.prisma.syncOperation.findUnique({ where: { id: op.id } });
    if (
      existing &&
      (existing.businessId !== member.businessId || existing.userId !== member.userId)
    ) {
      return {
        id: op.id,
        type: op.type,
        status: 'FAILED_FINAL',
        errorCode: 'OPERATION_ID_CONFLICT',
        message: 'This operation id belongs to someone else.',
      };
    }
    // Settled outcomes are returned as stored. Only retryable failures run again.
    if (existing && existing.status !== 'FAILED_RETRYABLE') return this.fromRecord(existing);

    const outcome = await this.run(member, op.type, op.payload, op.id);
    await this.prisma.syncOperation.upsert({
      where: { id: op.id },
      create: {
        id: op.id,
        businessId: member.businessId,
        userId: member.userId,
        type: op.type,
        payload: jsonSafe(op.payload) as Prisma.InputJsonValue,
        status: outcome.status,
        errorCode: outcome.errorCode,
        errorMessage: outcome.message,
        result:
          outcome.result === undefined
            ? undefined
            : (jsonSafe(outcome.result) as Prisma.InputJsonValue),
        deviceId,
        clientCreatedAt: new Date(op.clientCreatedAt),
      },
      update: {
        status: outcome.status,
        errorCode: outcome.errorCode ?? null,
        errorMessage: outcome.message ?? null,
        result:
          outcome.result === undefined
            ? undefined
            : (jsonSafe(outcome.result) as Prisma.InputJsonValue),
        attempts: { increment: 1 },
      },
    });
    return { id: op.id, type: op.type, ...outcome };
  }

  private fromRecord(r: Prisma.SyncOperationGetPayload<object>): SyncOperationResult {
    return {
      id: r.id,
      type: r.type,
      status: r.status,
      errorCode: r.errorCode ?? undefined,
      message: r.errorMessage ?? undefined,
      result: r.result ?? undefined,
    };
  }

  private async validated<T extends object>(
    cls: ClassConstructor<T>,
    payload: unknown,
  ): Promise<T> {
    const instance = plainToInstance(cls, payload);
    const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
    if (errors.length > 0) {
      throw badRequest(
        'VALIDATION_FAILED',
        'The saved transaction is not valid.',
        errors.map((e) => ({ field: e.property, messages: Object.values(e.constraints ?? {}) })),
      );
    }
    return instance;
  }

  /** Runs one operation and classifies the outcome for the device. */
  private async run(
    member: TenantMember,
    type: SyncOperationType,
    payload: Record<string, unknown>,
    key: string,
  ): Promise<Omit<SyncOperationResult, 'id' | 'type'>> {
    try {
      if (!member.permissions.has(REQUIRED[type]))
        throw forbidden('PERMISSION_DENIED', 'You do not have permission to record this.');
      let result: unknown;
      switch (type) {
        case 'customer.create':
          result = await this.customers.create(
            member,
            await this.validated(CreateCustomerDto, payload),
          );
          break;
        case 'sale.create':
          result = (
            await this.sales.create(member, await this.validated(CreateSaleDto, payload), key)
          ).body;
          break;
        case 'expense.create':
          result = (
            await this.expenses.create(member, await this.validated(CreateExpenseDto, payload), key)
          ).body;
          break;
        case 'repayment.create': {
          const { receivableId, customerId, ...rest } = payload as {
            receivableId?: string;
            customerId?: string;
          };
          const dto = await this.validated(RepaymentDto, rest);
          if (receivableId)
            result = (await this.receivables.repayReceivable(member, receivableId, dto, key)).body;
          else if (customerId)
            result = (await this.receivables.repayCustomer(member, customerId, dto, key)).body;
          else
            throw badRequest(
              'VALIDATION_FAILED',
              'A repayment needs a receivableId or customerId.',
            );
          break;
        }
      }
      return { status: 'SYNCED', result };
    } catch (e) {
      return this.classify(e);
    }
  }

  private classify(e: unknown): Omit<SyncOperationResult, 'id' | 'type'> {
    if (e instanceof DomainError) {
      const base = { errorCode: e.code, message: e.message, details: e.details };
      if (e.code === 'INSUFFICIENT_STOCK') return { status: 'CONFLICT', ...base };
      if (e.code === 'IDEMPOTENCY_IN_PROGRESS' || e.code === 'RETRY_TRANSACTION')
        return { status: 'FAILED_RETRYABLE', ...base };
      return { status: e.getStatus() < 500 ? 'FAILED_FINAL' : 'FAILED_RETRYABLE', ...base };
    }
    if (e instanceof HttpException && e.getStatus() < 500) {
      return { status: 'FAILED_FINAL', errorCode: 'REQUEST_ERROR', message: e.message };
    }
    // Prisma errors, lock timeouts and anything unexpected are treated as temporary.
    this.logger.error({ err: e }, 'Sync operation failed unexpectedly');
    return {
      status: 'FAILED_RETRYABLE',
      errorCode: 'TEMPORARY_FAILURE',
      message: 'Could not save right now. It will be retried.',
    };
  }

  // ───────────── status and resolution ─────────────

  async status(member: TenantMember): Promise<SyncStatusDto> {
    const scope = member.permissions.has('sales.read_all') ? {} : { userId: member.userId };
    const where = { businessId: member.businessId, ...scope };
    const [groups, unresolved] = await Promise.all([
      this.prisma.syncOperation.groupBy({ by: ['status'], where, _count: true }),
      this.prisma.syncOperation.findMany({
        where: { ...where, status: { in: ['CONFLICT', 'FAILED_FINAL', 'FAILED_RETRYABLE'] } },
        orderBy: { receivedAt: 'desc' },
        take: 100,
      }),
    ]);
    return {
      counts: Object.fromEntries(groups.map((g) => [g.status, g._count])),
      unresolved: unresolved.map((u) => ({
        id: u.id,
        type: u.type,
        status: u.status,
        errorCode: u.errorCode,
        message: u.errorMessage,
        details: null,
        payload: u.payload,
        clientCreatedAt: u.clientCreatedAt.toISOString(),
        receivedAt: u.receivedAt.toISOString(),
        attempts: u.attempts,
      })),
      serverTime: new Date().toISOString(),
    };
  }

  /**
   * An explicit human decision on a conflict (guide section 9.4):
   *  - EDIT_AND_POST: correct the transaction (for example sell fewer) and post it.
   *  - DISMISS: record that it will not be posted, with a reason. The original is kept.
   */
  async resolve(
    member: TenantMember,
    id: string,
    dto: ResolveOperationDto,
  ): Promise<SyncOperationResult> {
    const op = await this.prisma.syncOperation.findFirst({
      where: { id, businessId: member.businessId },
    });
    if (!op) throw notFound('Operation');
    if (op.userId !== member.userId && !member.permissions.has('sales.reverse')) {
      throw forbidden(
        'PERMISSION_DENIED',
        'Only the person who recorded this, or the owner, can resolve it.',
      );
    }
    if (op.status !== 'CONFLICT' && op.status !== 'FAILED_FINAL') {
      throw conflict('NOT_RESOLVABLE', 'Only conflicts and rejected transactions can be resolved.');
    }

    if (dto.action === 'DISMISS') {
      await this.prisma.transaction(async (tx) => {
        await tx.syncOperation.update({
          where: { id },
          data: {
            status: 'DISMISSED',
            resolvedAt: new Date(),
            resolvedById: member.userId,
            resolutionNote: dto.reason,
          },
        });
        await this.audit.record(tx, {
          businessId: member.businessId,
          actorUserId: member.userId,
          action: 'sync.dismiss',
          entityType: 'sync_operation',
          entityId: id,
          reason: dto.reason,
          before: { type: op.type, errorCode: op.errorCode, payload: op.payload },
        });
      });
      return { id, type: op.type, status: 'DISMISSED' };
    }

    if (!dto.payload)
      throw badRequest('PAYLOAD_REQUIRED', 'Send the corrected transaction to post it.');
    if (canonicalJson(dto.payload) === canonicalJson(op.payload) && op.status === 'FAILED_FINAL') {
      throw badRequest('PAYLOAD_UNCHANGED', 'Change the transaction before posting it again.');
    }
    const outcome = await this.run(member, op.type as SyncOperationType, dto.payload, id);
    await this.prisma.transaction(async (tx) => {
      await tx.syncOperation.update({
        where: { id },
        data: {
          status: outcome.status,
          errorCode: outcome.errorCode ?? null,
          errorMessage: outcome.message ?? null,
          result:
            outcome.result === undefined
              ? undefined
              : (jsonSafe(outcome.result) as Prisma.InputJsonValue),
          payload: jsonSafe(dto.payload!) as Prisma.InputJsonValue,
          attempts: { increment: 1 },
          ...(outcome.status === 'SYNCED'
            ? { resolvedAt: new Date(), resolvedById: member.userId, resolutionNote: dto.reason }
            : {}),
        },
      });
      await this.audit.record(tx, {
        businessId: member.businessId,
        actorUserId: member.userId,
        action: 'sync.edit_and_post',
        entityType: 'sync_operation',
        entityId: id,
        reason: dto.reason,
        before: { payload: op.payload, errorCode: op.errorCode },
        after: { status: outcome.status },
      });
    });
    return { id, type: op.type, ...outcome };
  }
}

export type { SyncStatus };
