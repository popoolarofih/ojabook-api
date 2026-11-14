import { TestCtx, auth, createBusiness, createTestApp, resetDb, signIn, uniquePhone } from './helpers';

describe('Auth, sessions and tenancy', () => {
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

  describe('OTP', () => {
    it('normalises the phone number to E.164 and signs a new user in', async () => {
      const phone = '0803 123 4567';
      await ctx.http().post('/api/v1/auth/otp/request').send({ phone }).expect(200);
      const code = ctx.otp.sent.get('+2348031234567')!;
      const res = await ctx.http().post('/api/v1/auth/otp/verify').send({ phone: '+234 803 123 4567', code }).expect(200);
      expect(res.body.user.phone).toBe('+2348031234567');
      expect(res.body.memberships).toEqual([]);
      const cookie = (res.headers['set-cookie'] as unknown as string[])[0];
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Strict/i);
      expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    });

    it('rejects invalid numbers and wrong codes with stable error codes', async () => {
      const bad = await ctx.http().post('/api/v1/auth/otp/request').send({ phone: '12345' }).expect(400);
      expect(bad.body.error.code).toBe('INVALID_PHONE');
      expect(bad.body.error.requestId).toBeTruthy();

      const phone = uniquePhone();
      await ctx.http().post('/api/v1/auth/otp/request').send({ phone }).expect(200);
      const wrong = await ctx.http().post('/api/v1/auth/otp/verify').send({ phone, code: '000000' }).expect(400);
      expect(wrong.body.error.code).toBe('OTP_INVALID');
    });

    it('limits resends and locks a code after repeated wrong attempts', async () => {
      const phone = uniquePhone();
      await ctx.http().post('/api/v1/auth/otp/request').send({ phone }).expect(200);
      const again = await ctx.http().post('/api/v1/auth/otp/request').send({ phone }).expect(429);
      expect(again.body.error.code).toBe('OTP_RESEND_TOO_SOON');

      for (let i = 0; i < 5; i++) {
        await ctx.http().post('/api/v1/auth/otp/verify').send({ phone, code: '000001' }).expect(400);
      }
      const locked = await ctx.http().post('/api/v1/auth/otp/verify').send({ phone, code: '000001' }).expect(429);
      expect(locked.body.error.code).toBe('OTP_ATTEMPTS_EXCEEDED');
    });

    it('makes a code single use', async () => {
      const phone = uniquePhone();
      await ctx.http().post('/api/v1/auth/otp/request').send({ phone }).expect(200);
      const code = [...ctx.otp.sent.values()].pop()!;
      await ctx.http().post('/api/v1/auth/otp/verify').send({ phone, code }).expect(200);
      await ctx.http().post('/api/v1/auth/otp/verify').send({ phone, code }).expect(400);
    });

    it('never stores the code in plaintext', async () => {
      const phone = uniquePhone();
      await ctx.http().post('/api/v1/auth/otp/request').send({ phone }).expect(200);
      const code = [...ctx.otp.sent.values()].pop()!;
      const row = await ctx.prisma.otpChallenge.findFirstOrThrow();
      expect(row.codeHash).not.toContain(code);
      expect(row.codeHash).toHaveLength(64);
    });
  });

  describe('sessions', () => {
    const csrf = { 'X-Requested-With': 'ojabook-web', Origin: 'http://localhost:3000' };

    it('rotates the refresh token and detects reuse by revoking the whole session', async () => {
      const s = await signIn(ctx);
      const first = await ctx.http().post('/api/v1/auth/refresh').set(csrf).set('Cookie', s.cookie).expect(200);
      const rotated = (first.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
      expect(rotated).not.toBe(s.cookie);

      // The new token works.
      await ctx.http().post('/api/v1/auth/refresh').set(csrf).set('Cookie', rotated).expect(200);

      // Replaying the first, already rotated token is theft: everything in the family dies.
      await ctx.http().post('/api/v1/auth/refresh').set(csrf).set('Cookie', s.cookie).expect(401);
      const stillGood = await ctx.http().post('/api/v1/auth/refresh').set(csrf).set('Cookie', rotated).expect(401);
      expect(stillGood.body.error.code).toBe('REFRESH_INVALID');

      // Access tokens of the revoked session stop working immediately.
      await ctx.http().get('/api/v1/auth/me').set(auth(s)).expect(401);
    });

    it('requires the CSRF header and an allowed origin on cookie routes', async () => {
      const s = await signIn(ctx);
      await ctx.http().post('/api/v1/auth/refresh').set('Cookie', s.cookie).expect(403);
      await ctx.http().post('/api/v1/auth/refresh').set({ ...csrf, Origin: 'https://evil.example' }).set('Cookie', s.cookie).expect(403);
    });

    it('logs out and can revoke every device', async () => {
      const s1 = await signIn(ctx, '08031112233');
      const s2 = await signIn(ctx, '08031112233');
      await ctx.http().post('/api/v1/auth/logout').set(csrf).set('Cookie', s1.cookie).expect(204);
      await ctx.http().get('/api/v1/auth/me').set(auth(s1)).expect(401);
      await ctx.http().get('/api/v1/auth/me').set(auth(s2)).expect(200);
      await ctx.http().post('/api/v1/auth/logout-all').set(auth(s2)).expect(204);
      await ctx.http().get('/api/v1/auth/me').set(auth(s2)).expect(401);
    });

    it('rejects missing and tampered access tokens', async () => {
      await ctx.http().get('/api/v1/auth/me').expect(401);
      const s = await signIn(ctx);
      await ctx.http().get('/api/v1/auth/me').set({ Authorization: `Bearer ${s.token}x` }).expect(401);
    });
  });

  describe('businesses and tenant isolation', () => {
    it('creates a business with owner membership, chart of accounts and default categories', async () => {
      const owner = await signIn(ctx);
      const biz = await createBusiness(ctx, owner);
      expect(biz.currency).toBe('NGN');
      expect(biz.timezone).toBe('Africa/Lagos');

      const accounts = await ctx.prisma.account.count({ where: { businessId: biz.id } });
      expect(accounts).toBeGreaterThanOrEqual(9 + 9);
      expect(await ctx.prisma.expenseCategory.count({ where: { businessId: biz.id } })).toBe(9);

      const me = await ctx.http().get('/api/v1/auth/me').set(auth(owner)).expect(200);
      expect(me.body.memberships[0]).toMatchObject({ businessId: biz.id, role: 'OWNER' });
      expect(me.body.memberships[0].permissions).toContain('business.update');
    });

    it('denies access to another business, and does not reveal whether it exists', async () => {
      const a = await signIn(ctx);
      const b = await signIn(ctx);
      const bizA = await createBusiness(ctx, a, 'A Traders');
      await createBusiness(ctx, b, 'B Traders');

      const cross = await ctx.http().get(`/api/v1/businesses/${bizA.id}`).set(auth(b, bizA.id)).expect(403);
      expect(cross.body.error.code).toBe('BUSINESS_ACCESS_DENIED');
      const missing = await ctx.http().get('/api/v1/businesses/00000000-0000-4000-8000-000000000000')
        .set(auth(b, '00000000-0000-4000-8000-000000000000')).expect(403);
      expect(missing.body.error.code).toBe('BUSINESS_ACCESS_DENIED');
      await ctx.http().get(`/api/v1/businesses/${bizA.id}`).set(auth(b)).expect(403); // no header
    });

    it('blocks a path/header mismatch', async () => {
      const a = await signIn(ctx);
      const bizA = await createBusiness(ctx, a);
      const bizA2 = await createBusiness(ctx, a, 'Second shop');
      await ctx.http().get(`/api/v1/businesses/${bizA.id}`).set(auth(a, bizA2.id)).expect(403);
    });

    it('lets one user belong to several businesses with an explicit active business', async () => {
      const a = await signIn(ctx);
      const one = await createBusiness(ctx, a, 'Shop one');
      const two = await createBusiness(ctx, a, 'Shop two');
      const list = await ctx.http().get('/api/v1/businesses').set(auth(a)).expect(200);
      expect(list.body.map((b: { id: string }) => b.id).sort()).toEqual([one.id, two.id].sort());
    });

    it('validates and rejects unknown fields (mass assignment)', async () => {
      const a = await signIn(ctx);
      const res = await ctx.http().post('/api/v1/businesses').set(auth(a))
        .send({ name: 'X', category: 'nope', role: 'OWNER' }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.details.map((d: { field: string }) => d.field)).toEqual(
        expect.arrayContaining(['name', 'category', 'role']),
      );
    });
  });

  describe('staff invitations and roles', () => {
    it('invites staff with a single use token bound to their phone, then enforces role permissions', async () => {
      const owner = await signIn(ctx);
      const biz = await createBusiness(ctx, owner);
      const staffPhone = uniquePhone();

      const inv = await ctx.http().post(`/api/v1/businesses/${biz.id}/invitations`).set(auth(owner, biz.id))
        .send({ phone: staffPhone, role: 'CASHIER' }).expect(201);
      expect(inv.body.token).toBeTruthy();
      const stored = await ctx.prisma.invitation.findFirstOrThrow();
      expect(stored.tokenHash).not.toContain(inv.body.token);

      // Someone else cannot use it.
      const stranger = await signIn(ctx);
      const wrong = await ctx.http().post('/api/v1/invitations/accept').set(auth(stranger)).send({ token: inv.body.token }).expect(400);
      expect(wrong.body.error.code).toBe('INVITATION_INVALID');

      const cashier = await signIn(ctx, staffPhone);
      await ctx.http().post('/api/v1/invitations/accept').set(auth(cashier)).send({ token: inv.body.token }).expect(200);
      await ctx.http().post('/api/v1/invitations/accept').set(auth(cashier)).send({ token: inv.body.token }).expect(400); // single use

      // Cashier can read the business but not change it or manage staff.
      await ctx.http().get(`/api/v1/businesses/${biz.id}`).set(auth(cashier, biz.id)).expect(200);
      const denied = await ctx.http().patch(`/api/v1/businesses/${biz.id}`).set(auth(cashier, biz.id)).send({ name: 'Hacked' }).expect(403);
      expect(denied.body.error.code).toBe('PERMISSION_DENIED');
      await ctx.http().post(`/api/v1/businesses/${biz.id}/invitations`).set(auth(cashier, biz.id)).send({ phone: uniquePhone(), role: 'MANAGER' }).expect(403);
    });

    it('rejects expired invitations', async () => {
      const owner = await signIn(ctx);
      const biz = await createBusiness(ctx, owner);
      const staffPhone = uniquePhone();
      const inv = await ctx.http().post(`/api/v1/businesses/${biz.id}/invitations`).set(auth(owner, biz.id))
        .send({ phone: staffPhone, role: 'MANAGER' }).expect(201);
      await ctx.prisma.invitation.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
      const staff = await signIn(ctx, staffPhone);
      await ctx.http().post('/api/v1/invitations/accept').set(auth(staff)).send({ token: inv.body.token }).expect(400);
    });

    it('protects the owner, requires reasons and audits role changes', async () => {
      const owner = await signIn(ctx);
      const biz = await createBusiness(ctx, owner);
      const staffPhone = uniquePhone();
      const inv = await ctx.http().post(`/api/v1/businesses/${biz.id}/invitations`).set(auth(owner, biz.id)).send({ phone: staffPhone, role: 'CASHIER' }).expect(201);
      const staff = await signIn(ctx, staffPhone);
      await ctx.http().post('/api/v1/invitations/accept').set(auth(staff)).send({ token: inv.body.token }).expect(200);

      const members = await ctx.http().get(`/api/v1/businesses/${biz.id}/members`).set(auth(owner, biz.id)).expect(200);
      const ownerMember = members.body.find((m: { role: string }) => m.role === 'OWNER');
      const cashierMember = members.body.find((m: { role: string }) => m.role === 'CASHIER');

      const protectedOwner = await ctx.http().patch(`/api/v1/members/${ownerMember.id}`).set(auth(owner, biz.id)).send({ status: 'SUSPENDED', reason: 'test' }).expect(403);
      expect(protectedOwner.body.error.code).toBe('OWNER_PROTECTED');
      await ctx.http().patch(`/api/v1/members/${cashierMember.id}`).set(auth(owner, biz.id)).send({ role: 'MANAGER' }).expect(400); // no reason

      const updated = await ctx.http().patch(`/api/v1/members/${cashierMember.id}`).set(auth(owner, biz.id))
        .send({ role: 'MANAGER', revokedPermissions: ['reports.staff'], reason: 'Promoted to run the shop' }).expect(200);
      const m = updated.body.find((x: { id: string }) => x.id === cashierMember.id);
      expect(m.role).toBe('MANAGER');
      expect(m.permissions).not.toContain('reports.staff');

      const log = await ctx.prisma.auditLog.findFirst({ where: { action: 'member.update' } });
      expect(log).toMatchObject({ businessId: biz.id, reason: 'Promoted to run the shop' });
    });

    it('suspended members lose access immediately', async () => {
      const owner = await signIn(ctx);
      const biz = await createBusiness(ctx, owner);
      const staffPhone = uniquePhone();
      const inv = await ctx.http().post(`/api/v1/businesses/${biz.id}/invitations`).set(auth(owner, biz.id)).send({ phone: staffPhone, role: 'CASHIER' }).expect(201);
      const staff = await signIn(ctx, staffPhone);
      await ctx.http().post('/api/v1/invitations/accept').set(auth(staff)).send({ token: inv.body.token }).expect(200);
      const members = await ctx.http().get(`/api/v1/businesses/${biz.id}/members`).set(auth(owner, biz.id)).expect(200);
      const id = members.body.find((m: { role: string }) => m.role === 'CASHIER').id;
      await ctx.http().patch(`/api/v1/members/${id}`).set(auth(owner, biz.id)).send({ status: 'SUSPENDED', reason: 'Left the shop' }).expect(200);
      await ctx.http().get(`/api/v1/businesses/${biz.id}`).set(auth(staff, biz.id)).expect(403);
    });
  });

  describe('append only ledger tables', () => {
    it('rejects UPDATE and DELETE on audit logs at the database level', async () => {
      const owner = await signIn(ctx);
      await createBusiness(ctx, owner);
      await expect(ctx.prisma.auditLog.updateMany({ data: { action: 'tampered' } })).rejects.toThrow(/append only/);
      await expect(ctx.prisma.auditLog.deleteMany({})).rejects.toThrow(/append only/);
    });
  });
});
