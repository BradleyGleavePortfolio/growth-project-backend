# AUD-OPUS-FU2-118: Claude Opus 5.5 lens (agent 118 wave)

- Lens: independent T4 auditor; agent 118 is the operator.
- Scope:
  - growth-project-backend#700 @ 66569a616fed254e2d5022bbc277013e4652788b
  - growth-project-mobile#368 @ 2216ad1dc94d280e33a39a3ae2d8b7ac197c16dc
- Claims (left in place; created 09:47 PDT on 10-04):
  - ops/lanes118/claims/backend-700-66569a61-opus
  - ops/lanes118/claims/mobile-368-2216ad1d-opus
- Notes: ops/aud-118/AUD-OPUS-FU2-118/. Contents:
  - diffs and the independent log-sink scan (script and output)
  - the Apple page fetch
  - CI logs
  - posted verdict bodies
  - probes/ (probe specs, and patches for replay)
- Heads re-read at 10:12 PDT, just before posting. Neither had moved.

## Verdicts
| PR | Head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| backend#700 | 66569a616fed254e2d5022bbc277013e4652788b | REQUEST CHANGES | 0/2/5 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/700#issuecomment-5982447222 |
| mobile#368 | 2216ad1dc94d280e33a39a3ae2d8b7ac197c16dc | REQUEST CHANGES | 0/1/3 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/368#issuecomment-5982447325 |

- Tier: both PR bodies say T3. Both were audited at T4 (PII in logs, auth.service.ts, public privacy and deletion text).
- Size: #700 is 936 lines over 24 files; #368 is 112 lines over 3 files.
- Base: each is based on current main (backend b644198b, mobile 7fdb629a). Merge state is CLEAN for both.
- CI at the heads:
  - Backend: 11/11 required checks green (run 37181000501, build-and-test job 111373393514).
  - Mobile: Typecheck, lint, test (job 111373456068) and CodeQL Analyze are green.
- Failing-before runs were checked from GitHub:
  - Backend 37180400375 (lane head d74ca031 = af5b6f20 + lane files; af5b6f20 = main + 7 test files only): 7 suites and 19 tests failed.
  - Mobile 37180664588 (cb4a34ab = 018ad155 + lane files; 018ad155 = main + test file only): 9 tests failed.
  - In both, exactly the finding tests failed.
- Prior findings of this lens, all closed at these heads:
  - C-611-17 (addresses in email and digest logs)
  - C-611-18 (iOS 18 qualifier)
  - PRIV3-117 operator item 1 (mobile APPLE_FALLBACK)
- Apple pages were re-fetched on 10-04: Apple Support 102571 (published 2026-09-14) and iPhone guide versions 18.0, 17.0, 16.0 and current.
  - Backend and mobile give the same steps, and both are true on iOS 16.4 and later.

## Findings (B, must fix)
- **B-700-1: a person's name reaches log lines.**
  - Where: coach-brief.service.ts:1482, 1502, 1506, 1511 log `coach=${safeCoachName}`, the coach's full name.
  - What it breaks: the new observability README rule says log lines never carry a name. The guard reports 0 sites because the name rule `\b...coach_?name\b` cannot match camelCase-prefixed identifiers.
  - Fix rule:
    - Drop the name from these lines (use the mode or date, or a coach id).
    - Widen the guard to identifiers that contain a person-name token, with an allow-list.
    - Add this case to the guard's `bad` list.
- **B-700-2: email addresses reach log lines through text built from the address.**
  - (a) Supabase Auth errors are logged raw:
    - auth.service.ts:1474 (public forgot-password) and :879 (generateLink).
    - Supabase echoes the address in these errors (supabase/auth issue 2252).
  - (b) finance-admin.client.ts:166-167 logs `path=` on degraded outcomes, and the path carries `encodeURIComponent(email)` (:65, :73, :93).
    - This is the same practice-type flow this PR fixed at practice-type.service.ts:107.
    - The Sol lens reported it first, as its C-700-1. It was verified here with an independent probe and graded B.
  - Fix rule:
    - Redact Supabase Auth error text before logging it.
    - Log a fixed route label, not the path.
    - Add guard cases for both.
    - Make the README scope true.
- **B-368-1: the new APPLE_FORM_NOTE promise is not always kept.**
  - The note (DeleteAccountScreen.tsx:101-102, shown unconditionally) promises an Apple outcome card after confirmation.
  - That promise fails when getSignInProviders() returns null (a designed state) and the person confirms with Apple, in either of two cases:
    - the authorization code is null, so the server returns `not_requested` (apple-token-revocation.service.ts:114);
    - the response has no apple_revocation field.
  - In both cases neither card renders (:433-434, :461).
  - Fix rule: show APPLE_FALLBACK whenever Apple was used to confirm, or the provider is unknown, and the outcome is not `revoked`. Add tests for those paths.

## Probes (CI lane, audit/* branches, never pushed to a PR branch)
| Run | Branch, head | Result |
|---|---|---|
| https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37219384148 | audit/AUD-OPUS-FU2-118/700-all, b5df58cb = PR head + 3 probe commits (fa277c1e3, a1d9c9938, 42f15b2cc) + lane files | 4 failed, 10 passed (coach-name x2, reset-email, finance-path fail); no-pii-in-logs.spec.ts passes in the same run |
| https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218594635 | audit/AUD-OPUS-FU2-118/700-coachname, 262d2238 | coach-name probe failed 2/2; guard passes |
| https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218955317 | audit/AUD-OPUS-FU2-118/700-resetemail, 87bdaf4e | coach-name and reset-email probes failed; guard passes |
| https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219296106 | audit/AUD-OPUS-FU2-118/368-applenote, 389950f2 = PR head + probe commit 6e4f4351 + lane files | 2 failed, 48 passed (both promise tests fail; the control and all 47 existing tests pass) |

- The probe branches were deleted at job end.
- Replay files are in ops/aud-118/AUD-OPUS-FU2-118/probes/:
  - the 3 backend specs, plus 700-patches/0001-0003 (git am onto the PR head)
  - 368-applenote-probe.patch (git apply onto the PR head)
- These are the strings the probes received:
  - `CoachBrief Claude call failed for coach=Patricia Quillfeather: upstream 529 overloaded`
  - `resetPasswordForEmail failed: Email address "pat.client+tgp@example.com" is invalid`
  - `Finance federation degraded path=/api/admin/federation/coaches/by-email/pat.client%2Btgp%40example.com/practice reason=http_error`

## Independence and evidence reuse (G09)
- No approval was reused on either PR; every line was audited. The Apple sentence differs from this lens's #611 APPROVE (b09f2061) only by the qualifier.
- The Sol lens verdicts (posted 16:57Z and 16:59Z) were read only after both drafts were written. They changed these findings:
  - B-368-1 was first drafted here as C-368-1(b). It was raised to B because JOBS118 requires every public sentence to be true of the code, and this sentence is new in the diff. The probe was run independently.
  - B-700-2(b), the finance path, came from the Sol lens's C-700-1. It was verified here with an independent probe.
- These Sol findings were not adopted:
  - Sol B-700-1 (provider bodies keep names): kept here as C-700-3. No caller sends display names, and the providers echo the address, not other fields.
  - Sol B-700-2 (webhook keys): kept here as C-700-5. The value can only come from a crafted request to the stub.

## Follow-ups (C)
- **C-700-1:** ai-credits/coach-ai-budget.service.ts:425,477 log the owner's free-text `reason`. The log is the only record (admin-coach-ai.controller.ts:94).
  - Fix rule: persist the reason on CoachCreditPackPurchase (additive migration) and log reason_length.
  - Operator decision.
- **C-700-2:** raw Prisma and Supabase exception text in catch blocks, e.g. auth.service.ts:897,1215,2030; users/gdpr-scrub.service.ts:175; users/account.service.ts:113.
  - Fix rule: a shared redacting errorMessageForLog(), plus a guard rule.
- **C-700-3:** redactEmailAddresses keeps display names and any other echoed text (log-pii.spec pins `to: <Pat Quill <[email]>>`).
  - Fix rule: log and store the provider, HTTP status and provider error code, not body text.
- **C-700-4:** health-adjacent values in logs: macros/macros.service.ts:95-96 and ai/coach/coach-ai.service.ts:413-414.
  - Fix rule: ids plus a band only.
- **C-700-5:** scheduling-webhook.controller.ts:95-108 accepts any token-shaped event or key.
  - Fix rule: log only known event names and keys; map anything else to `other`.
- **C-368-1:** the "not removed" part of the note is shown only by omission (APPLE_FALLBACK starts "You can also remove...").
  - Fix rule: start the card with "Apple has not confirmed that this app's access was removed."
- **C-368-2:** first person at DeleteAccountScreen.tsx:80 ("Our own copies...") and :138 ("We could not check...").
  - Fix rule: neutral wording, kept the same as the backend manifest.
- **C-368-3:** "Apple ID" and first person at src/lib/signupRoleNotice.ts:53 and src/screens/auth/CreateAccountScreen.tsx:1015.
  - Fix rule: "Apple Account", with no "we".
- **Pre-existing, outside the job:**
  - The public help pages (src/public-pages/help-pages.html.ts) use first person ("we", "our support team", "Ask us by email"). Fix rule: neutral support wording.
  - IP addresses are logged at filters/throttler-exception.filter.ts:74 and ai/gateway/ai-gateway.service.ts:164. This is security telemetry and was not raised as a finding.

## Operator decisions (recommended defaults)
1. One small builder round on #700 for B-700-1 and B-700-2. Default: yes.
2. One builder round on #368 for B-368-1. Default: yes. C-368-1 is optional in the same edit.
3. C-700-1 needs a migration decision. Default: open a ticket, not in this PR.
4. Merge #368 together with #700 once both are approved, so the app and /privacy give the same Apple steps. Default: yes.

## Cleanup
- Branches deleted: backend audit/AUD-OPUS-FU2-118/{700-all,700-coachname,700-resetemail}, and mobile audit/AUD-OPUS-FU2-118/368-applenote. ls-remote shows 0 remaining. No ci/* branches were created.
- Worktrees removed with git worktree remove --force: wt/AUD-OPUS-FU2-118-700 and wt/AUD-OPUS-FU2-118-368. Neither had node_modules.
- wt/AUD-OPUS-FU2-118-700src was left in place. It is a read-only git-archive extract of the backend src/ at the PR head (not a worktree, 26 MB) and is safe to remove.
- No push to a PR branch, no merge, no prod access, no spend.

## HANDOFF
- Job complete at 10:15 PDT on 10-04. Both verdicts are posted at the exact heads.
- Next actors:
  - The builder fixes B-700-1, B-700-2 and B-368-1, and replays the probes from ops/aud-118/AUD-OPUS-FU2-118/probes/.
  - On a new head, both lenses re-audit.
