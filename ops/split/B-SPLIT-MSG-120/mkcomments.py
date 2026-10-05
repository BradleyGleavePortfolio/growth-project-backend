import json, sys
heads = json.load(open('heads.json'))   # {"708": sha, ...}
runs = json.load(open('runs.json'))     # {"708": {"ci": url, "live": url}}
M='cd130ae4cd4e0f72657110e980fc1ccd73ab5910'
info = {
 708: (1, 459, "migration 20270303000000 + down.sql, schema.prisma, account-deletion manifest entries, live RLS spec + its ci.yml line",
       "erasure-manifest-coverage 7/7, manifest-fk-order 10/10, messaging.service 26/26, feature-flags service 9/9; tsc 0 errors"),
 709: (2, 1141, "FEATURE_MESSAGING_CORE_V2 (env rule, fly desired state, runbook, /me/feature-flags), guard, messaging.* errors, thread-updated ping, MessagingService (idempotent insert, reply, read-up-to, unread without tombstones, mute-aware push), spec subset",
       "messaging-core-v2 15/15, messaging.service 26/26, messaging-voice 11/11, welcome-message-idempotency 7/7, no-pii-in-logs 11/11, env-validation 50/50, fly-env-manifest 67/67, env-discovery 181/181, env-registration 30/30, feature-flags 9/9 + 9/9; tsc 0 errors"),
 710: (3, 1092, "MessageActionsService, MessagingInboxService, module providers, spec cases for edit/delete/pins/mute/inbox pin/unified inbox",
       "messaging-core-v2 36/36, no-pii-in-logs 11/11; tsc 0 errors"),
 711: (4, 388, "coach + client routes (all new routes behind MessagingCoreV2Guard), DTOs, Idempotency-Key header resolution, README, last spec case",
       "messaging-core-v2 37/37, coach-messaging-roles 5/5, entitlement-guards-mounted 17/17, rate-limit 39/39, roles-enforced 2/2; tsc 0 errors"),
}
for n,(k,size,what,local) in info.items():
    h = heads[str(n)]
    top = ""
    if k == 4:
        top = f"\nTop-tree equality: `git rev-parse {h[:8]}^{{tree}}` = `git rev-parse {M[:8]}^{{tree}}` = `2ba9ed0815f36b6b0b7d20b7cd4ba252fb2ff749` (M = #660 @ 60556485 merged with main ee55f814, branch `agent120/msg-split-0-merged-reference`); `git diff {M[:8]} {h[:8]}` is empty.\n"
    c = f"""FIX ROUND 1 (OPENING, B-SPLIT-MSG-120, agent 120) — growth-project-backend#{n} @ {h}

MSG split {k}/4 of #660 (A3-MSG-CORE messaging inbox). Split only: no behaviour change beyond the main-merge resolution. Size {size:,} changed lines (under 1,500).
Contents: {what}.
Stack: #708 (main) <- #709 <- #710 <- #711. Land as one stack (rule 11).
{top}
| Finding | Change | Commit | Test |
|---|---|---|---|
| none (opening; #660 was never reviewed) | split + main-merge resolutions listed in the PR body (items 1-5, each in the piece that owns the file) | {h[:8]} | local targeted runs below; full suite in this PR's CI |

Prior probes from both lenses: none exist for #660 (no AUDIT comments, no ops/aud-*/ notes); nothing to replay.
Local (heavy.sh, one at a time, this exact tree): {local}.

Money list self-check (stack-wide, code in splits 2-4; this stack moves no money):
- webhook order/redelivery: n/a (no webhook code); send replay is idempotent on (sender_id, client_message_id) and the welcome-job key.
- concurrency/lock order: unique-index race replays the winner (P2002); pin caps under pg_advisory_xact_lock per thread / per user; edit and delete are conditional writes (a concurrent delete wins).
- terminal states: tombstone delete is idempotent; deleted account: manifest entries for CoachThreadState and CoachMessage.deleted_by_id/pinned_by_id.
- pagination/completeness: inbox keyset cursor (no gaps or repeats, spec case); no external lists.
- currency/minor units: n/a.
- copy truth: messaging.* error messages say what happened and the next action; no first person, no exclamation marks.

CI at this head: {runs[str(n)]['state']}
- build-and-test etc.: {runs[str(n)]['ci']}
- community-live-tests: RED, inherited from #660 (same single case at 60556485, run 37082428163): `coach-thread-state-rls.live.spec.ts` "pin / reply columns are visible to participants and to no one else" ({runs[str(n)]['live']}). Cause is pre-existing on main: no migration in the chain enables RLS on "CoachMessage" (only the loose `prisma/migrations/rls_fitness_backend.sql` does), so the existing participant policy is inert on a chain-migrated DB. No piece turns it green; operator decision D1 (report B-SPLIT-MSG-120). Every other required check is green.

READY FOR AUDIT
"""
    open(f'comment_{n}.md','w').write(c)
print('ok')
