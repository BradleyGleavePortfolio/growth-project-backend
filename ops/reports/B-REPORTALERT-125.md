# B-REPORTALERT-125 — every user report reaches a human (email alert)
Builder: Claude Opus 5.5, agent 125. Start 14:31 PDT 10-06. Hard stop 15:25.

## Scope traced
- DM report: POST /messages/report -> MessagesSafetyController -> MessagesSafetyService.reportMessage
  (src/messages-safety/messages-safety.service.ts:62) -> MessageReport row + audit + analytics. No fan-out to a human.
- Community report: POST /community/moderation/reports -> CommunityModerationController.report -> CommunityModerationService.report
  (src/community/moderation/community-moderation.service.ts:351) -> CommunityModerationAction row (status open). No fan-out.
- Email: src/email/email.service.ts (Resend transport, EMAIL_FROM_ADDRESS sender, EmailSendLog idempotency, global EmailModule).
- Support inbox: SUPPORT_EMAIL constant (src/public-pages/trust-pages.html.ts:31), already the community safety contact
  (COMMUNITY_SAFETY_EMAIL). Used as the recipient; no new address, no new env var.
- Metric: prom-client registry promRegistry (src/observability/prom-metrics.ts).

## B list
- B1 (Apple 1.2 / false claim): a member reports a DM or a community post as self-harm, threats or abuse; the app promises review
  within 24 hours, but no person is told the report exists, so it can sit unseen. Fix: email the support inbox on every new report.

## U list
- none

## C one-liners
- Coach push on community report (AUDIT-10-125 U-2 push half) not built; the email + m#428 Reports badge cover day 1 (owner is the only coach). C.
- Sub-coach cannot report a message in a head-coach thread (isParty). C (edge, deferred to 10k clients)

## Covered by open PRs
- None. No open backend PR touches messages-safety, community/moderation, community.module.ts or src/email (checked file lists of
  b#776-b#798). b#789 touches messaging.service.ts only. m#428 / m#429 are merged (mobile only).

## PRs opened
- growth-project-backend#801 (branch agent125/b-reportalert-125-email) head ec717a9782891dc880bdd100149569ed3fb25c12,
  397 additions + 2 deletions = 399 lines (9 files, tests included). CI at this head: 15/15 green (build-and-test incl. lint,
  type-check, build, full suite, env validation; R75; danger; schema parity; RLS floor + live; community live; mwb-3 live; CodeQL;
  npm audit; SBOM); deploy-readiness-gate skipped. READY FOR AUDIT comment posted 15:09
  (https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/801#issuecomment-6026355957).
- Files: src/report-alerts/report-alert.service.ts (new), src/email/templates/report-alert.hbs (new), src/email/email.types.ts
  (REPORT_ALERT key), src/email/email.service.ts (subject), src/messages-safety/messages-safety.{service,module}.ts,
  src/community/moderation/community-moderation.service.ts, src/community/community.module.ts, test/report-alerts/report-alert.spec.ts.
- Local proof: report-alert.spec.ts 8/8, email.service.spec.ts 14/14, messages-safety.service.spec.ts 33/33; eslint clean; R75 range OK.

## Not fixed (needs operator)
- O1: delivery depends on production EMAIL_TRANSPORT=resend (RESEND_API_KEY is present per fly-env-truth 10-05; EMAIL_TRANSPORT is not
  in .github/fly-env-desired-state.json so its value is unverified from the repo). With EMAIL_TRANSPORT=log the alert is only logged.
  Recommended default: after b#801 deploys, file one test report and confirm the email arrives at the support inbox.

## HANDOFF
- DONE 15:10. b#801 at ec717a9782891dc880bdd100149569ed3fb25c12, CI green, READY FOR AUDIT posted. Needs the T3 lenses, then merge
  and the next backend deploy (no migration). Then O1 (confirm an alert email arrives).
- Branch agent125/b-reportalert-125-email from origin/main 7fda4b23. Worktree /home/user/workspace/wt/B-REPORTALERT-125-backend
  removed after confirming clean and pushed. No ci/* lane branches created. No locks held.
- Possible follow-up (not built, C for day 1): push the workspace coach on a community report (AUDIT-10-125 U-2 push half).
