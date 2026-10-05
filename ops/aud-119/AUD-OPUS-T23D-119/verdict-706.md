AUDIT Claude Opus 5.5 — growth-project-backend#706 @ a3f011638f29d80d92115b90ba0897a24f6ae709 — VERDICT: APPROVE
A/B/C = 0/0/1

Reviewer: AUD-OPUS-T23D-119, agent 119. This is a full T4 audit of a new tests-only piece. There was no prior approval, so no evidence is reused.

### Scope and size
- **Base:** `agent115/trials-split-3-checkout-webhook` at `904b9642`.
- **Diff:** one file, `test/b-trials-4-fix-round.spec.ts`, +423/-0. It has no source, schema, dependency or config change.
- **Size rule:** the PR was opened at 13:20 PDT 10-04, after the 12:33 rule, and its 423 lines are under the 1,500 limit.
- **PR body and title:** the body carries the tier header, and the title is a Conventional Commit.
- **Piece boundary:** it imports only T2/T3 source and `test/utils/trial-fakes`, so it compiles alone on its base.

### What the tests prove (read in full)
- **B-673-1 (13 tests).** These run the real `TrialConflictService` and the real `StripeConnectApiService` over an intercepted fetch.
  - past_due and unpaid after a paid invoice are superseded, with one billed alert; the alert check runs through `sweep()`.
  - JPY and credit balance count as charged.
  - A never-billed plan gets one DELETE (the control).
  - The query is pinned to `subscription`, `status=paid`, `limit=100`.
  - Five unknown-evidence inputs give a retry with no DELETE, including the 404 case.
  - Three or more unknown attempts give exactly one cancel-failing alert.
  - A canceled plan reads no invoices.
- **B-673-2 (5 tests).** A supersession, a deletion or a lease takeover during the GET, and a supersession during the invoice read, each give `stale` with no DELETE, and the row keeps the change. The control cancels once.
- **B-672-3 (5 tests).** These cover card removal and card addition during admission, on push and on email, plus the RepeatableRead option on every admission.
- **Builder runs.** In the failing-before run [37230366374](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37230366374) on `5fdb5f5c`, 20 tests fail on assertions and 3 controls are green. The passing-after run [37231152495](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37231152495) has 23/23.
- **My run on this exact head.** [CI run 37232982567](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37232982567) ran #706 together with all 8 Opus probe files. The #706 spec is 23/23. The new Opus probes for #672 and #673 are green except N5 (C-672-12, expected red). The prior Opus probes show only their ruled reds. The total is 55 passed and 10 failed, and every failure is an expected red.

### C-706-1 (C): the B-672-3 race tests pin read order, not the snapshot
- **Where:** `test/b-trials-4-fix-round.spec.ts:316-318` (`$transaction` calls `cb(prisma)`) and :374-410.
- **The gap.** The fake transaction is read-committed. The tests "removed / added during the final purchase read" pass because the card read comes after the purchase read, and they would pass equally with no `isolationLevel`.
- **Why it matters.** With real Postgres REPEATABLE READ, a removal committed after the snapshot's first statement is invisible. The real result is then the consistent charge copy (my N1 control), which is the opposite of what the "removed during the purchase read" titles assert.
- **Why the code is still correct.** Only the 5th test checks the isolation option.
- **Fix rule:** either make the fake freeze reads at the first statement, and assert that a change before the snapshot gives the new copy while a change after it gives the old consistent copy (as in my N1/N2), or move the race to a live-DB spec.
- **Verify:** a fake that ignores `isolationLevel` fails a test.

### CI and status
- At `a3f01163`, all 10 applicable checks pass. deploy-readiness-gate is skipped. Merge state is CLEAN, and the PR is still a draft.
- It lands with T1, T2 and T3 as one, after recurring.
- No source edits, no merge, no production action.
