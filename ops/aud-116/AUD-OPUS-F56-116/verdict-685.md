AUDIT Claude Opus 5.5 — growth-project-backend#685 @ 858d37165662ad83af7c380f5f57700fd3d47afa — VERDICT: APPROVE
A/B/C = 0/0/3

Tier T4 (money). Piece F5 of #627: tests only, 4 files, +2958/-0, 67 tests (`s-fee-charge-concurrency` 13, `s-fee-r4-money-protocol` 21, `s-fee-r5-or-111-1` 22, `s-fee-r9-paused-sender` 11). No `.skip`, `.only`, `.todo` or env-gated tests.

### Evidence reuse (G09)
- Three files are byte-identical to the files at #627 @ `3a5338d7`, which this lens approved in comment 5972040127: `s-fee-charge-concurrency` (blob b2b403ff), `s-fee-r4-money-protocol` (29f5dc30) and `s-fee-r5-or-111-1` (a31ffc66). That evidence applies because the bytes match. I still re-read all three in full for this verdict.
- `s-fee-r9-paused-sender` changed since that approval (bc2bd0f1 -> e9a45cc4, round 10 commit 6c7706e1). The changes are the `Prisma` import and the B-627-10 describe at lines 452-525. I audited them line by line. The fence passes first and then fails. The park read-back throws a canary error, or a P9999 `PrismaClientKnownRequestError`. The test asserts that the lock loss is rethrown, nothing is sent, no canary or P9999 text is logged, and the closed codes `park_error=unknown` / `db_request` are logged. The test is valid for the path it covers. C-685-2 has the sibling path it does not cover.
- Nothing from the other lens was used.

### Piece boundary
The piece is tests only. It imports only `src/` modules from F1-F4 and `test/utils/settlement-fakes.ts` from F2. It imports nothing from F6 and has no migrations. It compiles and passes alone: build-and-test at this head is green ([run 37153348511](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37153348511), 720 suites, 12421 tests), and each of the 4 files shows PASS in the log.

### Do the tests assert the money invariants they claim?
Yes. Only Prisma (in-memory tables) and Stripe (`FakeStripe`) are faked. These services are real: ChargeSettlementService, TransferOrchestratorService, SplitLedgerService, FeePolicyService, ChargeLock and RefundDisputeHandlerService. The expected values are hand-computed cents, not recomputed through production code:
- $49 sale: fee 172, TGP 98, coach 4630
- $100 sale: fee 320, TGP 200, coach 9480
- OR-111-1 holds: 520, 2020 and 10000; netting 4630 then 4110; won dispute 7980
- Stripe-side net per account via `netTo`, idempotency keys `tgp-tr-rev-<id>-opN`, and lock fencing outcomes

Mutation probe ([run 37171892935](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171892935), branch `audit/AUD-OPUS-F56-116/686-canary-mutants`, red by design). It re-runs this PR's own spec files, unchanged, in fresh module registries. Each block replaces one production behaviour through a prototype spy.
- CONTROL: all 112 tests green (the four F5 files plus the three F6 files).
- TGP fee 2% -> 1.9%: 41 of 74 tests fail. In this PR that is r4 17/21 and r5 7/22.
- Fence always passes: r4's three fence tests fail. charge-concurrency, r8 and r9 stay green, because the transfer CAS, the durable reversal op and the claim re-proof still hold. That is defense in depth, not a gap.
- No 30 s send-start budget: r9's three start-budget tests fail.
- No OR-111-1 forward netting: 7 of 43 fail (r4 2, r5 5).
None of the tests is a tautology, and none mocks away the boundary it claims to test.

The fake's `$transaction` has no rollback (C-685-3). Every failure injection in this piece is at the first write of a transaction or outside a transaction, so the results would be the same under rollback. The CAS `updateMany` in the fake is atomic, which matches a single-statement Postgres compare-and-set.

### Findings
**C-685-1 (outside this diff; copy in #682 and #684): first-person coach notice copy is pinned here.**
- Where: `src/connect/fees/payout-notice-copy.ts:67,79,93,101` ("We will hold", "We took", "We paid", "We released") and `src/email/templates/coach-payout-adjustment.hbs:20` ("We take it out of your next payout"). This PR pins the strings at `test/s-fee-r5-or-111-1.spec.ts:304,310,401,460,530,543,927,937,962,965`.
- Counterexample: the exact body asserted at r5:304 is "A client got $100.00 back. We took $94.80 back from that sale's payout. We will hold $5.20 from your next sale."
- Rule broken: owner copy rule, no first person in product copy.
- Fix rule: rewrite the copy without first person, for example "$94.80 was taken back from that sale's payout. $5.20 will be held from your next sale." Change the template the same way, and update these expectations in the same change.
- Verify: `rg -n "\bWe\b" src/connect/fees/payout-notice-copy.ts src/email/templates/coach-payout-adjustment.hbs` returns nothing, and r5 stays green with the exact cents unchanged.

**C-685-2 (outside this diff; source in #682): the B-627-10 tests cover only one of the two ways a park can fail after the lock is lost.**
- Where: `src/connect/fees/transfer-orchestrator.service.ts:896`. The `scheduleRecheck` catch logs `${(err as Error)?.message}`.
- How it is reached: `reproveSendClaim` -> `abandonSend` -> `scheduleRecheck`. When the park's CAS `updateMany` throws, rather than returning count 0, this catch swallows the error. The closed-code line at :650 is never reached.
- Probe: run 37171892935, test "C-685-2 canary ... acceptance". The lock loss is still rethrown and nothing is sent, but the real logger emitted `could not schedule the transfer re-check transfer=tr-25: AUDIT_CANARY_name_contact_at_example_invalid message`.
- Impact: low. On this path the message is DB-driver text, and the row values involved are ids, cents and internal codes. It is the same class as B-627-10.
- Fix rule: log the closed code `parkFailureKind(err)` in that catch, never the message, name or code. Add an r9 case where the park's `updateMany` throws a canary name, message and code.
- Verify: the probe's acceptance test turns green, and the existing two B-627-10 tests stay green.

**C-685-3 (outside this diff; test utility in #682): `makeSettlementPrisma().$transaction(fn)` runs `fn(prisma)` with no rollback.**
- Where: `test/utils/settlement-fakes.ts`.
- Counterexample: a future test that injects a failure after the first write inside a transaction would see a partial commit that Postgres would roll back. r7's C-627-8 test already installs its own rollback for this reason.
- Fix rule: snapshot the tables on entry to `$transaction` and restore them on throw.
- Verify: r7's local override becomes redundant, and all seven fee suites stay green.

CI at this head: 10 checks pass and 1 is skipping. Per the stack notes, CodeQL, danger, banned-casts and build-sbom run only when the stack lands on main.
