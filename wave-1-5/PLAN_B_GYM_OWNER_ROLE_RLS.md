# PLAN B — Gym-Owner Role + RLS Privacy Boundaries (DESIGN ONLY)

**Author:** Chief of Product (reporting to Bradley Gleave)
**Date:** 2026-06-16
**Status:** DESIGN — no production code in this document. READ-ONLY audit of `growth-project-backend`.
**Repo audited:** `growth-project-backend-b8746bcc-cced4c3b` @ `fea925a`
**Scope:** Design the new `gym_owner` role and the RLS privacy wall that enforces what a gym owner can and cannot see.

> **The one-sentence thesis:** A gym owner is a **franchise-financial role**, not a super-user. The existing `owner` role in this codebase is platform god-mode (total bypass at BOTH the guard layer and the RLS layer). The single biggest mistake we could make is to model `gym_owner` as another flavour of `owner`. It must be a **separate role dimension with a separate RLS helper (`app.is_gym_owner()`) that is NARROW by construction** and can never read an individual client's PHI, contact info, or chat — by database-enforced default, not by remembering to add a `WHERE`.

---

## ⚠️ CRITICAL TERMINOLOGY — read this first

This codebase already has a role literally named `owner`. **It does NOT mean gym owner.** It means **platform / SaaS tenant owner** — Bradley's own super-admin account, the people who run The Growth Project platform itself.

| Term in this doc | Meaning | Today? |
|---|---|---|
| **`owner`** (existing `Role` enum value) | Platform super-admin. **Total bypass** in `RolesGuard` and **god-mode** in every RLS policy via `app.is_owner()`. | EXISTS. `prisma/schema.prisma:30-34` |
| **`coach`** / **head coach** | Sells packages, owns a client roster, runs a "team" / `TeamProfile`. | EXISTS |
| **sub-coach** | A `coach`-role user with active `TeamSubCoachAssignment` rows; restricted from billing. | EXISTS |
| **`student`** | A client. | EXISTS |
| **`gym_owner`** (THIS DOC) | Franchise operator who sees **financial aggregates** for coaches in their gym(s) and edits comp — but **NEVER** individual client PHI/PII/chat. | **NEW — does not exist** |

Throughout this document, "owner" in code/citations = the existing platform super-admin. "Gym owner" / "`gym_owner`" = the new role we are designing.

---

# Section 1 — Audit of the current role model

### 1.1 Where roles are defined

**The role is a Postgres enum + a Prisma enum + a TS union, three places that must stay in sync.**

- Prisma/DB enum — `prisma/schema.prisma:30-34`:
  ```prisma
  enum Role {
    coach
    student
    owner
  }
  ```
- `User.role` column — `prisma/schema.prisma:160`: `role Role @default(student)`.
- TS union — `src/common/decorators/roles.decorator.ts:15`: `export type AppRole = 'owner' | 'coach' | 'student';`

There is **no separate `user_role` table and no `permission` table.** Role is a single scalar column on `User`. This is important: the current model assumes **one user has exactly one role**, and that role is totally ordered (`owner > coach > student`).

### 1.2 Existing roles and their capabilities

| Role | Guard-layer capability | RLS-layer capability |
|---|---|---|
| `owner` | **Total bypass** — `roleSatisfies()` returns `true` for any `@Roles(...)` gate (`src/auth/roles.guard.ts:67-75`). | **God-mode** — `app.is_owner()` appears in the `USING`/`WITH CHECK` of essentially every Tier-1/financial policy, granting full read/write (`prisma/migrations/20261213000000_rls_tier1_phi_financial_privacy/migration.sql`, e.g. BloodworkResult SELECT/INSERT/UPDATE/DELETE). |
| `coach` | Passes `coach` and `student` gates (`roles.guard.ts:71-73`). Head-coach-only routes gated by `HeadCoachOnlyGuard` (`src/sub-coaches/head-coach-only.guard.ts`). | On most user-data tables a coach reads client rows **only via the `app.is_current_coach_of(client)` predicate** (`prisma/migrations/...rls_tier1...`), which resolves through `app.is_user_coached_by`. |
| sub-coach | A `coach` blocked from billing/team mutation by `NoActiveSubCoachGuard` (`src/common/guards/no-active-sub-coach.guard.ts`) and `HeadCoachOnlyGuard`. | Same coach predicates; client overlay via `SubCoachAssignment`. |
| `student` | Passes only `student` gates. | Self-access only — e.g. `User` policy `user_self_access` is `"id" = app.current_user_id()` (`prisma/migrations/rls_fitness_backend.sql:84-88`). |

### 1.3 How role propagates through the system

**Role is resolved by DB lookup, never trusted from the JWT.** This is the system's strongest existing property and we will preserve it.

1. **JWT validation** — `src/auth/auth.guard.ts:90-107`. The Supabase access token is verified **locally via JWKS** (`src/auth/jwks.service.ts`); only the `sub` claim (Supabase auth UUID) is read. The guard then does `prisma.user.findUnique({ where: { supabase_id } })` and assigns the **full Prisma `User` row** to `req.user` (`auth.guard.ts:135`). **Role comes from `user.role` in the DB, not from a token claim.**
2. **Guard layer** — `RolesGuard` (`src/auth/roles.guard.ts`) is registered globally (`APP_GUARD`) and reads `req.user.role`.
3. **RLS layer** — `RlsContextInterceptor` (`src/common/interceptors/rls-context.interceptor.ts:41-67`) runs after `JwtAuthGuard` and pushes the identity into Postgres GUCs via transaction-scoped `set_config(..., true)`:
   - `app.current_user_id` and `app.current_user_role`.
4. **RLS helpers read the GUCs** — `app.current_user_id()`, `app.current_user_role()`, `app.is_owner()`, `app.is_current_coach_of()` (`prisma/migrations/20261212000000_rls_helper_search_path/migration.sql:62-103`), all `STABLE` and pinned to `search_path = ''` (search-path-injection hardening).

> **🚩 SEPARATE FINDING F-1 (pre-existing, do NOT fix in this plan).** The interceptor gates on and sends `user.sub` (`rls-context.interceptor.ts:45,52`) but `req.user` is the Prisma `User` row, which has **no `sub` field** — the correct field is `user.id` (`auth.guard.ts:135`; `User.id` is the PK at `schema.prisma:155`). As written, `app.current_user_id` is set to `undefined` (→ the `if (user?.sub)` guard is falsy → `set_config` is never called) for normal request traffic. RLS therefore evaluates with a NULL `current_user_id`, i.e. **deny-by-default**. Production today survives this because **all runtime DB traffic uses the Supabase `service_role`, which has `BYPASSRLS`** (documented in `RLS_INVESTIGATION_LOG.md`); RLS is defense-in-depth for direct/Studio access and the live-DB test suites set the GUC themselves. **This is a latent landmine for the gym-owner design** (see §4.0) and must be fixed before RLS is the *enforcing* layer for gym-owner. Filed as a finding, not fixed here per the brief's "flag broken RLS separately" rule.

### 1.4 Existing RLS posture on user-data tables (the privacy wall today)

The wall is real and mature: **41 migrations** contain `CREATE POLICY`, and a live-DB suite of **543 tests** (`RLS_INVESTIGATION_LOG.md`) exercises it. Canonical primitives are documented in the Tier-1 migration header (`prisma/migrations/20261213000000_rls_tier1_phi_financial_privacy/migration.sql:9-23`):

- **A** — `service_role` bypass (`FOR ALL TO service_role USING (true) WITH CHECK (true)`).
- **C** — direct self-access on a TEXT user/coach/client column (`"user_id" = app.current_user_id()`).
- **D** — client-self OR current-coach (`... OR app.is_current_coach_of(client)`).
- **E** — child-table access through a parent row (`EXISTS (SELECT 1 FROM parent ...)`).
- Plus `app.is_owner()` OR-ed into nearly every policy as the platform-super-admin escalation.

Representative policies (the wall we are extending):

| Table | Policy | USING (paraphrased) | Cite |
|---|---|---|---|
| `User` | `user_self_access` (`FOR ALL`) | `id = current_user_id()` — **self only; coaches do NOT read student `User` rows via RLS** | `rls_fitness_backend.sql:84-88` |
| `WeightLog` | `weight_log_owner_access` | `user_id = current_user_id()` — **self only** | `rls_fitness_backend.sql:135-140` |
| `LoggedFoodEntry` | enabled+forced | self/coach predicate (Tier-3 nutrition) | `rls_fitness_backend.sql:75-77`; `...rls_tier3_nutrition...` |
| `WorkoutSession` | enabled+forced | self/coach (Tier-3 workouts) | `rls_fitness_backend.sql:58-59`; `...rls_tier3_workouts...` |
| `CoachMessage` | `coach_message_participant_access` | participant only (`coach_id`/`client_id`/`sender_id` IS NOT DISTINCT FROM current) | `rls_fitness_backend.sql:118-133` |
| `BloodworkResult` | `p_bloodworkresult_*` | child-via-`BloodworkPanel` to client/coach/`is_current_coach_of`/`is_owner` | `...rls_tier1...:54-72` |
| `ClientPurchase` | `client_purchase_select` | `client_user_id`/`coach_user_id` = current | `20260606000003_rls_financial_tables/migration.sql:32-43` |
| `Invoice` | coach-scoped | `coach_id = current_user_id()` | `20260606000003_rls_financial_tables/migration.sql:75-96` |

**Two facts from this audit drive the entire gym-owner design:**

1. **There is no "coach sees the roster" `User` SELECT policy.** Coaches read student PHI through the `service_role` application path, scoped by service-layer `WHERE coach_id = caller.id` (per `ENGINEERING_RULES.md §1`). So when we add the gym owner, we will likewise *not* give the gym owner a broad `User` SELECT — and crucially, **we must not let the gym owner ride the `service_role` path the way coaches do.** Gym-owner queries must be scoped at the service layer AND fenced by RLS so a future direct-DB or mis-scoped query cannot leak.
2. **`app.is_owner()` is god-mode.** If `gym_owner` were added to the `Role` enum and OR-ed into `is_owner()` (or the `owner > coach > student` hierarchy), it would inherit total read of PHI. **The design MUST keep `gym_owner` out of `Role` and out of `is_owner()`.**

---

# Section 2 — Coach ↔ Gym ↔ Owner relationship model

### 2.1 Does a "Gym" entity exist today? — **No.**

The closest construct is **`TeamProfile`** (`prisma/schema.prisma`, ~4160-4197), a *minimal* per-head-coach org stub. Its own header comment is explicit:

> *"TeamProfile is a minimal org/gym record attached to the head coach. We deliberately do NOT model gyms as first-class tenants … When (if) we promote gyms to first-class tenants this row will migrate into a `team_id` FK; the head coach link stays around as the owner pointer."*

So: gyms were always planned as a future first-class entity. **This plan promotes them.** `has_gym_membership` and the `full_gym`/`home_gym` equipment enums on `UserProfile` are workout-context flags, unrelated.

### 2.2 The entities to add

```
GymOwnerProfile (1) ──< GymOwnerGym (M) >── Gym (1) ──< GymCoach (M) >── User(role=coach)
                                              │                              │
                                              │                              └──< User(role=student) via User.coach_id
                                              └──(non-PT gym members) ──< User (gym_id, no coach_id)
```

**Cardinalities (locked by Bradley's "franchise owner" framing):**

- **Gym Owner → Gym: one-to-many.** A franchise owner owns multiple gyms. Implemented via join table `GymOwnerGym` (kept M:N-capable for the rare co-ownership case; see §11 OPEN-2).
- **Gym → Coach: many-to-many.** A coach *usually* belongs to one gym, but a coach working at two gyms must be representable. Join table `GymCoach`.
- **Coach → Client: already exists** — `User.coach_id` self-relation (`schema.prisma:163-165`, relation `CoachToStudents`). We do **not** change this.
- **Gym → non-PT member:** a `student` with a `gym_id` but `coach_id = NULL`. Requires adding a nullable `gym_id` to `User` (or a `GymMembership` join — see §11 OPEN-3).

### 2.3 Proposed schema (Prisma sketch — design only)

```prisma
// NEW — a gym is a first-class billing/org entity.
model Gym {
  id            String   @id @default(uuid())
  name          String
  // Billing entity metadata (kept minimal; Stripe wiring is out of scope for this PR).
  legal_name    String?
  timezone      String?
  archived_at   DateTime?
  created_at    DateTime @default(now())
  updated_at    DateTime @updatedAt

  owners        GymOwnerGym[]
  coaches       GymCoach[]
  // Non-PT members: a User with gym_id set and coach_id null. (See OPEN-3.)
  members       User[]    @relation("GymMembers")

  @@index([archived_at])
}

// NEW — profile row for a gym-owner identity. Mirrors CoachProfile's role-profile pattern.
model GymOwnerProfile {
  id          String   @id @default(uuid())
  user_id     String   @unique
  user        User     @relation("GymOwnerProfileUser", fields: [user_id], references: [id], onDelete: Cascade)
  created_at  DateTime @default(now())
  updated_at  DateTime @updatedAt
}

// NEW — owner↔gym join (M:N-capable; one owner → many gyms is the common case).
model GymOwnerGym {
  id          String    @id @default(uuid())
  gym_id      String
  gym         Gym       @relation(fields: [gym_id], references: [id], onDelete: Cascade)
  owner_user_id String
  owner       User      @relation("GymOwnerLink", fields: [owner_user_id], references: [id], onDelete: Cascade)
  // Lifecycle: removing an owner archives rather than deletes (audit trail).
  added_at    DateTime  @default(now())
  removed_at  DateTime?
  added_by_id String?   // platform-owner/admin who provisioned this link

  @@unique([gym_id, owner_user_id])
  @@index([owner_user_id, removed_at])
  @@index([gym_id, removed_at])
}

// NEW — gym↔coach membership (M:N; a coach can work at >1 gym, rare).
model GymCoach {
  id          String    @id @default(uuid())
  gym_id      String
  gym         Gym       @relation(fields: [gym_id], references: [id], onDelete: Cascade)
  coach_user_id String
  coach       User      @relation("GymCoachLink", fields: [coach_user_id], references: [id], onDelete: Cascade)
  joined_at   DateTime  @default(now())
  left_at     DateTime?

  @@unique([gym_id, coach_user_id])
  @@index([coach_user_id, left_at])
  @@index([gym_id, left_at])
}
```

`User` gains (sketch): `gym_owner_profile GymOwnerProfile?`, `owned_gyms GymOwnerGym[] @relation("GymOwnerLink")`, `gym_coach_links GymCoach[] @relation("GymCoachLink")`, optional `gym_id String?` + `gym Gym? @relation("GymMembers")` for non-PT members.

**Rationale for join tables over scalar FKs:** owner→gym and gym→coach are both lifecycle relationships (people join and leave gyms; ownership transfers). Modeling them as soft-deletable join rows gives us (a) a clean audit trail of who could see what and when — essential for a privacy-sensitive role — and (b) the ability to revoke access by setting `removed_at`/`left_at` without destroying history. This mirrors the codebase's existing `TeamSubCoachAssignment` archival pattern (`schema.prisma:2691-2707`).

---

# Section 3 — Payment-structure model (owner ↔ coach compensation)

### 3.1 Requirements recap
The gym owner can **see and edit** the comp structure for each coach in their gym; the coach can **see their own** comp (and only their own); history is preserved; every change is audited.

### 3.2 Where this differs from existing fee models
The codebase already has **`FeePolicy`** (`schema.prisma:3598-3618`: `platform_application_fee_bps`, `head_coach_split_bps`) and **`SplitLedgerEntry`** (`schema.prisma:3637-3685`). Those govern **platform↔coach↔sub-coach Stripe revenue splits at charge time.** Gym-owner comp is a **different relationship** (owner↔coach employment/rev-share) and should **not** overload `FeePolicy`. We add a dedicated, versioned table.

### 3.3 Proposed schema (design only)

```prisma
enum CompModel {
  rev_share        // % of coach-generated revenue to owner (or to coach)
  base_salary      // fixed periodic salary
  hybrid           // base + rev share
  per_client_bonus // flat amount per active client
}

// NEW — current + historical compensation agreements between a gym (owner) and a coach.
// VERSIONED: edits never UPDATE-in-place; they close the old row (effective_to) and
// INSERT a new one. The "current" agreement is the row with effective_to IS NULL.
model CoachCompensation {
  id              String     @id @default(uuid())
  gym_id          String
  gym             Gym        @relation(fields: [gym_id], references: [id], onDelete: Cascade)
  coach_user_id   String
  coach           User       @relation("CoachCompensationCoach", fields: [coach_user_id], references: [id], onDelete: Cascade)

  comp_model      CompModel
  rev_share_bps   Int?       // basis points, for rev_share / hybrid
  base_salary_cents Int?     // for base_salary / hybrid
  salary_interval String?    // 'month' | 'year' — for base_salary / hybrid
  per_client_bonus_cents Int? // for per_client_bonus
  currency        String     @default("usd")
  notes           String?

  // Versioning window.
  effective_from  DateTime   @default(now())
  effective_to    DateTime?  // NULL = current agreement
  superseded_by_id String?   @unique

  created_at      DateTime   @default(now())
  created_by_id   String     // the gym-owner User.id who authored this version

  @@index([gym_id, coach_user_id, effective_to])
  @@index([coach_user_id, effective_to])
}

// NEW — append-only audit of every comp change (who/when/before/after).
model CoachCompensationAudit {
  id               String   @id @default(uuid())
  compensation_id  String
  gym_id           String
  coach_user_id    String
  actor_user_id    String   // gym-owner who made the change
  action           String   // 'created' | 'superseded' | 'ended'
  before_json      Json?
  after_json       Json?
  created_at       DateTime @default(now())

  @@index([gym_id, created_at])
  @@index([coach_user_id, created_at])
}
```

**Versioning choice:** *close-and-insert* (temporal rows with `effective_from`/`effective_to`) rather than in-place UPDATE. Reason: comp disputes are inevitable ("you cut my rev share in March"), so the row history *is* the source of truth. The separate `CoachCompensationAudit` table captures the actor + before/after even for non-comp-value edits (notes), and is append-only (no UPDATE/DELETE policy for owner — see §4).

---

# Section 4 — RLS policies (the critical part)

### 4.0 Enforcement-model decision (foundational)

Today, RLS is **defense-in-depth**, not the primary gate (runtime uses `service_role`/BYPASSRLS — `RLS_INVESTIGATION_LOG.md`). For the gym owner that posture is **not safe enough**, because a gym owner is a *paying external user we are deliberately fencing off from PHI*. A single mis-scoped service query would leak client food logs to a franchise operator — exactly the catastrophic failure the brief names.

**Decision: the gym-owner read path must NOT use the blanket `service_role` connection.** Instead:

- **Layer 1 (RLS, primary for gym-owner):** Gym-owner requests run on a connection where `app.current_user_role = 'gym_owner'` and `app.current_user_id = <owner id>` are set, and the connection is **NOT** `service_role`. RLS is the hard wall.
- **Layer 2 (service/API):** Service methods additionally scope `WHERE gym_id IN (owner's gyms)` per `ENGINEERING_RULES.md §1`. Defense in depth, not the only defense.
- **Prerequisite:** Finding **F-1** (interceptor `user.sub` bug, §1.3) must be fixed so `app.current_user_id` is actually populated, AND a dedicated non-BYPASSRLS Postgres role (e.g. `app_gym_owner` or reuse `authenticated`) must carry gym-owner traffic. Without this, the RLS wall below is inert for gym owners. **This is the #1 build-order dependency.**

### 4.1 New RLS helpers (design)

```sql
-- The gym-owner role flag. SEPARATE from app.is_owner(). NEVER OR this into PHI policies.
CREATE OR REPLACE FUNCTION app.is_gym_owner()
RETURNS boolean LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT app.current_user_id() IS NOT NULL AND app.current_user_role() = 'gym_owner'
$$;

-- True when the current gym-owner owns the given gym (active link only).
CREATE OR REPLACE FUNCTION app.gym_owner_owns_gym(gym text)
RETURNS boolean LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT app.is_gym_owner() AND EXISTS (
    SELECT 1 FROM public."GymOwnerGym" g
    WHERE g."gym_id" = gym
      AND g."owner_user_id" = app.current_user_id()
      AND g."removed_at" IS NULL
  )
$$;

-- True when the current gym-owner owns a gym that the given coach belongs to.
CREATE OR REPLACE FUNCTION app.gym_owner_of_coach(coach text)
RETURNS boolean LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT app.is_gym_owner() AND EXISTS (
    SELECT 1
    FROM public."GymCoach" gc
    JOIN public."GymOwnerGym" go ON go."gym_id" = gc."gym_id"
    WHERE gc."coach_user_id" = coach
      AND gc."left_at" IS NULL
      AND go."owner_user_id" = app.current_user_id()
      AND go."removed_at" IS NULL
  )
$$;
```

> **Invariant (must be a guard test):** `app.is_gym_owner()` and `app.is_owner()` are mutually exclusive in their truth source (`current_user_role` is a single value), AND **no PHI/PII policy may reference `app.is_gym_owner()`**. A doctrine grep test (cf. `test/doctrine-cleanup.spec.ts`, `AGENT_RULES.md R70`) should fail if `is_gym_owner` ever appears in a policy on a denied table from the matrix below.

### 4.2 The contract matrix → concrete policies

| Table | Gym owner can read? | Policy approach |
|---|---|---|
| `User` (clients) | **Aggregates only, no PII** | **No new gym-owner SELECT policy.** Existing `user_self_access` stays. PII is unreachable by `gym_owner` at the row level. Counts/retention come exclusively from the §5 aggregate views. |
| `LoggedFoodEntry` (food log) | **NO** | No `gym_owner` clause added. Existing self/coach policy unchanged → gym owner gets **zero rows**. |
| `WorkoutSession` / `WorkoutRoutine` / `ExerciseSet` | **NO** | Same — no `gym_owner` clause. |
| `WeightLog` / `BloodworkPanel` / `BloodworkResult` / progress photos | **NO** | Same — no `gym_owner` clause. PHI stays coach/self/`is_owner` only. |
| `CoachMessage` / messages | **NO** | Existing participant-only policy unchanged. |
| AI-guide / Roman chat conversations | **NO** | No `gym_owner` clause. |
| `CheckIn`, `Habit`, `Notification`, `UserProfile` | **NO** | No `gym_owner` clause. |
| **`Gym`** | **YES (owned only)** | New SELECT `USING (app.gym_owner_owns_gym("id") OR app.is_owner())`. |
| **`GymCoach`** | **YES (owned gyms)** | SELECT `USING (app.gym_owner_owns_gym("gym_id") OR app.is_owner())`. |
| **`CoachCompensation`** | **YES + EDIT (owned gyms)** | SELECT+INSERT+UPDATE for owner of `gym_id`; coach gets SELECT of own rows; see §4.3. |
| **`CoachCompensationAudit`** | **YES read, append-only** | SELECT for owner of `gym_id`; INSERT via service/trigger; **no UPDATE/DELETE** for anyone but `service_role`. |
| **`CoachBusinessMetric`** (agg, §5) | **YES** | SELECT `USING (app.gym_owner_of_coach("coach_user_id") OR <coach self> OR app.is_owner())`. |
| **`GymFinancialAggregate`** (agg, §5) | **YES (owned)** | SELECT `USING (app.gym_owner_owns_gym("gym_id") OR app.is_owner())`. |
| `ClientPurchase` / `Invoice` / `SplitLedgerEntry` (billing) | **Aggregates only** | **No `gym_owner` clause on the raw tables.** Owner reads revenue **only** through `GymFinancialAggregate` / `CoachBusinessMetric`. Raw per-client billing rows return zero. |

### 4.3 `CoachCompensation` policies (the only owner-writable client-adjacent table)

```sql
ALTER TABLE "CoachCompensation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachCompensation" FORCE ROW LEVEL SECURITY;

-- A. service_role bypass (Primitive A — defense in depth + server jobs)
CREATE POLICY "p_coachcomp_service_role_all" ON "CoachCompensation"
  AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

-- SELECT: gym owner of this gym, OR the coach themselves (own rows only), OR platform owner.
CREATE POLICY "p_coachcomp_select" ON "CoachCompensation"
  AS PERMISSIVE FOR SELECT TO public
  USING (
    app.is_owner()
    OR app.gym_owner_owns_gym("gym_id")
    OR ("coach_user_id" = app.current_user_id())
  );

-- INSERT: only a gym owner of this gym (or platform owner). Coach CANNOT author comp.
CREATE POLICY "p_coachcomp_insert" ON "CoachCompensation"
  AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (
    app.is_owner()
    OR (app.gym_owner_owns_gym("gym_id") AND "created_by_id" = app.current_user_id())
  );

-- UPDATE: only a gym owner of this gym. WITH CHECK re-asserts ownership so an owner
-- cannot move a row to a gym they don't own.
CREATE POLICY "p_coachcomp_update" ON "CoachCompensation"
  AS PERMISSIVE FOR UPDATE TO public
  USING (app.is_owner() OR app.gym_owner_owns_gym("gym_id"))
  WITH CHECK (app.is_owner() OR app.gym_owner_owns_gym("gym_id"));

-- DELETE: service_role / platform owner only (versioned rows are not deleted by gym owners).
CREATE POLICY "p_coachcomp_delete" ON "CoachCompensation"
  AS PERMISSIVE FOR DELETE TO public
  USING (app.is_owner());
```

`CoachCompensationAudit` mirrors this but has **no UPDATE and no DELETE** policy beyond `service_role`/`is_owner()`, and INSERT is restricted to `service_role` (the service writes the audit row inside the same transaction as the comp change). Coaches and gym owners get SELECT (owner: their gym; coach: their own rows).

### 4.4 Universal critical rules (applied to every new table)

1. **DB-level enforcement** — `ENABLE` + `FORCE ROW LEVEL SECURITY` on every new table (mirrors `ENGINEERING_RULES.md §2`).
2. **Every INSERT/UPDATE policy has an explicit `WITH CHECK`** — never rely on `USING` alone for writes (this is how an owner is stopped from writing a comp row into another gym).
3. **Default-deny** — tables denied to the gym owner get **no `gym_owner` clause at all**; the absence is the denial. We never write `... AND role != 'gym_owner'` (brittle); we simply never grant.
4. **`search_path = ''`** on all new helpers (anti-hijack, matches `20261212000000`).
5. **No `app.is_gym_owner()` in any PHI/PII policy** — enforced by doctrine grep test.

---

# Section 5 — Aggregation layer (per-coach numbers without leaking rows)

### 5.1 The leak risk
The brief's example is exactly right: `COUNT(*) WHERE coach_id=X AND client_age>35 = 1` is a re-identification leak. **Any aggregate the owner can *slice* is a potential differencing attack.** Today there is **no aggregate/metric table at all** (confirmed: no `*Metric`/`*Aggregate`/`MRR`/`Retention` model exists; metrics would be computed live). So we design the aggregation layer from scratch — and we design it *closed*.

### 5.2 Recommended approach — **pre-computed, coach-grain-only, owner-unsliceable tables**

Reject live owner-issued aggregation queries (too easy to slice into a leak). Instead, a **server-side scheduled job** (running as `service_role`, which *can* read the raw PHI/billing rows) computes denormalized rows at a **fixed grain the owner cannot subdivide**:

```prisma
// One row per coach per period. Owner SELECTs whole rows; cannot add WHERE on client attributes.
model CoachBusinessMetric {
  id              String   @id @default(uuid())
  gym_id          String
  coach_user_id   String
  period_start    DateTime // e.g. month bucket
  period_end      DateTime
  mrr_cents       Int      @default(0)
  active_clients  Int      @default(0)
  new_clients     Int      @default(0)
  churned_clients Int      @default(0)
  retention_pct   Float?
  conversion_pct  Float?
  growth_rate_pct Float?
  computed_at     DateTime @default(now())
  @@unique([gym_id, coach_user_id, period_start])
}

// One row per gym per period. Gym-level financial rollup.
model GymFinancialAggregate {
  id              String   @id @default(uuid())
  gym_id          String
  period_start    DateTime
  period_end      DateTime
  total_revenue_cents Int  @default(0)
  total_clients   Int      @default(0)
  total_coaches   Int      @default(0)
  computed_at     DateTime @default(now())
  @@unique([gym_id, period_start])
}
```

**Why this is safe:**
- The **only** grain exposed to the owner is *coach × period* and *gym × period*. There is no client-attribute column to filter on, so the differencing attack (`age > 35`) is structurally impossible — the owner literally cannot express it.
- The owner reads via `app.gym_owner_of_coach()` / `app.gym_owner_owns_gym()` RLS, never the raw PHI.
- The job reads raw rows as `service_role`; the *output* is the only thing the owner touches.

### 5.3 k-anonymity suppression (belt-and-suspenders)
Even at coach grain, a coach with 1 client makes `active_clients=1` mildly identifying for downstream UI. Recommendation: **suppress small cells** — when `active_clients < k` (start at **k=5**), emit the count but **NULL out** `retention_pct`/`churn`/`conversion` (rates over tiny n are both noisy and identifying), and surface a UI state "Not enough clients yet." This is cheap because we control the compute job. Document `k` as a locked default (cf. the D7 locked-defaults pattern, `test/invariants/locked_defaults.spec.ts`).

### 5.4 Refresh cadence
Nightly scheduled job (the repo already runs scheduled work). Owner dashboards read yesterday's close — acceptable for financial/retention metrics and removes any real-time inference channel. (OPEN-5: is nightly fresh enough, or does Bradley want near-real-time revenue?)

---

# Section 6 — JWT / auth integration

### 6.1 Where the role lives — **DB, not JWT (unchanged)**
Keep the existing model: the JWT carries only Supabase `sub`; role is resolved by `prisma.user.findUnique` in `JwtAuthGuard` (`auth.guard.ts:105-135`). **Do NOT add `role`/`gym_ids` as trusted JWT claims** — it would create a second, spoofable source of truth and break the system's strongest property (§1.3). Performance is already fine: JWKS verify is local (microseconds) and the user lookup is a single indexed query.

### 6.2 The role-shape problem and the recommendation

`User.role` is a single scalar and `owner` is total-bypass. Two options:

- **Option A — add `gym_owner` to the `Role` enum.** Simple, but dangerous: every `roleSatisfies`/`is_owner`/hierarchy site must be re-audited to ensure `gym_owner` is *not* swept into `owner` semantics. The `owner > coach > student` total order doesn't cleanly admit a sideways role.
- **Option B (RECOMMENDED) — `gym_owner` is a distinct `Role` value BUT explicitly modeled as a *non-hierarchical* role**, with:
  - `roleSatisfies()` updated so `gym_owner` satisfies **only** `gym_owner` gates (no inheritance, no bypass) — it is a *leaf*, not a *king*.
  - `app.is_owner()` **left untouched** (so `gym_owner` never gets god-mode RLS).
  - A new `GymOwnerGuard` (`role === 'gym_owner'`) and `@Roles('gym_owner')` for owner endpoints.
  - The RLS GUC `app.current_user_role` simply carries `'gym_owner'`; the new helpers in §4.1 key off it.

> A user who is *both* a coach and a gym owner is the hard case (§11 OPEN-1). With a single scalar role this isn't directly representable. The clean answer is a **separate `GymOwnerProfile` row decoupled from `User.role`** (already proposed in §2), letting "is this user a gym owner?" be answered by *profile existence* rather than the scalar role — while the *active request role* is what's in the GUC. This is the safest path and is the recommendation; see OPEN-1.

### 6.3 Token-refresh on promotion
When a coach is promoted to gym owner (or a gym owner added to a gym), nothing in the JWT changes (role isn't in the token), so **no forced token refresh is needed** — the next request's DB lookup reflects the new state immediately. This is a direct benefit of keeping role in the DB. Access changes (added/removed from a gym) are likewise instant because `GymOwnerGym.removed_at` is read live by `app.gym_owner_owns_gym()`.

---

# Section 7 — Feature-flag implications (Wave 1.5 BIG)

### 7.1 How flags work today
There is **no central `evaluateFeatureFlags`**; flags are an **open-set of per-feature env-var functions** (e.g. `src/community/ai-triage/ai-triage.feature.ts:25-27` `aiTriageEnabled()` → `process.env.FEATURE_... === 'true'`). ~15 flags exist. **Flags are feature-wide, not per-role** — role gating lives separately in guards/entitlements (`src/common/guards/client-entitlement.guard.ts:41`). Per `AGENT_RULES.md R71`, the flag registry is a shared-append-only surface.

> Note: the brief references an `evaluateFeatureFlags` evaluator service and an "open-set flag registry per locked D7 override." That centralized evaluator is **not present in this repo today** (it may be a Wave-1.5 deliverable from a sibling plan). This plan assumes the flag layer stays env-var/open-set and lists the flags to add; if the centralized evaluator lands, these flags map onto it 1:1.

### 7.2 Flags to add (owner-specific, default OFF in prod)
- `FEATURE_GYM_OWNER_DASHBOARD` — gates the owner dashboard surface.
- `FEATURE_COACH_COMPENSATION_EDIT` — gates owner comp read/write endpoints.
- `FEATURE_FRANCHISE_METRICS_VIEW` — gates the per-coach/gym aggregate views.
- `FEATURE_GYM_OWNER_ROLE` — master gate for the whole role (lets us ship tables+RLS dark, then turn on).

All follow the existing strict `=== 'true'` pattern, default OFF in production, auto-on in dev/test only if we follow the `contracts.feature.ts:61-73` precedent. **Recommendation: include all four in the registry from day one** (ship-dark), consistent with the open-set/locked-defaults discipline — so the role can land behind a master flag and be enabled per-environment without a new deploy.

### 7.3 Which existing flags resolve TRUE for gym owner?
**None automatically.** Because flags are feature-wide (not role-resolved), there's nothing to flip. Gym-owner-specific behavior is gated only by the four new flags above plus `GymOwnerGuard`. Explicitly: gym owner does **not** inherit coach flags.

---

# Section 8 — Migration / rollout plan

1. **Ship tables + RLS dark** (behind `FEATURE_GYM_OWNER_ROLE=false`). One append-only, timestamped migration per `ENGINEERING_RULES.md §2`: create `Gym`, `GymOwnerProfile`, `GymOwnerGym`, `GymCoach`, `CoachCompensation`, `CoachCompensationAudit`, `CoachBusinessMetric`, `GymFinancialAggregate`, each with `ENABLE`+`FORCE` RLS and full policy set in the same migration. Add helpers (`is_gym_owner`, `gym_owner_owns_gym`, `gym_owner_of_coach`). No user has `gym_owner` yet → zero behavior change.
2. **Fix Finding F-1** (interceptor `user.sub` → `user.id`) and provision the non-BYPASSRLS gym-owner DB role — prerequisite for RLS to actually enforce (§4.0). Ship as its own audited PR (it touches the security-critical interceptor).
3. **Backfill / identify owners — manual admin action.** There is no signal in the data for "who should be a gym owner"; it's a business decision. Reuse the existing admin promotion pattern (`src/admin/admin.service.ts:113-157` `promoteUser`, guarded by `ServiceTokenGuard` + `@Roles('owner')`). Add `promoteToGymOwner(targetUserId, gymIds[])` that (a) creates `GymOwnerProfile`, (b) sets active request-role plumbing, (c) inserts `GymOwnerGym` links. Bootstrap-script analogue: `scripts/bootstrap-owners.ts` is the template (`:62-65`).
4. **Admin tooling:** new admin endpoint(s) `POST /admin/gyms`, `POST /admin/gyms/:id/owners`, `POST /admin/gyms/:id/coaches` (all `ServiceTokenGuard` + platform-`owner`-gated). CLI not required — the admin endpoints + existing admin surface suffice. Do **not** lean on the Supabase dashboard for promotion (no audit trail).
5. **Enable per-environment** by flipping `FEATURE_GYM_OWNER_ROLE` once a gym's owners/coaches are provisioned and the RLS suite is green against the new tables.

---

# Section 9 — Test scenarios (the contract the build must pass)

These are **live-DB RLS tests** (`jest.rls.config.js`, run as a non-BYPASSRLS role with GUCs set per the harness in `RLS_INVESTIGATION_LOG.md`). Add a new suite `test/rls-gym-owner-policies.spec.ts`.

**Denial tests (PHI/PII/chat — the catastrophic-failure surface):**
- **T1** Gym owner SELECT `LoggedFoodEntry` for a client in their gym → **0 rows.**
- **T2** Gym owner SELECT `WorkoutSession` / `WorkoutRoutine` / `ExerciseSet` for an in-gym client → **0 rows.**
- **T3** Gym owner SELECT `WeightLog` / `BloodworkPanel` / `BloodworkResult` (progress) for an in-gym client → **0 rows.**
- **T4** Gym owner SELECT `CoachMessage` for an in-gym coach↔client thread → **0 rows.**
- **T5** Gym owner SELECT AI-guide/Roman chat rows → **0 rows.**
- **T6** Gym owner SELECT `User` rows of in-gym clients → **0 rows** (no name/email/phone reachable).
- **T7** Gym owner SELECT `ClientPurchase` / `Invoice` / `SplitLedgerEntry` raw rows → **0 rows** (aggregates only).
- **T8** Gym owner attempts INSERT/UPDATE on any of the above → **denied (42501).**

**Allow tests (the owner's legitimate surface):**
- **T9** Gym owner SELECT `Gym` they own → returns it; a gym they don't own → **0 rows.**
- **T10** Gym owner SELECT `CoachBusinessMetric` for a coach in their gym → returns rows; coach in another gym → **0 rows.**
- **T11** Gym owner SELECT `GymFinancialAggregate` for owned gym → rows; un-owned gym → **0 rows.**
- **T12** Gym owner SELECT `CoachCompensation` for a coach in their gym → rows.
- **T13** Gym owner UPDATE `CoachCompensation` for their gym's coach → **succeeds.**
- **T14** Gym owner INSERT `CoachCompensation` with `gym_id` they own + `created_by_id = self` → **succeeds.**
- **T15** Gym owner UPDATE/INSERT `CoachCompensation` for **another** gym's coach → **denied (RLS).**
- **T16** Gym owner UPDATE that tries to move a comp row to a gym they don't own (`WITH CHECK`) → **denied.**

**Coach / role-isolation tests:**
- **T17** Coach SELECT their own `CoachCompensation` → **succeeds (own rows only).**
- **T18** Coach SELECT another coach's `CoachCompensation` → **0 rows.**
- **T19** Coach INSERT/UPDATE `CoachCompensation` (any) → **denied** (only owner authors comp).
- **T20** A former coach demoted to `student` SELECT `CoachCompensation` → **0 rows.**
- **T21** A gym owner removed from a gym (`GymOwnerGym.removed_at` set) → immediately **0 rows** for that gym's `Gym`/metrics/comp.
- **T22** `student` (regular client) SELECT any gym-owner table → **0 rows / denied.**

**Aggregation / leak tests:**
- **T23** Confirm `CoachBusinessMetric`/`GymFinancialAggregate` expose **no client-attribute column** an owner could filter on (schema assertion / no client-grain rows).
- **T24** k-anonymity: a coach with `active_clients < k` has `retention_pct`/`conversion_pct`/`churn` **NULL** in the owner-visible row.

**Invariant / doctrine tests:**
- **T25** Grep test: `app.is_gym_owner()` appears in **no** policy on a denied table (T1–T7 set).
- **T26** Invariant: `app.is_owner()` body is unchanged (no `gym_owner` OR-ed in) — protects platform-owner semantics.
- **T27** `roleSatisfies('gym_owner', [...])` is `true` only for `['gym_owner']` gates and `false` for `coach`/`student`/`owner` gates (no inheritance, no bypass).
- **T28** Every new table has `relrowsecurity` AND `relforcerowsecurity` = true (catalog assertion, mirrors existing service_role catalog checks).

---

# Section 10 — R82 follow-ups (deferred, with rationale)

- **R82-1 — Stripe billing entity for `Gym`.** This plan models `Gym` as an org but does NOT wire it as a Stripe billing customer / Connect account. Coach billing stays as-is. Deferred: gym-level billing is a separate revenue project; modeling it now would over-build (`engineering: don't design for hypothetical requirements`).
- **R82-2 — Non-PT member full lifecycle.** We add `gym_id` on `User` for non-PT members and their aggregate visibility, but member onboarding/billing flows are out of scope. Deferred until the member-management surface is specced.
- **R82-3 — Near-real-time metrics.** §5 recommends nightly compute. If Bradley wants live revenue, a streaming/materialized-view variant is an R82 spike (and must re-pass the differencing-attack analysis).
- **R82-4 — Owner↔owner gym co-ownership UI.** Schema supports M:N owners per gym; the *UI/permissions* for multiple owners of one gym is deferred (OPEN-2).
- **R82-5 — Fix F-1 + dedicated DB role rollout** is called out as a hard prerequisite (§4.0/§8 step 2) but is itself a security-critical PR with its own audit; tracked as R82-5 so it isn't silently bundled.

---

# Section 11 — Open questions for Bradley

- `[ ] OPEN-1` **Coach who is ALSO a gym owner.** Some gym owners coach their own clients. Should that user, when acting on the coach path, see *their own* clients' PHI (yes — via the existing coach RLS predicates), while on the owner path seeing only aggregates for *other* coaches? **Recommendation:** yes — model "gym owner" via a separate `GymOwnerProfile` decoupled from `User.role`, so the same human can hold a coach role (full access to *their own* roster) and a gym-owner capability (aggregates-only for the rest). Trade-off: more plumbing (two capability sources) vs. one scalar role. Needs Bradley's sign-off because it shapes §6.2.
- `[ ] OPEN-2` **Multiple owners per gym.** Schema supports it (`GymOwnerGym` M:N). Do co-owners have identical rights, or is there a primary owner who alone can edit comp? Trade-off: simplicity (all equal) vs. franchise reality (a managing partner).
- `[ ] OPEN-3` **Non-PT members:** model as `User.gym_id` scalar (simple, one gym per member) or a `GymMembership` join (a member at multiple gyms)? Recommendation: scalar `gym_id` first (YAGNI); promote to join only if needed.
- `[ ] OPEN-4` **Access revocation timing when an owner is removed from a gym.** Design defaults to **immediate** (live read of `removed_at`). Confirm there's no grace period needed for in-flight reporting. Trade-off: instant security vs. abrupt dashboard loss.
- `[ ] OPEN-5` **Metric freshness.** Nightly close (recommended, removes inference channel) vs. near-real-time revenue. Trade-off: privacy/simplicity vs. live numbers.
- `[ ] OPEN-6` **k-anonymity threshold.** Start k=5 for suppressing rate metrics on tiny client counts? Trade-off: privacy vs. owners of small gyms seeing "Not enough data."
- `[ ] OPEN-7` **Can a gym owner see *coach* PII** (the coach's own name/email/phone)? The matrix protects *client* PII; coaches are the owner's business counterparties, so coach contact info is presumably fine. Confirm.

---

# Section 12 — Build-order recommendation

1. **Prerequisite PR (security-critical, own audit):** Fix Finding **F-1** (`rls-context.interceptor.ts` `user.sub` → `user.id`) and provision the non-BYPASSRLS gym-owner DB role. *Without this, the entire RLS wall below is inert for gym owners.* (§4.0)
2. **Schema + RLS migration (ship dark):** all 8 new tables with `ENABLE`+`FORCE` RLS and complete policy sets + the three new `app.*` helpers, in one append-only migration, behind `FEATURE_GYM_OWNER_ROLE=false`. (§2, §3, §4, §5 schemas)
3. **RLS live-DB test suite** `test/rls-gym-owner-policies.spec.ts` — implement T1–T28 (§9). Gate the migration merge on green per `AGENT_RULES.md R66`.
4. **`gym_owner` role plumbing:** `GymOwnerGuard`, `roleSatisfies` leaf-role update (no inheritance/bypass), `@Roles('gym_owner')`, GUC carries `'gym_owner'`. (§6) + invariant tests T26/T27.
5. **Aggregation job:** nightly `service_role` compute populating `CoachBusinessMetric` / `GymFinancialAggregate` with k-anonymity suppression. (§5) + tests T23/T24.
6. **Admin promotion tooling:** `promoteToGymOwner` + gym/owner/coach admin endpoints, modeled on `admin.service.ts:promoteUser` and `scripts/bootstrap-owners.ts`. (§8)
7. **Owner read/write endpoints + feature flags:** comp read/edit, dashboard/metrics endpoints, behind the four new flags. (§7)
8. **Enable per-environment** once a gym is provisioned and the suite is green.

---

## Appendix A — Key file:line citations (evidence index)

| Claim | Cite |
|---|---|
| `Role` enum `{coach,student,owner}` | `prisma/schema.prisma:30-34` |
| `User.role`, `User.id`, `User.coach_id` self-relation | `prisma/schema.prisma:155,160,163-165` |
| TS `AppRole` union | `src/common/decorators/roles.decorator.ts:15` |
| JWT local verify + DB role lookup; `req.user = user` | `src/auth/auth.guard.ts:90-107,135`; `src/auth/jwks.service.ts` |
| `owner` = total guard bypass | `src/auth/roles.guard.ts:67-75` |
| RLS interceptor sets GUCs (and the `user.sub` bug, F-1) | `src/common/interceptors/rls-context.interceptor.ts:41-67` (bug at `:45,52`) |
| RLS helpers (`current_user_id/role`, `is_owner`, `is_current_coach_of`), `search_path=''` | `prisma/migrations/20261212000000_rls_helper_search_path/migration.sql:62-103` |
| Canonical RLS primitives A/C/D/E + `is_owner` escalation | `prisma/migrations/20261213000000_rls_tier1_phi_financial_privacy/migration.sql:9-23,54-72` |
| `User` self-only policy (no coach-sees-roster RLS) | `prisma/migrations/rls_fitness_backend.sql:84-88` |
| `WeightLog`/`CoachMessage`/`CheckIn` policies | `prisma/migrations/rls_fitness_backend.sql:118-140` |
| `ClientPurchase`/`Invoice` financial RLS | `prisma/migrations/20260606000003_rls_financial_tables/migration.sql:32-96` |
| `TeamProfile` "we do NOT model gyms as first-class tenants … future `team_id`" | `prisma/schema.prisma:~4160-4197` |
| `FeePolicy` (2%/5% bps), `SplitLedgerEntry` (head_coach_split) | `prisma/schema.prisma:3598-3618,3637-3685` |
| `TeamSubCoachAssignment` archival pattern | `prisma/schema.prisma:2691-2707` |
| `CoachProfile` ($300 seat), `CoachSubscription`, `Invoice` | `prisma/schema.prisma:518-543,549-590` |
| Admin `promoteUser` (ServiceTokenGuard + @Roles('owner')) | `src/admin/admin.service.ts:113-157`; `src/admin/admin.controller.ts:113-133` |
| `bootstrap-owners.ts` role write | `scripts/bootstrap-owners.ts:62-65` |
| Feature flags: open-set env-var pattern, ~15 flags | `src/community/ai-triage/ai-triage.feature.ts:25-27`; `src/contracts/contracts.feature.ts:61-73` |
| Role-gating lives in guards, not flags | `src/common/guards/client-entitlement.guard.ts:41` |
| RLS live-DB suite config + 543-test proof | `jest.rls.config.js`; `RLS_INVESTIGATION_LOG.md` |
| Engineering rules: RLS in same migration, WITH CHECK, no inline role checks | `ENGINEERING_RULES.md §1,§2` |

## Appendix B — Findings summary (non-design issues surfaced during audit)

- **F-1 (P1, pre-existing, NOT fixed here):** `RlsContextInterceptor` references non-existent `user.sub`; should be `user.id`. Effect: `app.current_user_id` is never set on normal requests → RLS is deny-by-default and currently masked only because runtime uses `service_role`/BYPASSRLS. **Hard prerequisite to fix before RLS enforces the gym-owner wall.** (`src/common/interceptors/rls-context.interceptor.ts:45,52`)
- **F-2 (informational):** No aggregate/metric tables exist today; gym-owner aggregates are greenfield (good — lets us design them closed/unsliceable).
- **F-3 (informational):** No centralized `evaluateFeatureFlags` evaluator present in this repo; flags are open-set per-feature env functions. The brief's evaluator may be a sibling Wave-1.5 deliverable.

---

*End of PLAN B. No production code was written or modified. Repo accessed read-only.*
