AUDIT Claude Opus 5.5 — growth-project-backend#681 @ 9de3135c2f128289ab302dff43a04e12f32b74d1 — VERDICT: APPROVE
A/B/C = 0/0/1

Job AUD-OPUS-F12-117 (agent 117 wave). Tier T4: money ledger, Stripe Connect, a migration. F1 is a slice of a stack that lands as one. This verdict approves F1 only as part of that stack, per the operator landing contract ([5975772674](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/681#issuecomment-5975772674)). F1 must not reach main before F2-F6 are folded in and the composed tree is checked again.

Scope: FIX ROUND 11 (`5a19178d..9de3135c`: 2 commits, 6 files, +408/-47), read line by line. Everything else rests on this lens's APPROVE at `5a19178d` ([5975947638](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/681#issuecomment-5975947638)) and that verdict's G09 basis.
- A 116-wave Opus draft existed for this head, with probes written but never run. I used it only as a pointer.
- I ran its probes, added my own, and re-derived every conclusion below.
- Sol's verdict at this head was posted while my probes were running. My disposition of its open finding is in section 4.

## 1. Prior Opus findings (at `5a19178d`)

| ID | Status | Evidence |
|---|---|---|
| **C-681-3** (= Sol B-681-2): legacy ledger rows had no DB uniqueness | **Closed for the same-account race** | Section 2. Probe L1/L3 passes, and so does live Postgres DB-L1 (30 purchases x 4 planners on 2 pools: one row per slice). The control DB-L0 runs the old algorithm on the same database and duplicates 30 of 30 purchases. A narrower residual remains: see C-681-7. |
| **C-681-4** (= Sol B-681-1): the lock-release log carried `Error.message` | **Closed** | `charge-lock.ts:234` now logs `SFEE_CHARGE_LOCK_RELEASE_FAILED lock=<name> error_kind=<dbErrorKind>`. Probe D1 checks 5 error shapes: init, panic, unknown request, a thrown string, and an object with a code. Each logs the closed kind with no canary text, and the work still returns its value. |
| **C-681-5**: `undoReversal` was dead and not idempotent | **Closed** | Deleted. `git grep undoReversal` over the F6 tree `6f1b94a9` finds nothing in `src` or `test`. |
| **C-681-6**: migration timestamp `20270210000000` | **Closed as ruled** | OR-113-4 keeps assigned prefixes, and `migrate deploy` applies pending ones out of order. On main `a5b605d1`, none of the later migrations (`20270211`..`20270301`, both `20270301` directories) mention any S-FEE table. |

## 2. Round-11 delta, line by line

- **`money-diagnostics.ts` (new, 86 lines).**
  - `dbErrorKind` maps the Prisma error classes to `db_request`, `db_unavailable` or `db_validation`. Anything else is `unknown`.
  - `moneyErrorDiagnostic` builds `kind=stripe http=<100-599|other> type=<allow-list|other|none> code=<allow-list|other|none>`. An `AbortError` or `TimeoutError` instance maps to `timeout`.
  - Message, name and code never reach the output. Probe D2 covers 9 shapes, including NaN, 99, 600 and 402.5 status values, canary type and code strings, and a plain object named `AbortError`. Every output matches the closed grammar.
  - The module imports only `@prisma/client` and `StripeConnectApiError`, so there is no cycle with charge-lock.
- **`split-ledger.service.ts:332-383`.**
  - The lookup on `(purchase_id, kind, payee_user_id)` is unchanged. A missing row is created with `idempotency_key = sfee-legacy-ledger:<purchase>:<kind>:<account|platform>` (`:61-64`).
  - On P2002, the loser re-reads by key (`:362-367`) and adopts the winner under the old update rule. The platform row is never rewritten (probe X2). A P2002 with no keyed winner is rethrown (probe X1), and any other error propagates (builder spec).
  - The P2002 cannot abort a transaction: `ensurePendingEntries` uses the service's own client, and its only caller (`purchase-split-handler.service.ts`, legacy branch only) opens no transaction around it.
  - `SplitLedgerEntry.idempotency_key` has exactly one writer in the whole F6 tree: this path. `tgp-settle-*` keys belong to `ConnectTransfer`. The column already has a unique index, so no migration is needed. The key holds no user id, and the deletion manifest keeps the row for FINANCE.
  - Live DB-L2 on real Postgres shows the unique index raising the exact error the code relies on: the 4-column unique lets NULL-charge duplicates through, and the key stops them with P2002.
- **`stripe-connect-api.service.ts:790-811`.**
  - `reverseTransfer({ beforeSend })` passes the hook to `post()`.
  - `post()` (`:1072`) runs the hook synchronously right before `fetch`, with no await in between. The call sits outside the try block, so a refusal comes back unchanged and nothing is sent (builder spec "B-682-1 (F1 half)").
- **`schema.prisma`**: a comment change only, and schema parity is green.

## 3. Executed evidence (CI lane: exact head plus probe specs only)

- [Run 37177782132](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37177782132/job/111363926028) on `3c2cf1b9` (`9de3135c` plus 2 probe files): 4 suites, 36/36 pass.
  - The 116 probe: L1-L5, D1 x5, D2 x9.
  - This lens's extra spec: X1 (a P2002 with no keyed winner is rethrown) and X2 (an adopting loser never rewrites the platform row).
  - `test/s-fee-r11-ledger-identity-diagnostics.spec.ts` and main's `test/split-ledger.service.spec.ts`.
- [Run 37178103246](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37178103246/job/111364872185): real Postgres 15 with the repo's full chain through `prisma migrate deploy`. It runs on the #682 head, where every F1 file is byte-identical to `9de3135c`. DB-L0, DB-L1 and DB-L2 pass (details above).
- Builder evidence is bound correctly.
  - Failing-before [37172716648](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172716648) ran on `cd204382`, which is `b2bb3100` plus the lane files.
  - Passing-after with tsc [37172742665](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172742665) ran on `40d08a33`, which is `9de3135c` plus the lane files.

## 4. Finding

**C-681-7: the legacy key names the payee's account, while the lookup names the payee user.** GPT-6.1 Sol holds this open as B-681-2 at this head. The 116 Opus draft found it independently before Sol posted, and probe L4 documents it here. This lens rates it C.

- **Where:** `split-ledger.service.ts:61-64` (the key) against `:336-345` (the lookup).
- **Counterexample:** two concurrent first-time planners for one legacy purchase. One reads the seller's old account, the other reads a reconnected one. Both miss the lookup, and their keys differ, so no P2002 fires. Result: two `destination` rows. Probe L4 prints `destination rows=2`.
- **Why C:**
  - The path runs only when `settleCharge` returns `legacy_destination`, which needs a charge carrying `transfer_data`.
  - No F1 code path mints such a charge any more. Checkout, guest checkout and storefront are separate charges, and `transfer_data` remains only in comments and type fields.
  - The operator recorded 0 Connect accounts in production (10-03 19:15 PDT), so no legacy charge exists to renew.
  - The race needs a reconnect write to land between two concurrent first-time reads.
  - Legacy destination slices are paid by Stripe through `transfer_data`. The head-coach transfer is keyed per purchase (`tgp-tr-<purchase>-headcoach`), and `entries.find` picks one row. So a duplicate is a bookkeeping row and cannot pay twice.
  - This is the same rule this lens applied to C-681-3. If a legacy destination charge exists at deploy time, treat this as B.
- **Fix rule (cheap):** key the legacy identity on the lookup's own tuple, `sfee-legacy-ledger:<purchase>:<kind>`. A legacy purchase has one payee per kind, so this is enough; alternatively add `payee_user_id`, which the row already stores. Keep the account refresh in `refreshLegacyEntry`. Sol's B forces a round anyway, so the recommended default is to fix it in that round.
- **Verify:** probe L4, or a live-DB variant of DB-L1 with two account snapshots, writes exactly one destination row.

Not raised again: C-627-10, the operator's follow-up after merge.

## 5. Piece boundary, checks, size

- **Boundary.** F1 compiles alone (tsc lane above) and imports no later piece. It changes no migration in this round. Its new code is covered by its own spec and by this lens's probes.
- **Checks.** All 17 contexts that run at this head pass, including the 11 required ones; deploy-readiness-gate is skipped. build-and-test is [run 37173385908, attempt 2, job 111353805376](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173385908/job/111353805376), rerun once after the known jest OOM. CodeQL, danger, banned casts, SBOM, schema parity, forward migrations and reversible migrations are all green.
- **Size.** 2,882 changed lines (+2,217/-665), under 3,000.
- **Main.** The PR is BEHIND main `a5b605d1`. The 14 files main changed since `d23fa317` include none of #681's files, so an update-branch qualifies for the rule-12 MERGE-ONLY TREE CHECK.

No local heavy run, no push to the PR branch, no merge. The head was re-read right before posting.
