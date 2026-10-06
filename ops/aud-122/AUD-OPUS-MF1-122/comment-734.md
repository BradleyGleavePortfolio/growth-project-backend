AUDIT Claude Opus 5.5 — growth-project-backend#734 @ 11ebdf44ffe27beceff36c79073155624068e73f — VERDICT: APPROVE

AUD-OPUS-MF1-122, agent 122. RUTHLESS SCOPE. Base main 6aff479cd09f1afdeafedf47684cb34f4ef0584e; 1 file, +4/-0.

**A 0 / B 0 / C 1**

**Map is right.** `INVITE_ATTACH_ERROR.CODE_REVOKED / CODE_EXPIRED / CODE_EXHAUSTED` (`src/invite-codes/invite-codes.service.ts:135-139`, thrown by `inviteCodeLifecycleRefusal` at :207-226) now map to `COACHLESS_ERROR.CODE_REVOKED / CODE_EXPIRED / CODE_EXHAUSTED` (`src/coachless/coach-code-redemption.service.ts:54-56`). All three answer 410 with their own copy (`coachless.errors.ts`). Both places that read the map pick them up: the `execute()` catch (:236-238) and `toCoachlessError()` (:291-295). Before this change they fell through to 500 `redemption_failed`.

**Other callers of `attachUserToCoachByCode`: none turns the three codes into a 500 or the wrong message.**
- `auth.service.ts:244` `tryAttachInviteCode` (used by signup-with-code :1549, Google :1105, Apple :1316) catches every error. `inviteAttachErrorCode()` knows the three codes because its set is built from `Object.values(INVITE_ATTACH_ERROR)`. Result: 200 with `invite_attached:false` and `invite_attach_error:'code_*'`. Mobile (`src/lib/inviteAttachOutcome.ts:43-51`) shows "ask your coach for a new one" copy for all three.
- `auth.service.ts:1409` select-role, `auth.controller.ts:275` `/auth/attach-invite-code` and `invite-codes.controller.ts:213` `/auth/attach-coach-code` pass the `BadRequestException {code, message}` straight through `HttpExceptionFilter` (`src/filters/http-exception.filter.ts:55-65`). Result: 400 with the code and the specific "Ask your coach for ..." message.
- No other map or switch over `InviteAttachErrorCode` exists in `src`.

**CI is green at this head.** `build-and-test` [run 37391823720](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37391823720/job/112038438547) passed: `test/coachless/coach-code-redemption.spec.ts` PASS, 813 suites, 13,852 tests (main had 13,849 plus the 3 failures). Every other check passed too (`deploy-readiness-gate` skipped as usual). Main's red run [37390793076](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37390793076) failed on exactly these 3 cases (revoked / expired / exhausted) and nothing else.

C: C-734-1. Mobile shows the "has expired" sentence for `code_revoked` (`inviteAttachOutcome.ts:45`). What it tells the client to do is still right. Copy nit, not in this PR.
