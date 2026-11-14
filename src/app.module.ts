import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { BusinessesModule } from './businesses/businesses.module';
import { CatalogueModule } from './catalogue/catalogue.module';
import { CustomersModule } from './customers/customers.module';
import { ExpensesModule } from './expenses/expenses.module';
import { ReportsModule } from './reports/reports.module';
import { JobsModule } from './jobs/jobs.module';
import { SyncModule } from './sync/sync.module';
import { ConfigModule } from './config/config.module';
import { APP_CONFIG, AppConfig, loadConfig } from './config/env';
import { HealthController } from './health/health.controller';
import { AllExceptionsFilter } from './http/all-exceptions.filter';
import { RequestContextMiddleware } from './http/request-context.middleware';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { InventoryModule } from './inventory/inventory.module';
import { LedgerModule } from './ledger/ledger.module';
import { SalesModule } from './sales/sales.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.nodeEnv === 'test' ? 'silent' : 'info',
          genReqId: (req) => {
            const id = (req.headers['x-request-id'] as string) ?? randomUUID();
            req.headers['x-request-id'] = id;
            return id;
          },
          // Never log credentials or one time codes.
          redact: [
            'req.headers.authorization',
            'req.headers.cookie',
            'res.headers["set-cookie"]',
            'req.body.code',
          ],
          transport: config.isProduction
            ? undefined
            : { target: 'pino-pretty', options: { singleLine: true } },
        },
      }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        throttlers: [{ ttl: 60_000, limit: config.nodeEnv === 'test' ? 10_000 : 240 }],
        storage: config.redisUrl ? new ThrottlerStorageRedisService(config.redisUrl) : undefined,
      }),
    }),
    PrismaModule,
    AuditModule,
    IdempotencyModule,
    LedgerModule,
    AuthModule,
    BusinessesModule,
    InventoryModule,
    CatalogueModule,
    SalesModule,
    CustomersModule,
    ExpensesModule,
    ReportsModule,
    SyncModule,
    JobsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}

// Fail fast at import time if the environment is invalid.
loadConfig();
