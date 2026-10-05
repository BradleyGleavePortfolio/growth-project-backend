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

## HANDOFF
- Backend pushed; waiting on CI at 07d16d82 / d9cf7ad9 / 3572b209 / db7fa3bf. Then post FIX ROUND 2 on #708 and RESTACK on #709-#711
  (drafts in ops/aud-121/B-MSG-FIN-121/). Then step 2 (mobile M-MSG-121).
