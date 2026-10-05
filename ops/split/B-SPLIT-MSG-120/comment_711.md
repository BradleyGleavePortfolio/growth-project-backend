FIX ROUND 1 (OPENING, B-SPLIT-MSG-120, agent 120) — growth-project-backend#711 @ 5a7c41e89ff6f79fc02fd8bab06e7b83bd11d666

MSG split 4/4 of #660 (A3-MSG-CORE messaging inbox). Split only: no behaviour change beyond the main-merge resolution. Size 388 changed lines (under 1,500).
Contents: coach + client routes (all new routes behind MessagingCoreV2Guard), DTOs, Idempotency-Key header resolution, README, last spec case.
Stack: #708 (main) <- #709 <- #710 <- #711. Land as one stack (rule 11).

Top-tree equality: `git rev-parse 5a7c41e8^{tree}` = `git rev-parse cd130ae4^{tree}` = `2ba9ed0815f36b6b0b7d20b7cd4ba252fb2ff749` (M = #660 @ 60556485 merged with main ee55f814, branch `agent120/msg-split-0-merged-reference`); `git diff cd130ae4 5a7c41e8` is empty.

| Finding | Change | Commit | Test |
|---|---|---|---|
| none (opening; #660 was never reviewed) | split + main-merge resolutions listed in the PR body (items 1-5, each in the piece that owns the file) | 5a7c41e8 | local targeted runs below; full suite in this PR's CI |

Prior probes from both lenses: none exist for #660 (no AUDIT comments, no ops/aud-*/ notes); nothing to replay.
Local (heavy.sh, one at a time, this exact tree): messaging-core-v2 37/37, coach-messaging-roles 5/5, entitlement-guards-mounted 17/17, rate-limit 39/39, roles-enforced 2/2; tsc 0 errors.

Money list self-check (stack-wide, code in splits 2-4; this stack moves no money):
- webhook order/redelivery: n/a (no webhook code); send replay is idempotent on (sender_id, client_message_id) and the welcome-job key.
- concurrency/lock order: unique-index race replays the winner (P2002); pin caps under pg_advisory_xact_lock per thread / per user; edit and delete are conditional writes (a concurrent delete wins).
- terminal states: tombstone delete is idempotent; deleted account: manifest entries for CoachThreadState and CoachMessage.deleted_by_id/pinned_by_id.
- pagination/completeness: inbox keyset cursor (no gaps or repeats, spec case); no external lists.
- currency/minor units: n/a.
- copy truth: messaging.* error messages say what happened and the next action; no first person, no exclamation marks.

CI at this head: 10 of 11 checks green; one red (community-live-tests).
- build-and-test etc.: build-and-test green, 13,224 tests passed, 0 failed (https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37347370315/job/111889231893)
- community-live-tests: RED, inherited from #660 (same single case at 60556485, run 37082428163): `coach-thread-state-rls.live.spec.ts` "pin / reply columns are visible to participants and to no one else" (https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37347370315/job/111889231866). Cause is pre-existing on main: no migration in the chain enables RLS on "CoachMessage" (only the loose `prisma/migrations/rls_fitness_backend.sql` does), so the existing participant policy is inert on a chain-migrated DB. No piece turns it green; operator decision D1 (report B-SPLIT-MSG-120). Every other required check is green.

READY FOR AUDIT
