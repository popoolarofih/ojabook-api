import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { APP_CONFIG, AppConfig } from './config/env';
import { createValidationPipe } from './http/validation';

export const API_PREFIX = 'api/v1';

/** Shared by main.ts and the integration tests so both run the same pipeline. */
export function configureApp(app: INestApplication, opts: { useLogger?: boolean } = {}) {
  const config = app.get<AppConfig>(APP_CONFIG);
  const express = app as NestExpressApplication;
  if (opts.useLogger) app.useLogger(app.get(Logger));

  express.set('trust proxy', 1); // behind one load balancer; makes req.ip and secure cookies correct
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: config.webOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Business-Id', 'Idempotency-Key', 'X-Requested-With', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'Idempotent-Replayed'],
  });
  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalPipes(createValidationPipe());
  app.enableShutdownHooks();
  return app;
}
