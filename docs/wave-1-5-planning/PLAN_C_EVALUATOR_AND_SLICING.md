# PLAN C — Evaluator Architecture, 6-Dimension Slicing, LRU+Redis Cache, Bidirectional Drift Telemetry

**Status:** DESIGN ONLY. No production code. Read-only backend audit.
**Author:** Chief of Product / Principal Architect (Planner C)
**Date:** 2026-06-16
**Repo audited:** `growth-project-backend` @ HEAD `fea925a` (PR-395-FOLLOWUP)
**Companion docs:** `SERVER_SIDE_FEATURE_FLAGS_SPEC.md` (mobile contract), `DECISIONS.md` (D1–D7 base), `PLAN_B` (RLS / privacy boundaries — referenced throughout as "coordinated with PLAN_B").

---

## 0. Override reconciliation (READ FIRST)

`DECISIONS.md` D3/D4/D7 are **superseded** by Bradley's session overrides. Where this document and `DECISIONS.md` disagree, **this document wins**. Net effect:

| Decision | DECISIONS.md (base) | Bradley override (THIS DOC) |
| --- | --- | --- |
| **D3 slicing** | env + allowlist + role + tier + cohort, *graceful-degrade if table missing* | **BUILD all 6 dimensions** (tier, cohort, program, coach, tag, activity). None stubbed. None optional. |
| **D4 cache** | Redis 5-min TTL *or* per-request memoize fallback | **In-process LRU (5-min TTL) + Redis pub/sub invalidation.** Locked. |
| **D7 emission** | Emit *exactly* the 4 typed mobile flags | **Emit ALL flags from code-owned `KNOWN_FLAGS` registry** + bidirectional drift telemetry. No silent dark features. |

**Unchanged and still binding:** D1 (γ open-guard + `unlock_cta`), D2 (fail-closed default-DENY), D5 (perf budget — but see §6 note on the p99 conflict), D6 (role binary coach/owner, owner = superset). Wire shape stays `snake_case` + `.strict()` envelope (mobile Zod throws otherwise).

> **⚠ D5/D7 tension — must be flagged to Bradley (§10 OQ-1):** `DECISIONS.md` D7 says emit *exactly* 4 keys; the override says emit *all known flags*. With only 4 flags in `KNOWN_FLAGS` today these coincide. The moment a 5th flag is added to the registry, the endpoint emits it to mobile — and mobile's `FeatureFlagsResponseSchema` is `.strict()` on the **envelope** but `flags` is an **open `z.record`** (spec §2/§8 T8), so extra keys are *safe* (old clients ignore untyped keys). The override is therefore contract-compatible. We proceed on the override.

---

## Section 1 — Audit of existing primitives

All citations from HEAD `fea925a`.

### 1.1 Redis — installed, conditionally wired, NO pub/sub today
- `ioredis@5.10.1` is a dependency (`package.json:47`). `@nest-lab/throttler-storage-redis@1.2.0` is present (`package.json:30`).
- Redis is instantiated **lazily** only when `REDIS_URL` is set, inside the throttler factory: `src/throttler/throttler.config.ts:412-423` (`new Redis(redisUrl, { enableOfflineQueue:false, maxRetriesPerRequest:1 })`), with an error handler at `:425`.
- It is **NOT** a NestJS provider/module — it is created inside `buildThrottlerOptions()` and consumed only by `ThrottlerModule.forRootAsync()` (`src/app.module.ts:139-142`).
- **No pub/sub anywhere.** No `.subscribe`/`.publish`/`.psubscribe` calls exist in the codebase. Redis pub/sub for invalidation (§4.2) is **net-new**.
- Redis is **fail-open** in throttling: on Redis-down it allows requests + emits a `throttler_storage_failures_total` metric (`src/throttler/throttler.config.ts:276-382`).

**Conclusion:** `REDIS_URL` is a *production-only* expectation (dev/test fall back to in-memory throttling). For Plan C, Redis pub/sub invalidation requires a **dedicated, always-on Redis connection** owned by a new `FeatureFlagsModule` — we must NOT piggyback on the throttler's lazy client. See §4.4: **Redis provisioning is a Wave-1.5 BUILD PREREQUISITE.**

### 1.2 Auth / JWT / role / request context
- **`JwtAuthGuard`** at `src/auth/auth.guard.ts:63-180`, registered globally as `APP_GUARD` (`src/app.module.ts:384`). Verifies Supabase ES256 JWT locally via JWKS (`:92`), reads `payload.sub` (`:100`), and attaches the **full Prisma `User` record** to `req.user` (`:135`).
- `@Public()` opt-out decorator: `src/common/decorators/public.decorator.ts:8`.
- **Request shape:** `AuthedRequest` (`src/auth/auth-request.ts:10-17`) carries `user: User`. There is **no `@CurrentUser` decorator** — controllers use `@Request() req: AuthedRequest` and read `req.user.id` / `req.user.role`.
- **Role model:** enum `Role { coach, student, owner }` (`prisma/schema.prisma:30-34`); `User.role: Role @default(student)` (`:160`). **`owner` already exists** in the enum (contrary to `DECISIONS.md` D6's note that it "doesn't exist yet"). Role hierarchy is enforced in `src/auth/roles.guard.ts:67-75` (`owner` bypasses all; `coach` inherits `student`).
- **JWT claims available at the guard layer** are `sub` + `role` (the RLS interceptor reads `user.sub` and `user.role` — `src/common/interceptors/rls-context.interceptor.ts:45-57`). NOTE: `req.user` is the full DB record (has `id`, `role`, `coach_id`), but the **raw JWT** only guarantees `sub`+`role`. The evaluator should key on `req.user.id` (DB id == `sub` for Supabase users).

### 1.3 Throttler — the 60/min reference
- The spec's "60/min/user" is realized by the **`coach-command-center`** named throttler: `COACH_CMD_CENTER_PER_MIN` default `60` (`src/throttler/throttler.config.ts:131`). There is currently **no** `/me/feature-flags` route, so no throttle binding for it yet.
- Per-user keying is done by `UserThrottlerGuard` (`src/throttler/user-throttler.guard.ts:59-145`): uses `req.user.id` when authed, else decodes JWT `sub`, else IP. **Plan C reuses this** — add a `feature-flags-per-min` named throttler (default 60) and `@Throttle({ 'feature-flags-per-min': ... })` on the controller.

### 1.4 Telemetry / logging
- **PostHog** via `AnalyticsService` (`src/analytics/analytics.service.ts:49-91`). Signature: `capture(distinctId: string, event: string, props?: Record<string, unknown>): void` (`:77-91`). No-op when `POSTHOG_KEY` unset; **never throws**; PII-stripped (`stripPII`). Event taxonomy lives in `src/analytics/events.ts`. This is the **primary sink for drift telemetry** (§5.2).
- **Sentry** (`src/instrument.ts:1-45`, imported first in `src/main.ts:1-5`); used for 5xx capture (`src/filters/http-exception.filter.ts:60-68`). Use Sentry for **startup fail-loud** + warning-severity drift spikes.
- **Structured logger:** `AppLoggerService` (`src/observability/app-logger.service.ts`), single-line JSON, request-id correlated. Use for local warn-level drift logs.
- **Metrics:** `MetricsService` (`src/observability/metrics.service.ts:70-95`, `onModuleInit` initializes Prometheus counters) — use for `feature_flags_cache_hit_total` / `_miss_total` / `flag_drift_total`.

### 1.5 Migration tooling
- **Prisma Migrate**, forward-only. Single monolithic `prisma/schema.prisma` (~160 models, 57 enums, 143 migrations). `prisma migrate deploy` runs at boot (Dockerfile release command) and CI. User PK is `uuid` (`prisma/schema.prisma:155`).

### 1.6 RLS mechanism (coordinate with PLAN_B)
- RLS context is set per-request by `RlsContextInterceptor` (`src/common/interceptors/rls-context.interceptor.ts:41-67`): `SELECT set_config('app.current_user_id', $sub, true)` and `set_config('app.current_user_role', $role, true)` — **transaction-scoped** (the `true` arg) for pgbouncer safety. Policies read `current_setting('app.current_user_id')`.
- RLS is production-proven (PR #370 audit, `RLS_INVESTIGATION_LOG.md`); live-DB RLS tests run via `jest.rls.config.js`.
- **Implication for Plan C:** any new slicing table is RLS-governed. The evaluator's single-roundtrip load (§3.1) runs inside the request's RLS context, so it MUST either (a) run as the authenticated user and rely on policies that let a user read *their own* slicing rows, or (b) use a `service_role` connection (BYPASSRLS) for the evaluator load, since the evaluator legitimately reads cross-cutting config the user can't normally see (e.g. allowlists). **Recommendation: (b)** — the evaluator runs on a service-role Prisma client, because flag rules and allowlists are global config, not user-owned rows. Coordinate the exact policy set with PLAN_B (§2 RLS notes).

### 1.7 Existing scheduling + cache patterns to mirror
- **`@nestjs/schedule`** is wired (`ScheduleModule.forRoot()`, `src/app.module.ts:148`); ~15 existing `@Cron` jobs in a staggered `03:xx UTC` window (`src/users/gdpr-scrub.scheduler.ts:16-20`). The nightly activity recompute (§2.6) slots into this window.
- **In-process LRU precedent already exists:** `TriageCacheService` (`src/community/ai-triage/triage-cache.service.ts`) — bounded `Map` with **5-min TTL**, `MAX_CACHE_ENTRIES = 1000`, LRU touch-on-hit, bounded TTL sweep. **Plan C's LRU mirrors this proven pattern** (and is the reason we can adopt `lru-cache` confidently — the codebase already accepts in-process per-user caches).

### 1.8 Existing feature-flag pattern (the thing we are replacing/generalizing)
- Today flags are **env-only**, decentralized: `resolveCommunityFlag(callerId)` (`src/community/community-feature-flag.guard.ts:23-30`) = `FEATURE_COMMUNITY_API === 'true'` OR `callerId ∈ FEATURE_COMMUNITY_API_ALLOWLIST` (CSV env). ~95 files use `process.env.FEATURE_*` directly.
- **No `/me/feature-flags` endpoint, no `KNOWN_FLAGS`, no evaluator service, no allowlist DB table, no `FeatureFlag` model exist on HEAD.** Backend "PR #414" referenced by the mobile spec is **not present** on this branch. Plan C is greenfield against this surface, but must **reuse the `envGate + allowlist` shape** (now DB-backed for allowlist, env for the gate) so existing `FEATURE_COMMUNITY_*` env vars keep working.

---

## Section 2 — Slicing dimensions: data model

**Naming:** snake_case tables/columns (matches existing schema). All new tables get `id uuid @default(uuid())`, `created_at`, `updated_at` unless noted. PK type matches `User.id` (uuid).

**Privacy boundary (coordinate with PLAN_B):** Per the privacy matrix, **owner CANNOT read individual tag values for individual clients**. This is enforced by RLS on `client_tag_assignment` (§2.5). The evaluator itself runs service-role (§1.6), so it can read tags for rule evaluation, but **never returns raw tag values to the client** — it only returns boolean flag results. The owner-facing read path (any admin UI, R82) must go through user-context RLS, which denies individual-tag reads to owners.

### 2.0 Tier-of-truth reconciliation — the biggest data-model gap
The override requires tiers **Free / Pro / Elite** as a **per-user (client)** dimension. But the existing `CoachSubscription` (`prisma/schema.prisma:549-570`) is **coach-scoped** (`coach_id @unique`) with enum `CoachTier { free, pro, enterprise }` (`:144-148`) — it describes *a coach's SaaS plan*, not *a client's subscription*. Clients pay via `ClientPurchase` (`:3498`), which is **package-purchase / entitlement**, not a tier.

**Decision (OQ-2 for Bradley):** We introduce a **client-facing** tier dimension distinct from `CoachTier`. Two sub-options:
- **2.0-A (recommended):** New enum `ClientTier { free, pro, elite }` + new table `client_subscription` mirroring `CoachSubscription`'s Stripe columns but keyed by the *client* user. Clean separation; `elite` ≠ coach's `enterprise`.
- **2.0-B:** Reuse `CoachSubscription` for coach-role users and derive client tier from `ClientPurchase.entitlement_active` (active purchase ⇒ "pro", none ⇒ "free", no "elite"). Cheaper but cannot express 3 tiers.

We design to **2.0-A**. The evaluator's `tier` is resolved per-role: coach/owner → `CoachSubscription.tier`; client → `client_subscription.tier`.

### 2.1 Subscription tier
```prisma
enum ClientTier { free  pro  elite }

model ClientSubscription {
  id                     String     @id @default(uuid())
  client_user_id         String     @unique
  client                 User       @relation(fields: [client_user_id], references: [id])
  tier                   ClientTier @default(free)
  status                 String     @default("active") // active|trialing|past_due|canceled|paused
  stripe_customer_id     String?
  stripe_subscription_id String?    @unique
  current_period_end     DateTime?
  created_at             DateTime   @default(now())
  updated_at             DateTime   @updatedAt
  @@index([tier])
  @@index([client_user_id, status])
}

model ClientTierHistory {           // audit trail
  id             String     @id @default(uuid())
  client_user_id String
  from_tier      ClientTier?
  to_tier        ClientTier
  reason         String     // stripe_webhook|admin_override|trial_expired
  changed_at     DateTime   @default(now())
  @@index([client_user_id, changed_at])
}
```
- **Source of truth:** Stripe (client-side subscription). The Stripe webhook handler writes `client_subscription` + appends `client_tier_history` + **publishes invalidation** (§4.3).
- **Coach/owner tier** continues to come from existing `CoachSubscription` (`:549`); no new table for them.
- **Indexes:** `client_user_id` unique (point lookup in evaluator), `tier` (for admin segmentation), `(client_user_id, status)`.
- **RLS:** client reads own row; coach reads rows of their clients (join via `User.coach_id`); service-role bypass for evaluator. Owner: aggregate only (no per-client tier exposure beyond their gyms — coordinate with PLAN_B).

### 2.2 Cohort
Existing `CommunityCohort` (`prisma/schema.prisma:5720`) is **community-group-scoped** (`workspace_id`, capacity, status) — wrong semantics for a slicing cohort ("Q3-2026 onboard"). We add a **dedicated slicing cohort**, leaving `CommunityCohort` untouched.
```prisma
model Cohort {
  id          String   @id @default(uuid())
  name        String
  slug        String   @unique           // "q3-2026-onboard"
  start_date  DateTime?
  end_date    DateTime?
  created_by  String                      // coach or admin user id
  created_at  DateTime @default(now())
  @@index([slug])
}

model ClientCohort {                       // junction
  id        String   @id @default(uuid())
  client_user_id String
  cohort_id String
  cohort    Cohort   @relation(fields: [cohort_id], references: [id])
  joined_at DateTime @default(now())
  @@unique([client_user_id, cohort_id])
  @@index([client_user_id])
}
```
- **Defined by:** both coach and admin (`created_by` + RLS scope). v1 = admin-defined; coach self-serve = R82 (§9).
- **RLS:** client reads own `client_cohort` rows; coach reads cohorts they created + memberships of their clients; service-role for evaluator.

### 2.3 Program enrollment
`ClientPurchase` (`prisma/schema.prisma:3498-3542`) already models payment→entitlement (`package_id`, `status`, `entitlement_active`, `access_expires_at`). **We reuse it as the program-enrollment source** rather than a parallel table — `package_id` IS the program identity (`CoachPackage`, `:3208`).
- **Evaluator reads:** `ClientPurchase WHERE client_user_id = ? AND entitlement_active = true AND (access_expires_at IS NULL OR access_expires_at > now())` → `programEnrollments: string[]` (the set of `package_id`s).
- **Status states (existing):** `pending | paid | active | past_due | canceled | payment_failed | expired` (`:3522-3523`). "refunded" maps to `canceled`; "gifted" is not modeled today → **OQ-3** (add `gifted` status or a `granted_by` admin column? Defer to R82).
- **No new table** for this dimension. New index recommended for the evaluator hot path:
```prisma
// add to ClientPurchase:
@@index([client_user_id, entitlement_active, access_expires_at])
```

### 2.4 Coach assignment
Two existing models cover this — **no new table**:
- **Primary:** `User.coach_id` (self-FK, `prisma/schema.prisma:160-165`, relation `CoachToStudents`). One head-coach per client. This is the evaluator's `coachUserId`.
- **Team mode:** `SubCoachAssignment` (`:4379`) with `head_coach_id`, `sub_coach_id`, `client_id`, `unassigned_at` (active = `unassigned_at IS NULL`). Historical assignments retained.
- **Evaluator reads:** `coachUserId = user.coach_id` (single column on the already-loaded `req.user`!). Active sub-coach set (if a rule needs it) = `SubCoachAssignment WHERE client_id = ? AND unassigned_at IS NULL`.
- **Cardinality decision:** one head-coach per client (`coach_id` is scalar). Multi-coach = team mode via `SubCoachAssignment`, already many-to-many. v1 rules key on the head coach.

### 2.5 Tag — NEW (does not exist today)
No tag/label model exists. We build **normalized** (so a coach renaming a tag propagates):
```prisma
model Tag {
  id         String   @id @default(uuid())
  owner_coach_id String                 // the coach who owns this tag namespace
  text       String                     // "competitor", "rehab", "beginner"
  created_at DateTime @default(now())
  @@unique([owner_coach_id, text])
  @@index([owner_coach_id])
}

model ClientTagAssignment {
  id             String   @id @default(uuid())
  client_user_id String
  tag_id         String
  tag            Tag      @relation(fields: [tag_id], references: [id])
  applied_by     String                  // coach user id
  applied_at     DateTime @default(now())
  @@unique([client_user_id, tag_id])
  @@index([client_user_id])
  @@index([tag_id])
}
```
- **RLS (privacy-critical, coordinate with PLAN_B):**
  - Coach: read/write `tag` + `client_tag_assignment` for **their own clients only** (join `User.coach_id = current_user`).
  - Client: read own tag assignments **read-only**.
  - **Owner: DENIED individual-client tag values** per the privacy matrix. Owner may see aggregate counts via a separate aggregated view, never `client_tag_assignment` rows for a specific client. This RLS policy is the most sensitive one in Plan C and must be co-reviewed with PLAN_B.
  - Service-role: bypass (evaluator).
- **Evaluator reads:** `tags: string[]` = `tag.text` joined through `client_tag_assignment WHERE client_user_id = ?`.

### 2.6 Activity level — NEW materialized summary
No `last_active` column exists. Signals are spread across `WorkoutSession` (`:853`, indexed `(user_id, date)`), `Message` (`:676`), `ActivityEvent` (`:701`, indexed `(client_id, created_at)`), `LoggedFoodEntry` (`:829`). Computing `MAX(created_at)` across a UNION per request is too slow for the p95 budget. **Recommendation: materialized summary table, refreshed nightly.**
```prisma
enum ClientActivityLevel { active  lapsed  churned }   // NB: distinct from existing ActivityLevel(:53) which is fitness intensity

model ClientActivitySummary {
  client_user_id   String              @id
  last_active_at   DateTime?
  sessions_last_30d Int                @default(0)
  messages_last_30d Int                @default(0)
  level            ClientActivityLevel @default(active)
  computed_at      DateTime            @default(now())
  @@index([level])
  @@index([last_active_at])
}
```
- **Level derivation (tunable, OQ-4):** `active` = last_active ≤ 7d; `lapsed` = 7d < last_active ≤ 30d; `churned` = > 30d (or never).
- **Refresh:** nightly `@Cron` in the `03:xx UTC` stagger window (mirror `src/users/gdpr-scrub.scheduler.ts`). One `INSERT ... ON CONFLICT DO UPDATE` over the UNION of signal tables. After recompute, **publish bulk invalidation** (§4.3) — but see §4.2 note on bulk-evict cost.
- **Why materialized, not computed:** keeps evaluator load to a single indexed PK lookup (`client_activity_summary WHERE client_user_id = ?`) instead of a 4-table UNION+aggregate.

### 2.7 Allowlist (per spec §5 — confirm + build)
The mobile contract's evaluator inputs include a **per-caller allowlist**. Today it's CSV env (`FEATURE_COMMUNITY_API_ALLOWLIST`). To support coach-managed allowlists we add a DB table while keeping env CSV as a fallback union:
```prisma
model FeatureFlagAllowlist {
  id        String   @id @default(uuid())
  flag_name String                       // must exist in KNOWN_FLAGS (validated at startup §5.2)
  user_id   String
  added_by  String
  added_at  DateTime @default(now())
  @@unique([flag_name, user_id])
  @@index([flag_name])
  @@index([user_id])
}
```
- Evaluator's `isAllowlisted(userId, flag)` = `userId ∈ (env CSV ∪ FeatureFlagAllowlist rows for flag)`.

### 2.8 Migration ordering
1. Enums: `ClientTier`, `ClientActivityLevel` (+ keep existing `CoachTier`, `ActivityLevel` untouched).
2. `Cohort`, `Tag` (parent tables, no FKs out).
3. `ClientSubscription`, `ClientTierHistory`, `ClientCohort`, `ClientTagAssignment`, `ClientActivitySummary`, `FeatureFlagAllowlist`.
4. Add `@@index([client_user_id, entitlement_active, access_expires_at])` to `ClientPurchase`.
5. RLS policies (coordinate ordering with PLAN_B's migration so both land in one deploy — "RLS policies coordinated with PLAN_B").
6. Backfill: `ClientActivitySummary` initial population (one-off script, then nightly cron takes over); `ClientSubscription` defaults all clients to `free`.

---

## Section 3 — Evaluator service architecture

```ts
@Injectable()
export class FeatureFlagsEvaluatorService {
  constructor(
    private readonly cache: FeatureFlagsCacheService,   // §4
    private readonly registry: FeatureFlagsRegistry,    // §5
    private readonly context: EvaluatorContextLoader,   // §3.1
  ) {}

  async evaluate(userId: string): Promise<FeatureFlagsEvaluation> {
    const cached = this.cache.get(userId);
    if (cached) return cached;                          // LRU hit (<1ms)
    const ctx = await this.context.load(userId);        // single-roundtrip §3.1
    const result = this.evaluateFromContext(ctx);       // pure, §3.2
    this.cache.set(userId, result);
    return result;
  }
}

interface FeatureFlagsEvaluation {
  flags: Record<string, boolean>;   // snake_case keys, booleans only
  evaluated_at: string;             // ISO 8601 UTC ("...Z")
}
```
Output is the exact mobile wire shape (spec §2). `evaluated_at = new Date().toISOString()` (full datetime, never a bare date — spec §6/§T9). DTO uses snake_case; if class-transformer is involved, no camelCase interceptor may touch this route.

### 3.1 EvaluatorContext — single-roundtrip load
```ts
interface EvaluatorContext {
  userId: string;
  role: 'student' | 'coach' | 'owner';        // from User.role (req.user.role)
  tier: 'free' | 'pro' | 'elite';             // client_subscription OR coach_subscription per role
  cohorts: string[];                          // cohort.slug[] via client_cohort
  programEnrollments: string[];               // active package_id[] via ClientPurchase
  coachUserId: string | null;                 // User.coach_id
  tags: string[];                             // tag.text[] via client_tag_assignment
  activityLevel: 'active' | 'lapsed' | 'churned';  // client_activity_summary.level
  gymIds: string[];                           // for owner role — coordinate with PLAN_B
}
```
**Single DB roundtrip strategy:** one Prisma `$queryRaw` CTE (service-role connection, §1.6) that LEFT JOINs all dimensions off `users u WHERE u.id = $1`. `role`, `coach_id`, and (for coach/owner) `coach_subscription.tier` come from one join cluster; `client_subscription`, `client_activity_summary` are PK lookups; `cohorts`, `programEnrollments`, `tags` are aggregated arrays (`array_agg`). Shape:
```sql
WITH base AS (SELECT id, role, coach_id FROM users WHERE id = $1)
SELECT b.*,
  cs.tier              AS client_tier,
  ks.tier              AS coach_tier,
  cas.level            AS activity_level,
  COALESCE(array_agg(DISTINCT co.slug)  FILTER (WHERE co.slug  IS NOT NULL), '{}') AS cohorts,
  COALESCE(array_agg(DISTINCT cp.package_id) FILTER (WHERE cp.entitlement_active AND (cp.access_expires_at IS NULL OR cp.access_expires_at > now())), '{}') AS programs,
  COALESCE(array_agg(DISTINCT t.text)   FILTER (WHERE t.text  IS NOT NULL), '{}') AS tags
FROM base b
LEFT JOIN client_subscription      cs  ON cs.client_user_id = b.id
LEFT JOIN coach_subscription       ks  ON ks.coach_id       = b.id
LEFT JOIN client_activity_summary  cas ON cas.client_user_id= b.id
LEFT JOIN client_cohort            cc  ON cc.client_user_id = b.id
LEFT JOIN cohort                   co  ON co.id = cc.cohort_id
LEFT JOIN client_purchase          cp  ON cp.client_user_id = b.id
LEFT JOIN client_tag_assignment    cta ON cta.client_user_id= b.id
LEFT JOIN tag                      t   ON t.id = cta.tag_id
GROUP BY b.id, b.role, b.coach_id, cs.tier, ks.tier, cas.level;
```
`tier` resolution in TS: `role === 'student' ? (client_tier ?? 'free') : mapCoachTier(coach_tier)`. `gymIds` for owner is a separate small query (or extra join) — coordinate exact gym model with PLAN_B. Allowlist is loaded lazily inside rules (small, flag-scoped) or prefetched once and memoized process-wide with its own short TTL.

### 3.2 Per-flag evaluation algorithm
```ts
evaluateFromContext(ctx: EvaluatorContext): FeatureFlagsEvaluation {
  const flags: Record<string, boolean> = {};
  for (const flag of this.registry.activeFlags()) {       // KNOWN_FLAGS, status==='active'
    flags[flag.name] = flag.rule(ctx);                    // pure (ctx) => boolean
  }
  return { flags, evaluated_at: new Date().toISOString() };
}
```
Each rule is **pure** `(ctx) => boolean`, combining `envGate AND allowlist AND role AND tier AND cohort AND program AND tag AND activity` as the flag needs. **D2 fail-closed:** a rule that throws or a flag absent from the map ⇒ DENY (the loop only ever writes `true`/`false`; absence is OFF by mobile semantics, spec §3/§T6). Example rules (mirroring the 4 mobile flags):
```ts
community_search: (ctx) =>
  envGate('FEATURE_COMMUNITY_SEARCH') && isAllowlisted(ctx.userId, 'community_search'),

coach_community_wearable_prompts: (ctx) =>
  envGate('FEATURE_COACH_COMMUNITY_WEARABLE_PROMPTS')
  && roleAllowsCoachGated(ctx.role)               // role === 'coach' || role === 'owner' (D6)
  && isAllowlisted(ctx.userId, 'coach_community_wearable_prompts'),

community_classroom: (ctx) =>
  envGate('FEATURE_COMMUNITY_CLASSROOM')
  && (ctx.tier === 'pro' || ctx.tier === 'elite')
  && ctx.programEnrollments.some(programGrantsClassroom)
  && ctx.activityLevel !== 'churned',

community_events: (ctx) =>
  envGate('FEATURE_COMMUNITY_EVENTS')
  && (ctx.tier === 'pro' || ctx.tier === 'elite'),
```
**Adding a new rule = one PR** that touches `known-flags.ts` (registry entry incl. `rule`) + adds its test(s) + (if new env gate) an `ENV_RULES` entry in `src/common/env-validation.ts`. Startup validation (§5.2) guarantees registry/rule consistency.

---

## Section 4 — Cache layer: LRU + Redis pub/sub (locked D4 override)

### 4.1 LRU configuration
- **Library:** `lru-cache` (Node). Precedent: `TriageCacheService` already does bounded-Map+TTL+LRU by hand (`src/community/ai-triage/triage-cache.service.ts`); `lru-cache` formalizes it.
- **Sizing:** `max: 10_000` entries, `ttl: 5 * 60 * 1000` (5 min), `updateAgeOnGet: false` (TTL is wall-clock from write, matching mobile's `staleTime` 5 min so server and client age in lockstep).
- **Key:** `userId` only. (No gym-context hash for v1 — a user's evaluation is identity-scoped; owner gym context is part of the loaded ctx, not a separate cache axis. Revisit if owner multi-gym switching lands — R82.)
- **Value:** the full `FeatureFlagsEvaluation` object (frozen).

### 4.2 Redis pub/sub for invalidation
- **Dedicated connections:** a new `FeatureFlagsModule` owns **two** ioredis connections (pub/sub requires a connection in subscriber mode that can't run normal commands): one publisher, one subscriber. These are separate from the throttler's lazy client (§1.1).
- **Channel:** `feature_flags_invalidation`.
- **Message:** `{ "userId": string, "reason": InvalidationReason }` where `reason ∈ {tier_change, cohort_change, program_change, coach_change, tag_change, activity_recompute, allowlist_change, flag_rule_changed}`.
- **On receive:** each process evicts that `userId` from its own LRU (`cache.delete(userId)`).
- **Wildcard:** `{ "userId": "*", reason: "flag_rule_changed" }` → `cache.clear()` on every process (used after a flag-rule deploy or allowlist mass change).
- **Bulk-evict caution:** the nightly activity recompute (§2.6) could touch many users. Publishing one message per user is a pub/sub storm. **Recommendation:** the nightly job publishes a **single wildcard** `{ userId:'*', reason:'activity_recompute' }` (clear all) rather than N per-user messages — the cache refills lazily within 5 min anyway. Per-user messages are reserved for **interactive** mutations (tier/cohort/program/coach/tag/allowlist).

### 4.3 Mutation hooks (where to publish invalidation)
| Mutation | Site to instrument | Message |
| --- | --- | --- |
| Tier change | Stripe webhook handler (client subscription) → writes `client_subscription` | `{userId, tier_change}` |
| Cohort assign/remove | coach/admin action on `client_cohort` | `{userId, cohort_change}` |
| Program enrollment | `ClientPurchase` status→active/canceled/expired (checkout-complete + refund webhooks) | `{userId, program_change}` |
| Coach assignment | admin sets `User.coach_id` / `SubCoachAssignment` insert/unassign | `{userId, coach_change}` |
| Tag change | coach action on `client_tag_assignment` (and `tag.text` rename → wildcard, since many clients affected) | `{userId, tag_change}` / wildcard on rename |
| Activity recompute | nightly cron | **single** `{*, activity_recompute}` |
| Allowlist change | `FeatureFlagAllowlist` insert/delete | `{userId, allowlist_change}` (or wildcard if bulk) |
| Flag rule registry change | deploy hook / admin push | `{*, flag_rule_changed}` |

Publishes are **fire-and-forget** (not in the request critical path). A publish failure logs+metrics but never fails the mutation (the 5-min TTL is the backstop — staleness is bounded even if a publish is lost).

### 4.4 Fallback if Redis is NOT provisioned → **FILE AS BUILD PREREQUISITE**
Redis is installed but only lazily wired for throttling, and only when `REDIS_URL` is set (§1.1). The locked D4 override **requires** Redis pub/sub. Therefore:
- **Wave-1.5 BUILD PREREQUISITE (BIG):** provision an always-on Redis (Fly Upstash/managed) and set `REDIS_URL` in all envs the evaluator runs in. Without it, cross-process invalidation is impossible and a user could see stale flags for up to 5 min on a process that missed the mutation.
- **Degraded mode (must still be safe):** if `REDIS_URL` is unset, the LRU still works *per-process* but **without cross-process invalidation**. Staleness is then bounded only by the 5-min TTL. This is acceptable for dev/test, **NOT** for production. The module logs a loud warning at startup if Redis is absent in a prod-like `NODE_ENV` (mirror the `feature`-tier env pattern in `src/common/env-validation.ts`). It must never *fail open on flags* — degraded cache only affects freshness, never correctness of a single evaluation (each evaluation is still a correct fail-closed computation).

---

## Section 5 — KNOWN_FLAGS registry + drift telemetry (locked D7 override)

### 5.1 KNOWN_FLAGS registry — single source of truth
`src/feature-flags/known-flags.ts`:
```ts
export interface FlagDefinition {
  name: string;                                   // snake_case
  description: string;
  status: 'active' | 'experimental' | 'deprecated';
  rule: (ctx: EvaluatorContext) => boolean;
  mobile_min_version: string;                     // semver — for old-client drift warnings
}

export const KNOWN_FLAGS: FlagDefinition[] = [
  { name: 'community_search',                  status: 'active', mobile_min_version: '1.0.0', description: '...', rule: rules.community_search },
  { name: 'coach_community_wearable_prompts',  status: 'active', mobile_min_version: '1.0.0', description: '...', rule: rules.coach_community_wearable_prompts },
  { name: 'community_classroom',               status: 'active', mobile_min_version: '1.0.0', description: '...', rule: rules.community_classroom },
  { name: 'community_events',                  status: 'active', mobile_min_version: '1.0.0', description: '...', rule: rules.community_events },
];
```
The endpoint emits **every `status==='active'` flag**. `experimental`/`deprecated` flags are still in the registry (for drift bookkeeping) but excluded from emission unless explicitly promoted.

### 5.2 Bidirectional drift telemetry
- **Backend → fail-loud at startup (unknown flag references):** a new `FeatureFlagsModule` `onModuleInit()` (precedent: `MetricsService.onModuleInit`, `src/observability/metrics.service.ts:70-95`) validates: (a) every `kindToFlag` mapping target (spec §4: `community_classroom`, `community_events`) exists in `KNOWN_FLAGS`; (b) every `FeatureFlagAllowlist.flag_name` referenced is known; (c) every rule's referenced env gate has an `ENV_RULES` entry. On any miss → **throw at boot** (`BootstrapValidationError` precedent, `src/common/errors/bootstrap-validation.error.ts`) + `Sentry.captureMessage(..., 'error')`. No silent dark features.
- **Mobile → backend drift telemetry:** mobile sends its known-flag expectations so the backend can detect divergence. Two mechanisms:
  - *Cheap (recommended v1):* mobile attaches header `X-Client-Flag-Keys: community_search,...` (or app version → backend maps to expected set). On each `/me/feature-flags` response, backend compares emitted keys vs. expected:
    - emitted-but-not-expected → `analytics.capture(userId, 'flag_drift_backend_extra', { flag, app_version })`
    - expected-but-not-emitted → `analytics.capture(userId, 'flag_drift_backend_missing', { flag, app_version })`
  - This reuses `AnalyticsService.capture` (`src/analytics/analytics.service.ts:77-91`), which is no-op-safe and PII-stripped.
- **Reconciliation job (weekly):** a `@Cron` (weekly, in the stagger window) aggregates `flag_drift_*` PostHog events (via PostHog query API or a local counter table) and, if non-zero, emails Bradley (reuse existing email module). Payload: per-flag drift counts, top app versions.

**Telemetry schema:**
| Event | Payload | Sink |
| --- | --- | --- |
| `flag_drift_backend_extra` | `{ flag, app_version, user_id }` | PostHog |
| `flag_drift_backend_missing` | `{ flag, app_version, user_id }` | PostHog |
| `flag_registry_validation_failed` | `{ flag, reason }` | Sentry (error) + boot crash |
| `feature_flags_cache_hit` / `_miss` | counter | MetricsService (Prometheus) |
| weekly reconciliation | aggregate email | email module |

---

## Section 6 — Performance budget realization

> **⚠ Perf-budget conflict (OQ-5):** The brief's §6 header cites **p99 < 1500ms (hard fail)**, but `DECISIONS.md` D5 (still binding) says **p99 < 250ms**. These differ by 6×. We design to the **stricter D5 (p99 < 250ms)** and note both in CI; Bradley to confirm which p99 is canonical. p95 < 100ms is consistent across both.

- **LRU hit:** <1ms (in-memory object return). Target hit rate **>90%** after warm (mobile refetches at most every 5 min + on foreground; 5-min server TTL ⇒ most requests hit warm cache).
- **LRU miss → single-roundtrip CTE load (§3.1):** estimated **20–80ms p95** (one indexed query with array_aggs; all join keys indexed). Service-role connection avoids per-row RLS overhead.
- **Publish path:** not in critical path (fire-and-forget, §4.3).
- **Cold p95 < 100ms is unrealistic** for the very first request per user; hence the two-phase perf test below.

**Perf test (CI-enforced, mirror D5):** 100 concurrent users hitting `GET /me/feature-flags`.
- Phase A (cold, first request fills LRU): assert **p95 < 250ms**, **p99 < 250ms** (per D5; or 1500ms if Bradley picks the brief's number).
- Phase B (warm): assert **p95 < 100ms**, **p99 < 250ms**.
- CI fails if any assertion breached. Test harness mirrors existing perf-style specs; runs against a seeded DB.

---

## Section 7 — Throttle + abuse

- **Reuse the per-user throttler:** add named throttler `feature-flags-per-min` (default 60, env `FEATURE_FLAGS_PER_MIN`) in `src/throttler/throttler.config.ts` and bind `@Throttle({ 'feature-flags-per-min': {...} })` on the controller. Keying via existing `UserThrottlerGuard` (`src/throttler/user-throttler.guard.ts`).
- **Pub/sub abuse:** only evaluator-mutation code paths publish to `feature_flags_invalidation` (§4.3). The channel is **not user-controllable** — there is no endpoint that lets a user trigger a publish directly. A bad actor with DB write access is already game-over (out of scope). Publishers are server-internal services only.
- **Wildcard flood guard:** wildcard invalidation (`*`) is restricted to the nightly cron + deploy hook + admin allowlist-bulk path. No user-reachable code emits a wildcard.

---

## Section 8 — Test scenarios (build subagent's test plan)

Mirrors spec §11 T1–T9, extended per overrides. Backend unit/integration tests.

**Contract / mobile-mirror (spec §11):**
- **T1:** `classroom_lesson` hit + `community_classroom:false` → per **D1**: hit RETURNED with `unlock_cta` attached (NOT excluded). (γ is open-guard, D1 — overrides brief's exclude.)
- **T2:** `voice_note_transcript` (passthrough) → always included, never gated.
- **T3:** mixed kinds, only `community_events:false` → all pass except `event` hits get `unlock_cta`.
- **T4:** flags fetch fails (401/403/404/5xx/timeout) → no `true` flag ever returned; every gated surface dark.
- **T5:** never emit out-of-enum kind.
- **T6:** omitted key === explicit `false` (absent = OFF, D2).
- **T7:** non-coach → `coach_community_wearable_prompts:false`; coach/owner → may be true subject to env+allowlist.
- **T8:** extra flag key in `flags` does not break client (open map).
- **T9:** `evaluated_at` is valid ISO 8601 UTC; bad value would throw client `contract`.

**Slicing dimensions (override D3):**
- **T_TIER_1:** tier=pro, rule requires {pro,elite} → true.
- **T_TIER_2:** tier=free, same rule → false.
- **T_TIER_3:** coach-role tier resolved from `CoachSubscription`, client-role from `ClientSubscription` → correct source per role.
- **T_COHORT_1:** user in cohort `q3-2026-onboard`, rule whitelists slug → true.
- **T_COHORT_2:** not in cohort → false.
- **T_PROGRAM_1:** active `ClientPurchase` for whitelisted `package_id` → true.
- **T_PROGRAM_2:** purchase exists but `entitlement_active=false` / expired → false.
- **T_COACH_1:** rule requires assigned coach in set → true when `User.coach_id` matches; false otherwise.
- **T_TAG_1:** client tagged `competitor`, rule requires tag → true.
- **T_TAG_2:** rule requires tag client lacks → false.
- **T_ACTIVITY_1:** `churned` user, rule excludes churned → false.
- **T_ACTIVITY_2:** `active` user, same rule → true.

**Role (D6):**
- **T_ROLE_1:** owner is superset of coach for `coach_community_wearable_prompts` (one-line `roleAllowsCoachGated`).

**Cache (D4):**
- **T_CACHE_1:** cold request fills LRU (miss metric increments).
- **T_CACHE_2:** warm request returns from LRU <5ms (hit metric).
- **T_INVALIDATE_1:** mutation publishes invalidation → subscriber evicts → next request loads fresh.
- **T_INVALIDATE_2:** wildcard `*` clears entire LRU on all processes.
- **T_INVALIDATE_3:** publish failure (Redis down) does not fail the mutation; TTL still bounds staleness.

**Drift (D7):**
- **T_DRIFT_1:** registry references a flag not in `KNOWN_FLAGS` (e.g. kindToFlag target missing) → throws at startup (fail-loud).
- **T_DRIFT_2:** mobile sends expected keys diverging from emitted → `flag_drift_backend_extra`/`_missing` PostHog event fires.
- **T_DRIFT_3:** allowlist row references unknown flag → boot crash.

**Privacy / RLS (coordinate with PLAN_B):**
- **T_RLS_1:** owner cannot read individual `client_tag_assignment` values (RLS denies).
- **T_RLS_2:** coach reads tags only for own clients.
- **T_RLS_3:** evaluator (service-role) reads all dimensions correctly.

**Perf (D5):**
- **T_PERF_1:** 100 concurrent warm → p95 <100ms, p99 <250ms.
- **T_PERF_2:** 100 concurrent cold → p95 <250ms, p99 <250ms.

**Wire (Bonus):**
- **T_WIRE_1:** response is exactly `{ flags, evaluated_at }`, snake_case, no extra sibling keys (`.strict()` envelope holds).

---

## Section 9 — R82 follow-ups (deferred)

- Admin UI for managing tags, cohorts, allowlists.
- Coach self-serve UI for creating cohorts/tags.
- Per-client coach overrides ("coach grants client X access to lesson Y") + override table + audit (explicitly deferred by D6).
- `gifted` program-enrollment status / admin grant column (§2.3 OQ-3).
- Flag-rule A/B test framework (rules are deterministic today).
- Multi-region cache coordination (single-region v1).
- Owner multi-gym cache-context axis (if owner gym switching lands).
- PostHog-query-backed reconciliation vs. local counter table (pick a source for the weekly job).
- Promotion path for `experimental`/`deprecated` flags into emission.

---

## Section 10 — Open questions for Bradley

- [ ] **OQ-1 (D5/D7 emission):** Override says "emit all known flags"; `DECISIONS.md` D7 says "exactly 4". Confirm we emit all `active` registry flags (we proceeded on the override; safe because `flags` is an open map).
- [ ] **OQ-2 (client tier model):** Confirm **2.0-A** — new `ClientSubscription` + `ClientTier { free, pro, elite }`, separate from coach's `CoachTier { free, pro, enterprise }`. "Elite" ≠ "enterprise". Where does client billing originate (Stripe client subscription vs. derived from `ClientPurchase`)?
- [ ] **OQ-3 (program status):** Is "gifted"/admin-granted enrollment in scope for v1, or R82? (`ClientPurchase.status` has no `gifted` today.)
- [ ] **OQ-4 (activity thresholds):** Confirm active ≤7d / lapsed ≤30d / churned >30d, and the signal set (workout sessions + messages + activity events + food logs).
- [ ] **OQ-5 (p99 budget):** Brief §6 says p99 < **1500ms**; `DECISIONS.md` D5 says p99 < **250ms**. Which is canonical? (Designed to 250ms.)
- [ ] **OQ-6 (owner/gym model):** `gymIds` for owner role — confirm the gym/franchise model with PLAN_B so the owner branch resolves correctly.
- [ ] **OQ-7 (Redis provisioning):** Confirm Redis will be provisioned (`REDIS_URL` always-on) as the Wave-1.5 prerequisite — the locked D4 pub/sub requires it.

---

## Section 11 — Build order

1. **Schema + migrations** (§2.1–2.8) — enums, 6-dimension tables, `ClientPurchase` index, RLS policies **co-landed with PLAN_B**. Backfill scripts.
2. **`KNOWN_FLAGS` registry skeleton** (`known-flags.ts`) — flag defs, no rules yet.
3. **`EvaluatorContextLoader`** + single-roundtrip CTE (§3.1) on a service-role Prisma client.
4. **Per-flag rules** wired into the registry (§3.2); `envGate`/`isAllowlisted`/`roleAllowsCoachGated` helpers.
5. **`/me/feature-flags` controller + DTO** — snake_case, `.strict()` envelope, `JwtAuthGuard` (not `@Public`), `feature-flags-per-min` throttle (§7).
6. **LRU cache layer** (`FeatureFlagsCacheService`, `lru-cache`, §4.1).
7. **Redis pub/sub invalidation** — dedicated pub+sub ioredis connections in `FeatureFlagsModule` (§4.2).
8. **Mutation hooks** publish invalidation at the 8 sites (§4.3).
9. **Drift telemetry** — startup fail-loud validation (§5.2) + PostHog drift events + weekly reconciliation cron.
10. **Tests** — T1–T9 + all extended scenarios (§8).
11. **Perf assertion + CI gating** (§6) — two-phase 100-concurrent load test.

---

## Cross-plan coordination note

RLS policies in §2.1, §2.2, §2.5 (especially the owner-cannot-read-individual-tag-values boundary) are **coordinated with PLAN_B**. Both plans' migrations must land in a single deploy so the privacy matrix is never half-applied. The gym/owner model (`gymIds`, §3.1) is owned by PLAN_B; Plan C consumes it read-only.
