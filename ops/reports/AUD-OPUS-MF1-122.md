# AUD-OPUS-MF1-122 — Opus lens, growth-project-backend#734 (main fix: coachless map for invite-code lifecycle codes)

Lens: Claude Opus 5.5, for operator agent 122. Started 17:02 PDT 2026-10-05 (time box 15 min). Claim:
ops/lanes122/claims/backend-734-11ebdf44-opus. Worktree: /home/user/workspace/wt/AUD-OPUS-MF1-122-734 (detached, read-only).

Head: 11ebdf44ffe27beceff36c79073155624068e73f (base main 6aff479cd09f1afdeafedf47684cb34f4ef0584e). 1 file, +4/-0.

## What I checked
1. Map correct: INVITE_ATTACH_ERROR.CODE_REVOKED/EXPIRED/EXHAUSTED ('code_revoked'/'code_expired'/'code_exhausted',
   src/invite-codes/invite-codes.service.ts:135-139, thrown by inviteCodeLifecycleRefusal :207-226) now map to
   COACHLESS_ERROR.CODE_REVOKED/EXPIRED/EXHAUSTED (src/coachless/coachless.errors.ts), all HTTP 410 with specific copy.
   Both use sites take the map: execute() catch (coach-code-redemption.service.ts:236-238) and toCoachlessError() (:291-295).
2. Other callers of attachUserToCoachByCode (backend):
   - auth.service.ts:244 tryAttachInviteCode (signupWithCode :1549, googleAuth :1105, appleAuth :1316): catches every error,
     inviteAttachErrorCode() recognises the three new codes (INVITE_ATTACH_ERROR_CODES is built from Object.values), so the
     reply is 200 with invite_attached:false + invite_attach_error:'code_*'. No 500.
   - auth.service.ts:1409 selectRole, auth.controller.ts:275 /auth/attach-invite-code, invite-codes.controller.ts:213
     /auth/attach-coach-code: BadRequestException {code, message} passes through HttpExceptionFilter
     (src/filters/http-exception.filter.ts:55-65) as 400 with the code and specific copy ("Ask your coach for ..."). No 500.
   - No other Record/switch over InviteAttachErrorCode in src (rg).
3. Mobile copy for the signup paths (mobile main 203e80e, src/lib/inviteAttachOutcome.ts:43-51): code_revoked/code_expired
   match the "expired ... ask your coach for a new one" message, code_exhausted matches "used up". Specific, actionable.
4. Main CI red at 6aff479c (run 37390793076, job 112035110329): exactly 3 failures, all in
   test/coachless/coach-code-redemption.spec.ts (revoked / expired / exhausted). Log: ops/aud-122/AUD-OPUS-MF1-122/.

## Findings
A 0, B 0.
C (one line each):
- C-734-1: mobile shows code_revoked with the "has expired" sentence (inviteAttachOutcome.ts:45); action is still right (ask
  coach for a new code). Copy nit, not this PR.

## CI at head
All green at 11ebdf44. build-and-test run 37391823720 (job 112038438547): coach-code-redemption.spec.ts PASS; 813 suites,
13,852 tests passed (main had 13,849 + 3 failed). rls/mwb-3/community live tests, CodeQL, danger, size-label, schema parity,
npm audit, banned casts, sbom, test-deploy-readiness all success; deploy-readiness-gate skipped (normal).
Logs: ops/aud-122/AUD-OPUS-MF1-122/pr734-11ebdf44-build-and-test.log, main-6aff479c-build-and-test.log.

## Verdict (posted 17:11 PDT)
AUDIT Claude Opus 5.5 — growth-project-backend#734 @ 11ebdf44ffe27beceff36c79073155624068e73f — VERDICT: APPROVE. A 0 / B 0 / C 1.
Comment: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/734#issuecomment-6006167155
Body: ops/aud-122/AUD-OPUS-MF1-122/comment-734.md. Head verified right before posting.

## HANDOFF
Done. Opus verdict APPROVE posted at 11ebdf44 (head checked right before posting). No probes or lane runs used. Worktree
wt/AUD-OPUS-MF1-122-734 removed; no ci/* or audit/* branches created; temp ref origin/pr734 deleted. Claim file left in
ops/lanes122/claims/backend-734-11ebdf44-opus. Follow-up: C-734-1 (mobile copy nit). Operator next: wait for the Sol verdict; once
both lenses approve and checks are green, merge with --match-head-commit 11ebdf44ffe27beceff36c79073155624068e73f to turn main CI
green. If the head moves, this verdict is void.
