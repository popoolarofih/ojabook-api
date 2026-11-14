# Accounting rules

Guide section 8.2 says the exact posting rules must be defined and tested before coding. This is that definition. Every row below is covered by an integration test in `test/sales.int-spec.ts` or `test/business.int-spec.ts`.

All amounts are integer kobo. Every entry balances (debits equal credits), and the database rejects an entry that does not. Entries are never edited. A correction is a mirror entry (`reversesEntryId`) with a reason.

## Chart of accounts (created for every business)

| Code | Key | Name | Type |
|---|---|---|---|
| 1000 | `CASH` | Cash on hand | Asset |
| 1010 | `BANK` | Bank | Asset |
| 1020 | `PENDING_TRANSFERS` | Transfers awaiting verification | Asset |
| 1100 | `RECEIVABLES` | Accounts receivable | Asset |
| 1200 | `INVENTORY` | Inventory | Asset |
| 3000 | `OPENING_EQUITY` | Opening balance equity | Equity |
| 4000 | `SALES_REVENUE` | Sales revenue | Revenue |
| 5000 | `COGS` | Cost of goods sold | Cost of sales |
| 6000 to 6890 | (per category) | One account per expense category | Expense |
| 6900 | `STOCK_ADJUSTMENTS` | Stock adjustments and damaged goods | Expense |

## Postings

| Event | Debit | Credit | Notes |
|---|---|---|---|
| Opening stock on a new product | Inventory (qty x cost) | Opening balance equity | Source `OPENING_STOCK` |
| Stock receipt (a purchase) | Inventory (sum of line totals) | Cash, or Bank for a transfer | Not an expense. Blends weighted average cost. |
| Sale | Cash (cash part), Transfers awaiting verification (transfer part), Receivables (credit part) | Sales revenue (total) | Revenue is net of line discounts. Source `SALE`. |
| Sale cost of goods | COGS (sum of line costs) | Inventory | Cost is the average at the moment of sale, snapshotted per line. Source `SALE_COGS`. |
| Customer repayment in cash | Cash | Receivables | Source `REPAYMENT`. Allocated oldest debt first under row locks. |
| Customer repayment by transfer | *nothing posted* | | Payment stays `PENDING`. It does not reduce the debt until verified. |
| Operating expense | The category's expense account | Cash, or Bank for a transfer | Source `EXPENSE`. |
| Stock written off (damaged, expired, lost, count down) | Stock adjustments | Inventory | Value is quantity x current average cost. The average does not change. |
| Stock found or counted up | Inventory | Stock adjustments | At current average cost. |
| Sale reversal | Mirror of the sale and COGS entries | | Stock returns at the cost snapshotted on each line. Blocked if the sale has repayments. |
| Expense reversal | Mirror of the expense entry | | |

## Rounding

Round half up to the nearest kobo, in one place (`src/common/money.ts`). Quantities are never rounded: more than four decimals, or a unit conversion that does not land on four decimals, is rejected. Average cost keeps four decimals of kobo per base unit. Inventory valuation (`quantity x average`) can therefore differ from the ledger Inventory balance by less than one kobo per transaction. That is expected and is why the ledger is the source for profit.

## Costing

Weighted average per product, per business.

- Receipt: `newAvg = (onHandQty x onHandAvg + receivedQty x receivedCost) / (onHandQty + receivedQty)`.
- Sale: consumes at the current average. The average is unchanged. Cost is snapshotted on the sale item.
- Sale reversal: returns stock at the snapshotted cost (a receipt at that cost).
- Write offs and adjustments: do not change the average.
- Negative stock is not allowed.

## Reporting definitions

| Figure | Definition |
|---|---|
| Revenue | Credits minus debits on Sales revenue, by entry date. A reversal counts in the period it is made. |
| Collected | Cash debits from sales and repayments, minus cash credited back on reversals. Unverified transfers are excluded. |
| Outstanding debt | Credit charged before the end of the period, minus repayments before it, excluding voided receivables. Rebuilt per date, so past dates are exact. |
| COGS | Debits minus credits on COGS. |
| Gross profit | Revenue minus COGS. |
| Net operating profit | Gross profit minus operating expenses minus stock write offs. An operational figure, not audited statutory profit. |
| Inventory value | On hand quantity x weighted average cost, now. |
| Low stock | Active products at or below their reorder level. |

Day boundaries follow the business timezone (default `Africa/Lagos`), never the server or browser timezone.

## Idempotency and offline

- `POST` routes that move money or stock require an `Idempotency-Key` (8 to 128 chars). Scope is business, user and operation.
- The idempotency row is inserted in the same transaction as the work. A concurrent duplicate waits on the unique index, then replays the stored response. A failed first attempt leaves no row.
- Offline operations use their id as the key. `/sync/operations` stores every operation. A stock shortfall becomes a `CONFLICT` with the original payload kept. `/sync/operations/:id/resolve` takes `EDIT_AND_POST` (a corrected body) or `DISMISS` (a reason, audited).
- Records are kept for 60 days, longer than the 30 day limit on how old an offline timestamp may be.
