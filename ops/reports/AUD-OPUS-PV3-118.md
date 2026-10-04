# AUD-OPUS-PV3-118: Claude Opus 5.5 lens (agent 118 wave), privacy follow-ups

- Lens: independent T4 auditor; agent 118 is the operator. Started 11:18 PDT and finished 11:41 PDT on 10-04.
- Scope:
  - growth-project-backend#700 @ 5e3dabb0d0b9adc3ecf53c06f7bccf11852745fb
  - growth-project-mobile#368 @ fdfecc47a4ff8a65bf1cd8f6a26f1c2a34c88c45
- Claims (left in place):
  - ops/lanes118/claims/backend-700-5e3dabb0-opus
  - ops/lanes118/claims/mobile-368-fdfecc47-opus
- Notes: ops/aud-118/AUD-OPUS-PV3-118/. Contents:
  - diffs and verdict drafts
  - the guard re-implementation (guard_extract.ts/.js, run_guard.js, alias_scan.js) and its outputs
  - probe logs, and probes/ for replay
- Evidence trail: the previous verdicts of this lens (AUD-OPUS-FU2-118 report and verdicts).

## Status
See the Verdicts table below (posted state, comment URLs).

## Backend #700 summary
- **Prior Opus findings at 66569a61:** B-700-1, B-700-2(a), B-700-2(b), C-700-3 and C-700-5 are closed. C-700-2 is closed for the listed files except checkout-recovery (see C-700-6). C-700-1 and C-700-4 are with the operator, out of scope.
- **Probe replay at this exact head:** run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37224777673, branch audit/AUD-OPUS-PV3-118/700-probes at 6ca8adf6.
  - My FU2 probes (coach-name, reset-email, finance-path) and Sol's boundary spec pass, checked with diff against the saved files.
  - The new guard-gap probe fails by design.
  - An earlier attempt, run 37224534728, had a harness error in the checkout-recovery cases (it spied on the wrong Logger class). It is not evidence.
- **Guard check (operator ask):**
  - Every probe shape is caught (`bad` self-tests).
  - The baseline is exact-match per file.
  - An independent re-run over src/ at this head:
    - 934 calls scanned
    - strict violations: 0
    - exception text: 141 files and 306 sites, matching the baseline
  - Gap: two shapes are not counted (C-700-6).
- **Builder runs checked:** 37221266107 (before, c7224bb7 = 6946f0b9 + lens specs, unchanged) and 37222059865 (after, aa267a99 = d8ee379f + the same specs).
- **Main merge:** 64ad9438 is clean (the remerge-diff is empty) and touches no PR files.
- **CI:** 11/11 required checks green at the head. Merge state is CLEAN.

## Mobile #368 summary
- **Closed:** B-368-1, C-368-1, C-368-2 and C-368-3. The truth table was checked by reading and in tests.
- **Probe replay at this exact head:** run https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37224697247 (FU2 Opus block + Sol file, unchanged). 3/3 suites and 68/68 tests passed.
- **Builder runs checked:** 37222630053 (before, 4faad225) and 37222797494 (after, 4dd999e6).
- **CI:** required checks green. Merge state is CLEAN.
- **Copy:**
  - Mobile `APPLE_REMOVAL_STEPS` gives the same steps as backend #700's `SIGN_IN_WITH_APPLE_DELETION_TEXT`.
  - Live production /privacy and /help/delete-account (643817b3), fetched 10-04, still show the pre-#700 text: an unqualified iPhone path, then "On the web".

## Follow-ups (C)
- **C-700-6: guard false negatives, test/privacy/no-pii-in-logs.spec.ts:474.**
  - (a) A bare error after another template expression (`${userId}: ${err}`) is not counted.
  - (b) A message read into a variable not on the name list (`const detail = err.message`) is not counted.
  - Effect 1: checkout-recovery.service.ts:164, :178, :511 still log Redis error text. The guard's test "files fixed print no exception text at all" and src/observability/README.md:108 ("A new site fails the guard") are not true for these shapes.
  - Effect 2: google-oauth.service.ts:161 logs the Google token-endpoint body (`detail.slice(0, 200)`, outside the diff).
  - Fix rule:
    - Match an error identifier in any expression position.
    - Count logged aliases of `.message`, `.stack`, `String(err)` and `res.text()`.
    - Move the 3 checkout-recovery lines to describeFailure.
    - Count or fix google-oauth:161.
    - Add both shapes to `bad`.
  - Verify: the probes in ops/aud-118/AUD-OPUS-PV3-118/probes/ make the guard fail.
- **C-700-7: config errors collapse to `error=Error`.** auth.service.ts:1162, :1994, :2073 cover apple-verifier.service.ts:72 and google-verifier.service.ts:73; coach-brief.service.ts:1438 has the same problem.
  - Fix rule: a typed config error with a code from a finite module list, passed to describeFailure.
- **C-368-4: the status endpoint has no apple_revocation (backend),** so a later visit shows only the conditional card.
  - Fix rule: persist the outcome and return it from GET /me/delete-account/status.
- **C-368-5: first person in nearby copy.**
  - signupRoleNotice.ts:51, :55
  - CreateAccountScreen.tsx:892, :902-903
  - deletionErrors.ts:101, :126, :129
  - authFailure.ts:161, :186-187 (pinned by authFailureFixRound7.test.ts:43)
  - Fix rule: subjectless or "the app" wording, and update the pins.
- **Carry-over, operator-owned:**
  - C-700-1: owner reason text in coach-ai-budget logs; needs a migration.
  - C-700-4: calorie values at macros.service.ts:95-96 and coach-ai.service.ts:413-414.
  - C-700-2 remainder: 306 legacy sites.
- **Outside the jobs, not findings:**
  - The 5xx path of http-exception.filter.ts sends exception text to Sentry.
  - auth.service.ts:1786 (bootstrap only) puts Supabase text in a 500 body.

## Operator decisions (recommended defaults)
1. Merge #700 and #368 together, and deploy #700 before or with the next mobile build that carries #368, so the app and the live /privacy give the same Apple steps. Default: yes.
2. C-700-6: ticket a small guard-hardening PR, folded into the C-700-2 legacy-baseline PR. Default: yes, as the first commit of that PR.
3. C-368-4 needs a backend column. Default: ticket it; not now.

## Verdicts
| PR | Head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| backend#700 | 5e3dabb0d0b9adc3ecf53c06f7bccf11852745fb | APPROVE | 0/0/2 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/700#issuecomment-5983163999 |
| mobile#368 | fdfecc47a4ff8a65bf1cd8f6a26f1c2a34c88c45 | APPROVE | 0/0/2 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/368#issuecomment-5983164217 |

Heads and checks were re-read at 11:40 PDT, right before posting.
- Both heads unchanged, merge state CLEAN.
- Backend: 11/11 required checks green.
- Mobile: Typecheck/lint/test, both Analyze jobs and CodeQL green.
- Posted 11:40 PDT.
- Sol posted APPROVE on both before this, at 5983022103 and 5982997318. It was read only after these drafts and not copied.

## Cleanup
- Remote branches deleted: audit/AUD-OPUS-PV3-118/700-probes (backend) and audit/AUD-OPUS-PV3-118/368-probes (mobile).
- Worktrees removed with `git worktree remove --force`: wt/AUD-OPUS-PV3-118-700, -700p, -368, -368p.
- Claims and notes left in place.

## HANDOFF
Done at 11:41 PDT.
- Both PRs have dual APPROVE (Sol + Opus) at the exact heads, with CI green.
- Per JOBS118 they can merge now. Merge order: decision 1 above.
- Follow-up Cs: C-700-6 and C-700-7 (backend); C-368-4 and C-368-5 (mobile).
- Probe sources for replay: ops/aud-118/AUD-OPUS-PV3-118/probes/.
- No pushes to PR branches, no merges, no production access.
