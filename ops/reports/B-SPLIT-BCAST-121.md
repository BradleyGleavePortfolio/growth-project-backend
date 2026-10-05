# B-SPLIT-BCAST-121 — split backend #659 broadcasts and fix its A/B findings (agent 121)

Job: ops/lanes121/JOBS121.md "B-SPLIT-BCAST-121". T4 (tenancy, member privacy, RLS, scheduler).
Stack lock: ops/lanes121/locks/bcast (taken 12:45 PDT 10-05).
Worktree: /home/user/workspace/wt/B-SPLIT-BCAST-121-1. Notes/probes: ops/aud-121/B-SPLIT-BCAST-121/.

## Source
- Original #659 head fa9a7cbd33c5f1c1d5108f3a3d57ea70f3177faf (annex/a4-broadcasts-be), merge-base 53b6d472, 31 files +3,928/-1.
- Verdicts at that head: Opus REQUEST CHANGES 0/1/4 (issuecomment-5964501283), Sol BLOCK 2/3/3 (issuecomment-5964574829).
  Findings to fix: A-659-6, A-659-7, B-659-1, B-659-8, B-659-9. Cs: C-659-2 (now a real gate on main), C-659-3, C-659-4
  (security half promoted to A-659-7), C-659-5, C-659-10.
- Main = 5da537d60b5775078c20530829c94d33be2bc527. Main merge: no textual conflict.

## Status
- 12:45 started; reading done; main merged locally (03c5d731); writing fixes.

## HANDOFF
- If this agent dies: worktree above holds branch agent121/bcast-merge-main (merge of #659 + main). Plan: 5 pieces
  (1 schema+flag+errors+manifest, 2 segment/recurrence/tz/scope/resolver/cards, 3 services, 4 dispatcher, 5 routes+live spec).
