# AUD-OPUS-SCHA-121 (Claude Opus 5.5 lens, agent 121) — scheduling split b#712-#720 + #653

Started 12:38 PDT 10-05. Queue: SCHA #712 7fd99dce, #713 a7c8b33a, #714 55dfbdce, #715 8040f149, #716 31318708; then SCHB #717 112e0452,
#718 6feb18bb, #719 c79c3e67, #720 c2b27193, #653 9a23e3b2. Heads verified on GitHub 12:39 and again right before each post.
Claims: ops/lanes121/claims/backend-<n>-<head8>-opus for #712-#716.
Worktrees: wt/AUD-OPUS-SCHA-121-1 (c2b27193, detached), wt/AUD-OPUS-SCHA-121-2 (7fd99dce, detached). Notes/verdict drafts/probes:
ops/aud-121/AUD-OPUS-SCHA-121/.

## Evidence base
- My model's lens approved #634 at e18e8055 (5972118900, merge-only after 3d989702 5971916062). Tree(#720) == tree(M 6fc88c45) ==
  0595cfd7 (verified locally). Files of M byte-identical to e18e8055 rest on that evidence; files changed since are audited in full:
  migration 20270222 (session_start_at removed), schema.prisma, booking.emitter.ts (R4), reminder.job.ts (R3), lifecycle (R2 + 2 log
  sites), tests/fakes.
- Every piece merges cleanly with current main 5da537d6 (git merge-tree, no conflict). Main since ee55f814 shares only ci.yml with the
  stack (separate hunks).
- Migration commute (static): 20270222 touches SessionType / CoachingSession / NotificationDeliveryLog columns that predate 20270301;
  20270301 adds NotificationDeliveryLog.start_at + re-keys the unique; no shared object; no migration after 20270222 (20270223, 20270224,
  20270225, 20270301 community_win, 20270311) references these tables. Lane proof pending (mig-1).

## Verdicts posted
| PR | Head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| #713 | a7c8b33a | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/713#issuecomment-6001956738 |
| #714 | 55dfbdce | REQUEST CHANGES | 0/1/1 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/714#issuecomment-6001957114 |
| #715 | 8040f149 | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/715#issuecomment-6001957517 |
| #716 | 31318708 | APPROVE | 0/0/1 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/716#issuecomment-6001957966 |
| #717 | 112e0452 | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/717#issuecomment-6002158670 |
| #718 | 6feb18bb | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/718#issuecomment-6002159072 |
| #719 | c79c3e67 | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/719#issuecomment-6002159475 |
| #720 | c2b27193 | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/720#issuecomment-6002159830 |
| #653 | 9a23e3b2 | REQUEST CHANGES | 0/2/1 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/653#issuecomment-6002182391 |
| #712 | 7fd99dce | APPROVE (lane mig-2 still queued; static commute + prod out-of-order precedent) | 0/0/2 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/712#issuecomment-6002357973 |

## Findings
- B-714-1 booking.emitter.ts:516 deliver() pushes the full in-app body (display names, coach-written type names) through legacy
  pushToUser to lock screens, for every BOOKING_* kind incl. reminders; main sends no booking push today. Breaks A6.5 "reminder pushes
  show no name" and the push stack's B-692-1 fixed per-kind lock-screen copy. Proof: the PR's own green test
  test/booking-emitter.spec.ts:126-139 (push body == 'Jamie asked for Quick Q/A Call on ...'). Fix: push leg uses fixed per-kind copy
  (#693 lock-screen-copy.ts wording; reminders may keep the time, no name); in-app row unchanged. Verify: probe
  ops/aud-121/AUD-OPUS-SCHA-121/probes/booking-lock-screen.probe.spec.ts (all 11 emitters, canary name + type).

- B-653-1 booking.emitter.ts:417-446 emitRequestExpired body (client display name + coach-written type name) goes to the push via
  deliver() :512/:561. Fix: fixed push text for booking_request_expired; test with canaries.
- B-653-2 live-Postgres proof (operator S-SCHED-5 TO-DO before promotion; PR body "Not yet covered"): expired frees the gist
  constraint, lease takeover single winner, expire vs approve CAS, forced RLS allows the app role. Own stacked test PR if > 1,500.

## Follow-ups (C)
- C-653-3 request-expiry.ts:61 / request-expiry.job.ts:145: requested rows created by old machines during the rolling deploy have
  NULL request_expires_at and never expire. Fix: sweep sets requestExpiresAt(created_at, start_at) where NULL (CAS), or treat NULL so.
- C-714-2 (= builder C-S120-1) booking.emitter.ts:436 stored 24h title 'Session tomorrow'; fix: no relative day in the stored title.
- C-716-1 reminder.job.ts:601 dueIds skip precedes the start-mismatch park (:602-608): an old-start retry row stays unfinished while
  the new start is in band (<=10/30 min, no double send; >200 such rows pin the recovery page). Fix: park on start mismatch first.
- C-634-11 (carried, mine) orm-diagnostics.ts:109-170 instanceof outside try; fix: wrap after safeDiagnostic in try/catch -> OtherError.
- C-712-1 (to post with #712) migration.sql:28-29 says the operator preflight query is in the PR body; #712's body has none. Fix: add
  the two read-only queries (overlaps, inverted ranges) to the body. Operator already ran both 12:09 (0/0).

## Independence note
At 13:28 a grep of JOBS121 showed lines 220/225 (another job's entry) summarising the other lens's b#712-#720 result. Verdicts
#713-#720 and #653 were already posted; the #712 draft was written 13:19. No Sol comment or note was read. Disclosed in the #712 verdict.

## Operator notes
- Cross-stack: push #692/#693 (cc0a167f) and this stack both rewrite src/notifications/emitters/booking.emitter.ts,
  scheduling-session-lifecycle.service.ts, test/booking-emitter.spec.ts, test/scheduling.service.spec.ts. #693 adds sendPush (outbox,
  generic copy, dedupe) to main's old emitter; #714 adds pushToUser to the new one. Whichever lands second must restack so booking pushes
  go through sendPush exactly once (never both senders, never names on the lock screen).

- D2 (#653): migration 20270226000000 sorts before applied 20270301000000/20270311000000 (rule 7 says rename newer than prod's
  latest). Recommended default: keep the name (existing migration, same exemption as D1), pending lane mig-2 proof.
- #653 pre-deploy read-only query in its body (operator TO-DO) still to run before #653 deploys.

## Probes
- mig-1: audit/AUD-OPUS-SCHA-121/mig-1 (from #712 7fd99dce), run 37365508852 queued 12:46, cancelled 13:03 (replaced by mig-2,
  one lane in flight). mig-2: audit/AUD-OPUS-SCHA-121/mig-2 (from #653 9a23e3b2, covers 20270222 AND 20270226 sequentially + jest
  P-714-1 continue-on-error), run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37367384837 (queued 13:03;
  87 runs queued repo-wide). Workflow: ops/aud-121/AUD-OPUS-SCHA-121/probe-mig-order-2.yml. Old mig-1 description: production-order
  deploy of 20270222 (P1 deploy all but 20270222; P2 status/deploy applies it; P3 fresh chain; P4 prisma migrate diff prod-order vs
  fresh --exit-code; P5 catalog compare; P6 down.sql + re-apply round trip). Workflow: ops/aud-121/AUD-OPUS-SCHA-121/probe-mig-order.yml.

## Status
- [x] SCHA #713-#716 verdicts posted 12:59
- [x] #712 posted 13:29 (lane mig-2 queued, not started; result to be recorded here)
- [x] SCHB #717-#720 posted 13:14, #653 posted 13:16

## HANDOFF
All 10 verdicts posted (13:29). Open: lane mig-2 run 37367384837 (queued since 13:03, GitHub runner incident). When it finishes: record
P2a/P2b/P4/P5/P6 (+ P-714-1 jest, continue-on-error, expected red) here; if any 20270222/20270226 step fails, tell the operator (it
bears on #712 APPROVE and D2). Then delete branch audit/AUD-OPUS-SCHA-121/mig-2 and remove worktrees wt/AUD-OPUS-SCHA-121-1/-2/-3.
mig-1 branch deleted 13:17 (run cancelled).
