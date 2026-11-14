import { randomUUID } from 'node:crypto';
import {
  TestCtx,
  addStaff,
  auth,
  createProduct,
  createTestApp,
  ledgerBalance,
  newKey,
  postSale,
  resetDb,
  setupShop,
} from './helpers';

describe('Sales vertical slice: sale to stock to ledger', () => {
  let ctx: TestCtx;
  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it('creates a product with opening stock, a unit conversion and a balanced opening entry', async () => {
    const { owner, biz } = await setupShop(ctx);
    const p = await createProduct(ctx, owner, biz.id, { qty: '100', costKobo: 100_000 });
    expect(p.quantity).toBe('100.0000');
    expect(p.conversions[0].name).toBe('bag');
    expect(await ledgerBalance(ctx, biz.id, 'INVENTORY')).toBe(10_000_000n); // 100 kg x N1,000
    expect(await ledgerBalance(ctx, biz.id, 'OPENING_EQUITY')).toBe(-10_000_000n);
  });

  it('records a cash sale: converts units, deducts stock, snapshots cost, posts balanced ledger', async () => {
    const { owner, biz } = await setupShop(ctx);
    const p = await createProduct(ctx, owner, biz.id, {
      sellingPriceKobo: 150_000,
      costKobo: 100_000,
      qty: '100',
    });
    const bag = p.conversions[0].id;

    // 1 bag (50 kg) + 2.5 kg
    const res = await postSale(ctx, owner, biz.id, {
      items: [
        { productId: p.id, quantity: '1', unitId: bag },
        { productId: p.id, quantity: '2.5' },
      ],
      payments: [{ method: 'CASH', amountKobo: 7_500_000 + 375_000 }],
    }).expect(201);

    expect(res.headers['idempotent-replayed']).toBe('false');
    expect(res.body.receiptNumber).toBe('R-000001');
    expect(res.body.totalKobo).toBe(7_875_000);
    expect(res.body.items[0]).toMatchObject({
      unitName: 'bag',
      baseQuantity: '50.0000',
      unitPriceKobo: 7_500_000,
      unitCostKobo: '100000.0000',
    });
    expect(res.body.cogsKobo).toBe(5_250_000);
    expect(res.body.grossProfitKobo).toBe(2_625_000);

    const product = await ctx
      .http()
      .get(`/api/v1/products/${p.id}`)
      .set(auth(owner, biz.id))
      .expect(200);
    expect(product.body.quantity).toBe('47.5000');

    expect(await ledgerBalance(ctx, biz.id, 'CASH')).toBe(7_875_000n);
    expect(await ledgerBalance(ctx, biz.id, 'SALES_REVENUE')).toBe(-7_875_000n);
    expect(await ledgerBalance(ctx, biz.id, 'COGS')).toBe(5_250_000n);
    expect(await ledgerBalance(ctx, biz.id, 'INVENTORY')).toBe(10_000_000n - 5_250_000n);

    // Every journal entry balances.
    const unbalanced = await ctx.prisma.$queryRaw<unknown[]>`
      SELECT "entryId" FROM journal_lines GROUP BY "entryId" HAVING SUM("debitKobo") <> SUM("creditKobo")`;
    expect(unbalanced).toHaveLength(0);
  });

  it('recalculates totals on the server and rejects mismatched payments', async () => {
    const { owner, biz } = await setupShop(ctx);
    const p = await createProduct(ctx, owner, biz.id);
    const res = await postSale(ctx, owner, biz.id, {
      items: [{ productId: p.id, quantity: '2' }],
      payments: [{ method: 'CASH', amountKobo: 1 }],
    }).expect(422);
    expect(res.body.error.code).toBe('PAYMENT_TOTAL_MISMATCH');
    expect(res.body.error.details.totalKobo).toBe(300_000);
    // Nothing was written.
    expect(await ctx.prisma.sale.count()).toBe(0);
    expect(
      (await ctx.http().get(`/api/v1/products/${p.id}`).set(auth(owner, biz.id))).body.quantity,
    ).toBe('100.0000');
  });

  it('refuses to oversell and leaves no partial effects', async () => {
    const { owner, biz } = await setupShop(ctx);
    const p = await createProduct(ctx, owner, biz.id, { qty: '3' });
    const res = await postSale(ctx, owner, biz.id, {
      items: [{ productId: p.id, quantity: '3.0001' }],
      payments: [{ method: 'CASH', amountKobo: 450_015 }],
    }).expect(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(res.body.error.details).toMatchObject({ available: '3.0000', requested: '3.0001' });
    expect(await ctx.prisma.stockMovement.count({ where: { type: 'SALE' } })).toBe(0);
  });

  it('is idempotent: the same key and request returns the original sale once', async () => {
    const { owner, biz } = await setupShop(ctx);
    const p = await createProduct(ctx, owner, biz.id);
    const key = newKey();
    const body = {
      id: randomUUID(),
      items: [{ productId: p.id, quantity: '1' }],
      payments: [{ method: 'CASH', amountKobo: 150_000 }],
    };
    const first = await postSale(ctx, owner, biz.id, body, key).expect(201);
    const second = await postSale(ctx, owner, biz.id, body, key).expect(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(await ctx.prisma.sale.count()).toBe(1);
    expect(
      (await ctx.http().get(`/api/v1/products/${p.id}`).set(auth(owner, biz.id))).body.quantity,
    ).toBe('99.0000');
  });

  it('returns a conflict when a key is reused for a different request', async () => {
    const { owner, biz } = await setupShop(ctx);
    const p = await createProduct(ctx, owner, biz.id);
    const key = newKey();
    await postSale(
      ctx,
      owner,
      biz.id,
      {
        items: [{ productId: p.id, quantity: '1' }],
        payments: [{ method: 'CASH', amountKobo: 150_000 }],
      },
      key,
    ).expect(201);
    const res = await postSale(
      ctx,
      owner,
      biz.id,
      {
        items: [{ productId: p.id, quantity: '2' }],
        payments: [{ method: 'CASH', amountKobo: 300_000 }],
      },
      key,
    ).expect(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('handles concurrent retries of one request without duplicating the sale', async () => {
    const { owner, biz } = await setupShop(ctx);
    const p = await createProduct(ctx, owner, biz.id);
    const key = newKey();
    const body = {
      id: randomUUID(),
      items: [{ productId: p.id, quantity: '1' }],
      payments: [{ method: 'CASH', amountKobo: 150_000 }],
    };
    const results = await Promise.all(
      Array.from({ length: 6 }, () => postSale(ctx, owner, biz.id, body, key)),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.receiptNumber)).size).toBe(1);
    expect(await ctx.prisma.sale.count()).toBe(1);
    expect(
      (await ctx.http().get(`/api/v1/products/${p.id}`).set(auth(owner, biz.id))).body.quantity,
    ).toBe('99.0000');
  });

  it('never oversells under concurrent different sales', async () => {
    const { owner, biz } = await setupShop(ctx);
    const p = await createProduct(ctx, owner, biz.id, { qty: '5' });
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        postSale(ctx, owner, biz.id, {
          items: [{ productId: p.id, quantity: '1' }],
          payments: [{ method: 'CASH', amountKobo: 150_000 }],
        }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    const bal = await ctx.prisma.stockBalance.findUniqueOrThrow({ where: { productId: p.id } });
    expect(bal.quantity.toString()).toBe('0');
    // Receipt numbers are unique and gapless for committed sales.
    const receipts = (
      await ctx.prisma.sale.findMany({
        select: { receiptNumber: true },
        orderBy: { receiptNumber: 'asc' },
      })
    ).map((s) => s.receiptNumber);
    expect(receipts).toEqual(['R-000001', 'R-000002', 'R-000003', 'R-000004', 'R-000005']);
  });

  it('keeps historical profit when the product cost and price change later', async () => {
    const { owner, biz } = await setupShop(ctx);
    const p = await createProduct(ctx, owner, biz.id, {
      qty: '10',
      costKobo: 100_000,
      sellingPriceKobo: 150_000,
    });
    const sale = await postSale(ctx, owner, biz.id, {
      items: [{ productId: p.id, quantity: '4' }],
      payments: [{ method: 'CASH', amountKobo: 600_000 }],
    }).expect(201);
    expect(sale.body.grossProfitKobo).toBe(200_000);

    // Buy more stock at a higher cost, and raise the price.
    await ctx
      .http()
      .post('/api/v1/stock-receipts')
      .set(auth(owner, biz.id))
      .set('Idempotency-Key', newKey())
      .send({
        paymentMethod: 'CASH',
        lines: [{ productId: p.id, quantity: '6', unitCostKobo: 200_000 }],
      })
      .expect(201);
    await ctx
      .http()
      .patch(`/api/v1/products/${p.id}`)
      .set(auth(owner, biz.id))
      .send({ sellingPriceKobo: 400_000, name: 'Renamed rice' })
      .expect(200);

    const again = await ctx
      .http()
      .get(`/api/v1/sales/${sale.body.id}`)
      .set(auth(owner, biz.id))
      .expect(200);
    expect(again.body.grossProfitKobo).toBe(200_000);
    expect(again.body.items[0]).toMatchObject({
      productName: expect.stringContaining('Rice'),
      unitPriceKobo: 150_000,
      unitCostKobo: '100000.0000',
    });
    expect(await ledgerBalance(ctx, biz.id, 'COGS')).toBe(400_000n);

    // Weighted average: 6 kg at 1,000 + 6 kg at 2,000 = 1,500 per kg.
    const product = await ctx
      .http()
      .get(`/api/v1/products/${p.id}`)
      .set(auth(owner, biz.id))
      .expect(200);
    expect(product.body.avgCostKobo).toBe('150000.0000');
    expect(product.body.quantity).toBe('12.0000');
  });

  it('keeps a transfer unverified and out of collections', async () => {
    const { owner, biz } = await setupShop(ctx);
    const p = await createProduct(ctx, owner, biz.id);
    const res = await postSale(ctx, owner, biz.id, {
      items: [{ productId: p.id, quantity: '2' }],
      payments: [
        { method: 'CASH', amountKobo: 100_000 },
        { method: 'TRANSFER', amountKobo: 200_000 },
      ],
    }).expect(201);
    const transfer = res.body.payments.find((x: { method: string }) => x.method === 'TRANSFER');
    expect(transfer).toMatchObject({ status: 'PENDING', verified: false });
    expect(await ledgerBalance(ctx, biz.id, 'CASH')).toBe(100_000n);
    expect(await ledgerBalance(ctx, biz.id, 'PENDING_TRANSFERS')).toBe(200_000n);
    expect(await ledgerBalance(ctx, biz.id, 'SALES_REVENUE')).toBe(-300_000n);
  });

  it('records credit sales as receivables and requires a customer', async () => {
    const { owner, biz } = await setupShop(ctx);
    const p = await createProduct(ctx, owner, biz.id);
    const noCustomer = await postSale(ctx, owner, biz.id, {
      items: [{ productId: p.id, quantity: '1' }],
      payments: [{ method: 'CREDIT', amountKobo: 150_000 }],
    }).expect(422);
    expect(noCustomer.body.error.code).toBe('CREDIT_REQUIRES_CUSTOMER');

    const customer = await ctx
      .http()
      .post('/api/v1/customers')
      .set(auth(owner, biz.id))
      .send({ name: 'Mama Tunde', phone: '0805 111 2222' })
      .expect(201);
    const sale = await postSale(ctx, owner, biz.id, {
      customerId: customer.body.id,
      dueDate: '2026-12-20',
      items: [{ productId: p.id, quantity: '2' }],
      payments: [
        { method: 'CASH', amountKobo: 100_000 },
        { method: 'CREDIT', amountKobo: 200_000 },
      ],
    }).expect(201);
    expect(sale.body).toMatchObject({
      creditKobo: 200_000,
      outstandingKobo: 200_000,
      totalKobo: 300_000,
    });
    expect(await ledgerBalance(ctx, biz.id, 'RECEIVABLES')).toBe(200_000n);
    expect(await ledgerBalance(ctx, biz.id, 'CASH')).toBe(100_000n);
    // Revenue is recognised in full even though only part was collected.
    expect(await ledgerBalance(ctx, biz.id, 'SALES_REVENUE')).toBe(-300_000n);
  });

  it('restricts discounts and price overrides by permission, and audits them', async () => {
    const { owner, biz } = await setupShop(ctx);
    const cashier = await addStaff(ctx, owner, biz.id, 'CASHIER');
    const p = await createProduct(ctx, owner, biz.id);

    const denied = await postSale(ctx, cashier, biz.id, {
      items: [{ productId: p.id, quantity: '1', discountKobo: 10_000 }],
      payments: [{ method: 'CASH', amountKobo: 140_000 }],
    }).expect(403);
    expect(denied.body.error.code).toBe('DISCOUNT_DENIED');
    await postSale(ctx, cashier, biz.id, {
      items: [{ productId: p.id, quantity: '1', unitPriceKobo: 100 }],
      payments: [{ method: 'CASH', amountKobo: 100 }],
    }).expect(403);

    const ok = await postSale(ctx, owner, biz.id, {
      items: [
        {
          productId: p.id,
          quantity: '1',
          discountKobo: 10_000,
          overrideReason: 'Regular customer',
        },
      ],
      payments: [{ method: 'CASH', amountKobo: 140_000 }],
    }).expect(201);
    expect(ok.body).toMatchObject({
      subtotalKobo: 150_000,
      discountKobo: 10_000,
      totalKobo: 140_000,
    });
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'sale.discount', reason: 'Regular customer' },
      }),
    ).toBe(1);
  });

  it('limits cashiers to their own sales and hides cost data', async () => {
    const { owner, biz } = await setupShop(ctx);
    const cashier = await addStaff(ctx, owner, biz.id, 'CASHIER');
    const p = await createProduct(ctx, owner, biz.id);
    const mine = await postSale(ctx, cashier, biz.id, {
      items: [{ productId: p.id, quantity: '1' }],
      payments: [{ method: 'CASH', amountKobo: 150_000 }],
    }).expect(201);
    const theirs = await postSale(ctx, owner, biz.id, {
      items: [{ productId: p.id, quantity: '1' }],
      payments: [{ method: 'CASH', amountKobo: 150_000 }],
    }).expect(201);

    expect(mine.body.cogsKobo).toBeUndefined();
    expect(mine.body.items[0].unitCostKobo).toBeUndefined();
    const list = await ctx.http().get('/api/v1/sales').set(auth(cashier, biz.id)).expect(200);
    expect(list.body.items.map((s: { id: string }) => s.id)).toEqual([mine.body.id]);
    await ctx.http().get(`/api/v1/sales/${theirs.body.id}`).set(auth(cashier, biz.id)).expect(404);

    const catalogue = await ctx
      .http()
      .get('/api/v1/products/pos-catalogue')
      .set(auth(cashier, biz.id))
      .expect(200);
    expect(catalogue.body[0].avgCostKobo).toBeUndefined();
    await ctx
      .http()
      .post(`/api/v1/sales/${mine.body.id}/reversals`)
      .set(auth(cashier, biz.id))
      .set('Idempotency-Key', newKey())
      .send({ reason: 'oops' })
      .expect(403);
  });

  it('reverses a sale: stock returns at its original cost and the original ledger stays intact', async () => {
    const { owner, biz } = await setupShop(ctx);
    const p = await createProduct(ctx, owner, biz.id, { qty: '10', costKobo: 100_000 });
    const sale = await postSale(ctx, owner, biz.id, {
      items: [{ productId: p.id, quantity: '4' }],
      payments: [{ method: 'CASH', amountKobo: 600_000 }],
    }).expect(201);
    const entriesBefore = await ctx.prisma.journalEntry.count();

    await ctx
      .http()
      .post(`/api/v1/sales/${sale.body.id}/reversals`)
      .set(auth(owner, biz.id))
      .set('Idempotency-Key', newKey())
      .send({ reason: 'x' })
      .expect(400); // reason too short
    const rev = await ctx
      .http()
      .post(`/api/v1/sales/${sale.body.id}/reversals`)
      .set(auth(owner, biz.id))
      .set('Idempotency-Key', newKey())
      .send({ reason: 'Customer returned the rice' })
      .expect(201);
    expect(rev.body.status).toBe('REVERSED');
    expect(rev.body.reversal.reason).toBe('Customer returned the rice');

    expect(
      (await ctx.http().get(`/api/v1/products/${p.id}`).set(auth(owner, biz.id))).body.quantity,
    ).toBe('10.0000');
    expect(await ledgerBalance(ctx, biz.id, 'SALES_REVENUE')).toBe(0n);
    expect(await ledgerBalance(ctx, biz.id, 'COGS')).toBe(0n);
    expect(await ledgerBalance(ctx, biz.id, 'CASH')).toBe(0n);
    expect(await ledgerBalance(ctx, biz.id, 'INVENTORY')).toBe(1_000_000n); // back to the opening value: 10 kg at N1,000
    // The originals still exist. Corrections are additional rows.
    expect(await ctx.prisma.journalEntry.count()).toBe(entriesBefore + 2);
    expect(await ctx.prisma.journalEntry.count({ where: { reversesEntryId: { not: null } } })).toBe(
      2,
    );

    const again = await ctx
      .http()
      .post(`/api/v1/sales/${sale.body.id}/reversals`)
      .set(auth(owner, biz.id))
      .set('Idempotency-Key', newKey())
      .send({ reason: 'Second attempt' })
      .expect(409);
    expect(again.body.error.code).toBe('SALE_ALREADY_REVERSED');

    // The ledger and movements cannot be rewritten.
    await expect(ctx.prisma.journalLine.updateMany({ data: { debitKobo: 1n } })).rejects.toThrow(
      /append only/,
    );
    await expect(ctx.prisma.stockMovement.deleteMany({})).rejects.toThrow(/append only/);
  });

  it('isolates tenants: another business cannot see or sell products it does not own', async () => {
    const a = await setupShop(ctx);
    const b = await setupShop(ctx);
    const p = await createProduct(ctx, a.owner, a.biz.id);
    await ctx.http().get(`/api/v1/products/${p.id}`).set(auth(b.owner, b.biz.id)).expect(404);
    const res = await postSale(ctx, b.owner, b.biz.id, {
      items: [{ productId: p.id, quantity: '1' }],
      payments: [{ method: 'CASH', amountKobo: 150_000 }],
    }).expect(422);
    expect(res.body.error.code).toBe('PRODUCT_NOT_FOUND');
    await ctx.http().get('/api/v1/sales').set(auth(b.owner, a.biz.id)).expect(403);
    expect(
      (await ctx.http().get('/api/v1/sales').set(auth(b.owner, b.biz.id)).expect(200)).body.total,
    ).toBe(0);
  });
});
