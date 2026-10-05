# B-MSG-FIN-121 — close out B-MSG2 on b#708-#711 (CoachMessage RLS), then mobile inbox M-MSG-121 (agent 121)

Job: ops/lanes121/JOBS121.md "B-MSG-FIN-121". T4 (RLS). Stack lock: ops/lanes121/locks/msg (taken 12:38:45 PDT 10-05).

## Progress
- 12:38:45 PDT 10-05 read _COMMON_121, SoT A1/A6/A9.1/A9.2 (B-MSG2-120, M-MSG-120), reports B-MSG2-120 + B-SPLIT-MSG-120. Lock taken.

- 12:38 heads verified on GitHub: #708 80995735 (behind main 5da537d6), #709 d0381321, #710 ec99aba0, #711 56cabb77.
- D1 check on #708 (commit 80995735, migration 20270303000000_messaging_core_actions): ENABLE + FORCE RLS on CoachMessage (after the
  DO block); DO block on pg_policy creates coach_message_participant_access FOR ALL TO public with USING/WITH CHECK byte-equal to the
  chain's 20260607000000 definition (= production's deparsed expression) only when absent, then COMMENT ON POLICY marker
  'created by 20270303000000_messaging_core_actions'; down.sql drops the policy only when that marker matches and leaves RLS on.
  Live spec asserts relrowsecurity/relforcerowsecurity true and the single policy (PERMISSIVE, {public}, ALL, qual == with_check ==
  production text). No change needed. CI at 80995735: all green incl. community-live-tests, rls-live-tests.
- Tree checks (git merge-tree recompute): d0381321 == merge(87f0bfff, 80995735); ec99aba0 == merge(47b528ce, d0381321);
  56cabb77 == merge(5a7c41e8, ec99aba0). Pure merge-only restacks. #711 Schema parity failure (run 37359205960 job 111929248395):
  "Install dependencies" step cancelled (runner), infra only; superseded by the new head.
- 12:42 #708 merge main 5da537d6 -> 07d16d82 (clean; PR diff vs main identical to old diff except the ci.yml index line: main added
  checkout-settlement.live.spec.ts to the live job, #708 adds coach-thread-state-rls.live.spec.ts to community-live-tests; disjoint).
- 12:43 restack merge-only: #709 d9cf7ad9, #710 3572b209, #711 db7fa3bf. Per-piece diffs identical (index lines aside). Tree check:
  each new tree == merge-tree(old head, main 5da537d6) (b2e83eed / 7c4fb22f / 2f14de6c / f2b79650). Pushed 12:43:42.

- 12:56 PR titles set to Conventional Commits (old #708 title failed the non-required "danger dry-run").
- 13:14 mobile local evidence (heavy.sh, one file at a time): realtimeThreadUpdated 4/4, messagingV2Api 29/29, CoachInboxV2 10/10,
  useFeatureFlags 6/6, InviteCtaWiring 6/6; tsc clean.
- 13:15 m#371 opened DRAFT (base main), head 222d128c2b002dbbc2a9f3612ab8ad3a29765559, 1,358 lines (tests 484). Coach inbox v2.
- 13:36 m#377 opened DRAFT (base agent121/msg-mobile-1-inbox), head 4b9bb41a6258ed509a7123750b127954d0571c38, 1,489 lines
  (tests 537). Thread actions on both thread screens + bubble-side live bug fix. Local: threadV2 10/10, ClientMessagesScreenV2 5/5,
  MessagesScreenV2 2/2, messagingV2Api 29/29, ClientMessagesScreen.integration 3/3, MessageActionSheet 6/6, NoCoach 1/1, Cache 6/6;
  tsc clean; eslint on changed files clean; vendor-name guard passed.
- 13:38 backend: four required jobs were cancelled by the runner incident after 40-50 min unassigned (never started): danger
  (#708 run 37365273429), Schema parity (#709 run 37365269925), npm audit (#710 run 37365270100, #711 run 37365269955). Reran
  --failed (completed runs, not queued ones).
- 13:42 backend local evidence at db7fa3bf (top of stack = #708-#711 + main): test/messaging/messaging-core-v2.spec.ts 37/37 PASS.
  Backend tsc OOM in the shared sandbox (not a code failure); left to CI build-and-test.
- 13:33 operator edge-case freeze (A2) applied: no open Bs on these PRs; nothing deferred.

- 13:47 more runner-cancelled required jobs rerun --failed: #708 Banned cast tokens 37365158747, build-sbom 37365158784; #710 Schema
  parity 37365270185.
- 13:50 operator: MSG3 lens pair starts on 07d16d82 / d9cf7ad9 / 3572b209 / db7fa3bf; do not push those heads unless a lens posts a B.
- 13:53 posted (each ends READY FOR AUDIT; CI pending only because of the runner incident, stated in each):
  FIX ROUND 2 #708 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/708#issuecomment-6002726390
  RESTACK #709 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/709#issuecomment-6002726751
  RESTACK #710 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/710#issuecomment-6002727110
  RESTACK #711 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/711#issuecomment-6002727390
  Tree checks re-verified at 13:50 (all EQUAL). Backend worktree removed, local branch fin121/msg-1 deleted.
- 13:53 mobile PR CI (m#371 run 37368751632 + CodeQL 37368751769, m#377 run 37370921343) cancelled repo-wide in the incident (never
  started); rerun 13:59.


## FIX ROUND 3 (operator 14:0x/14:03; Sol MSG3 RC on #709 0/1/0 and #710 0/2/0; Opus MSG3 APPROVE on all four with no Bs)
- 14:09 lock retaken. Worktree wt/B-MSG-FIN-121-2.
- Failing before: Sol probes at old #710 `3572b209` gave 4 fail / 2 pass (ops/aud-121/B-MSG-FIN-121/sol-probes-before-3572b209.txt).
- #709 `8d3cf36c` B-709-1: thread-updated payload `{}` (messaging-realtime.ts, messaging.service.ts notifyThreadUpdated with
  `_kind`/`_messageId`), plus a new test in messaging-core-v2.spec.ts. 16/16 local. Pushed 14:14.
- #710 `1b9a2d8a` merges #709 (spec end-of-file conflict, union; -U0 delta equals the #709 round delta), then `654b048a`:
  B-710-1 assertNotBlocked also checks the actor/client pair (edit, pin; reply is a send; author delete stays allowed per Sol).
  B-710-2 client inbox preview seek and unread count skip blocked senders, with an in-memory guard; coach inbox hides a preview from a
  blocked sender. New test/messaging/messaging-block-boundaries.spec.ts (adapted from Sol) 5/5. Pushed 14:17.
- #711 `071ccda2` merges #710 (import-block conflict, keep both; -U0 delta equals the #710 round delta), then `3d0a615e` README text
  (empty payload, sub-coach blocks). Pushed 14:18. Top: Sol probes 6/6, core-v2 38/38, block-boundaries 5/5, eslint clean; tsc OOM
  locally, left to CI.
- Sizes: #709 1,148, #710 1,299, #711 390. One push per PR.
- 14:20 FIX ROUND 3 comments, each ending READY FOR AUDIT (CI queued, runner incident):
  #709 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/709#issuecomment-6003156563
  #710 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/710#issuecomment-6003156955
  #711 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/711#issuecomment-6003157149
- Mobile CI green: m#371 222d128c (CI + CodeQL), m#377 4b9bb41a. Posted OPENING (NOT READY) comments:
  https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/371#issuecomment-6003169903
  https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/377#issuecomment-6003170424
- Mobile change needed for the empty ping (not pushed, per operator 14:03): m#371 src/services/realtime.ts parseThreadUpdated
  (lines 74-84) requires kind/thread_client_id and drops `{}`, so it must treat any thread-updated event as a refetch signal (update
  realtimeThreadUpdated.test.ts). m#377 src/screens/coach/ClientMessagesScreen.tsx:187-188 must drop the `ping.threadClientId`
  filter. Until then the v2 screens refresh on the poll floor only. The client screen already ignores the payload.
- notify: ops/lanes121/notify/msg-fix-ready.txt

## Follow-ups (C)
- C-MSG-1 (from B-SPLIT-MSG-120): backend src/data-export/data-export.service.ts exports no CoachThreadState rows and omits the new
  CoachMessage columns. Fix rule: export the user's CoachThreadState rows; include edited_at, deleted_at, reply_to_id.
- C-MSG-2: mobile src/screens/client/MessagesScreen.tsx and src/screens/coach/ClientMessagesScreen.tsx report Alert
  "Our team will review within 24 hours. Thanks for keeping the community safe." (pre-existing, first person). Fix rule: e.g.
  "Reported. The report is reviewed within 24 hours."
- C-MSG-3: mobile src/screens/client/MessagesScreen.tsx no-coach copy "contact support and we will connect you" (pre-existing, first
  person). Fix rule: rewrite without first person.
- C-MSG-4: mobile src/screens/coach/command-center/InboxScreen.tsx is still a mocked inbox. Fix rule: back it with
  messagingV2Api.getCoachInbox behind messaging_core_v2 (or route to CoachInboxV2).
- C-MSG-5: coach thread mute state is unknown on open (no per-thread GET), so the menu offers every option incl. Unmute. Fix rule:
  pass `muted` from the inbox row as a route param, or add GET .../state.
- C-MSG-6: legacy (flag OFF) client pending bubble says "Sending" after a failed send (pre-existing). Fix rule: "Not sent" + retry.
- C-MSG-7 (pre-existing, outside this round): the legacy thread read `filterBlockedAuthors` only strips the other party's
  (head coach's) messages, so a client-blocked sub-coach's messages still appear in the client's thread page. Pins and, now, the
  inbox filter every blocked author. C (outside the B-710 scope; flagged for the operator).
- C-709-1, C-710-4, C-708-1: unchanged follow-ups, per the operator.

## HANDOFF
- Backend: #708 07d16d82 unchanged and approved by both lenses. #709 8d3cf36c, #710 654b048a, #711 3d0a615e are FIX ROUND 3,
  READY FOR AUDIT (comments above); a delta lens pair is next. PR CI is queued (runner incident). After runs complete, rerun with
  --failed any jobs that were cancelled without a runner. Do not push again unless a lens posts a B.
- Mobile m#371/m#377: drafts, CI green, NOT READY. The next push is the empty-ping change above (operator approval needed), then
  READY FOR AUDIT.
- Worktrees removed; no ci/* or audit/* branches; lock ops/lanes121/locks/msg released at the end of this round.
