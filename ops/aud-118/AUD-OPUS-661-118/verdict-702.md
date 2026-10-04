AUDIT Claude Opus 5.5 — growth-project-backend#702 @ 20d2eb4f696f5e9b4966000f88bd1cdf76ba4ddb — VERDICT: APPROVE

A/B/C = 0/0/1

Lens: AUD-OPUS-661-118 (operator agent 118). Tier T4: tests-only, but it is the regression proof for #661's money and entitlement fix, and the two PRs land as one (rule 11). This lens did not read the other lens's verdict at this head before posting. The companion #661 verdict is at `f80f0088`.

### Scope
- **Diff against the base** `agent/clinic/b-secrets-3` @ `f80f0088`: 2 files, +509/-4. There is no source, schema, workflow or dependency change, and no banned cast token.
- **`test/checkout-settlement.live.spec.ts` (+231/-4):** the round-7 block `B-661-3 round 7: the owner query is complete at any number of adopted purchases`, run with 9, 10 and 12 adoptions. The pool goes from 8 to 16 connections. Every line was read:
  - Each adopted row is a real `CheckoutService.createPaymentIntentForClient` reservation, with the provider reply held.
  - A real `payment_intent.payment_failed` metadata-fallback delivery adopts each one, in its own held transaction.
  - The owner then goes through a real completion, a real failure and a real success.
  - `legalOrder` answers only unordered reads, in a legal adversarial order: `findMany` newest first, `findFirst` oldest first.
  - The boundary is asserted, not assumed. There are `count + 1` failed rows and one activation record, and an unfiltered ten-row read misses the owner from ten rows on.
  - The outcome is asserted in full: `payment_recovered` with no split descriptor, the owner paid / entitled / drop pending, the adopted rows unchanged, one PurchaseFanout row, every native reply ending on its own PI, and a redelivery that is `no_matching_purchase`.
  - The `finally` releases every held reply and transaction, so a failure cannot leak connections into the next spec.
- **`test/checkout-hosted-activation-once.spec.ts` (+278):** moved from #661.
  - It is byte-identical to the copy #661 carried at `c7649169`: SHA-256 `fc2e00c2…`, verified from both git objects.
  - It equals the file this lens approved at `957e3677`, plus one double line (`findMany`) from round 6.
  - It is added after the merge, so a later restack cannot drop it.
- **Merges:** `5c25122d` and `b261dd1f` are automatic. `b261dd1f`'s tree `28cbca22` equals `git merge-tree 5c25122d f80f0088`. The integrated tree is `4339454c`, both at `5c25122d` and at this head, which is the tree audited for #661.
- **Piece boundary:** tests only. Every import exists in #661, and tsc is green on this tree with this lens's probe added (lane run below). Nothing imports a later piece.

### Evidence
- **Failing-before** [run 37186266591](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37186266591), these tests against #661 `c7ee15f0`: 2 failed / 31 passed. Only the 10 and 12 cases fail, with `{ claimed: false, reason: 'checkout_session_activates' }`; the 9 case is the control.
- **After** [run 37186426457](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37186426457): 190/190.
- **This lens's lane on this exact tree** ([run 37218675555](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218675555), real PostgreSQL 16.15, tsc green): 5 suites / 53 tests pass. They are:
  - this spec;
  - the moved spec;
  - `checkout-settlement-round5`;
  - the dead Sol lens AUD-SOL-661R6-117 probe (`661-native-verified`), unchanged;
  - this lens's probe `test/aud-opus-661-118.live.spec.ts`. Its O1 puts an owner behind 30 never-activated rows and 5 activated non-owners. It fails at the `c7ee15f0` control ([run 37218911726](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218911726)), so the boundary these tests pin is also caught well past 12 rows and against terminal and recurring activated rows.
- **Checks at this head:** every check that ran is green ([CI run 37218019543](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218019543)).
  - build-and-test: 729 suites passed, `checkout-hosted-activation-once` PASS.
  - mwb-3-live-tests: 8 suites / 74 tests, including the 9/10/12 cases, none skipped.
  - Also green: rls-live, community-live, rls-floor-guard, Schema parity and npm audit.
  - Branch protection requires no checks on this base. CodeQL, danger, banned casts and build-sbom run on #661 once this lands in its branch.
- **Size:** 513 changed lines.

### C findings
- **C-702-1 (docs):** the PR body is stale after FIX ROUND 1.
  - It says "One file, `test/checkout-settlement.live.spec.ts` (+231 / -4)" and "Size: 235 changed lines". It does not mention the moved `test/checkout-hosted-activation-once.spec.ts` (B-661-5 / C-661-7 hosted activation-once cases).
  - Rule: add the moved spec and its provenance (SHA-256, from #661 `c7649169`) to the acceptance evidence, and set the size to 513.

### Landing note
Merge this PR into `agent/clinic/b-secrets-3` before #661 lands on main; otherwise the hosted activation-once cases never reach main. A landed #661 head whose tree is `4339454c` is what this lens audited.

APPROVE: no A or B findings at this head. The tests prove the round-7 fix, with a failing-before at `c7ee15f0`. The moved spec is byte-identical, and the integrated tree is unchanged from `5c25122d`.
