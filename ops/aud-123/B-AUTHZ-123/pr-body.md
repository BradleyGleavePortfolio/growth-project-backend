## What

Two access fixes from the W3-11 access-control scout (S-AUTHZ-123, agent 123). Backend only, no schema change, no flag change.

### B-AUTHZ-1 — cohort member assignment no longer reaches foreign users

`POST /api/community/cohorts/:cohortId/members` used to resolve the body `user_id` / `email` across the whole platform, return that user's full name and email, and upsert an active membership (and lift a workspace ban) for anybody.

Now, before any lookup data is returned or any row changes, the target must be either:

- a live client of the workspace's owning coach (`coach_id` = workspace coach, `deleted_at` null), or
- someone already active in that workspace (an active `CommunityMembership` in any of its cohorts).

The platform owner (role `owner`) keeps an unrestricted override. If the target is foreign or unknown, the response is the same coded `404 { error: 'not_found', code: 'community.cohort.user_not_found' }` in both cases, so it never confirms that another coach's client exists. The mobile error contract already has that code. No membership, invite or ban row is written.

- `src/community/cohorts/community-cohort-members.repository.ts`: `AssignTargetScope` + scoped `findUserById` / `findUserByEmail`.
- `src/community/cohorts/community-cohort-members.service.ts`: `assignScope()` (owner -> null, coach -> workspace coach + workspace id), passed to both lookups.

### B-AUTHZ-2 — legacy block list follows the first-name privacy contract

`GET /api/users/blocks` returned `blocked.name` verbatim. For client (student) targets it now returns `memberFirstName(name)`, the same rule the community block list already uses. Coach, owner and sub-coach targets keep the name shown on their profile. Block and unblock behave exactly as before, with no new gate or relationship check.

- `src/messages-safety/messages-safety.service.ts`: `blockedDisplayName()`.

## Tests (fail on main, pass here)

- `test/community/cohorts/community-cohort-members.service.spec.ts`: refuses another coach's client by user_id (coded 404, no email in the response, no ban lift, no upsert); refuses by email; still assigns the coach's own client; the platform owner can override.
- `test/community/cohorts/community-cohort-members.repository.spec.ts`: the scoped where-clause for both lookups.
- `test/messages-safety.service.spec.ts`: a blocked client is listed as "Carol" (no "Q Member"); a blocked coach keeps the full profile name.

Local runs (one file at a time via heavy.sh): on main 6 new tests fail; on this branch all 3 files pass (21/21, 4/4, 33/33). ESLint is clean on the 6 changed files. Full tsc and the full suite run in this PR's CI.

Out of scope: B-AUTHZ-3 (leaderboard) is in #747, and `getLeaderboard` is untouched.
