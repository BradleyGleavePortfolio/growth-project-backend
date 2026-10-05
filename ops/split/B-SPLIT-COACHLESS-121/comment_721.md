FIX ROUND 1 (OPENING, B-SPLIT-COACHLESS-121, agent 121) — growth-project-backend#721 @ d90b484278f432e6e73e41326dc31cadc8892999

COACHLESS split 1/3 of #657 (A1-COACHLESS: coachless Home, featured coach, coach-code redemption). Split only: no behaviour change beyond the main-merge resolution (PR body items 1-5) and the two inherited-red fixes (items 6-7). Size 808 changed lines (under 1,500).
Contents: migration 20270301000000_coachless_featured_coach + down.sql, schema.prisma (3 models + back-relations), account-deletion manifest decisions (main-merge resolution 4), live RLS spec + its rls-live-tests step (resolution 3).
Stack: #721 (base main) <- #722 <- #723. Land as one stack, bottom-up (A5 rule 11). Top tree of #723 == reference M' `fcdc1d6c` tree `31ad366ffca001ef47446b9ad2374935b0c2f566` (branch agent121/coachless-split-0-merged-reference; M' = main-merge reference M f3f0d659 + fixes 6-7).

| Finding | Change | Commit | Test |
|---|---|---|---|
| none from lenses (opening; #657 was never reviewed) | split + main-merge resolutions 1-5 + inherited-red fixes 6-7 in the PR body (each in the piece that owns the file) | d90b4842 | evidence below; full suite in this PR's CI |

Prior probes from both lenses: none exist for #657 (no AUDIT comments, no ops/aud-*/ notes for it); nothing to replay.
Local (ops/heavy.sh, one at a time): on M' fcdc1d6c (top of stack, includes this piece): tsc --noEmit 0 errors (4 GB heap); 26 suites / 439 tests pass (all of test/account-deletion incl. erasure-manifest-coverage + manifest-fk-order, test/coachless, env-validation, lockout route table, admin hygiene, entitlement guards, rate-limit, throttler isolation, openapi, route-doc-drift, fly-env-workflows); no-pii-in-logs, fly-env-manifest, feature-flags, roles-enforced pass. The live RLS spec (fix 7) needs Postgres: runs in this PR's rls-live-tests job.
Lane ci/B-SPLIT-COACHLESS-121-1 (run 37365581470) was cancelled while queued (redundant with PR CI during the runner incident). Inherited red from #657's own CI (run 37082215722) fixed in the owning piece: PR body items 6 (roles-enforced, split 3, e3368cc3) and 7 (live RLS anon case, split 1, d90b4842); top tree of #723 == M' fcdc1d6c tree 31ad366f.

Money list self-check (stack-wide; this stack moves no money and opens no checkout):
- webhook order/redelivery: n/a (no webhook code). Redeem replay: one CoachCodeRedemption row per (user, Idempotency-Key); a completed key replays the stored response (`replayed: true`); the same key with another code is 422 `idempotency_key_reused`.
- concurrency/lock order: claim = INSERT on the (user_id, idempotency_key) unique; a losing duplicate polls the winner then replays or answers 409 `redemption_in_progress`; failed or stale (>60 s) claims are reclaimed by a conditional updateMany (exactly one retry wins). The only writer of User.coach_id stays `InviteCodesService.attachUserToCoachByCode` (unchanged; conditional attach, no re-parenting), so a double execution after a stale reclaim answers already_attached for the same coach and takes no second seat. Featured config save: audited in the same transaction, cache invalidated.
- terminal states: completed rows replay; failed rows are retryable; erasure removes the user's ledger and prompt rows, ledger rows naming an erased coach, and detaches the featured coach / editor (manifest, split 1/3).
- pagination/completeness: no lists returned; packages_available is a count of the coach's active, unarchived packages.
- currency/minor units: featured package is passed through from CoachPackage (amount_cents, currency) with no arithmetic.
- copy truth: COACHLESS_ERROR_MESSAGE says what happened and the next step; no first person, no emojis, no exclamation marks; mobile maps `code`. Flag off: every client route answers 404 `coachless_disabled`.

CI at this head: queued (GitHub runner incident; CI, Migration Dry-Run, Schema parity, Danger, codeql and the rest not started at 13:51 PDT). No red result exists at this head.

Overlap rule with #658: whichever of this stack and #658 lands second maps #658's code_revoked / code_expired / code_exhausted in ATTACH_TO_COACHLESS (src/coachless/coach-code-redemption.service.ts:46-53, split 3/3).
Operator decisions (report ops/reports/B-SPLIT-COACHLESS-121.md): D1 migration name kept (default keep), D2 CoachCodeRedemption.coach_id erasure = delete (default delete).

READY FOR AUDIT
