# AUD-OPUS-R3A-123 — lens queue R3A, Claude Opus 5.5 lens (agent 123)

Started 21:48 PDT 10-05 (operator mail), time box 45 min (ends 22:33); queue finished 21:58. Re-read _COMMON_123 rules and the
"Lens queue R3A" entry (incl. the 21:50 update adding b#746 full head and b#748). Sol lens comments/notes NOT read. No code changes,
pushes, merges, worktrees or CI lanes. Claims in ops/lanes123/claims/backend-<n>-<head8>-opus. Notify files:
ops/lanes123/notify/AUD-OPUS-R3A-123-b<n>.txt. Verdict texts + probe: ops/aud-123/AUD-OPUS-R3A-123/.

## Verdicts (heads verified right before each post; all required checks green, mergeState CLEAN at each head)
| # | PR | Head | Verdict | A/B/C | Comment |
|---|---|---|---|---|---|
| 1 | b#747 legacy leaderboard opt-in + removed viewer | ae1c103333361b3442c102b7bde1af4f3c950762 | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/747#issuecomment-6009596463 |
| 2 | b#744 Roman shares AI guide crisis lists | cda23212514b60adbfffef0e9add310a4c7f541a | REQUEST CHANGES | 0/2/2 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/744#issuecomment-6009586369 |
| 3 | b#745 invite landing per-platform buttons | 8ad33e4bbc1d826e2c896dc668e0fa86750c6f79 | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/745#issuecomment-6009601875 |
| 4 | b#742 feature-off 503s out of Sentry | c911aa95106bb68622d5c2797166fea270a16fcb | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/742#issuecomment-6009607507 |
| 5 | b#743 Codes/Broadcasts/coachless flags (MERGE HELD) | 3493baaa23f7155b1ee6b1f0ad25f5fb5acb1d27 | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/743#issuecomment-6009616494 |
| 6 | b#746 data export day-1 data | 31ae184dc06891e1818cd5b818a752d0fea3a4cd | APPROVE | 0/0/1 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/746#issuecomment-6009626052 |
| 7 | b#748 Sign in with Apple audience + nonce | f6b3e1915c4ff49453ac06bd9958cbd18aa136c9 | APPROVE | 0/0/2 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/748#issuecomment-6009639096 |

## b#744 Bs (probe: both router files, main vs head, types stripped in memory, node regex eval; probe744/)
- B-744-1: Roman loses its broad "overdose" 911 rule; the shared AI guide rules need a listed person + lead-in. emergency -> normal on
  Roman for "possible overdose", "is this an overdose?", "I think it's an overdose", "overdose", "she might be overdosing",
  "my cousin/uncle/aunt/grandpa/fiance/teammate/coworker/neighbor ... overdosed/overdosing", "a guy at my gym is overdosing".
  Story: a client types "my teammate is overdosing, what do I do" to Roman and gets a model reply instead of "call 911 now".
- B-744-2: "I cut myself again" (self_harm -> normal) and "I hurt myself again last night" (self_harm -> injury_pain) on Roman.
- Gym controls and every #736/#739 phrase tried hold; Roman gains hang/jump/"want it all to end".
- Cs: "thoughts of suicide run through my head" now normal (drill exclusion); "my teammate passed out and is not breathing" is
  medical_scope on main and head.

## Other Cs
C-746-1 large wearable_samples archive (edge). C-748-1 no Apple nonce until mobile sends one. C-748-2 audience closed set is bundle id only.

## Operator decisions (recommended defaults)
1. b#744: fix round for B-744-1/2 (widen PERSON + lead-ins, or person-free overdosed/overdosing; noun forms; "cut myself again")
   before merge. Default: yes, one round; Roman stays on with main's router meanwhile (main over-routes gym talk, which errs safe).
2. b#743 merge held for the owner; verdict APPROVE so it can merge as soon as he says go.
3. b#748 after merge: env-sync plan should show 1 set + 1 unset; then env-truth APPLE_AUDIENCES shape check pass, then iOS device pass.

## HANDOFF
- State: done 21:58 PDT. All seven Opus verdicts posted at exact heads. Nothing in flight; no worktrees/branches/locks/lane runs.
- Next: delta re-review of b#744 when its FIX ROUND 2 is posted (check only B-744-1/2 and the changed lines; re-run
  ops/aud-123/AUD-OPUS-R3A-123/probe744 with the new head files: copy the two router files into pr/, `node strip.js`, `node run.js < od.txt`).
