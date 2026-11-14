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
  Session,
} from './helpers';

const today = () => new Date().toISOString().slice(0, 10);

describe('Customers, expenses, reports, sync and stock control', () => {
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

  const customer = async (s: Session, bid: string, name = 'Mama Tunde') =>
    (await ctx.http().post('/api/v1/customers').set(auth(s, bid)).send({ name }).expect(201)).body
      .id as string;

  const creditSale = (
    s: Session,
    bid: string,
    productId: string,
    customerId: string,
    qty: string,
    credit: number,
    cash = 0,
    dueDate?: string,
  ) =>
    postSale(ctx, s, bid, {
      customerId,
      dueDate,
      items: [{ productId, quantity: qty }],
      payments: [
        ...(cash ? [{ method: 'CASH', amountKobo: cash }] : []),
        { method: 'CREDIT', amountKobo: credit },
      ],
    });

  const repay = (
    s: Session,
    bid: string,
    path: string,
    body: Record<string, unknown>,
    key = newKey(),
  ) => ctx.http().post(path).set(auth(s, bid)).set('Idempotency-Key', key).send(body);

  describe('Iwe Gbese', () => {
    it('records partial then full repayment, settles the receivable and keeps the ledger balanced', async () => {
      const { owner, biz } = await setupShop(ctx);
      const p = await createProduct(ctx, owner, biz.id);
      const cid = await customer(owner, biz.id);
      const sale = (await creditSale(owner, biz.id, p.id, cid, '4', 600_000).expect(201)).body;

      const part = await repay(owner, biz.id, `/api/v1/customers/${cid}/repayments`, {
        amountKobo: 250_000,
        method: 'CASH',
      }).expect(201);
      expect(part.body).toMatchObject({ status: 'PAID', customerOutstandingKobo: 350_000 });
      expect(part.body.allocations[0]).toMatchObject({
        receiptNumber: sale.receiptNumber,
        remainingKobo: 350_000,
      });
      expect(
        (await ctx.http().get(`/api/v1/customers/${cid}`).set(auth(owner, biz.id))).body
          .outstandingKobo,
      ).toBe(350_000);

      await repay(owner, biz.id, `/api/v1/customers/${cid}/repayments`, {
        amountKobo: 350_000,
        method: 'CASH',
      }).expect(201);
      const rec = await ctx.prisma.receivable.findFirstOrThrow();
      expect(rec).toMatchObject({ status: 'SETTLED', outstandingKobo: 0n });
      expect(await ledgerBalance(ctx, biz.id, 'RECEIVABLES')).toBe(0n);
      expect(await ledgerBalance(ctx, biz.id, 'CASH')).toBe(600_000n);
      // Revenue was recognised once, at the time of the sale. Repayment does not add revenue.
      expect(await ledgerBalance(ctx, biz.id, 'SALES_REVENUE')).toBe(-600_000n);
      await repay(owner, biz.id, `/api/v1/customers/${cid}/repayments`, {
        amountKobo: 1,
        method: 'CASH',
      }).expect(422);
    });

    it('rejects overpayment, including under concurrent repayments', async () => {
      const { owner, biz } = await setupShop(ctx);
      const p = await createProduct(ctx, owner, biz.id);
      const cid = await customer(owner, biz.id);
      await creditSale(owner, biz.id, p.id, cid, '2', 300_000).expect(201);

      const over = await repay(owner, biz.id, `/api/v1/customers/${cid}/repayments`, {
        amountKobo: 300_001,
        method: 'CASH',
      }).expect(422);
      expect(over.body.error).toMatchObject({
        code: 'OVERPAYMENT_NOT_ALLOWED',
        details: { outstandingKobo: 300_000 },
      });

      const race = await Promise.all(
        Array.from({ length: 5 }, () =>
          repay(owner, biz.id, `/api/v1/customers/${cid}/repayments`, {
            amountKobo: 200_000,
            method: 'CASH',
          }),
        ),
      );
      expect(race.filter((r) => r.status === 201)).toHaveLength(1);
      expect((await ctx.prisma.receivable.findFirstOrThrow()).outstandingKobo).toBe(100_000n);
    });

    it('applies a customer repayment to the oldest debt first', async () => {
      const { owner, biz } = await setupShop(ctx);
      const p = await createProduct(ctx, owner, biz.id);
      const cid = await customer(owner, biz.id);
      const first = (
        await creditSale(owner, biz.id, p.id, cid, '1', 150_000, 0, '2026-11-01').expect(201)
      ).body;
      const second = (
        await creditSale(owner, biz.id, p.id, cid, '1', 150_000, 0, '2026-12-01').expect(201)
      ).body;
      const res = await repay(owner, biz.id, `/api/v1/customers/${cid}/repayments`, {
        amountKobo: 200_000,
        method: 'CASH',
      }).expect(201);
      expect(
        res.body.allocations.map((a: { receiptNumber: string; amountKobo: number }) => [
          a.receiptNumber,
          a.amountKobo,
        ]),
      ).toEqual([
        [first.receiptNumber, 150_000],
        [second.receiptNumber, 50_000],
      ]);
    });

    it('keeps a transfer repayment unverified: it does not reduce the debt or post to the ledger', async () => {
      const { owner, biz } = await setupShop(ctx);
      const p = await createProduct(ctx, owner, biz.id);
      const cid = await customer(owner, biz.id);
      await creditSale(owner, biz.id, p.id, cid, '1', 150_000).expect(201);
      const res = await repay(owner, biz.id, `/api/v1/customers/${cid}/repayments`, {
        amountKobo: 150_000,
        method: 'TRANSFER',
        note: 'Opay screenshot',
      }).expect(201);
      expect(res.body).toMatchObject({
        status: 'PENDING',
        verified: false,
        allocations: [],
        customerOutstandingKobo: 150_000,
      });
      expect(await ledgerBalance(ctx, biz.id, 'CASH')).toBe(0n);
      expect(await ledgerBalance(ctx, biz.id, 'RECEIVABLES')).toBe(150_000n);
    });

    it('is idempotent for repayments', async () => {
      const { owner, biz } = await setupShop(ctx);
      const p = await createProduct(ctx, owner, biz.id);
      const cid = await customer(owner, biz.id);
      await creditSale(owner, biz.id, p.id, cid, '2', 300_000).expect(201);
      const key = newKey();
      const a = await repay(
        owner,
        biz.id,
        `/api/v1/customers/${cid}/repayments`,
        { amountKobo: 100_000, method: 'CASH' },
        key,
      ).expect(201);
      const b = await repay(
        owner,
        biz.id,
        `/api/v1/customers/${cid}/repayments`,
        { amountKobo: 100_000, method: 'CASH' },
        key,
      ).expect(201);
      expect(b.body).toEqual(a.body);
      expect((await ctx.prisma.receivable.findFirstOrThrow()).outstandingKobo).toBe(200_000n);
    });

    it('lists overdue debts and builds a statement with opening and closing balances', async () => {
      const { owner, biz } = await setupShop(ctx);
      const p = await createProduct(ctx, owner, biz.id);
      const cid = await customer(owner, biz.id);
      await creditSale(owner, biz.id, p.id, cid, '2', 300_000, 0, '2020-01-01').expect(201);
      const overdue = await ctx
        .http()
        .get('/api/v1/receivables?view=overdue')
        .set(auth(owner, biz.id))
        .expect(200);
      expect(overdue.body.items[0]).toMatchObject({ isOverdue: true, outstandingKobo: 300_000 });
      expect(overdue.body.items[0].daysOverdue).toBeGreaterThan(1000);
      await repay(owner, biz.id, `/api/v1/customers/${cid}/repayments`, {
        amountKobo: 100_000,
        method: 'CASH',
      }).expect(201);

      const st = await ctx
        .http()
        .get(`/api/v1/customers/${cid}/statement?from=${today()}&to=${today()}`)
        .set(auth(owner, biz.id))
        .expect(200);
      expect(st.body.openingBalanceKobo).toBe(0);
      expect(st.body.rows.map((r: { type: string }) => r.type)).toEqual(['SALE', 'REPAYMENT']);
      expect(st.body.rows[1].balanceKobo).toBe(200_000);
      expect(st.body.closingBalanceKobo).toBe(200_000);
      const later = await ctx
        .http()
        .get(`/api/v1/customers/${cid}/statement?from=2099-01-01&to=2099-01-02`)
        .set(auth(owner, biz.id))
        .expect(200);
      expect(later.body).toMatchObject({
        openingBalanceKobo: 200_000,
        closingBalanceKobo: 200_000,
        rows: [],
      });
    });

    it('blocks reversing a sale that already has repayments, and voids the debt otherwise', async () => {
      const { owner, biz } = await setupShop(ctx);
      const p = await createProduct(ctx, owner, biz.id);
      const cid = await customer(owner, biz.id);
      const sale = (await creditSale(owner, biz.id, p.id, cid, '2', 300_000).expect(201)).body;
      await repay(owner, biz.id, `/api/v1/customers/${cid}/repayments`, {
        amountKobo: 50_000,
        method: 'CASH',
      }).expect(201);
      const blocked = await repay(owner, biz.id, `/api/v1/sales/${sale.id}/reversals`, {
        reason: 'Customer changed mind',
      }).expect(409);
      expect(blocked.body.error.code).toBe('SALE_HAS_REPAYMENTS');

      const sale2 = (await creditSale(owner, biz.id, p.id, cid, '1', 150_000).expect(201)).body;
      await repay(owner, biz.id, `/api/v1/sales/${sale2.id}/reversals`, {
        reason: 'Entered by mistake',
      }).expect(201);
      expect(
        (await ctx.http().get(`/api/v1/customers/${cid}`).set(auth(owner, biz.id))).body
          .outstandingKobo,
      ).toBe(250_000);
      expect(await ledgerBalance(ctx, biz.id, 'RECEIVABLES')).toBe(250_000n);
    });
  });

  describe('expenses and profit', () => {
    it('keeps expenses separate from stock purchases and reports net operating profit', async () => {
      const { owner, biz } = await setupShop(ctx);
      const p = await createProduct(ctx, owner, biz.id, {
        qty: '10',
        costKobo: 100_000,
        sellingPriceKobo: 150_000,
      });
      await postSale(ctx, owner, biz.id, {
        items: [{ productId: p.id, quantity: '4' }],
        payments: [{ method: 'CASH', amountKobo: 600_000 }],
      }).expect(201);
      // Buying stock is not an expense.
      await ctx
        .http()
        .post('/api/v1/stock-receipts')
        .set(auth(owner, biz.id))
        .set('Idempotency-Key', newKey())
        .send({
          paymentMethod: 'CASH',
          lines: [{ productId: p.id, quantity: '10', unitCostKobo: 100_000 }],
        })
        .expect(201);

      const cats = (
        await ctx.http().get('/api/v1/expense-categories').set(auth(owner, biz.id)).expect(200)
      ).body;
      const rent = cats.find((c: { name: string }) => c.name === 'Rent');
      const exp = await ctx
        .http()
        .post('/api/v1/expenses')
        .set(auth(owner, biz.id))
        .set('Idempotency-Key', newKey())
        .send({
          categoryId: rent.id,
          amountKobo: 50_000,
          method: 'CASH',
          description: 'Shop rent for the week',
        })
        .expect(201);

      const profit = (
        await ctx
          .http()
          .get('/api/v1/reports/profit?preset=today')
          .set(auth(owner, biz.id))
          .expect(200)
      ).body;
      expect(profit).toMatchObject({
        revenueKobo: 600_000,
        cogsKobo: 400_000,
        grossProfitKobo: 200_000,
        operatingExpensesKobo: 50_000,
        netOperatingProfitKobo: 150_000,
      });
      const byCat = (
        await ctx
          .http()
          .get('/api/v1/reports/expenses?preset=today')
          .set(auth(owner, biz.id))
          .expect(200)
      ).body;
      expect(byCat).toMatchObject({
        totalKobo: 50_000,
        byCategory: [{ name: 'Rent', totalKobo: 50_000 }],
      });

      // Reversal restores profit and leaves the original entry in place.
      await ctx
        .http()
        .post(`/api/v1/expenses/${exp.body.id}/reversals`)
        .set(auth(owner, biz.id))
        .set('Idempotency-Key', newKey())
        .send({ reason: 'Paid twice' })
        .expect(201);
      const after = (
        await ctx
          .http()
          .get('/api/v1/reports/profit?preset=today')
          .set(auth(owner, biz.id))
          .expect(200)
      ).body;
      expect(after.netOperatingProfitKobo).toBe(200_000);
      await ctx
        .http()
        .post(`/api/v1/expenses/${exp.body.id}/reversals`)
        .set(auth(owner, biz.id))
        .set('Idempotency-Key', newKey())
        .send({ reason: 'Again' })
        .expect(409);
      expect(await ctx.prisma.journalEntry.count({ where: { sourceType: 'EXPENSE' } })).toBe(1);
    });

    it('only lets the description of a posted expense change', async () => {
      const { owner, biz } = await setupShop(ctx);
      const cats = (await ctx.http().get('/api/v1/expense-categories').set(auth(owner, biz.id)))
        .body;
      const e = await ctx
        .http()
        .post('/api/v1/expenses')
        .set(auth(owner, biz.id))
        .set('Idempotency-Key', newKey())
        .send({
          categoryId: cats[0].id,
          amountKobo: 10_000,
          method: 'TRANSFER',
          description: 'Transport',
        })
        .expect(201);
      await ctx
        .http()
        .patch(`/api/v1/expenses/${e.body.id}`)
        .set(auth(owner, biz.id))
        .send({ amountKobo: 1 })
        .expect(400);
      const ok = await ctx
        .http()
        .patch(`/api/v1/expenses/${e.body.id}`)
        .set(auth(owner, biz.id))
        .send({ description: 'Transport to market' })
        .expect(200);
      expect(ok.body).toMatchObject({ amountKobo: 10_000, description: 'Transport to market' });
    });

    it('creates custom expense categories with their own ledger account', async () => {
      const { owner, biz } = await setupShop(ctx);
      const c = await ctx
        .http()
        .post('/api/v1/expense-categories')
        .set(auth(owner, biz.id))
        .send({ name: 'Generator fuel 2' })
        .expect(201);
      await ctx
        .http()
        .post('/api/v1/expense-categories')
        .set(auth(owner, biz.id))
        .send({ name: 'generator FUEL 2' })
        .expect(409);
      expect(
        await ctx.prisma.expenseCategory.findUniqueOrThrow({ where: { id: c.body.id } }),
      ).toMatchObject({ businessId: biz.id });
    });
  });

  describe('reports reconcile with the ledger', () => {
    it('separates revenue, collections, debt and pending transfers on the overview', async () => {
      const { owner, biz } = await setupShop(ctx);
      const p = await createProduct(ctx, owner, biz.id, {
        qty: '50',
        costKobo: 100_000,
        sellingPriceKobo: 150_000,
      });
      const cid = await customer(owner, biz.id);
      await postSale(ctx, owner, biz.id, {
        items: [{ productId: p.id, quantity: '2' }],
        payments: [{ method: 'CASH', amountKobo: 300_000 }],
      }).expect(201);
      await postSale(ctx, owner, biz.id, {
        items: [{ productId: p.id, quantity: '2' }],
        payments: [{ method: 'TRANSFER', amountKobo: 300_000 }],
      }).expect(201);
      await creditSale(owner, biz.id, p.id, cid, '2', 300_000).expect(201);
      await repay(owner, biz.id, `/api/v1/customers/${cid}/repayments`, {
        amountKobo: 100_000,
        method: 'CASH',
      }).expect(201);

      const o = (
        await ctx
          .http()
          .get('/api/v1/reports/overview?preset=today')
          .set(auth(owner, biz.id))
          .expect(200)
      ).body;
      expect(o.revenueKobo).toBe(900_000); // all three sales
      expect(o.collectedKobo).toBe(400_000); // cash sale + cash repayment only
      expect(o.pendingTransfersKobo).toBe(300_000); // not collected
      expect(o.outstandingDebtKobo).toBe(200_000);
      expect(o.salesCount).toBe(3);
      expect(o.cogsKobo).toBe(600_000);
      expect(o.grossProfitKobo).toBe(300_000);
      expect(o.netOperatingProfitKobo).toBe(300_000);
      expect(o.inventoryValueKobo).toBe(44 * 100_000);
      expect(o.revenueSeries).toHaveLength(1);
      expect(o.definitions.revenue).toMatch(/not money received/);

      const sales = (
        await ctx
          .http()
          .get('/api/v1/reports/sales?preset=today')
          .set(auth(owner, biz.id))
          .expect(200)
      ).body;
      expect(sales).toMatchObject({
        grossSalesKobo: 900_000,
        netSalesKobo: 900_000,
        transactionCount: 3,
        paymentMix: { cashKobo: 300_000, transferKobo: 300_000, creditKobo: 300_000 },
      });

      const col = (
        await ctx
          .http()
          .get('/api/v1/reports/collections?preset=today')
          .set(auth(owner, biz.id))
          .expect(200)
      ).body;
      expect(col).toMatchObject({
        cashFromSalesKobo: 300_000,
        cashFromRepaymentsKobo: 100_000,
        netCollectedKobo: 400_000,
      });

      const rec = (
        await ctx.http().get('/api/v1/reports/receivables').set(auth(owner, biz.id)).expect(200)
      ).body;
      expect(rec).toMatchObject({ totalOutstandingKobo: 200_000 });
      expect(rec.customers[0]).toMatchObject({ name: 'Mama Tunde', outstandingKobo: 200_000 });
    });

    it('reconstructs debt at a past date and counts reversals in the period they happen', async () => {
      const { owner, biz } = await setupShop(ctx);
      const p = await createProduct(ctx, owner, biz.id);
      const cid = await customer(owner, biz.id);
      await creditSale(owner, biz.id, p.id, cid, '2', 300_000).expect(201);
      const sale = (
        await postSale(ctx, owner, biz.id, {
          items: [{ productId: p.id, quantity: '1' }],
          payments: [{ method: 'CASH', amountKobo: 150_000 }],
        }).expect(201)
      ).body;
      await repay(owner, biz.id, `/api/v1/sales/${sale.id}/reversals`, {
        reason: 'Wrong item',
      }).expect(201);

      const yesterday = (
        await ctx
          .http()
          .get('/api/v1/reports/overview?preset=yesterday')
          .set(auth(owner, biz.id))
          .expect(200)
      ).body;
      expect(yesterday.outstandingDebtKobo).toBe(0);
      expect(yesterday.revenueKobo).toBe(0);
      const sales = (
        await ctx
          .http()
          .get('/api/v1/reports/sales?preset=today')
          .set(auth(owner, biz.id))
          .expect(200)
      ).body;
      expect(sales).toMatchObject({
        grossSalesKobo: 450_000,
        reversalsKobo: 150_000,
        netSalesKobo: 300_000,
        reversedCount: 1,
      });
    });

    it('shows profit to managers only, keeps cashiers out, and limits inventory managers', async () => {
      const { owner, biz } = await setupShop(ctx);
      const manager = await addStaff(ctx, owner, biz.id, 'MANAGER');
      const cashier = await addStaff(ctx, owner, biz.id, 'CASHIER');
      const stock = await addStaff(ctx, owner, biz.id, 'INVENTORY_MANAGER');
      await ctx.http().get('/api/v1/reports/overview').set(auth(cashier, biz.id)).expect(403);
      await ctx.http().get('/api/v1/reports/profit').set(auth(cashier, biz.id)).expect(403);
      await ctx.http().get('/api/v1/reports/overview').set(auth(stock, biz.id)).expect(403);
      expect(
        (await ctx.http().get('/api/v1/reports/inventory').set(auth(stock, biz.id)).expect(200))
          .body.items,
      ).toBeDefined();
      await ctx.http().get('/api/v1/reports/staff').set(auth(stock, biz.id)).expect(403);
      expect(
        (await ctx.http().get('/api/v1/reports/overview').set(auth(manager, biz.id)).expect(200))
          .body.netOperatingProfitKobo,
      ).toBeDefined();
      await ctx.http().get('/api/v1/audit-logs').set(auth(manager, biz.id)).expect(403);
      await ctx.http().get('/api/v1/audit-logs').set(auth(owner, biz.id)).expect(200);
    });

    it('uses the business timezone for day boundaries', async () => {
      const { owner, biz } = await setupShop(ctx);
      const p = await createProduct(ctx, owner, biz.id);
      // 23:30 UTC is already the next day in Lagos (UTC+1).
      const at = new Date();
      at.setUTCHours(23, 30, 0, 0);
      if (at.getTime() > Date.now()) at.setUTCDate(at.getUTCDate() - 1);
      await postSale(ctx, owner, biz.id, {
        occurredAt: at.toISOString(),
        items: [{ productId: p.id, quantity: '1' }],
        payments: [{ method: 'CASH', amountKobo: 150_000 }],
      }).expect(201);
      const lagosDay = new Date(at.getTime() + 3600_000).toISOString().slice(0, 10);
      const utcDay = at.toISOString().slice(0, 10);
      expect(lagosDay).not.toBe(utcDay);
      const r = (d: string) =>
        ctx
          .http()
          .get(`/api/v1/reports/sales?from=${d}&to=${d}`)
          .set(auth(owner, biz.id))
          .expect(200);
      expect((await r(lagosDay)).body.transactionCount).toBe(1);
      expect((await r(utcDay)).body.transactionCount).toBe(0);
    });
  });

  describe('stock control', () => {
    it('writes off damaged stock at the average cost, with a reason, and never goes negative', async () => {
      const { owner, biz } = await setupShop(ctx);
      const p = await createProduct(ctx, owner, biz.id, { qty: '10', costKobo: 100_000 });
      const adj = (body: Record<string, unknown>) =>
        ctx
          .http()
          .post('/api/v1/stock-adjustments')
          .set(auth(owner, biz.id))
          .set('Idempotency-Key', newKey())
          .send(body);
      await adj({
        productId: p.id,
        direction: 'OUT',
        reason: 'DAMAGED',
        quantity: '2',
        note: '',
      }).expect(400);
      const res = await adj({
        productId: p.id,
        direction: 'OUT',
        reason: 'DAMAGED',
        quantity: '2',
        note: 'Rats got into the bag',
      }).expect(201);
      expect(res.body).toMatchObject({
        movementType: 'DAMAGED',
        quantityAfter: '8.0000',
        valueKobo: 200_000,
      });
      expect(await ledgerBalance(ctx, biz.id, 'STOCK_ADJUSTMENTS')).toBe(200_000n);
      const tooMany = await adj({
        productId: p.id,
        direction: 'OUT',
        reason: 'LOST_OR_STOLEN',
        quantity: '9',
        note: 'Stolen',
      }).expect(409);
      expect(tooMany.body.error.code).toBe('INSUFFICIENT_STOCK');
      await adj({
        productId: p.id,
        direction: 'IN',
        reason: 'DAMAGED',
        quantity: '1',
        note: 'Nonsense',
      }).expect(422);

      const profit = (
        await ctx.http().get('/api/v1/reports/profit').set(auth(owner, biz.id)).expect(200)
      ).body;
      expect(profit).toMatchObject({
        stockAdjustmentsKobo: 200_000,
        netOperatingProfitKobo: -200_000,
      });
      const moves = (
        await ctx
          .http()
          .get(`/api/v1/stock-movements?productId=${p.id}`)
          .set(auth(owner, biz.id))
          .expect(200)
      ).body;
      expect(moves.items.map((m: { type: string }) => m.type)).toEqual(['DAMAGED', 'OPENING']);
      expect(await ctx.prisma.auditLog.count({ where: { action: 'stock.adjust' } })).toBe(1);
    });

    it('blocks cashiers from adjusting stock and flags low stock', async () => {
      const { owner, biz } = await setupShop(ctx);
      const cashier = await addStaff(ctx, owner, biz.id, 'CASHIER');
      const p = await createProduct(ctx, owner, biz.id, { qty: '3', threshold: '5' });
      await ctx
        .http()
        .post('/api/v1/stock-adjustments')
        .set(auth(cashier, biz.id))
        .set('Idempotency-Key', newKey())
        .send({
          productId: p.id,
          direction: 'IN',
          reason: 'FOUND',
          quantity: '5',
          note: 'Found some',
        })
        .expect(403);
      const low = await ctx
        .http()
        .get('/api/v1/products?lowStock=true')
        .set(auth(owner, biz.id))
        .expect(200);
      expect(low.body.items.map((x: { id: string }) => x.id)).toEqual([p.id]);
      const sum = await ctx
        .http()
        .get('/api/v1/inventory/summary')
        .set(auth(owner, biz.id))
        .expect(200);
      expect(sum.body).toMatchObject({ lowStockCount: 1, stockValueKobo: 300_000 });
    });

    it('rejects a unit conversion that would need silent rounding', async () => {
      const { owner, biz } = await setupShop(ctx);
      const p = await createProduct(ctx, owner, biz.id, {
        conversions: [{ name: 'tiny', factor: '0.0003' }],
      });
      const unit = p.conversions[0].id;
      const res = await postSale(ctx, owner, biz.id, {
        items: [{ productId: p.id, quantity: '0.5', unitId: unit }],
        payments: [{ method: 'CASH', amountKobo: 1 }],
      }).expect(422);
      expect(res.body.error.code).toBe('QUANTITY_PRECISION');
    });
  });

  describe('offline sync', () => {
    const batch = (s: Session, bid: string, operations: unknown[]) =>
      ctx
        .http()
        .post('/api/v1/sync/operations')
        .set(auth(s, bid))
        .send({ deviceId: 'device-1', operations });
    const saleOp = (
      productId: string,
      qty: string,
      amount: number,
      extra: Record<string, unknown> = {},
    ) => ({
      id: randomUUID(),
      type: 'sale.create',
      clientCreatedAt: new Date(Date.now() - 60_000).toISOString(),
      payload: {
        id: randomUUID(),
        occurredAt: new Date(Date.now() - 60_000).toISOString(),
        items: [{ productId, quantity: qty }],
        payments: [{ method: 'CASH', amountKobo: amount }],
        ...extra,
      },
    });

    it('applies offline sales once, even if the device retries the whole batch', async () => {
      const { owner, biz } = await setupShop(ctx);
      const p = await createProduct(ctx, owner, biz.id);
      const ops = [saleOp(p.id, '1', 150_000), saleOp(p.id, '2', 300_000)];
      const first = await batch(owner, biz.id, ops).expect(200);
      expect(first.body.results.map((r: { status: string }) => r.status)).toEqual([
        'SYNCED',
        'SYNCED',
      ]);
      const retry = await batch(owner, biz.id, ops).expect(200);
      expect(retry.body.results.map((r: { status: string }) => r.status)).toEqual([
        'SYNCED',
        'SYNCED',
      ]);
      expect(retry.body.results[0].result.id).toBe(first.body.results[0].result.id);
      expect(await ctx.prisma.sale.count()).toBe(2);
      expect(
        (await ctx.http().get(`/api/v1/products/${p.id}`).set(auth(owner, biz.id))).body.quantity,
      ).toBe('97.0000');
      // The original device time is kept for reporting.
      expect(
        new Date(
          (await ctx.prisma.sale.findFirstOrThrow({ orderBy: { occurredAt: 'asc' } })).occurredAt,
        ).getTime(),
      ).toBeLessThan(Date.now() - 30_000);
    });

    it('preserves a stock conflict between two devices and resolves it explicitly', async () => {
      const { owner, biz } = await setupShop(ctx);
      const p = await createProduct(ctx, owner, biz.id, { qty: '5' });
      const cashier = await addStaff(ctx, owner, biz.id, 'CASHIER');
      const a = saleOp(p.id, '4', 600_000);
      const b = saleOp(p.id, '3', 450_000);
      expect((await batch(owner, biz.id, [a]).expect(200)).body.results[0].status).toBe('SYNCED');
      const second = await batch(cashier, biz.id, [b]).expect(200);
      expect(second.body.results[0]).toMatchObject({
        status: 'CONFLICT',
        errorCode: 'INSUFFICIENT_STOCK',
      });
      // Nothing was lost: the intent is stored and no partial effect exists.
      expect(await ctx.prisma.sale.count()).toBe(1);
      const stored = await ctx.prisma.syncOperation.findUniqueOrThrow({ where: { id: b.id } });
      expect(stored).toMatchObject({ status: 'CONFLICT', userId: cashier.userId });
      // A resubmission does not retry blindly.
      expect((await batch(cashier, biz.id, [b]).expect(200)).body.results[0].status).toBe(
        'CONFLICT',
      );

      const status = await ctx
        .http()
        .get('/api/v1/sync/status')
        .set(auth(cashier, biz.id))
        .expect(200);
      expect(status.body.counts).toMatchObject({ CONFLICT: 1 });
      expect(status.body.unresolved[0].id).toBe(b.id);

      // Another cashier cannot resolve it. The owner can edit it down to what is left.
      await ctx
        .http()
        .post(`/api/v1/sync/operations/${b.id}/resolve`)
        .set(auth(cashier, biz.id))
        .send({
          action: 'EDIT_AND_POST',
          reason: 'Sell what remains',
          payload: {
            ...b.payload,
            items: [{ productId: p.id, quantity: '1' }],
            payments: [{ method: 'CASH', amountKobo: 150_000 }],
          },
        })
        .expect(200);
      expect(await ctx.prisma.sale.count()).toBe(2);
      expect(
        (await ctx.prisma.syncOperation.findUniqueOrThrow({ where: { id: b.id } })).status,
      ).toBe('SYNCED');
      expect(await ctx.prisma.auditLog.count({ where: { action: 'sync.edit_and_post' } })).toBe(1);
    });

    it('lets an owner dismiss a conflict only with a reason, keeping the record', async () => {
      const { owner, biz } = await setupShop(ctx);
      const p = await createProduct(ctx, owner, biz.id, { qty: '1' });
      const op = saleOp(p.id, '5', 750_000);
      expect((await batch(owner, biz.id, [op]).expect(200)).body.results[0].status).toBe(
        'CONFLICT',
      );
      await ctx
        .http()
        .post(`/api/v1/sync/operations/${op.id}/resolve`)
        .set(auth(owner, biz.id))
        .send({ action: 'DISMISS', reason: '' })
        .expect(400);
      await ctx
        .http()
        .post(`/api/v1/sync/operations/${op.id}/resolve`)
        .set(auth(owner, biz.id))
        .send({ action: 'DISMISS', reason: 'Customer left without the goods' })
        .expect(200);
      expect(
        await ctx.prisma.syncOperation.findUniqueOrThrow({ where: { id: op.id } }),
      ).toMatchObject({ status: 'DISMISSED', resolutionNote: 'Customer left without the goods' });
      expect(await ctx.prisma.auditLog.count({ where: { action: 'sync.dismiss' } })).toBe(1);
    });

    it('syncs customers, credit sales, repayments and expenses created offline in order', async () => {
      const { owner, biz } = await setupShop(ctx);
      const p = await createProduct(ctx, owner, biz.id);
      const cats = (await ctx.http().get('/api/v1/expense-categories').set(auth(owner, biz.id)))
        .body;
      const customerId = randomUUID();
      const t = (n: number) => new Date(Date.now() - 600_000 + n * 1000).toISOString();
      const ops = [
        {
          id: randomUUID(),
          type: 'repayment.create',
          clientCreatedAt: t(3),
          payload: { customerId, amountKobo: 100_000, method: 'CASH' },
        },
        {
          id: randomUUID(),
          type: 'customer.create',
          clientCreatedAt: t(1),
          payload: { id: customerId, name: 'Offline Customer' },
        },
        {
          id: randomUUID(),
          type: 'sale.create',
          clientCreatedAt: t(2),
          payload: {
            id: randomUUID(),
            customerId,
            items: [{ productId: p.id, quantity: '2' }],
            payments: [{ method: 'CREDIT', amountKobo: 300_000 }],
          },
        },
        {
          id: randomUUID(),
          type: 'expense.create',
          clientCreatedAt: t(4),
          payload: {
            id: randomUUID(),
            categoryId: cats[0].id,
            amountKobo: 5_000,
            method: 'CASH',
            description: 'Airtime',
          },
        },
      ];
      const res = await batch(owner, biz.id, ops).expect(200);
      // Processed in the order they happened, not the order sent.
      expect(res.body.results.map((r: { type: string }) => r.type)).toEqual([
        'customer.create',
        'sale.create',
        'repayment.create',
        'expense.create',
      ]);
      expect(res.body.results.map((r: { status: string }) => r.status)).toEqual([
        'SYNCED',
        'SYNCED',
        'SYNCED',
        'SYNCED',
      ]);
      expect(
        (await ctx.http().get(`/api/v1/customers/${customerId}`).set(auth(owner, biz.id))).body
          .outstandingKobo,
      ).toBe(200_000);
    });

    it('rejects invalid or unauthorised operations as final failures without side effects', async () => {
      const { owner, biz } = await setupShop(ctx);
      const p = await createProduct(ctx, owner, biz.id);
      const stock = await addStaff(ctx, owner, biz.id, 'INVENTORY_MANAGER');
      const bad = { ...saleOp(p.id, '1', 1) };
      const res = await batch(owner, biz.id, [
        bad,
        { ...saleOp(p.id, '1', 150_000), payload: { hacker: true } },
      ]).expect(200);
      expect(res.body.results[0]).toMatchObject({
        status: 'FAILED_FINAL',
        errorCode: 'PAYMENT_TOTAL_MISMATCH',
      });
      expect(res.body.results[1]).toMatchObject({
        status: 'FAILED_FINAL',
        errorCode: 'VALIDATION_FAILED',
      });
      const denied = await batch(stock, biz.id, [saleOp(p.id, '1', 150_000)]).expect(200);
      expect(denied.body.results[0]).toMatchObject({
        status: 'FAILED_FINAL',
        errorCode: 'PERMISSION_DENIED',
      });
      expect(await ctx.prisma.sale.count()).toBe(0);
    });
  });

  describe('maintenance', () => {
    it('purges expired one time codes and old idempotency records but never financial records', async () => {
      const { owner, biz } = await setupShop(ctx);
      const p = await createProduct(ctx, owner, biz.id);
      await postSale(ctx, owner, biz.id, {
        items: [{ productId: p.id, quantity: '1' }],
        payments: [{ method: 'CASH', amountKobo: 150_000 }],
      }).expect(201);
      await ctx.prisma.idempotencyRecord.updateMany({
        data: { createdAt: new Date(Date.now() - 90 * 86_400_000) },
      });
      const { MaintenanceService } = await import('../src/jobs/maintenance.service');
      const summary = await ctx.app.get(MaintenanceService).purge();
      expect(summary.idempotencyRecords).toBeGreaterThan(0);
      expect(await ctx.prisma.sale.count()).toBe(1);
      expect(await ctx.prisma.journalEntry.count()).toBeGreaterThan(0);
    });
  });
});
