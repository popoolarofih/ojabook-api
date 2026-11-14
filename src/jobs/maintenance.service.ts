import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { APP_CONFIG, AppConfig } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';

const QUEUE = 'maintenance';
const DAY = 86_400_000;

/**
 * Retryable background work (guide section 6.2). A daily BullMQ job removes data that is
 * no longer needed. It never touches ledger, stock movement, sale or audit records.
 * Without REDIS_URL (local development) the job does not run, and purge() can be called directly.
 */
@Injectable()
export class MaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaintenanceService.name);
  private connection?: IORedis;
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit() {
    if (!this.config.redisUrl) return;
    this.connection = new IORedis(this.config.redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue(QUEUE, { connection: this.connection });
    await this.queue.upsertJobScheduler(
      'purge-expired',
      { pattern: '0 2 * * *', tz: 'Africa/Lagos' },
      { name: 'purge-expired' },
    );
    this.worker = new Worker(QUEUE, async () => this.purge(), { connection: this.connection });
    this.worker.on('failed', (job, err) =>
      this.logger.error({ err, job: job?.name }, 'Maintenance job failed'),
    );
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue?.close();
    this.connection?.disconnect();
  }

  /**
   * Retention: one time codes after a day, dead refresh tokens after a week, idempotency
   * records after 60 days (longer than the 30 day offline backdating limit, so a late retry
   * of an offline sale is still recognised).
   */
  async purge(now = new Date()) {
    const [otp, tokens, idem] = await Promise.all([
      this.prisma.otpChallenge.deleteMany({
        where: { expiresAt: { lt: new Date(now.getTime() - DAY) } },
      }),
      this.prisma.refreshToken.deleteMany({
        where: {
          OR: [
            { expiresAt: { lt: new Date(now.getTime() - 7 * DAY) } },
            { revokedAt: { lt: new Date(now.getTime() - 30 * DAY) } },
          ],
        },
      }),
      this.prisma.idempotencyRecord.deleteMany({
        where: { createdAt: { lt: new Date(now.getTime() - 60 * DAY) } },
      }),
    ]);
    const summary = {
      otpChallenges: otp.count,
      refreshTokens: tokens.count,
      idempotencyRecords: idem.count,
    };
    this.logger.log(summary, 'Maintenance purge complete');
    return summary;
  }
}
