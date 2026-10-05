AUDIT Claude Opus 5.5 — growth-project-backend#686 @ 8cb7b2d4bee3bccb65596581f84bccf9227ffc4b — VERDICT: APPROVE
A/B/C = 0/0/4

AUD-OPUS-F56-119 (agent 119). Tier T4 (money). This is the top of the fees stack, so its tree is what lands under rule 11. Delta audit since this lens's APPROVE at 7be7d396dcaab5f62c941a78e6e071ce3518ad28 (comment 5975903521), plus a review of the integrated tree.

**Own diff.** Base #685 `c5e282fb` to head `8cb7b2d4`: 3 test files, +1355/-0, byte-identical to 7be7d396 (`git diff 7be7d396 8cb7b2d4 -- <3 files>` is empty). The only F5 file change since 7be7d396 is the r5 +10/-10 expectation swap (see the #685 verdict). The title is now accurate, which closes C-686-1.

**Merges.** The head has 11 first-parent merges since 7be7d396 (b5bbe806 .. 8cb7b2d4). For each one, the tree equals `git merge-tree --write-tree <p1> <p2>`: no conflict hunks and no edits. Merges into the lower pieces were checked the same way on #685.

**Checks at this head.** All 10 checks pass and deploy-readiness-gate is skipping (build-and-test runs 37225036263 and 37225036205). R75 `check-r75 --mode=range` for b644198b..8cb7b2d4 is OK (as any net -14; as unknown as, as never and empty-catch-undefined net 0). It is also OK from main 3e9a9a75, and for own c5e282fb..8cb7b2d4.

**Migrations.** The stack has one migration, `20270210000000_s_fee_charge_settlement` (#681). It is not on main, so it is unreleased. It adds tables, columns and forced RLS, and it replaces one SplitLedgerEntry unique index (approved on #681). Its timestamp is older than prod latest 20270301000000, kept under OR-113-4, and it depends on no later migration.

**Money list on the composed tree**
- Every fee suite passes at this head (PR CI).
- The fees-top probe https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37225776608 ran 13 suites and 427 tests at 8cb7b2d4 plus probe files only. The 12 non-mutant probe suites from both lenses pass (webhook redelivery, reversal/listing fail-closed on incomplete Stripe lists, the settlement boundaries, notice recovery, the R75 probe). The 54 failures are all expected MUTANT kills from this lens's F56-116 probe, which is byte-identical: fee 41, fence 3, send budget 3, netting 7. CONTROL and the C-685-2 canary are green.
- The fixed-point work (lock order, CAS fences, terminal refund/dispute states, presentment vs settlement) rests on the piece audits. Findings at #683 cc183e0a, #684 6b13af56 and #697 88c72200 belong to those PRs (guide rule 9).

**Landing check: fees top merged with current main.** `8cb7b2d4` + `3e9a9a75` merges cleanly (email.service.ts, email.types.ts and notifications.service.ts auto-merge, and the hunks compose). This scratch commit was never pushed to a PR.
- https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37228918958: tsc PASS; 34 suites (the 31 fee/stack specs + privacy + email), 596 pass, 1 FAIL.
- https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37229205868: every main-changed spec plus test/account-deletion, test/data-export*, test/privacy, test/ci and email/notifications. 58 suites pass; the same 1 FAIL.

**Findings (all C, all outside this diff)**
- **C-686-2** (open, was C-685-3): the fake `$transaction` in `test/utils/settlement-fakes.ts` (#682) has no rollback. Fix rule: snapshot on entry and restore on throw. Also fix `cmp` so that null never satisfies `lte` (B-FEES16-118 note).
- **C-686-3** (landing blocker for the stack, owned by #682/#683/#684): `test/privacy/no-pii-in-logs.spec.ts` (main #700) fails on the merged tree. Guard probe runs https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37229175115 and https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37229442817 (a copy of the guard that prints both deltas and every site; red by design) show:
  - (a) strict rule `email`: `src/checkout/payout-notice.service.ts:259` interpolates `email=${email.status}` (#684). It is a channel status, not an address.
  - (b) exact exception-text baseline (`exceptionText` vs `LEGACY_EXCEPTION_TEXT`):
    - `src/connect/fees/transfer-orchestrator.service.ts` 1 -> 4 (#682 :874, :1146, :1228, :1340, each `${message}`)
    - `src/connect/fees/charge-settlement.service.ts` 0 -> 1 (#683 :2132 markAwaiting `${message}`)
    - `src/checkout/refund-dispute-handler.service.ts` 5 -> 4
    - `src/checkout/purchase-split-handler.service.ts` 2 -> 0
  - The new values are closed diagnostics (moneyErrorDiagnostic, settlementFailureCode, or fixed text), so no PII leaks. The guard is lexical and exact, though, and build-and-test is required.
  - Fix rule: rename the interpolated identifiers to non-matching names (`emailStatus`; `diagnostic` instead of `message`), then lower the two baseline entries (refund-dispute-handler 4; delete purchase-split-handler). Verify by running test/privacy/no-pii-in-logs.spec.ts on the stack merged with main.
- **C-686-4** (#682, `src/connect/fees/payout-notice-copy.ts:35-63`): `formatMoney` treats `ugx` as zero-decimal. [Stripe's currency docs](https://docs.stripe.com/currencies) say UGX amounts are still sent as two-decimal values (5 UGX = `500`), so a UGX notice would overstate the amount 100x. The money math is unaffected; the bug is in the displayed copy. Fix rule: drop `ugx` from the set and test 500 -> "5.00 UGX". Re-check the set against Stripe's list in the same change.
- **C-686-5** (cross-stack copy, R-DISPUTE-PAUSE, owner 12:01 PDT 10-04): the coach `chargeback` notice (`payout-notice-copy.ts:99-101`, #682) says only what was taken back and held. On a recurring plan, R-DISPUTE-PAUSE copy must say that access has ended, billing is paused and the coach decides on restarting. Adding that sentence in the fees stack before the pause exists would be a claim before proof. Fix rule: the piece that builds R-DISPUTE-PAUSE (dunning #688) adds the recurring-plan sentence to this notice and pins it in r5.

**Evidence reuse (G09):** F6's 3 files rest on this lens's 7be7d396 APPROVE, byte-identical as shown above. The r5 delta was audited in full. The integrated tree was judged from the composed-tree CI and probes above, and the other lens's verdicts were not copied.
