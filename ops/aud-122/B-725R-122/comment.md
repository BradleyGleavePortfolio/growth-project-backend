MAIN REFRESH (B-725R-122, agent 122) — growth-project-backend#725 @ b3caa5b18baa20ecca125efa2d51326f37dc5ee2

Previous approved head 1dbc59b690119f03f010e406f9f1e0e43d1e6556 (dual APPROVE, B-353-10). Main eb2e9e038a4cc6e2b8b20fb0d37d251a91162350 (dunning #687 incl. #691) conflicted on the lockout allow-list, so this is NOT a merge-only tree-check case: both lenses re-review the delta.

Commits:
1. fbcfb74b03c809927ef87661f6153d705ff7fcce — merge origin/main (parents 1dbc59b6 + eb2e9e03), two conflicted files.
2. b3caa5b18baa20ecca125efa2d51326f37dc5ee2 — tests only, each change proven by a failing spec on the merge commit.

**One lockout allow-list.** Main's S-DUNNING F8 set (`ALLOWED_EXACT_PATHS`: messages, messages/read, messages/unread-count, messages/report, matched by path for any method) and #725's `COACH_THREAD_OPERATIONS` (exact METHOD + PATH) are now one table, `COACH_THREAD_OPERATIONS`:
`GET messages`, `POST messages`, `POST messages/read`, `GET messages/unread-count`, `POST messages/report`.
These are the mounted methods (ClientMessagingController, MessagesSafetyController). A locked client reaches their own coach thread and the safety report, nothing else new: no other method on those paths (for example `PATCH`/`DELETE messages/:message_id` called with the id `read`), no voice upload, coach-review, coach-side or community message routes. Everything else main allows (billing, checkout incl. checkout/dunning, recover, auth, health, Roman, the AI consent pairs, data export, account deletion) is unchanged. The coach restart route (`POST v1/coach/purchases/:id/dispute-restart`, #690/#691) stays outside the client allow-list.

**Hunk resolutions**
- `src/checkout/dunning-v2/dunning-lockout.guard.ts`
  - constants hunk (conflict): kept main's `ACCOUNT_RIGHTS_PREFIXES`; main's `ALLOWED_EXACT_PATHS` and #725's `COACH_THREAD_OPERATIONS` merged into the one METHOD + PATH table above (adds `POST messages/report` from main); `ALLOWED_EXACT_PATHS` removed.
  - `isAllowedWhileLocked`: `return ALLOWED_EXACT_PATHS.has(path)` becomes `return false` (the messages routes are matched by `isCoachThreadOperationWhileLocked`, which the guard already calls from #725).
  - header doc: main's "contact the coach" bullet and #725's B-353-10 bullet merged into one bullet.
  - auto-merged unchanged: #725's guard call and shared `matchesOperation` helper; main's F6 lock authority (`effectiveLock`), `recover` prefix and account rights.
- `test/dunning-v2-lockout-allowlist-route-table.spec.ts`
  - header comment (conflict): union of both explanations.
  - `EXPECTED_REACHABLE_WHILE_LOCKED` (conflict): main's list kept (data export x4, account deletion x4, messages x4 incl. messages/report); the reachable filter keeps #725's `|| isCoachThreadOperationWhileLocked` (auto-merged).
- Fix commit (tests only):
  - `test/dunning-v2-lockout-guard.spec.ts`: main asserted method-blind `isAllowedWhileLocked('messages*')` (4 failed on the merge); now pins the five METHOD + PATH pairs and that the path rule alone does not admit them.
  - `test/dunning-v2-e2e-lifecycle.spec.ts`: `ctxFor` built a request with no method (1 failed); it now carries `GET` by default, like `dunning-r2-native-card-1a-2a-e2e.spec.ts`.
  - `test/dunning-v2-lockout-coach-thread.spec.ts`: the Prisma stub had no `clientPurchase.findMany` (main's `effectiveLock`), so the guard failed open (10 failed); the stub now matches main, plus a `POST messages/report` admit and a `GET messages/report` refusal.

**Evidence**
- Local (heavy.sh, one file each) at the merge commit: coach-thread 10 failed, lockout-guard 4 failed, lifecycle 1 failed, route-table 36/36. At b3caa5b1: coach-thread 17/17, lockout-guard 93/93, lifecycle 10/10.
- CI lane ci/B-725R-122-1 [run 37395013791](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37395013791) at b3caa5b1: `tsc --noEmit` green, 12 suites / 552 tests passed (route-table, coach-thread, lockout-guard, lockout-guard e2e, privacy-exact, AI consent lockout e2e, v2 lifecycle, R2 native card e2e, R3 money truth e2e, D2d restart, coach restart route, pilot coach allow-list bootstrap).
- PR CI at b3caa5b1: all 11 required checks green (build-and-test incl. lint, type-check, build and the full test suite: [run 37395321509](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37395321509)).
- Size: 5 files, +141 / -25 = 166 lines vs main (1,500 rule).

READY FOR AUDIT
