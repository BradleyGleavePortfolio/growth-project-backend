FIX ROUND 11 (B-F12-116, agent 116) — growth-project-backend#681 @ 9de3135c2f128289ab302dff43a04e12f32b74d1

Round 11 on F1 against GPT-6.1 Sol [RC 0/2/0](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/681#issuecomment-5975862374) and Claude Opus 5.5 [APPROVE 0/0/4](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/681#issuecomment-5975947638), both at `5a19178d`. Two commits on top of `5a19178d`, fast-forward (no force): `b2bb3100` tests only (the failing-before head), then `9de3135c` the fix.

| Finding | Change | Commit | Test (fails before, passes after) |
|---|---|---|---|
| Sol B-681-1 = Opus C-681-4: lock-release failure logged `Error.message` | New `src/connect/fees/money-diagnostics.ts`: `dbErrorKind` (Prisma class -> `db_request` / `db_unavailable` / `db_validation` / `unknown`) and `moneyErrorDiagnostic` (adds Stripe `http=<int 100-599 or other> type=<allow-listed or other/none> code=<allow-listed or other/none>`; `AbortError`/`TimeoutError` -> `timeout`). Message, name and code never reach output. `charge-lock.ts` release now logs `SFEE_CHARGE_LOCK_RELEASE_FAILED lock=<name> error_kind=<kind>: ...`. The module imports no charge-lock code (no cycle). F2 reuses it. | `9de3135c` | `test/s-fee-r11-ledger-identity-diagnostics.spec.ts` "B-681-1": canary message/name/code, Prisma known-request error carrying input, Prisma validation error. The work still completes. |
| Sol B-681-2 = Opus C-681-3: legacy ledger rows had no atomic identity (NULL `stripe_charge_id` in the 4-column unique) | `split-ledger.service.ts` `upsertEntry`: the lookup by `(purchase_id, kind, payee_user_id)` stays the same. A missing row is created with a durable identity in the existing unique `idempotency_key` column: `sfee-legacy-ledger:<purchase>:<kind>:<payee Stripe account or platform>` (ids only, no user id). A concurrent loser gets P2002, re-reads by key and adopts the winner's row under the same update rule (amount and account for payees; the platform row is never rewritten). Any other error propagates. There is no migration: the column and its unique index already exist. `schema.prisma` comment updated. | `9de3135c` | "two concurrent planners for one legacy purchase write one row per slice and return the same rows" fails before (2 rows per kind) and passes after. Controls pass on both: attach `ch_1`, then a replay and a concurrent renewal with a new amount (one set, charge kept, amount updated); per-charge S-FEE rows of two renewals stay distinct with no legacy key; a non-P2002 INSERT error propagates. The fake enforces both unique indexes with Postgres NULL semantics. |
| B-682-1, F1 half (both lenses on #682) | `stripe-connect-api.service.ts` `reverseTransfer` takes `beforeSend?: () => void` and passes it to `post` (same contract as `createTransfer`: runs synchronously right before fetch; a throw sends nothing). | `9de3135c` | "B-682-1 (F1 half)": a throwing hook sends no request and surfaces its error; a passing hook runs before fetch. |
| Opus C-681-5: `undoReversal` dead and not idempotent | Deleted (no caller anywhere in the F6 tree). | `9de3135c` | No behavioural test (deletion). tsc is green at F1 (lane run below), F2 (lane) and the composed F6 tree. |
| Opus C-681-6: migration `20270210000000` timestamp | Not renamed, per operator ruling OR-113-4. No dependency-order defect: the migration references only `ClientPurchase`, `ConnectTransfer` and `SplitLedgerEntry` (all created earlier) plus tables it creates itself. Of the later migrations (`20270211`..`20270301`), only `20270216000000_package_first_published_at` reads one of those tables (`ClientPurchase`, pre-existing), and none touches an S-FEE object. | none | n/a |

CI lane:
- Failing-before, at `b2bb3100` (tests on the old code): [run 37172716648](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172716648/job/111348816612), 6 failed and 3 controls passed.
- Passing-after, at `9de3135c` with `tsc --noEmit`: [run 37172742665](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172742665/job/111348891780), 15/15 including main's `test/split-ledger.service.spec.ts`.

Pre-push checklist:
- No free text reaches logs: closed codes and ids only.
- No new await-then-write without a re-check: the P2002 path re-reads before it writes.
- Copy: no user-facing copy in F1.
- Size: 2,882 changed lines (+2,217/-665), under 3,000.

Restack: F2 #682 merged this head (merge commit `479873f4`), and F3..F6 were restacked merge-only under the fees stack lock.

Checks at `9de3135c`:
- All 17 contexts that run pass, including build-and-test, schema parity, forward and reversible migrations, CodeQL, danger, banned casts, SBOM, the rls/community/mwb-3 live tests, npm audit, deploy-readiness and size-label. deploy-readiness-gate is skipped.
- build-and-test passed on attempt 2: [job 111353805376](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173385908/job/111353805376). Attempt 1 hit the known jest heap OOM in `scout-reconstruct.flag.spec.ts` with 0 test failures; it was rerun once.
- The PR is BEHIND main; the operator runs update-branch.

READY FOR AUDIT
