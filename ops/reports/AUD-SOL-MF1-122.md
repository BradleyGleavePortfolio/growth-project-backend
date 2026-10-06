# AUD-SOL-MF1-122 — independent Sol audit

Job: AUD-SOL-MF1-122, agent 122.

Audit started: 2026-10-05 17:02:44 PDT.

Candidate: growth-project-backend#734, head `11ebdf44ffe27beceff36c79073155624068e73f`, base `6aff479cd09f1afdeafedf47684cb34f4ef0584e`, four added lines in one file. ([PR #734](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/734))

AUDIT GPT-6.1 Sol — growth-project-backend#734 @ 11ebdf44ffe27beceff36c79073155624068e73f — VERDICT: APPROVE

Status: independent review complete; APPROVE posted at 2026-10-05 17:12:10 PDT after verifying the unchanged full head immediately before posting. ([Sol exact-head verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/734#issuecomment-6006178911))

## A/B/C

- A: 0.
- B: 0.
- C: 0.

No ordinary-use blocker found in the requested change or the other canonical attach callers reviewed.

## Review evidence

- `src/coachless/coach-code-redemption.service.ts:54-56` maps the three canonical lifecycle refusals directly to the corresponding coachless contract codes, and both the attach catch at `230-237` and outer conversion at `289-295` use that map. ([Changed service at the audited head](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/11ebdf44ffe27beceff36c79073155624068e73f/src%2Fcoachless%2Fcoach-code-redemption.service.ts))
- `src/coachless/coachless.errors.ts:56-59,84-86,109-119` supplies actionable expired/revoked/exhausted copy with HTTP 410, rather than HTTP 500 `redemption_failed`. ([Coachless error contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/11ebdf44ffe27beceff36c79073155624068e73f/src/coachless/coachless.errors.ts))
- `src/invite-codes/invite-codes.service.ts:135-156,208-225,890-894` defines and extracts all three codes and throws structured HTTP 400 lifecycle refusals before a normal new redemption writes the attachment. ([Canonical attach writer](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/11ebdf44ffe27beceff36c79073155624068e73f/src/invite-codes/invite-codes.service.ts))

### Other caller inventory

- `src/auth/auth.service.ts:234-255` preserves lifecycle failures as `invite_attached:false` plus their exact `invite_attach_error`, rather than throwing a 500; Google `1105-1119`, Apple `1316-1347`, and email signup-with-code `1552-1572` forward that result. ([Authentication service](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/11ebdf44ffe27beceff36c79073155624068e73f/src/auth/auth.service.ts))
- `src/auth/auth.service.ts:1409` (`selectRole`), `src/auth/auth.controller.ts:275` (`attachInviteCode`), and `src/invite-codes/invite-codes.controller.ts:213` (`attachCoachCode`) delegate without replacing the canonical lifecycle exception. ([Role-selection service](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/11ebdf44ffe27beceff36c79073155624068e73f/src/auth/auth.service.ts); [Auth attach controller](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/11ebdf44ffe27beceff36c79073155624068e73f/src/auth/auth.controller.ts); [Invite attach controller](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/11ebdf44ffe27beceff36c79073155624068e73f/src/invite-codes/invite-codes.controller.ts))
- `src/filters/http-exception.filter.ts:37-38,55-65,99-108` retains the status, machine code, and message of these non-ORM HTTP exceptions, so direct attach routes deliver the canonical HTTP 400 and correct lifecycle copy. ([Global HTTP exception filter](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/11ebdf44ffe27beceff36c79073155624068e73f/src/filters/http-exception.filter.ts))
- Scope qualification: email signup's unchanged preflight at `auth.service.ts:1529-1533` rejects already-unusable codes with HTTP 400 “Invalid or expired invite code” before invoking attach; `previewCode` intentionally returns only `valid:false` for an unusable row, so this is not a new conversion of the three lifecycle exceptions to a 500 or a false success/message. ([Signup preflight](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/11ebdf44ffe27beceff36c79073155624068e73f/src/auth/auth.service.ts); [Preview contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/11ebdf44ffe27beceff36c79073155624068e73f/src/invite-codes/invite-codes.service.ts))

## CI evidence

- Failing-before evidence was independently read from main run `37390793076`, build-and-test job `112035110329`: the revoked, expired, and exhausted redemption cases expected HTTP 410 with their lifecycle codes but received HTTP 500 `redemption_failed`; the overall run had exactly three failed tests. ([Main failing-before job](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37390793076/job/112035110329))
- The existing spec at `test/coachless/coach-code-redemption.spec.ts:127-152` exercises the real canonical writer over the stateful fixture and checks these lifecycle statuses/codes plus an unchanged null `coach_id` after refusals. ([Existing redemption regression spec](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/11ebdf44ffe27beceff36c79073155624068e73f/test/coachless/coach-code-redemption.spec.ts))
- Candidate CI run `37391823720`, build-and-test job `112038438547`, completed successfully: lint, control-source lint, full type-check, build, 813 executed suites / 13,852 passing tests, six passing snapshots, and production-env validation; the redemption, attach-reliability, and attach-ledger specs all passed. ([Candidate build-and-test job](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37391823720/job/112038438547))
- At 2026-10-05 17:11:38 PDT, the exact-head check snapshot contained 15 successful completed checks and only one skipped `deploy-readiness-gate`, with none pending or failed. ([PR #734 checks](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/734))

Local evidence directory: `/home/user/workspace/ops/aud-122/AUD-SOL-MF1-122/`.

- `audited-diff.patch` — four-line candidate delta.
- `main-build-and-test-37390793076.log` — independently inspected failing-before log.
- `candidate-build-and-test-37391823720.log` — successful candidate log.
- `final-check-runs.json` — exact-head final check snapshot.
- `verdict-comment.md` — outbound Sol verdict payload.
- `posted-comment.json` — GitHub receipt for the sole verdict comment.

## Constraints followed

Read the common brief in full, only this job-book entry, the required source-of-truth sections, and the lens contract; did not read the Opus lens's notes, report, or comments.

No repository changes, local test/build/type-check execution, new CI lane, pushes, merges, deploys, or production interactions.

## HANDOFF

Complete: Sol APPROVE, A/B/C = 0/0/0, at `11ebdf44ffe27beceff36c79073155624068e73f`; CI green, no requested fixes or deferred findings. ([Posted Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/734#issuecomment-6006178911))

Operator: use this exact-head Sol attestation together with the independently obtained Opus attestation under T4; no additional operator decision requested.

No worktrees or CI branches created, no lock held, and no cleanup required; the claim marker remains as the completed exact-head audit record at `/home/user/workspace/ops/lanes122/claims/backend-734-11ebdf44-sol`.
