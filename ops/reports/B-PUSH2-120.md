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
- Not pushed yet.

## HANDOFF
In progress. Next: P2 fixes, tests, push both, CI, FIX ROUND comments.
