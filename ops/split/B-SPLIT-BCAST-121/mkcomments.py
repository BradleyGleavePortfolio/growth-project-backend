import json
heads=json.load(open('heads.json')); prs={1:726,2:727,3:728,4:729,5:730}
R='https://github.com/BradleyGleavePortfolio/growth-project-backend'
OPUS=R+'/pull/659#issuecomment-5964501283'; SOL=R+'/pull/659#issuecomment-5964574829'
LANE=R+'/actions/runs/37370113404'
sizes={1:642,2:1221,3:1162,4:1114,5:865}
rows={
1:"""| A-659-6 (Sol) | persisted idempotency namespace widened to (tenant, author, key): schema 7838-7840, migration 127 | b5501a89 | service + live cases in splits 3 and 5 |
| B-659-1 (Opus, Sol) | run columns body/card/segment/urgent hold the payload frozen at claim: schema 7866-7872, migration 53-56; codes `broadcast.already_sending`, `broadcast.series_started` | b5501a89 | dispatcher + service + live cases in splits 3-5 |
| C-659-2 (Opus) | main-merge resolution 1: six manifest decisions (delete), main's erasure gate red on the plain merge, green here | b5501a89 | erasure-manifest-coverage: before 2 failed / 7, after 7/7 |""",
2:"""| A-659-7 (Sol) | `lockSendAuthority`: author, client, membership row and open assignment read FOR SHARE inside the message transaction | 15cf8e5c | broadcast-scope.spec 6 cases: before 6 failed (method absent), after 6/6 |""",
3:"""| A-659-6 (Sol) | create and the P2002 loser replay only the caller's own (tenant, author, key) row; replay re-checks tenant and author | 1dd798ab | broadcasts.service.spec: sibling sub-coach and head-coach collisions, before 2 failed, after pass; same-author replay and P2002 loser pass both sides (regression guards) |
| B-659-1 (Opus, Sol) | update refuses a started one-off and series-to-one-off; series edits and resumes start after the last claimed local day; a started one-off is never re-armed | 1dd798ab | 6 cases: before 5 failed, after 6/6 |""",
4:"""| B-659-1 (Opus, Sol) | claim CAS pins `updated_at` and freezes the payload on the run; fan-out and every copy use the run | 82a28bf2 | 4 cases: before all failed, after pass |
| A-659-7 (Sol) | `fenceSend` calls `lockSendAuthority`; a removed author fails or skips, never sends as the head coach | 82a28bf2 | 4 cases: before all failed (each delivered), after pass |
| B-659-8 (Sol) | `fenceSend` reads the broadcast row FOR SHARE first: canceled skips, paused parks, no message/card/realtime/push | 82a28bf2 | 3 cases: before all failed (delivered), after pass |
| B-659-9 (Sol) | flag re-read at every phase, per occurrence, run and delivery, and last inside the message transaction; parks without spending an attempt | 82a28bf2 | 5 cases incl. the real cron entry: before all failed, after pass |
| C-659-3 (Opus, same lines as B-659-9) | the claim no longer counts an attempt; a failed send counts one | 82a28bf2 | 2 cases: before failed, after pass |
| main-merge resolution 2 | `describeFailure(err)` in both log calls | 82a28bf2 | no-pii-in-logs: before 1 failed / 11, after 11/11 |""",
5:"""| B-659-1, B-659-8, A-659-6, A-659-7 | Postgres coverage: pause mid-run / edit refused / resume gives one copy per recipient with one text; cancel committed while a copy waits on FOR SHARE; two sub-coaches with one key; reassignment committed while a sub-coach copy waits | e97c472f | 4 new cases in broadcasts-dispatch.live.spec.ts (community-live-tests, this PR's CI; no Postgres in the ci-lane) |""" }
local={
1:"tsc (targeted project: src/broadcasts, test/broadcasts, manifest, messaging.service, app.module) 0 errors; erasure-manifest-coverage 7/7; manifest-fk-order 10/10; env-validation 50/50; fly-env-manifest 67/67; env-registration 30/30; env-discovery 181/181; locked_defaults 3/3; restore-schema-declared-objects-migration 21/21.",
2:"tsc 0 errors; segment 11/11; recurrence 14/14; cards 4/4; broadcast-scope 6/6.",
3:"tsc 0 errors; broadcasts.service 16/16; messaging.service 26/26.",
4:"tsc 0 errors; dispatcher-delivery 28/28; no-pii-in-logs 11/11.",
5:"tsc 0 errors; roles-enforced 2/2; dunning-v2-lockout-allowlist-route-table 36/36; auth-guard-deletion-lockout 4/4. The live spec needs Postgres: community-live-tests in this PR's CI."}
for k in range(1,6):
    h=heads[str(k)]
    c=f"""FIX ROUND 1 (OPENING, B-SPLIT-BCAST-121, agent 121) — growth-project-backend#{prs[k]} @ {h}

BCAST split {k}/5 of #659 (A4 broadcasts), {sizes[k]:,} changed lines (under 1,500). Stack: #726 (main) <- #727 <- #728 <- #729 <- #730; land as one stack. Prior verdicts on #659 @ fa9a7cbd: [Opus REQUEST CHANGES]({OPUS}), [Sol BLOCK]({SOL}). Each finding is fixed in the piece that owns the code; the PR body lists every line that differs from #659 merged with main and why.

| Finding | Change | Commit | Test (failing before -> after) |
|---|---|---|---|
{rows[k]}

Failing-before evidence: the new unit specs run against #659 merged with main (03c5d731, specs only) in a second worktree, logs in `ops/aud-121/B-SPLIT-BCAST-121/before_*.log` (dispatcher-delivery 18 failed / 28; broadcasts.service 7 failed / 16; broadcast-scope 6 failed / 6; erasure-manifest-coverage 2 failed; no-pii-in-logs 1 failed). Same run on the ci-lane: [run 37370113404]({LANE}) (queued in the Actions incident; cited when it finishes). Sol's five probes (`ops/aud-sol-114b/659-probe.spec.js`) are not in the workspace; each boundary is rebuilt as a named case (A-659-6 sibling key, A-659-7 empty author scope while deferred, B-659-1 paused edit with a run, B-659-8 cancel during the preference await, B-659-9 flag off during occurrence processing via the real cron entry). Opus left no probe files.
Local (heavy.sh, one at a time, this tree): {local[k]}

Edge-case freeze (owner 13:29, A2): B-659-8 (cancel committed in the same instant as a send) and B-659-9 (kill switch flipped inside a running tick) are C (edge, deferred to 10k clients) under item 2; both fixes were already written and tested before the rule, so they stay in. B-659-1 and A-659-7 happen in normal use (pause, fix a typo, resume; a client reassigned while a scheduled or quiet-hours copy waits). A-659-6 is kept fixed (a short shared key such as a repeated text reveals another author's segment).

Money list self-check (stack-wide; no money moves): webhook order/redelivery n/a; concurrency and lock order: send fence order is broadcast row, author User, membership row, client User, open assignment, all FOR SHARE; pause/cancel/reassign write one of those rows each, so they serialise without a cycle; the claim CAS pins `updated_at`; terminal states: canceled skips, paused parks without spending an attempt, failed after 5 failed sends, a one-off with a run is never re-armed; pagination/completeness: fan-out resolves the frozen segment against the author's current scope and fails closed on a removed author; currency/minor units n/a; copy truth: the two new 409 messages say what happened and the next action, no first person, no exclamation marks.

Follow-ups (C), not fixed (FREEZE): C-659-4 head coach editing a sub-coach's broadcast is validated against the head roster (`src/broadcasts/broadcasts.service.ts:276`; validate with the author's scope); C-659-5 copies are written with `tx.coachMessage.create` (`src/broadcasts/broadcast-dispatcher.service.ts:419`), skipping the messaging.sent audit, AI-context invalidation and PTM, a crash after commit leaves `push_status` pending (:439-454), replay compares only the body (`broadcasts.service.ts:266`); C-659-10 live RLS covers one forbidden INSERT (`test/broadcasts/broadcasts-dispatch.live.spec.ts:508`; assert UPDATE and DELETE per table and role); migration header names a spec file that does not exist (`migration.sql:12`; name broadcasts-dispatch.live.spec.ts).

Flags: `FEATURE_COACH_BROADCASTS` unchanged (unset, off).
CI at this head: queued (GitHub Actions runner delays); the full suite and community-live-tests run in this PR's CI.

READY FOR AUDIT
"""
    open(f'comment_{prs[k]}.md','w').write(c)
s=f"""SUPERSEDED (B-SPLIT-BCAST-121, agent 121) — growth-project-backend#659 @ fa9a7cbd33c5f1c1d5108f3a3d57ea70f3177faf

This PR (3,929 changed lines) is superseded by a five-piece stacked split, each under 1,500 changed lines, with main 5da537d6 merged in once and fix round 1 for the [Opus]({OPUS}) and [Sol]({SOL}) verdicts:
- #726 BCAST split 1/5 (schema, migration, flag, error codes; inert) @ {heads['1']}, 642 lines, base main
- #727 BCAST split 2/5 (segments, recurrence, send-time scope, cards) @ {heads['2']}, 1,221 lines, base #726
- #728 BCAST split 3/5 (broadcasts, saved replies, client tags services) @ {heads['3']}, 1,162 lines, base #727
- #729 BCAST split 4/5 (dispatcher) @ {heads['4']}, 1,114 lines, base #728
- #730 BCAST split 5/5 (routes, module, live coverage) @ {heads['5']}, 865 lines, base #729

Top tree of #730 equals this PR merged with main plus the listed fixes (reference `agent121/bcast-split-0-merged-reference` @ cb87282a00ae5119851f9b4417e9f2c40046030a, tree 6b89e8e23a831749b8fdd2604b9041d164714118; plain merge 03c5d7316528bf68df182e7509deda9b07617dc6). Fixed: A-659-6, A-659-7, B-659-1, B-659-8, B-659-9, plus C-659-2 (main's erasure gate) and C-659-3 on the same lines. Open Cs are listed in each piece's FIX ROUND 1 comment.
This PR stays open for reference; do not merge it.
"""
open('superseded_659.md','w').write(s)
