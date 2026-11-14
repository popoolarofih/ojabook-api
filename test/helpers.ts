import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { ConsoleOtpSender } from '../src/auth/otp/otp-sender';
import { PrismaService } from '../src/prisma/prisma.service';

export interface TestCtx {
  app: INestApplication;
  prisma: PrismaService;
  otp: ConsoleOtpSender;
  http: () => ReturnType<typeof request>;
}

export async function createTestApp(): Promise<TestCtx> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  const prisma = app.get(PrismaService);
  const otp = app.get(ConsoleOtpSender);
  return { app, prisma, otp, http: () => request(app.getHttpServer()) };
}

/** Wipes every table. TRUNCATE does not fire the append only row triggers. */
export async function resetDb(prisma: PrismaService) {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

let phoneCounter = 0;
/** A valid, unique Nigerian mobile number per call. */
export const uniquePhone = () => `0803${String(1_000_000 + ++phoneCounter + Math.floor(Math.random() * 1000) * 1000).slice(-7)}`;

export interface Session {
  token: string;
  userId: string;
  phone: string;
  cookie: string;
}

export async function signIn(ctx: TestCtx, phone = uniquePhone()): Promise<Session> {
  // Model a returning user who waited out the resend cooldown.
  await ctx.prisma.otpChallenge.updateMany({ data: { createdAt: new Date(Date.now() - 120_000) } });
  await ctx.http().post('/api/v1/auth/otp/request').send({ phone }).expect(200);
  const e164 = [...ctx.otp.sent.keys()].pop()!;
  const code = ctx.otp.sent.get(e164)!;
  const res = await ctx.http().post('/api/v1/auth/otp/verify').send({ phone, code }).expect(200);
  const cookie = (res.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  return { token: res.body.accessToken, userId: res.body.user.id, phone: e164, cookie };
}

export const auth = (s: Session, businessId?: string) => ({
  Authorization: `Bearer ${s.token}`,
  ...(businessId ? { 'X-Business-Id': businessId } : {}),
});

export async function createBusiness(ctx: TestCtx, s: Session, name = 'Amaka Provisions') {
  const res = await ctx
    .http()
    .post('/api/v1/businesses')
    .set(auth(s))
    .send({ name, category: 'provision_store' })
    .expect(201);
  return res.body as { id: string; name: string; currency: string; timezone: string };
}

export const newKey = () => `idem-${randomUUID()}`;

export interface ProductSeed {
  name?: string;
  sellingPriceKobo?: number;
  qty?: string;
  costKobo?: number;
  conversions?: { name: string; factor: string; sellingPriceKobo?: number }[];
  threshold?: string;
}

export async function createProduct(ctx: TestCtx, s: Session, businessId: string, p: ProductSeed = {}) {
  const res = await ctx
    .http()
    .post('/api/v1/products')
    .set(auth(s, businessId))
    .send({
      name: p.name ?? `Rice ${Math.random().toString(36).slice(2, 7)}`,
      baseUnit: 'kg',
      sellingPriceKobo: p.sellingPriceKobo ?? 150_000,
      reorderThreshold: p.threshold,
      conversions: p.conversions ?? [{ name: 'bag', factor: '50' }],
      openingStock: { quantity: p.qty ?? '100', unitCostKobo: p.costKobo ?? 100_000 },
    })
    .expect(201);
  return res.body as { id: string; quantity: string; conversions: { id: string; name: string }[] };
}

/** Owner with a business, ready to trade. */
export async function setupShop(ctx: TestCtx) {
  const owner = await signIn(ctx);
  const biz = await createBusiness(ctx, owner);
  return { owner, biz };
}

/** Invites and signs in a staff member with the given role. */
export async function addStaff(ctx: TestCtx, owner: Session, businessId: string, role: 'MANAGER' | 'CASHIER' | 'INVENTORY_MANAGER') {
  const phone = uniquePhone();
  const inv = await ctx.http().post(`/api/v1/businesses/${businessId}/invitations`).set(auth(owner, businessId)).send({ phone, role }).expect(201);
  const staff = await signIn(ctx, phone);
  await ctx.http().post('/api/v1/invitations/accept').set(auth(staff)).send({ token: inv.body.token }).expect(200);
  return staff;
}

export const postSale = (
  ctx: TestCtx,
  s: Session,
  businessId: string,
  body: Record<string, unknown>,
  key = newKey(),
) => ctx.http().post('/api/v1/sales').set(auth(s, businessId)).set('Idempotency-Key', key).send(body);

/** Net balance (debit minus credit) of a system account, straight from the ledger. */
export async function ledgerBalance(ctx: TestCtx, businessId: string, systemKey: string): Promise<bigint> {
  const rows = await ctx.prisma.$queryRaw<{ b: bigint }[]>`
    SELECT COALESCE(SUM(l."debitKobo" - l."creditKobo"), 0)::bigint AS b
    FROM journal_lines l JOIN accounts a ON a.id = l."accountId"
    WHERE l."businessId" = ${businessId}::uuid AND a."systemKey" = ${systemKey}`;
  return rows[0].b;
}
