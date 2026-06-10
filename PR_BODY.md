## v1-6 Coach Admin — Cohort Write, Member Admin, Coach Inbox

Implements the backend coach-admin surface from **COMMUNITY_EXECUTION_PLAN.md → PR v1-6** (`community: v1-6 coach admin inbox`): coaches can create/update/archive cohorts, assign and remove members, and read a single FIFO aggregated "unanswered" inbox across all their cohorts. This directly unblocks the v1-6 mobile builder, which **STOPPED and reported** that 5 of its 10 required API functions had no backend route (see `V1_6_MOBILE_BUILDER_RESULT.md`).

### Scope

**IN**
- Cohort write: create / update / archive (soft).
- Cohort member admin: list (paginated), assign/invite (idempotent), remove.
- Coach inbox: single aggregated FIFO queue of unanswered client messages + un-replied client Lab posts across all cohorts the coach owns.

**OUT (deferred, with reason)**
- **The Lab** coach-admin semantics are **deferred**: the Lab's coach-side moderation/curation semantics are undefined in the execution plan (no acceptance criteria for what a coach "administers" in the Lab beyond existing post/moderation paths). Mobile already ships a "Coming soon" placeholder for the Lab tab, so there is no client dependency on a Lab admin endpoint in this lane. Re-scope when Lab semantics are specified.

### Endpoint inventory

| # | Method | Path | Auth predicate | Primary Prisma model |
|---|--------|------|----------------|----------------------|
| 1 | POST   | `/community/workspaces/:workspaceId/cohorts` | `@Roles('coach','owner')` + `CommunityAccessService` owns-this-workspace | `CommunityCohort` |
| 2 | PATCH  | `/community/cohorts/:cohortId` | `@Roles('coach','owner')` + owns-this-cohort's-workspace | `CommunityCohort` |
| 3 | DELETE | `/community/cohorts/:cohortId` (soft archive) | `@Roles('coach','owner')` + owns-this-cohort's-workspace | `CommunityCohort` (+ cascade `CommunityMembership`) |
| 4 | GET    | `/community/cohorts/:cohortId/members` | `@Roles('student','coach','owner')` + access check (coach → full rows; member → sanitized roster) | `CommunityMembership` |
| 5 | POST   | `/community/cohorts/:cohortId/members` | `@Roles('coach','owner')` + owns-this-cohort's-workspace | `CommunityMembership` |
| 6 | DELETE | `/community/cohorts/:cohortId/members/:userId` | `@Roles('coach','owner')` + owns-this-cohort's-workspace | `CommunityMembership` |
| 7 | GET    | `/community/me/coach-inbox` | `@Roles('coach','owner')` (scoped to caller's owned workspaces) | `CommunityMessage`, `CommunityPost` |

All routes are guarded `JwtAuthGuard → RolesGuard → CommunityFeatureFlagGuard` (in that order). Cohort admin is intentionally **not** placed behind the message/post/DM write kill-switches — it must remain reachable for coaches to administer cohorts even when chat features are paused.

### Behavior notes

- **Archive (DELETE cohort)** is a soft delete: sets `status='archived'` + `archived_at`, and cascades active memberships to `status='removed'`. No hard row deletion.
- **Assign member** is an idempotent upsert. Body is `user_id` **XOR** `email`. An `email` matching an existing user creates a membership at `status='invited'`; a `user_id` creates `status='active'`. An `email` for a **non-existent** user returns **404** — coach-roster onboarding (the existing `invite-codes` module) is the intended path to create the account first. The `invite-codes` module is deliberately **not** reused for cohort membership: it is coach-roster onboarding, a distinct concern from placing an existing user into a cohort.
- **Remove member** protects the OWNER coach role from removal.
- **Roster read** is dual-mode: a coach/owner gets full membership rows; a fellow cohort member gets a sanitized roster (no `student` string, no PII beyond display identity).
- **Pagination** is keyset/cursor: `base64url("<created_at_iso>|<id>")` over `(created_at, id)`.
- **Inbox "unanswered"** = (a) `CommunityMessage` rows where `coach_replied_at IS NULL` and the sender role is not in `[coach, owner]`, plus (b) `CommunityPost` rows authored by a client with no coach-authored comment (comments modeled as `CommunityMessage` with `plan_context_id = post.id` and the COMMENT context type). Returned in FIFO (oldest-first) order with a content preview.
- **Role mapping**: API `co_coach` ↔ Prisma `assistant`; API response roles are `student | coach | owner` via `PRISMA_TO_API_ROLE`.

### Auth / RLS coverage

App-layer authorization is the **primary** gate (the app connects as `service_role`/`BYPASSRLS`), with Postgres RLS as **defense-in-depth**. Authorization reuses the existing `CommunityAccessService` — **no new auth primitives were introduced**.

| Endpoint | App-layer predicate (CommunityAccessService) | Backing RLS policy (defense-in-depth) | Test coverage |
|---|---|---|---|
| POST cohort | coach/owner owns workspace | `community_cohorts_coach_all` (FOR ALL) | unit 403/404 + RLS static + live-gated |
| PATCH cohort | coach/owner owns cohort's workspace | `community_cohorts_coach_all` | unit + RLS static + live-gated |
| DELETE cohort | coach/owner owns cohort's workspace | `community_cohorts_coach_all` | unit + RLS static + live-gated |
| GET members | member self/shared-cohort OR coach owns | `community_memberships_self_or_shared_cohort_select`, `community_cohorts_member_select` | unit + RLS static + live-gated |
| POST member | coach/owner owns cohort's workspace | `community_memberships_coach_all` (FOR ALL) | unit + RLS static + live-gated |
| DELETE member | coach/owner owns cohort's workspace | `community_memberships_coach_all` | unit + RLS static + live-gated |
| GET coach-inbox | caller's owned workspaces only | `community_messages_select`, `community_posts_member_select` | unit + RLS static + live-gated |

**No new RLS migration.** The existing v1-1 policies already cover every new read/write path: `community_cohorts_coach_all`, `community_memberships_coach_all`, `community_memberships_self_or_shared_cohort_select`, `community_cohorts_member_select`, `community_messages_select`, `community_posts_member_select`. The PR #268 helper functions (`app.is_community_workspace_coach`, `app.shares_community_cohort`, `app.is_community_workspace_member`) were left **untouched** (they are in a separate fix-cycle for `pg_temp` search-path pinning). The RLS spec includes a static assertion that no v1-6 migration adds or replaces a community helper function.

### Test inventory

| Suite | File | Tests |
|---|---|---|
| Cohort write (service) | `test/community/cohorts/community-cohort-write.service.spec.ts` | 14 ✅ |
| Cohort members (service) | `test/community/cohorts/community-cohort-members.service.spec.ts` | 17 ✅ |
| Coach inbox (service) | `test/community/inbox/community-coach-inbox.service.spec.ts` | 10 ✅ |
| RLS (static + live-gated) | `test/rls/community-coach-rls.spec.ts` | 30 (10 static ✅ active + 20 live-gated, skip without `COMMUNITY_TEST_DATABASE_URL`) |

**Total: 71 new tests** (41 unit + 30 RLS). The 20 live RLS tests cover: 8 cross-workspace denials, 4 cross-cohort denials, 4 member-not-coach denials, and 4 OWNER/coach positive (bypass/own-workspace) paths — they run automatically when `COMMUNITY_TEST_DATABASE_URL` is set and skip cleanly otherwise. Lane run (`community|module-graph|rbac|guards`): **190 passed, 90 skipped, 0 failed** — no existing test regressed.

### No schema change

```
$ git diff origin/main -- prisma/schema.prisma
(empty — no output)
```

`prisma/schema.prisma`, `package.json`, and `src/app.module.ts` are all byte-identical to `origin/main` (verified `git diff` returns zero lines). New sub-modules are registered inside the existing `CommunityModule` (`src/community/community.module.ts`), not in `app.module.ts`. No files under `src/roman/**`, `src/workout-programs/**`, `src/ai/**`, `src/payouts/**`, or `src/contracts/**` were touched.

### Gates (§4)

- `./node_modules/.bin/prisma generate` ✅
- `npx tsc --noEmit` ✅ (exit 0)
- `npx eslint` (scoped to new dirs) ✅ (exit 0)
- Lane tests ✅ (190 passed / 0 failed)

### References

- [NestJS controllers & guards](https://docs.nestjs.com/controllers) — route + guard composition pattern used for all 7 endpoints.
- [PostgreSQL Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) — RLS as defense-in-depth behind the app-layer access gate.
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security) — RLS doctrine for the service-role/BYPASSRLS connection model.
- Existing community module (`src/community/community-access.service.ts`, `src/community/community.controller.ts`) — reused access-check and controller conventions.

### Cross-references

- `COMMUNITY_EXECUTION_PLAN.md` → **PR v1-6** (`community: v1-6 coach admin inbox`).
- v1-6 backend builder brief (this lane).
- `V1_6_MOBILE_BUILDER_RESULT.md` — mobile builder's STOP report enumerating the 5 missing backend functions this PR provides.
