AUDIT Claude Opus 5.5 — growth-project-backend#752 @ 69ad43d08f874f5a4d0122785493fd2c4d28187b — VERDICT: APPROVE

Lens AUD-OPUS-W2B-123 (agent 123), queue R3C item 1. Full review of the 211-line diff at the exact head against main. All required checks green at this head (build-and-test, community-live-tests, rls-live-tests, mwb-3-live-tests, banned casts, Danger, Schema parity, CodeQL, npm audit; deploy-readiness-gate skipped as usual). Conventional Commits title; no new casts to any/unknown/never, no empty catch.

**A: 0 | B: 0 | C: 1**

### Checked
- **B-AUTHZ-1 (cohort assign authz):** `assign()` still runs `assertWorkspaceCoach` first, then builds the target scope before any lookup or write. For a coach (or co-coach) the scope is the workspace's own `coach_id` roster (not deleted) OR an active CommunityMembership in the same workspace; only `role === 'owner'` gets no scope. Both lookups (`findUserById` now `findFirst` with the filter, and `findUserByEmail`) apply it, so another coach's client resolves to the same coded 404 `community.cohort.user_not_found` as an unknown id. No ban is lifted and no membership row is written for an out-of-scope target, because `liftWorkspaceBan` and `upsertMembership` run only after a non-null target. This matches the operator ruling (no cross-roster cohort invites in v1).
- Normal flow still works: a coach adding or inviting their own client (by id or email), or re-adding someone already active in the workspace, passes the filter, and the existing ban-lift reinstatement for their own client is unchanged.
- **B-AUTHZ-2 (block list names):** `listBlocks` selects `blocked.role`; student targets show `memberFirstName` (falls back safely on a null name), coach/owner/sub_coach keep the profile name. Block/unblock are untouched.
- Tests: service + repository + messages-safety specs added, and they run in the green build-and-test.

### C (one line)
- C-752-1: a coach can no longer reinstate a workspace-banned or removed member who is not their client and not currently active (the owner still can); not a normal day-1 flow.
