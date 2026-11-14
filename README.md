# ojabook-api

NestJS API for OjaBook. Versioned under `/api/v1`. Swagger UI at `/api/v1/docs`, contract at `/api/v1/openapi.json` and committed as [`openapi.json`](openapi.json).

## Structure

```
src/
  auth/         OTP, sessions, JWT guard, tenant and permission guards, CSRF guard for cookie routes
  businesses/   Business, members, invitations, ownership transfer, audit trail
  catalogue/    Categories, products, unit conversions
  inventory/    Stock engine (row locks, weighted average, append only movements), receipts, adjustments
  sales/        Sale creation (atomic with stock and ledger), reversal
  customers/    Customers, receivables, repayments, statements
  expenses/     Expense categories and expenses
  reports/      Server side aggregation from the ledger
  sync/         Offline operation intake, conflicts, resolution
  ledger/       Chart of accounts and double entry posting
  idempotency/  Safe retries
  audit/        Append only audit trail
  jobs/         BullMQ retention job
  common/       Money, decimals, costing, units, dates, permissions, errors
prisma/         Schema and migrations (with the integrity triggers and constraints)
test/           Integration tests against PostgreSQL
docs/           Accounting rules
```

## Develop

```bash
cp .env.example .env     # set JWT_ACCESS_SECRET and OTP_PEPPER
npm ci
npx prisma migrate deploy
npm run start:dev
```

| Command | Purpose |
|---|---|
| `npm test` | Unit tests |
| `npm run test:integration` | Integration tests. Needs PostgreSQL and a database whose name contains `test` (`TEST_DATABASE_URL`). Migrations are applied automatically. |
| `npm run lint`, `format:check`, `typecheck` | Static checks |
| `npm run openapi:export` | Rebuilds `openapi.json`. CI fails if it is stale. |
| `npm run build` | Compile to `dist` |

## Conventions

- **Permissions, not roles**, are checked in code. Roles only supply defaults (`src/common/permissions.ts`).
- Business scoping comes from `X-Business-Id`, verified against membership on every request.
- Errors always look like `{ "error": { "code", "message", "details?", "requestId" } }`.
- Money in JSON is an integer number of kobo. Quantities are decimal strings.
- Never run `prisma migrate reset` outside a throwaway database. Integration tests refuse to run unless the database name contains `test`.

## Security notes

Access tokens last 15 minutes. Refresh tokens are opaque, hashed at rest, single use and rotated, and replaying a used one revokes the whole session family. The refresh cookie is `HttpOnly`, `SameSite=Strict`, scoped to `/api/v1/auth` and `Secure` in production, with an Origin allow list and a custom header as CSRF defence. OTP codes are HMAC hashed with a pepper. Unknown request properties are rejected (mass assignment). Authorization headers, cookies and codes are redacted from logs.
