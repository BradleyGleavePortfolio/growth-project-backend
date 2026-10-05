# B-SPLIT-ROMANCHATS-121 (agent 121, Claude Opus 5.5 builder): split mobile #331 Roman chats

Status: 5 split PRs open, FIX ROUND 1 (OPENING) posted; CI queued (GitHub Actions runner incident). Times PDT from `date`.

## Inputs read
- _COMMON_121 (items 1-12), JOBS121 entry B-SPLIT-ROMANCHATS-121, TGP_SOURCE_OF_TRUTH A1, A6 (A6.4 Roman), A9.1, A9.2 "Roman day-1 jobs".
- #331 verdicts in full (copies in ops/aud-121/B-SPLIT-ROMANCHATS-121/c*.md): Opus RC + Sol BLOCK at a224e5bd, Sol BLOCK + Opus RC at ec2857ba,
  FIX ROUND 2 5971975848, Sol BLOCK 5972029545 + Opus RC 5972101193 at c621770f, Sol BLOCK 5972195886 at 5b58a121.
- handoffs/op-115/reports/B-MOB-A-115.md and patches/331-round3-wip.patch (agent 115's unpushed round-3 work: tests reused, source replaced).

## Work
1. Worktree wt/B-SPLIT-ROMANCHATS-121-1 at #331 head 5b58a121; merged main b79ca594 -> fc82b025 (tree e88a4b57).
   One conflict, src/services/authActions.ts (merge-tree 0454f66f vs result: 3 hunks): main's health-retiring signOut wrapper kept;
   #331's SignOutOptions interface and `opts` threaded into signOutWhileHealthRetires. Health retirement is storage-only (no API call),
   so the fenced refresh-failure sign-out cannot self-wait.
2. Fix commit d3b6967d (tree 3a22bc53): Sol A-331-7 round 3 (legacy migration outside the fence) and Opus B-331-9 step 1.
   - sessionFence.ts: runSessionMigration(expected, copy): waits only for 'write' holds, refuses when generation moved or anyone holds
     the fence (incl. a sign-out), holds the fence for the whole copy, does not move the generation (same session).
   - secureStorage.ts doMigration: generation read before the legacy read; session-key copy inside runSessionMigration, re-reads
     SecureStore and never overwrites a newer value, legacy removal inside the hold; refused -> null. Non-session keys unchanged.
   - Tests: new secureStorage.migration.fence.test.ts (5 counterexamples + 3 upgrade controls); sessionFence.refresh.test.ts +2
     (Opus B-331-9 access-write-in-flight, Opus P2 sign-out removal in flight; from the 115 WIP patch).
3. Split (each file verbatim from F = d3b6967d; top tree == F):
   | Piece | PR | Head | Lines (tests/src) |
   |---|---|---|---|
   | 1/5 auth-fence (base main) | #372 | 61141c05c6fe5281a7a4c61370e3240163409f9e | 1,456 (800/656) |
   | 2/5 api | #373 | 70c24e710b9c5dddc49d87e0ea3e9e84298c9a26 | 923 (611/312) |
   | 3/5 state | #374 | 0ae9013fe06cbd1d5f1dbaf6ad6072f72f92358a | 823 (0/823) |
   | 4/5 list-screen | #375 | a10123f222013416edff450b15bd1bd34952dd90 | 1,339 (684/655) |
   | 5/5 transcript-entry | #376 | 6fabb1f989a985bf187552c2c8ad0f93d5486d4a | 896 (350/546) |
   File lists: ops/aud-121/B-SPLIT-ROMANCHATS-121/pieces.txt. Bodies: .../bodies/p1..p5.md (generator mkbodies.py).
   3/5 has no test file: the hook/copy/tracker are exercised only through the list-screen test (684 lines, kept whole in 4/5).

## Comments posted (13:29 PDT)
- FIX ROUND 1 (OPENING) + READY FOR AUDIT: #372 issuecomment-6002345966, #373 -6002346374, #374 -6002346812, #375 -6002347222,
  #376 -6002347560. Superseded note on #331: issuecomment-6002353921 (PR left open).

## Evidence
- Failing-before (fc82b025 + new tests, no fix), local heavy.sh: 5 failed / 16 passed; the 5 are exactly the round-3 counterexamples
  (log local-before.log). Lane ci/B-SPLIT-ROMANCHATS-121-1 run 37367260302 (same tree) pushed 13:02 PDT, queued.
- After (F): 6 suites / 50 tests pass (local-after-auth.log); tsc --noEmit clean (local-tsc-F.log); eslint on all changed files clean.
- Prior probes replayed verbatim on F (fetched by run head SHA from deleted audit branches; copies in prior-probes/):
  Sol r3 auditSol331SessionPublish 12/12 pass; Sol r2 auditSol331MidSigninPair 10/10; Opus r2 zzAudOpus331R2Probe 3/3.
  Sol 112 probes (a224e5bd seams: no stored credential, unbound deleteAll()) do not reach their preconditions: 1/8 pass (labels),
  7 stop at setup; their adapted versions are the suite blocks "Sol A-331-4", "Sol B-331-5", "Sol B-331-6" (closed by both lenses).
- Money list self-check: no money paths. Concurrency and lock order: the session fence is the only lock; migration waits only for
  write holds, never under a sign-out; no holder awaits a migration. Terminal states: refused copy returns null (fail closed).
  Pagination: unchanged (keyset cursor, tombstones). Copy truth: unchanged; no copy claims notes or other data are deleted.

## Follow-ups (C)
- C-RC121-1 (copy, later): when Roman memory/notes ship (v1.1, A6.4 "notes survive chat deletion"), the Delete / Delete all confirm
  must say Roman's notes are kept (src/screens/settings/romanChatsCopy.ts confirmOneBody / confirmAllBody). No Roman notes model on
  backend main today, so the current copy is true.
- C-RC121-2 (naming): two modules named sessionFence (src/services/sessionFence.ts for credentials, src/services/health/sessionFence.ts
  for health work); rename the health one (e.g. healthWorkFence) in a later PR to avoid import mix-ups.

## Operator decisions
1. Land #372-#376 as one train after dual APPROVE on all five (default: yes, one train, bottom-up).
2. 3/5 (#374) has no test file of its own; lenses read it with 4/5's tests (default: accept).

## HANDOFF
- Remaining: wait for PR CI on #372-#376 and lane 37367260302; cite them in a short CI note on each PR (no new push needed if green).
- If a PR's CI fails: fix in the piece that owns the file (one push per PR per round), restack upward merge-only.
- Worktrees: wt/B-SPLIT-ROMANCHATS-121-{1,2,3,4}. Lane branch ci/B-SPLIT-ROMANCHATS-121-1. Remove/delete when CI evidence is cited.
