# B-PUSH3-120 — backend push #693 (P2) FIX ROUND 6 for reopened B-648-8 (agent 120)

Started 11:18 PDT 10-05 (from `date`). Stack lock: ops/lanes120/locks/push (taken 11:18 PDT).
Read: _COMMON_120 -> 119 -> 118 -> 116, AGENT_RULES, JOBS120 entry, AUD-SOL-PUSH3-120.md, B-PUSH2-120.md.
Scope: #693 only. #692 stays at 346cf4a8 (Sol APPROVE); not moved.

## Heads
- #692 346cf4a8ee462c8f241de65df6ffda95988257f3 (unchanged)
- #693 53796f1e -> 2ab3c726 (11:29 PDT) -> cc0a167fcf977e1452e8f94f72aa72d83ec648d0 (11:33 PDT, tsc fix in the test helper). Normal
  fast-forward pushes. Size 2,965 (+2,844/-121), 25 files vs #692; grandfathered 3,000.

## Fix (commit 2ab3c726)
- src/notifications/push/push-delivery.service.ts: handOff(row, to) moved after the final consent/token re-read; it is the last await before
  client.send. One CAS: fence (id, status sending, lease_token) + lease_until > now + `user: { is: { expo_push_token: to } }`; sets
  handed_off_at and renews the lease. Lost lease, swept row, erased row or changed/cleared token = zero provider calls; handed_off_at stays
  null so the sweep returns the row to pending (never classified as an unknown attempt). Quiet-hours clock check after the CAS kept (later()
  clears handed_off_at); late-provider finish path unchanged. lost() log text now "claim lapsed, taken back or erased".
- test/utils/push-outbox-fake.ts: updateMany honours the `user.is.expo_push_token` relation filter.
- test/push-delivery-send-time.spec.ts: 5 round-6 regressions (replica sweep, erasure, lease lapse without sweep, sign-out, new device).
  Local: 5/5 fail with 53796f1e src, 23/23 pass after. round5 15/15, service 22/22, eslint/prettier clean.

## Lanes and CI
- Failing-before (53796f1e src + round-6 tests): run 37356352005 — 5 fail / 18 pass.
- Replay lane run 37356348452 (at 2ab3c726): tsc failed (test helper type) -> fixed in cc0a167f.
- Replay lane (Postgres 15 + tsc) at cc0a167f: run 37356806463 — tsc clean; 18 suites, 240/243. Failures: Opus U2/U3 (ruled Cs, unchanged)
  and Sol PUSH3 refined probe 1 at its `expect(reads).toBe(2)` line only (reads=4: replica's own reads after re-claiming the released
  unstarted row; outcome holds). Variant (ops/aud-120/B-PUSH3-120/b-push3-120-sol-refined-variant.spec.ts) passes. Log saved in
  ops/aud-120/B-PUSH3-120/replay-37356806463.log.
- PR CI at cc0a167f: CI 37356808729 success (build-and-test, rls, live suites), Schema parity, Dependency Audit, H4 readiness, size: all green.
- FIX ROUND 6 comment (READY FOR AUDIT): https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/693#issuecomment-6000796965
  (source: ops/reports/B-PUSH3-120-comment-693.md). PR body fix table not edited (operator 11:29: no extra polishing).

## Follow-ups (C)
Unchanged from B-PUSH2-120.md (Sol C-693-1, C-693-2; Opus C-692-2, C-693-3, -4, -6..-10).

## Operator decisions (recommended default)
1. Sol refined probe 1's read-count line conflicts with a release-and-resend fix; default: accept the variant (A sends 0, replica sends once).
2. Unchanged: land #692 then #693 back to back, deploy after #693 with migrations.

## HANDOFF
Done 11:41 PDT. #693 READY FOR AUDIT at cc0a167f (all PR checks green); #692 untouched at 346cf4a8. Next: Opus PUSH3 reviews #692 + #693,
Sol posts a #693 delta. Notify line written; lock ops/lanes120/locks/push released; ci/B-PUSH3-120-* branches deleted; worktree removed
(local branch wip/B-PUSH3-120-693 kept in the clone). No merges, deploys or production actions.
