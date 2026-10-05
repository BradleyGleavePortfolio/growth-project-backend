# B-PUSH2-120 — backend push #692 (P1) + #693 (P2) FIX ROUND (agent 120)

Started 10:14 PDT 10-05. Stack lock: ops/lanes120/locks/push (taken).
Read: _COMMON_120 -> 119 -> 118 -> 116, AGENT_RULES, JOBS120 entry, AUD-SOL-PUSH-120.md + verdicts, AUD-OPUS-PUSH-120.md + comments, both lenses' probes.

## Starting heads
- #692 27156167037d5c1be687c597ad349e5a151f5228 (base main, BEHIND ee55f814), 815 lines, created 2026-10-03 (grandfathered 3,000).
- #693 13417e7be58b96b6fccf203f71ec3b1f1ac8bb20 (base #692 branch agent115/push-split-1-outbox-foundation), 2,382 lines, created 2026-10-03 (grandfathered 3,000).

## Findings to close
- B-692-1 (Sol) lock-screen PII -> fixed in P1: fixed per-kind templates only.
- B-693-1 (Sol) reschedule dedupe -> P2.
- B-648-7 (Sol, reopened) hidden sole notifications -> P2.
- B-693-2 (Sol) failed token cleanup settled -> P2.
- B-648-9 (Sol, reopened) consent revoked during send preparation -> P2.
- B-693-1 (Opus) Android channelId 'default' -> P2.
- C-693-2 (Opus, operator-allowed) main refresh + payout-notice push_twin -> P2.
- C-692-1 tier header in #692 body (job entry).

## Progress
- Worktrees: wt/B-PUSH2-120-1 (P1, local branch wip/B-PUSH2-120-692), wt/B-PUSH2-120-2 (P2, wip/B-PUSH2-120-693).
- P1: merged main ee55f814 (clean) = 32863d3c; fix commit 346cf4a8 (lock-screen templates, result_code index, test/push-lock-screen-copy.spec.ts). Local: new spec 6/6, Sol P1 probe 6/6 (was 2 fail).
- P2: merged P1 32863d3c into P2 = 60fb8fe9; conflict in notifications.service.ts CreateNotificationInput resolved keeping main's throttle_key and P2's push_twin.
- P2: merged P1 fix 346cf4a8 = b2c167c6; fix commit c2cef1d1 (channels, templates at send, consent + token re-read after handoff, token-cleanup-pending retry, reschedule per-move identity, proven push_twin, payout twin). New test/push-delivery-round5.spec.ts 15/15 locally (12 of its first 14 cases fail with the src fix removed); 10 touched suites pass locally; tsc --noEmit clean; eslint clean on changed src.
- Pushed 10:42 PDT: #692 27156167 -> 346cf4a8 (910 lines), #693 13417e7b -> c2cef1d1 (2,876 lines vs P1 head). Normal fast-forward pushes.
- Probe replay lane (Postgres) at c2cef1d1: run 37350591060 — 13/14 suites, 192/194 tests; only Opus U2 [C-693-3] and U3 [C-693-4] fail (follow-up Cs by ruling). Sol P1 6/6, Sol P2 7/7, Opus U1 + U4 pass, Opus live L1-L6 pass.
- P1 lane at 346cf4a8 (+ Sol P1 probe commit ed783365): run 37351622402 — Sol P1 6/6, push-lock-screen-copy 6/6.
- PR CI: #692 @ 346cf4a8 CI run 37350476563 success (all checks green). #693 @ c2cef1d1 CI run 37350492403 failed one guard: test/privacy/no-pii-in-logs.spec.ts (main's B-PRIVFU2-118 guard, arrived with the refresh) flagged P2's onModuleInit `this.logger.error(message)` (variable named `message`). Fixed by renaming to `notWired`: commit 53796f1e, pushed 10:55 PDT (size unchanged 2,876). Guard 11/11 locally.
- PR bodies: #692 tier header + fix table (patched before the 10:56 comment); #693 tier header + fix table (updated again 11:03 for 53796f1e). Pre-edit bodies saved: ops/reports/B-PUSH2-120-body692-before.md, -body693-before.md.
- Probe lane at 53796f1e: run 37352088482 — 14/15 suites, 203/205 tests; again only Opus U2/U3 (Cs) fail; Sol P1 6/6, Sol P2 7/7, Opus U1/U4, live L1-L6, round5 15/15, no-pii guard pass.
- PR CI #693 @ 53796f1e: CI run 37352037508 build-and-test success; all checks that run on the stacked PR green. Main-only gates (migrations, banned casts, CodeQL, danger) run once the base is main.
- FIX ROUND comments (both end READY FOR AUDIT):
  - #692: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/692#issuecomment-6000090214 (10:56 PDT)
  - #693 (MAIN REFRESH + FIX ROUND + RESTACK): https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/693#issuecomment-6000199795 (11:03 PDT)
  - Comment sources: ops/reports/B-PUSH2-120-comment-692.md, -comment-693.md. Lane/CI logs + patch: ops/reports/B-PUSH2-120-artifacts/.
- Notify: ops/lanes120/notify/push.txt (two lines). Lock ops/lanes120/locks/push removed 11:04 PDT. ci/* branches deleted (probes-1, probes-2, 692-p1probe-1, 692-p1probe-2). Worktrees removed (node_modules symlinks only; shared deps intact). Local branches wip/B-PUSH2-120-692 / -693 kept in the clone.

## Final heads
- #692 346cf4a8ee462c8f241de65df6ffda95988257f3 — 910 lines (+910/-0), 10 files, base main ee55f814. A/B/C fixed: 0/1/1 (Sol B-692-1, Opus C-692-1 tier header).
- #693 53796f1e278c12ebb56d701724df032675dcedf1 — 2,876 lines (+2,756/-120), 24 files, base #692. A/B/C fixed: 0/5/1 (Sol B-693-1, B-648-7, B-693-2, B-648-9; Opus B-693-1; Opus C-693-2 payout twin).

## Follow-ups (C)
- Sol C-693-1 — src/notifications/push/push-delivery.service.ts:246-262 (collapse in enqueue) and :500-510 (per-user window in sendOne), lines at 53796f1e: cross-replica burst admission is not atomic. Fix rule: admit by a DB-side count or advisory lock per user inside the claim.
- Sol C-693-2 — src/notifications/notifications.service.ts:744 pushToCoach and :803 pushToUser (legacy senders): bypass the outbox (no quiet hours, no consent re-check). Fix rule: route through sendPush/outbox.
- Opus C-692-2 — prisma PushOutbox rows + account-deletion.manifest.ts:249: counterpart names in title/body kept 30 days (context names no longer written by booking emitter). Fix rule: null title/body/context/token once sent/dropped and receipt read.
- Opus C-693-3 — src/notifications/push/push-delivery.service.ts:459 (session re-check only for REMINDER_KINDS): a deferred non-reminder booking push (e.g. confirmed) for a session cancelled overnight is still sent at 08:00 (probe U2). Fix rule: re-check session state for every booking kind at send.
- Opus C-693-4 — src/notifications/push/push-delivery.service.ts:646-652 (transportFailure network branch): connect-phase errors (ECONNREFUSED before the request reached Expo) are dropped, not retried (probe U3). Fix rule: classify pre-request errors as retryable.
- Opus C-693-6 — src/scheduling/scheduling-session-lifecycle.service.ts:188 and :281 (requested/declined emits, line numbers from the Opus verdict at 13417e7b): not marked urgent, so they defer in quiet hours. Fix rule: decide urgency per kind.
- Opus C-693-7 — src/notifications/push/push-delivery.service.ts:257-261 (collapse updateMany): the updateMany count is ignored. Fix rule: treat count 0 as lost collapse and enqueue new.
- Opus C-693-8 — src/users/users.service.ts:106-111: registering a token does not clear it from other users. Fix rule: clear the same token from any other user in the same transaction.
- Opus C-693-9 — direct pushToUser/pushToCoach callers (notifications.service.ts:744, :803; same rule as Sol C-693-2).
- Opus C-693-10 — ops/aud-120/AUD-OPUS-PUSH-120/probes/audit-opus-push-120.live.spec.ts runs only in lanes; PR CI has no Postgres claim spec. Fix rule: add the Postgres lane to CI.
- Opus C-693-5 — closed by the reschedule identity fix.

## Operator decisions (recommended default)
1. Merge #692 then #693 back to back, deploy after #693 with migrations (default: yes, as ruled).
2. Lock-screen reminders keep the session start time (no name) — default: keep.
3. Twin proof window 1 hour (runtime) vs the migration backfill's 10 s — default: keep (payout retries can land minutes later).
4. Mobile #341 (PUT /notifications/timezone) should ship with push — default: ship together.
5. Android delivery unverified on device (FCM key uploaded 09:51 10-05) — default: one device check before announcing Android push.

## HANDOFF
Done. Both PRs READY FOR AUDIT at the heads above; next: fresh Opus + Sol verdicts at exact heads (#692 346cf4a8, #693 53796f1e). After #692 merges, #693's base becomes main and the main-only gates must run green at its head before merge. No merges, deploys or production actions were taken.
