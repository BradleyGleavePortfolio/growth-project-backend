AUDIT Claude Opus 5.5 — growth-project-backend#686 @ 7be7d396dcaab5f62c941a78e6e071ce3518ad28 — VERDICT: APPROVE
A/B/C = 0/0/2

Tier: T4 (money). This is piece F6 of #627, the top of the stack. It adds tests only: 3 files, +1355/-0.
- `s-fee-r7-transfer-create-recovery`: 10 tests, which expand to 19 through `it.each`
- `s-fee-r8-transfer-in-flight`: 14 tests
- `s-fee-renewal-backfill`: 12 tests

None of the tests uses `.skip`, `.only`, `.todo` or an env gate.

### Stack tree check (JOBS F56)
The tree at this head is the tree of #627 @ `66162285` merged with main `d23fa317`.
- `git merge-tree --write-tree 66162285882d75d7619542c9aa581da5cc93145d d23fa31773f2e7f14781d243db35067d949f421a` gives `09de2bffd1b9186b64f840bd9ee4761c4c0f510f`, the same as `7be7d396^{tree}`.
- The merge base of #627 and main is `0d33c4d4`. `git diff 66162285 7be7d396` has the same patch-id (`25eec362...`) as main's own `git diff 0d33c4d4 d23fa317`: 19 files, +1427/-116, the #647 notifications and scheduling work.
- So the split pieces F1 to F6 add nothing beyond #627 @ `66162285` plus main.

### Evidence reuse (G09)
- All 3 files are byte-identical to the same files at #627 @ `3a5338d7`, which this lens approved in comment 5972040127. The blobs are eff4b0aa, 3e7c84c8 and e68aafe4, and none of them changed in round 10. That evidence applies because the bytes match.
- I still re-read all 3 files in full for this verdict.
- Nothing from the other lens was used.

### Piece boundary
- The files import only `src/` from F1 to F4 and `test/utils/settlement-fakes.ts` from F2. There are no migrations.
- `git diff 858d3716 7be7d396` contains only the 3 new test files, so the source here is identical to #685.
- build-and-test is green at this head: [run 37151664774](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37151664774), 723 suites, 12466 tests, and all 3 files show PASS in the log.
- Schema parity ([run 37151664776](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37151664776)) and npm audit (run 37151664773) are green.
- Overall, 10 checks pass and 1 is skipping.

### Do the tests assert the money invariants they claim?
Yes. The checks below use the real orchestrator, settlement, ledger and lock, with only Prisma and Stripe faked.

**r7: a create whose outcome is unknown is never re-sent blind.**
- Every "receipt lost" or "response lost" case asserts exactly one Stripe create per key, including after 25 h with the key expired. It also asserts that the row is recorded `succeeded` with the right `stripe_transfer_id`, and that no repay alert is raised.
- The C-627-8 test installs a rollback `$transaction` "like Postgres" before it injects a mid-transaction failure.

**r8: a peer's in-flight create is never "proven absent".**
- Both probe orderings are reproduced with gated Stripe calls. Worker B holds (`pending`), A pays once, and there is no repay alert. In ordering 2, B loses its CAS and re-reads A's result.
- The in-flight window is pinned to timeout plus margin, which is 5 min, and a misconfigured timeout cannot shrink it.
- Every outcome write is a CAS: a stale success never regresses a reversed row, and a duplicate transfer raises `SFEE_TRANSFER_DUPLICATE`.
- The sweeper takes the same charge lock and wait. `runSettlementSweep` is stubbed in two tests only, to isolate the transfer loop. That is commented, and it is not the boundary those tests make claims about.

**Renewal backfill**
- A missed renewal is matched by charge id and paid once: coach net 9260 across two sales, idempotent on the next run.
- The 35-day window and the resumable cursor are covered (400 records, then 51), as is the per-run limit.
- Legacy destination charges are left alone.
- The provisional `awaiting_fee` row survives a Stripe or lock failure and settles at 4630.
- Stale money alerts fire after 1 h.

**Mutation probe** ([run 37171892935](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171892935), red by design). This PR's own files are re-run unchanged, with one production behaviour replaced at a time:
- Control: green, 45/45 for these files.
- TGP fee set to 1.9%: kills 11 of 19 r7 tests and 6 of 12 renewal tests.
- Fence always passes: r8 stays green. Its claims rest on the lock's `run`, the CAS and the marker window, not on the fence.

None of the tests is a tautology.

### Findings
**C-686-1: the PR title and commit message name specs this piece does not contain.**
- The title is "transfer recovery, in-flight and checkout specs". The commit `7be7d396` message adds "reconciliation and checkout specs".
- Those specs moved to F1 and F4 in the re-cut. The PR body is correct.
- Fix rule: retitle to "test(fees): transfer create recovery, in-flight and renewal backfill specs (split F6 of #627)".
- Verify: `gh pr view 686 --json title`.

**C-686-2 (outside this diff; test utility in #682): the fake `$transaction` has no rollback.**
- r7 works around this locally for C-627-8. Any new mid-transaction failure test in these files would need the same workaround.
- This is the same root cause as C-685-3 on #685.
- Fix rule: make `makeSettlementPrisma().$transaction` snapshot the tables and restore them on throw.
- Verify: r7's local override becomes redundant and all seven fee suites stay green.
