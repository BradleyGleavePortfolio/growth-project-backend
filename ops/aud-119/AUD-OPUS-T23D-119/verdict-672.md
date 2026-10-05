AUDIT Claude Opus 5.5 — growth-project-backend#672 @ 62c2c066a9347dcf16ad45d010f5434e85ae1a60 — VERDICT: APPROVE
A/B/C = 0/0/6

Reviewer: AUD-OPUS-T23D-119, agent 119. This is a T4 delta audit of FIX ROUND 10 ([5984032484](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672#issuecomment-5984032484)).

**Evidence reuse (G09).** This lens approved `2690c07c` with 0/0/5 ([5983711171](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672#issuecomment-5983711171)).
- The delta `2690c07c..62c2c066` is one commit and one file, `src/packages/trials/trial-notice.service.ts` (+14/-7). It was read in full, along with every caller of `prepare()`, which are `deliver()` and `admit()`.
- Every other file is byte-identical to the approved head, so the earlier approval still covers them.
- The base is still T1 `c75002c9`.
- Size is 2,968 lines (+2,966/-2). That is under the grandfathered 3,000 ceiling, with 32 lines of headroom.

### Sol B-672-3 (narrowed): closed
- **The fix.** `prepare()` (:488-500) now reads the purchase and the customer card through `tx` inside one `$transaction(..., { isolationLevel: 'RepeatableRead' })`. The purchase is read first, and `customerHasDefaultCard(userId, tx)` (:1064) uses `tx`.
- **Why this closes the finding.** In Postgres, the snapshot is taken at the first statement. Both authorities therefore describe one instant: the admission point. A card removal that commits after that instant is a post-admission change, the same as a removal just after the send. No mixed state can be sent.
- **Unchanged guards.** The zone read stays outside the snapshot (it is not a money authority). Unknown-card deferral, the mute check, the end date, the lease room and the fenced give-back are unchanged.
- **Failure modes.** A card-read error inside the snapshot returns `null` and defers. That is safe even when Postgres has aborted the transaction, because the result is discarded. A rejected transaction before the claim spends nothing. The one remaining gap is C-672-12 below.
- **Probe evidence.** [CI run 37232961230](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37232961230) ran the new `test/audit-opus-t23d-119-672.spec.ts` on this exact head. Its `$transaction` fake models snapshot semantics (reads frozen at the first statement). All controls are green:
  - N1: a removal committed after the snapshot started gives the consistent charge copy.
  - N2: a removal committed before the admission snapshot gives "nothing will be charged".
  - N3 and N3b: a card-read failure before the claim, or at admission, sends nothing and spends no attempt (the attempt is given back).
  - N4: a transaction rejected before the claim sends nothing and spends no attempt.
- **Sol's customer-card probe.** This lens agrees with the operator default to narrow it. The received text is the correct no-card copy, and N2 and #706 assert it exactly.

### Replay on this head (same run)
- Opus T23-119 672 (R9-1..5): all pass.
- Opus T23-118 672: C-672-10 and C-672-11 are red, which are open Cs. The 4 controls pass.
- Opus T12-117: C-671-4, C-672-7 and the exact-copy line are red by design, as ruled. The other tests pass.
- Builder run [37231152495](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37231152495) agrees: 280 of 291 pass, and the 11 reds are the ruled list.

### C-672-12 (new, C): a rejected admission snapshot spends the attempt and keeps the lease
- **Where:** `trial-notice.service.ts:898-916` (`admit()`) together with :488. If `prepare()` throws at admission, the error propagates past `admit()`. This can happen when the RepeatableRead transaction cannot start or times out (P2028 under pool pressure on the Free plan).
- **Effect:** the `push_attempts` increment is not given back, and the lease stays held until it expires. The null path does give the attempt back.
- **Why it is a C:** five such transient failures would silently exhaust the channel. The same propagation already existed for a throwing `findUnique`; the snapshot only adds another way to throw.
- **Probe:** N5 (expected red) received `push_attempts: 1, push_lease_token: <uuid>`.
- **Fix rule:** catch inside `admit()` and complete with `{ <channel>_attempts: { increment: -1 }, last_error: '<channel>:prepare_failed' }`, then return null.
- **Verify:** N5 turns green.

### Carried Cs (unchanged, FREEZE)
- C-672-10: `trial-notice.service.ts:956-959, 1007-1010`. A hung push that really delivers is sent again.
- C-672-11: `trial-notice.service.ts:302-331`. The in-app row says "will be charged" for a purchase that already converted.
- C-672-3: mobile #338 adds the push route.
- C-672-5: `reconcilePage` records notices without the tax flag.
- C-672-6(b): the in-app row copy is frozen at record time.
- C-672-1 stays on the #680 integration round.

### CI and status
- At `62c2c066`, all 10 applicable checks pass. deploy-readiness-gate is skipped. Merge state is CLEAN, and the PR is still a draft.
- CodeQL, danger, banned casts and SBOM run once the stack is based on main.
- Landing order: T1 #671, then T2 #672, then T3 #673, then T4 #706 as one, after recurring.
- No source edits, no merge, no production action.
