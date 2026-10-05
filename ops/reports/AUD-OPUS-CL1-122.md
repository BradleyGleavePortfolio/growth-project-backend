# AUD-OPUS-CL1-122 — Opus lens, coachless backend b#721-#723, first full review (agent 122)

Lens: Claude Opus 5.5. Started 15:57 PDT 10-05 (time box 45 min, ends 16:42). RUTHLESS SCOPE (SoT A2 items 1-11).
Independence: Sol notes/report/comments for this round NOT read before posting.
Claims: ops/lanes122/claims/backend-{721-d90b4842,722-c219d2f3,723-e3368cc3}-opus.
Worktree: /home/user/workspace/wt/AUD-OPUS-CL1-122-723 (detached at #723 head e3368cc3; read-only).

## Heads (verified via gh at 15:58 and again before posting)
- #721 d90b484278f432e6e73e41326dc31cadc8892999 base main, +808, DIRTY vs main 5cde6253 (git merge-tree: one conflict, prisma/schema.prisma)
- #722 c219d2f391c37edd700d5204f31b50286f280d82 base split-1, +1,290
- #723 e3368cc3cbb0961326ddf147728f7fc32d884188 base split-2, +1,116/-1
All under the 1,500 rule.

## What was read (money/access/data paths first)
- coach-code-redemption.service.ts (all), coach-code-lookup.service.ts (all), featured-coach.service.ts (all),
  coachless.controller.ts, coachless.dto.ts, coachless.errors.ts, coachless-home.service.ts, coachless-prompt.service.ts,
  coachless-feature.guard.ts, coachless.module.ts, app.module hunk, README.
- Canonical writer on the stack base: InviteCodesService.attachUserToCoachByCode (l.689-806), assertCoachCanAcceptClients
  (l.214), the three existing callers (auth.controller attach-invite-code, invite-codes.controller attach-coach-code,
  auth.service signup paths) — all plain calls of the same writer, so the coachless route adds no missed side effect.
- Migration 20270301000000_coachless_featured_coach (all) + down.sql, schema.prisma hunks, erasure manifest hunk, ci.yml step,
  RLS spec anon fix (fix 7), flag wiring (env rule, fly desired state, runbook, feature-flags service: students only).
- Prisma connects as service_role (BYPASSRLS, docs/decisions/2026-09-26-s8d-person-link.md:149), so the server writer is not
  blocked by the no-public-write policies; RLS here is the direct-API defence and matches the 59-migration pattern.

## Findings
Bs: none on any piece.

Checks against the item list:
- Client attached to the wrong coach: no. Only writer is attachUserToCoachByCode with the resolved stored code; already attached to a
  different coach -> 409 already_attached; non-students refused; case-fold lookup exact-first then upper-case.
- Code granting access it should not: no. Lifecycle (revoked/expired/exhausted/email/subscription) enforced by the canonical writer
  inside its transaction; the coachless lookup only names the reason. Package grant stays the existing C01 path.
  next.featured_package is display-only and limited to an active package of that coach (activePackageOf).
- Private data across tenants: no. Ledger keyed (user_id, idempotency_key), replay only to the same user; coach card is public
  profile fields only; Home returns nothing for non-students/attached users.
- RLS gap reachable by a user: no. Three tables RLS enabled+forced, anon revoked + RESTRICTIVE deny, self-only SELECT for the two
  per-user tables, owner-only SELECT for the singleton, no public writes.
- Signup dead end: no. Flag defaults off (404 coachless_disabled); existing attach routes untouched.
- Owner admin route: JwtAuthGuard + OwnerGuard + @Roles('owner'); every reference validated server-side; audited in-tx.

Cs (follow-ups, no fix now):
- C-723-1 Idempotency-Key contract: a failed attempt (typo) retried with the corrected code under the SAME key returns
  422 idempotency_key_reused. Mobile must mint a new key whenever the code text changes and reuse it only for a resend of the same
  code; the README says "reused on retry" without that line. Fix rule: one README line + flag it to the mobile code-sheet lens.
- C-723-2 The owner's featured-offer pause is enforced on /coachless/coach-code/redeem only; /auth/attach-invite-code and
  /auth/attach-coach-code still attach with the same code (coach subscription gate still applies everywhere).
- C-CL-1 / C-CL-2 (builder's): no controller spec; CoachCodeRedemption / CoachlessPromptState not in the data export. Concur, C.
- C (edge, deferred to 10k clients): 30 s per-instance featured-config cache; stale in_progress reclaim window.

Operator notes:
- D1 (migration timestamp 20270301000000 sorts before main's applied 20270307-20270317116000): concur keep; additive, no dependency;
  prisma migrate deploy applies unapplied migrations regardless of order; no ordering gate in scripts/.github.
- D2 (CoachCodeRedemption.coach_id erasure = delete): concur.
- CI: every PR CI run at all three heads was cancelled 20:31 UTC (runner incident); no required check has completed. The live RLS
  suite (fix 7) is only provable in PR CI (rls-live-tests). Merge precondition, not a content B.
- #721 DIRTY: only prisma/schema.prisma conflicts with main 5cde6253 (merge-tree). #722 touches env-validation and feature-flags
  files main also changed; expect conflicts at restack.

## Evidence
- Lane audit/AUD-OPUS-CL1-122/723 at e3368cc3: tsc --noEmit + coach-code-redemption, coachless-home, roles-enforced,
  feature-flags.service specs. Run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37386084938
  (pushed 16:02, done 16:04): SUCCESS, tsc 0 errors, 4 suites / 60 tests pass. Log: ops/aud-122/AUD-OPUS-CL1-122/lane-37386084938.log.
- Comment bodies: ops/aud-122/AUD-OPUS-CL1-122/c721.md, c722.md, c723.md.

## Verdicts / comments (posted 16:05 PDT, heads re-verified immediately before)
- #721 @ d90b484278f432e6e73e41326dc31cadc8892999 APPROVE, A0/B0/C1 (C-721-1 data export = C-CL-2)
  https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/721#issuecomment-6005035666
- #722 @ c219d2f391c37edd700d5204f31b50286f280d82 APPROVE, A0/B0/C1 (cache edge)
  https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/722#issuecomment-6005036089
- #723 @ e3368cc3cbb0961326ddf147728f7fc32d884188 APPROVE, A0/B0/C3 (C-723-1 key contract, C-723-2 pause scope, C-723-3 = C-CL-1)
  https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/723#issuecomment-6005036513

## HANDOFF (16:06 PDT 10-05)
- Done: Opus verdicts posted on all three pieces at the exact heads (APPROVE x3, no Bs). Lane run green at #723 head.
- Left for the operator: (1) PR CI at all three heads was cancelled 20:31 UTC; re-run it (rls-live-tests on #721 is the only proof of
  fix 7) before any merge; (2) #721 DIRTY (schema.prisma) -> conflict refresh, then #722/#723 restack; any non-merge-only change
  voids these verdicts except under A5 rule 12; (3) D1 keep migration name (recommended), D2 delete (recommended).
- Cleanup done: worktree wt/AUD-OPUS-CL1-122-723 removed; lane branch audit/AUD-OPUS-CL1-122/723 deleted. Claims left in place
  (record). Also removed a stray worktree this lens created by mistake at growth-project-backend/wt/x (detached, no work; main
  clone checkout untouched).
- Sol report/comments for this round were not read.
