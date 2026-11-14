import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().optional().default(''),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  OTP_PEPPER: z.string().min(32, 'OTP_PEPPER must be at least 32 characters'),
  WEB_ORIGINS: z.string().min(1),
  OTP_PROVIDER: z.string().default('console'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  COOKIE_DOMAIN: z.string().optional().default(''),
});

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  jwtAccessSecret: string;
  otpPepper: string;
  webOrigins: string[];
  otpProvider: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  cookieDomain?: string;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration. ${problems}`);
  }
  const e = parsed.data;
  const config: AppConfig = {
    nodeEnv: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    jwtAccessSecret: e.JWT_ACCESS_SECRET,
    otpPepper: e.OTP_PEPPER,
    webOrigins: e.WEB_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    otpProvider: e.OTP_PROVIDER,
    accessTokenTtlSeconds: e.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlDays: e.REFRESH_TOKEN_TTL_DAYS,
    cookieDomain: e.COOKIE_DOMAIN || undefined,
  };
  if (config.isProduction) {
    if (config.otpProvider === 'console') {
      throw new Error(
        'OTP_PROVIDER=console is not allowed in production. Configure a real SMS provider adapter (guide section 18).',
      );
    }
    if (!config.redisUrl) throw new Error('REDIS_URL is required in production.');
    if (config.webOrigins.some((o) => !o.startsWith('https://'))) {
      throw new Error('WEB_ORIGINS must be https origins in production.');
    }
  }
  return config;
}
