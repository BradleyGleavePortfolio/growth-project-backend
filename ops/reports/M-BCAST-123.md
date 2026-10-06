# M-BCAST-123 (agent 123, Claude Opus 5.5) — mobile coach broadcasts composer

Started 19:42 PDT 10-05. Time box 80 minutes (ends about 21:02).

## PR
| PR | Title | Head | Lines | Base |
|---|---|---|---|---|
| growth-project-mobile#388 | feat(broadcasts): coach broadcasts list and composer | 6ad27c87592fcfca38c7d145643c8deed1fb163f | 1,318 (10 files, tests included) | main a33e5d75 |

One PR, no split needed (under 1,500). Branch agent123/mobile-broadcasts-api-list. PR body: ops/aud-123/M-BCAST-123/pr_body.md.

## What it does
- src/api/broadcastsApi.ts: zod-parsed client for list, segment-options, preview, create (Idempotency-Key), cancel/pause/resume;
  503 `broadcasts.disabled` and bare 404 read as off (`broadcastsAvailable`, `broadcastsOff`); `broadcastErrorMessage` shows coded
  backend sentences, else names network / 429 / 5xx.
- src/screens/coach/broadcasts/: CoachBroadcastsScreen (Scheduled / Recurring / Sent, stats, cancel confirmed, pause/resume),
  BroadcastComposerScreen (text with {first_name}, audience all/tag/package/program with live count, send now / schedule, repeat
  daily/weekly/monthly at a time, confirm sheet), BroadcastsEntry (Messages header button, hidden unless the probe succeeds),
  broadcastFormat.ts (pure helpers).
- CoachNavigator: CoachBroadcasts + CoachBroadcastComposer in the Clients stack with native back headers.
- MessagesScreen (legacy) and CoachInboxV2 headers render BroadcastsEntry. CoachInboxV2.test mocks the entry (call-order asserts).
- Client side: none needed. The dispatcher writes ordinary CoachMessage rows into each client's coach thread (checked
  backend src/broadcasts/broadcast-dispatcher.service.ts:418-421); no messaging endpoint returns cards, so cards are not offered.

## Evidence (local, via heavy.sh)
- jest src/screens/coach/broadcasts/__tests__/broadcasts.test.tsx: 11/11 pass (new modules, so all fail before).
- jest src/screens/coach/__tests__/CoachInboxV2.test.tsx: 10/10 pass.
- eslint on changed files: 0 errors (2 pre-existing warnings in MessagesScreen.tsx).
- tsc --noEmit over a temp tsconfig listing the changed files (641 src files pulled in): 0 errors.
- Full suite / full tsc / lint: PR CI.

## Decisions (defaults taken)
1. Tier T4 (member content fan-out). Default: keep T4, both lenses.
2. No card attach in the composer: clients cannot see cards today (no messaging read returns coach_message_cards). Default: follow-up
   after a backend read change.
3. Saved replies picker skipped: nothing in the app creates saved replies, so a picker alone is always empty. Default: follow-up
   (picker + "save as reply", about 120 lines).
4. Client tag editor and broadcast edit (PATCH) not built. Default: follow-up; cancel and re-create covers edits.
5. Entry lives in the coach Messages header and routes into the Clients stack with `initial: false` (keeps ClientsList as root).
6. Two pushes before the opening comment: 56c7ea7a (CI all green, run 37407378691) then 6ad27c87 (self-review found the B-332-7
   style dead end: without `initial: false` a never-opened Clients stack is built with only Broadcasts and the Clients tab loses the
   client list; also pickers now open in place, iOS inline + Done). No audit had started, so no verdict was voided. Default: accept.

## Status (20:23 PDT, DONE)
- 20:06 PR opened at 56c7ea7a; CI green 20:14. 20:15 pushed 6ad27c87 (pre-audit fix above); CI all green 20:22
  (Typecheck, lint, test run 37408085125; CodeQL + Analyze run 37408085084).
- 20:22 FIX ROUND 1 (OPENING) ... READY FOR AUDIT posted:
  https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/388#issuecomment-6008675359
- Notify: ops/lanes123/notify/M-BCAST-123.txt. Open Bs: none known. A/B/C: 0/0/0 (no audit yet).

## Follow-up Cs (builder-noted)
- C: card attach + client card render need a backend read that returns coach_message_cards first.
- C: saved replies picker + "save as reply" (about 120 lines).
- C: client tag editor on coach client detail (PUT /coach/clients/:id/tags), so tag audiences have tags to pick.
- C: edit a scheduled broadcast (PATCH /coach/broadcasts/:id); today cancel and re-create.

## HANDOFF
- State: DONE for the opening round. PR growth-project-mobile#388 @ 6ad27c87592fcfca38c7d145643c8deed1fb163f, CI all green, READY FOR
  AUDIT comment posted (link above). Worktrees removed (wt/M-BCAST-123-1, wt/M-BCAST-123-be); the PR branch
  agent123/mobile-broadcasts-api-list stays. No ci/* or audit/* branches, no locks, no claims created. Local check config kept at
  ops/aud-123/M-BCAST-123/tsconfig.bcast-check.json; PR body and comment text in the same folder.
- Next for the operator: lens pair (Opus + Sol, T4) on #388 at 6ad27c87; one fix round if a B lands (re-create a worktree from the
  branch: `git -C /home/user/workspace/growth-project-mobile worktree add /home/user/workspace/wt/M-BCAST-123-2 agent123/mobile-broadcasts-api-list`,
  link deps with ops/link_deps.sh mobile, one push, FIX ROUND 2 comment). After merge + device pass: backend manifest flip
  FEATURE_COACH_BROADCASTS -> true (separate backend PR; not this job).
- If the head moved: re-check `gh pr view 388 --json headRefOid` before any verdict.
