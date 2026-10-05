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

## HANDOFF
- Backend #708 07d16d82 / #709 d9cf7ad9 / #710 3572b209 / #711 db7fa3bf: merge-only, waiting on CI (GitHub runner incident; four
  cancelled required jobs rerun at 13:38). When all required checks are green, post FIX ROUND 2 on #708 and RESTACK on #709-#711
  (drafts in ops/aud-121/B-MSG-FIN-121/comments/), each ending READY FOR AUDIT.
- Mobile m#371 222d128c, m#377 4b9bb41a: DRAFT (stay draft until #708-#711 approved). OPENING comments posted with READY FOR AUDIT when
  CI is green. Worktrees: wt/B-MSG-FIN-121-1 (backend, detached db7fa3bf), wt/B-MSG-FIN-121-m1 (mobile). Remove when done.
