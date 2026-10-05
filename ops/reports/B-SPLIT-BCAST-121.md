# B-SPLIT-BCAST-121 (agent 121) — split of growth-project-backend#659 (A4 broadcasts) + fix round 1

Status 13:50 PDT 10-05: DONE for this round. Five draft PRs open, FIX ROUND 1 (OPENING) + READY FOR AUDIT posted on each, superseded comment on #659 (left open). CI queued at every head (GitHub Actions runner incident); no CI result yet.

## PRs (stack, land as one)
| PR | Title | Head | Lines | Base |
|---|---|---|---|---|
| #726 | BCAST split 1/5: schema, migration, flag, error codes (inert) | b5501a89611844fc43717084d887e604af33037a | 642 | main |
| #727 | BCAST split 2/5: segments, recurrence, send-time scope, cards | 15cf8e5c0f2e3e6de19a0a8f58c0c1ff6a4f76a5 | 1,221 | #726 |
| #728 | BCAST split 3/5: broadcasts / saved replies / client tags services | 1dd798ab36e90dbb6b3719b7a4ae13883797167f | 1,162 | #727 |
| #729 | BCAST split 4/5: dispatcher | 82a28bf2dbbe52b516e30fda1d22959ea0f87b42 | 1,114 | #728 |
| #730 | BCAST split 5/5: routes, module, live coverage | e97c472f00cdecbce2e5f1a680e05b1744c14715 | 865 | #729 |

Comments: #726 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/726#issuecomment-6002660383 ; #727 ...#issuecomment-6002660606 ; #728 ...#issuecomment-6002660841 ; #729 ...#issuecomment-6002661137 ; #730 ...#issuecomment-6002661418 ; #659 superseded ...pull/659#issuecomment-6002661723.

Provenance: #659 @ fa9a7cbd + main 5da537d6 = plain merge 03c5d731 (no textual conflicts). Fixed reference cb87282a (branch agent121/bcast-split-0-merged-reference). Tree of #730 head == tree of cb87282a == 6b89e8e23a831749b8fdd2604b9041d164714118. Main-merge resolutions (semantic): (1) account-deletion manifest: six delete decisions (main erasure gate red on 03c5d731: 2 failed); (2) dispatcher log calls via describeFailure (main no-pii-in-logs red on 03c5d731).

## Findings
Fixed: A-659-6 (idempotency namespace tenant+author+key), A-659-7 (send-time author authority, FOR SHARE locks), B-659-1 (run payload frozen at claim; started one-off immutable; series edits/resume skip claimed local day), B-659-8 (broadcast row FOR SHARE fence), B-659-9 (flag re-read per phase/delivery and at write); C-659-2 (manifest) and C-659-3 (attempts count failed sends only) on the same lines.
Edge-case freeze (A2, 13:29): B-659-8 and B-659-9 are C (edge, deferred to 10k clients); fixes were already written and tested, kept. Open Bs: none.
Evidence: failing-before logs ops/aud-121/B-SPLIT-BCAST-121/before_*.log (dispatcher 18/28 failed, service 7/16, scope 6/6, erasure 2, no-pii 1); after: all targeted specs pass locally (per-piece logs piece*_jest.log, piece*_tsc.log). Lane run 37370113404 canceled (queued in incident; local evidence covers it). Live spec (4 new Postgres cases) runs only in community-live-tests of PR CI: not yet run.

## Follow-ups (C)
- C-659-4: head editing a sub-coach's broadcast validated against head roster — src/broadcasts/broadcasts.service.ts:276; validate with author's scope.
- C-659-5: copies written via tx.coachMessage.create — src/broadcasts/broadcast-dispatcher.service.ts:419 (skips messaging.sent audit, AI-context invalidation, PTM); push_status left pending on crash after commit (:439-454); replay compares only body (broadcasts.service.ts:266). Route through the MessagingService send primitive.
- C-659-10: live RLS asserts one forbidden INSERT — test/broadcasts/broadcasts-dispatch.live.spec.ts:508; assert UPDATE/DELETE per table and role.
- Migration header names a missing spec — migration.sql:12; name broadcasts-dispatch.live.spec.ts.
- B-659-8, B-659-9: C (edge, deferred to 10k clients) under A2 (already fixed).

## Mobile day-1 gaps (mobile main a32058d7, read only)
No mobile screen calls the broadcasts API: no references to /coach/broadcasts, saved-replies, client-tags or message cards under src/. Only src/types/wave11.ts:216 names an 'announcement' kind. Missing for day 1: coach broadcast composer + list/pause/cancel screens (src/screens/coach/), API client (src/api/), saved replies picker in the coach thread (src/screens/coach/MessagesScreen.tsx and thread screen), client tag editor (coach client detail), card rendering in client thread (src/screens/client/ messages). Flag stays off until built.

## Operator decisions needed
1. Erased author's broadcasts are deleted (not detached as #659's body said). Default: keep delete.
2. Migration 20270304000000 edited in place and sorts before already-merged later migrations. Default: keep the name (never applied).
3. Keep the already-built B-659-8/B-659-9 fixes despite A2. Default: keep.
4. READY FOR AUDIT posted with CI queued (runner incident). Default: audit now, CI cited when it finishes.

## HANDOFF
Heads: #726 b5501a89, #727 15cf8e5c, #728 1dd798ab, #729 82a28bf2, #730 e97c472f (full shas above). Done: split, fix round 1, comments, superseded note. Left: watch PR CI (CI, community-live-tests incl. 4 new live cases, Schema parity, Migration Dry-Run, CodeQL/Danger/SBOM on #726 only); if a red is a regression, fix in the owning piece with one push per PR; lens audits of #726-#730; mobile day-1 work above. Open Bs: none. Flags unchanged. Worktrees removed, lock released, ci/B-SPLIT-BCAST-121-before deleted.
