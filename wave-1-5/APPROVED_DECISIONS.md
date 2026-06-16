# Wave 1.5 BIG — APPROVED DECISIONS (Bradley Gleave, locked)

**Date:** 2026-06-16 (PDT)
**Status:** ALL 21 OPEN QUESTIONS RESOLVED. Build may proceed once #263 closes.
**Governing docs:** `PLAN_A_CONTENT_PACKAGE_MAPPING.md`, `PLAN_B_GYM_OWNER_ROLE_RLS.md`, `PLAN_C_EVALUATOR_AND_SLICING.md`, `SERVER_SIDE_FEATURE_FLAGS_SPEC.md`, `DECISIONS.md`, `HYPERSCALER_RESEARCH.md`.

This document is the **single source of truth** for the 21 open questions that gated Wave 1.5 BIG. Where it conflicts with any prior plan section, this document wins.

---

## PLAN A — Content↔Package Mapping + Luxury Unlock Page (8 questions → 7 locked + 1 closed)

### A-Q1 — Wire casing
**LOCKED: camelCase `unlockCta`** on the search slice. Matches the slice's existing wire convention and avoids `.strict()` Zod throws on mobile.

### A-Q2 — Unlock page flow (BRADLEY OVERRIDE — materially changed Plan A Section 4)
**LOCKED: Picker-page-first flow.** First tap on gated content goes **directly** to a picker page showing **ALL** packages that unlock it (every option, as luxury cards). No "canonical hero first then disclose options." The picker IS the unlock page.

**Plan A Section 4 rewrite required:** screen renamed `UnlockPickerScreen`. Layout shows all unlock-eligible packages as a stack of luxury cards (eyebrow + name + price + brief value list per card). Bottom of page has a single small quiet "Message Coach Maya →" exit link.

If exactly one package unlocks the content, the picker degrades gracefully to a single-card layout (same screen, same skeleton).

### A-Q3 — Orphan / no-edge content (BRADLEY OVERRIDE)
**LOCKED: Orphan content → "Message Coach Maya →" page as default.** If content is gated but has zero package edges AND the user has an assigned coach, the picker is **skipped entirely** and the screen goes straight to a message-coach page (single CTA, same luxury skeleton, button = `Message Maya`).

If user has no assigned coach AND content is orphan, fall back to a generic `View upgrade options` page (R82 storefront).

**Why this matters:** Bradley correctly noted that gated-AND-searchable-AND-no-package-edge is a near-pathological state. Defaulting to message-coach makes orphan a feature (warm handoff to the coach who can grant access manually) instead of a dead-end.

### A-Q4 — CLOSED
This question (free-on-cohort-membership content copy) was not a real product surface in the current model. Closed as non-question. If/when free-on-membership content becomes real, we spec it then.

### A-Q5 — Price separator
**LOCKED: Middot `·`.** Quiet Luxury Doctrine wins all ties. Example: `Buy Strength Program 2.0 · $149`.

### A-Q6 — Shareable unlock deep link (BRADLEY OVERRIDE — NOT deferred)
**LOCKED: `com.growthproject.app://unlock/{kind}/{contentId}` route in v1.** Coupon-at-the-door pattern. Maya emails her cohort → tap goes straight to the picker page → 2-tap conversion.

Plan A Section 5.2 is upgraded from "deferred to R82-G" to in-scope for Wave 1.5 BIG. Route registration + deep-link handler land with the rest of the mobile work.

### A-Q7 — Post-purchase entitlement window
**LOCKED: "Finishing your purchase…" calm interstitial** during the Stripe-webhook lag window. Correctness-first per Phantom CALM doctrine.

---

## PLAN B — Gym-Owner Role + RLS Privacy Boundaries (7 questions → 7 locked)

### B-Q1 — Coach who is also a gym owner
**LOCKED: Single user, two capabilities, NO mode switch.** Database-enforced wall. `GymOwnerProfile` row existence (not `User.role`) answers "is this user a gym owner?" The same human sees their own client roster in full detail AND aggregate-only metrics for other coaches at their gym — simultaneously, no toggle.

### B-Q2 — Multiple owners per gym
**LOCKED: Equal rights v1.** Surface a "last modified by [name] on [date]" stamp on every comp row for accountability. Co-owner quabbles are not the platform's design problem.

### B-Q3 — Non-PT member membership model (HYPERSCALER-INFORMED)
**LOCKED: `GymMembership` join table.** Hyperscaler research is unanimous:
- Apple Family Sharing (scalar) → painful for blended families
- Google Workspace (scalar) → forced identity fragmentation
- Slack (started scalar) → massive Enterprise Grid rewrite to retrofit
- Stripe Connect, Linear, Notion, GitHub, Mindbody, ClassPass (join table from day one) → extended gracefully

Schema:
```prisma
model GymMembership {
  id           String   @id @default(uuid())
  user_id      String
  gym_id       String
  plan_type    String   // 'floor_access' | 'all_access' | etc
  status       String   // 'active' | 'frozen' | 'cancelled'
  started_at   DateTime @default(now())
  expires_at   DateTime?
  @@unique([user_id, gym_id])
  @@index([gym_id, status])  // door-check hot path
  @@index([user_id, status])
}
```

Multi-gym franchise membership, ClassPass-style aggregator integrations, and "drop-in at any of Maya's locations" become free instead of needing a future migration.

### B-Q4 — Access revocation timing
**LOCKED: Instant revocation** when a coach is removed from a gym (`GymCoach.left_at` set). RLS predicates cut over immediately.

### B-Q4-FOLLOWUP — Termination cascade with Roman pre-write (BRADLEY OVERRIDE — new feature)
**LOCKED: Hybrid termination workflow with AI assist.** This is now a feature, not just an admin button:

1. **Owner clicks "Terminate coach."**
2. **Roman pre-writes a personalized goodbye DM per client** using:
   - Client's name + Maya's name + new assigned coach
   - Maya's voice/tone learned from her past messages
   - Standard farewell structure
3. **Modal shows owner all pre-written drafts + single "Approve all & send" button.** Owner can edit any draft inline. Owner can also choose "Skip drafts, send sterile system notice" for a clean break.
4. **On approve:** system sends pre-written messages to each client → revokes ALL coach gym data access (RLS cuts instantly) → triggers client reassignment workflow.
5. **Fired coach has 24h window** to send additional personal DMs to their old roster:
   - Read access to their old client list (DM thread metadata only — no PHI, no logs)
   - Write access to send DMs only (no other data access)
   - All messages flagged for audit review during the 24h window
   - After 24h, RLS cuts the message-send permission too
6. **Client reassignment** runs in parallel: round-robin by current roster size, OR owner picks manually per client.
7. **Audit log** captures every DM sent, every reassignment, every access revocation, every Roman draft + edit + approval.

**New R82 stream:** R82-B4 — Termination wizard + Roman draft generation pipeline. Significant standalone effort. Plan B Section 4.5 captures the spec.

### B-Q5 — Metric freshness
**LOCKED: Nightly close.** Removes live-inference channel. Live revenue = R82 once differencing attacks are re-modeled.

### B-Q6 — k-anonymity threshold (BRADLEY OVERRIDE — no suppression)
**LOCKED: No k-anonymity threshold.** Coaches with tiny rosters (e.g. 3 clients) get their actual `retention_pct`, `conversion_pct`, `churn` shown to the owner. Bradley's reasoning: with n=3, there's a 1-in-3 random-guess identification probability anyway — withholding rate metrics is theater, not privacy. Show honest data.

**Plan B Section 5.3 is REMOVED.** Aggregation layer emits raw rates regardless of `active_clients` count.

### B-Q7 — Coach PII to owner
**LOCKED: Owner sees coach PII** (name, email, phone) for coaches in their gyms. Client PII stays walled. Default communication path: in-app team comms first; external comms identifiable when needed.

Matrix update in Plan B §4.2: row "Coach contact info (`User` row for `gym_coach` users)" → `Yes, for coaches in owned gyms via gym membership join`.

---

## PLAN C — Evaluator, Slicing, Cache, Drift (7 questions → 7 locked)

### C-Q1 — Emit-all vs exactly-4
**LOCKED: Emit all `status==='active'` registry flags.** `flags` is an open `z.record` map on mobile — extra keys are safe (old clients ignore untyped keys). No two-deploy dance.

### C-Q2 — Client tier model (BRADLEY OVERRIDE — flipped to 2.0-B)
**LOCKED: 2.0-B — derive everything from `ClientPurchase.entitlement_active + package_id`.** No `ClientSubscription` table. No `ClientTier` enum. Rules key on "does this user own active package X?" rather than "are they Pro?"

**Rationale:** Bradley said "I'm not even sure what a 'pro' client would be yet." When the abstraction has no clear semantic referent, don't build it. Defer the tier layer until the product surface demands it.

**Plan C Section 2.0 and 2.1 are removed (no `ClientSubscription`, no `ClientTier`).** Evaluator dimension `tier` is dropped from `EvaluatorContext` for client-role users. Coach/owner tier still resolves from existing `CoachSubscription`.

### C-Q3 — Coach-to-coach program sharing (BRADLEY OVERRIDE — new feature stream)
**LOCKED: Defer `gifted` status; build cross-coach sharing as a separate program marketplace.**

This is no longer about "admin grants gifted access." It's about **native export/import of programs, workout regimes, content bundles between coaches.** New R82 stream:

- **R82-C3a:** Coach-to-coach program export pipeline (export any program, workout regime, content bundle as a portable artifact)
- **R82-C3b:** Coach-to-coach program import pipeline (ingest another coach's exported artifact into your library)
- **R82-C3c:** Coach Program Marketplace UI surface (browse, share, possibly resell?)

Standalone wave later. Out of Wave 1.5 BIG scope. For Wave 1.5, evaluator just keys on `ClientPurchase.entitlement_active`. No `gifted` status added to the enum.

### C-Q4 — Activity thresholds (BRADLEY OVERRIDE — uses existing lockout)
**LOCKED:**
- `lapsed` = 7 days without activity logs (workout session, food entry, message, or activity event)
- `churned` = locked out of app from non-payment, **day 10 after payment due** (Bradley confirmed code already exists for this)

**Plan C Section 2.6 update:** `ClientActivitySummary.level` derivation rewires to read the existing payment-lockout state instead of inventing a new 30-day rule. Coordinate with the existing payment-lockout module during build.

### C-Q5 — p99 budget
**LOCKED: p99 < 250ms.** Design to D5, not the brief's 1500ms. Missile, not sports car. CI asserts to 250ms.

### C-Q6 — Owner gymIds context resolution (HYPERSCALER-INFORMED)
**LOCKED: Option (a) — eager single-roundtrip CTE.** `gymIds` loads as part of the unified context object before the evaluator runs.

Hyperscaler research is unanimous:
- LaunchDarkly, Statsig, Unleash: all dimensions hydrated into context BEFORE evaluation. Evaluation is pure-function, zero I/O. "SDKs do not enrich missing attributes from the database."
- Google Cloud IAM, AWS IAM: pre-distribute policy data; accept ~4s propagation window to keep hot path synchronous-call-free.
- Stripe: eager session-establishment-time assembly.

The CTE joins `gym_memberships gm ON gm.user_id = u.id WHERE gm.status='active'` and aggregates `array_agg(gm.gym_id) → gymIds: string[]`. Adds ~2-5ms to context load; evaluator itself stays sub-1ms warm.

**Optional second-level cache (Option c):** Short-TTL Redis cache on `userId → gymIds[]` (30-60s TTL) layered on top. Mirrors AWS IAM's ~4s propagation window. Build as a follow-up optimization if profiling shows the gym-membership join is hot.

### C-Q7 — Redis provisioning
**LOCKED: Provision Redis (Upstash/Fly Redis) as Wave 1.5 BIG prerequisite.** `REDIS_URL` always-on in all environments. Dedicated `FeatureFlagsModule` owns two ioredis connections (pub + sub).

**Build order:** Redis provisioning is the **first** task in the build sequence, before any code changes. Without it, D4 cross-process invalidation is impossible.

---

## Cross-cutting decisions (carried from DECISIONS.md, still binding)

- **D1** — γ contract: open-guard (NOT exclude) + per-hit `unlockCta` payload + direct Buy button + tap-only
- **D2** — Default-DENY on absent/undefined feature flag values (Apple/Google/Tesla standard)
- **D5** — p99 < 250ms target, p99 > 1500ms = production failure
- **D6** — Gym-owner role: numerical aggregates only; NO food/training/personal data; role+flags+RLS land in this PR
- **D7** — Emit ALL `active` `KNOWN_FLAGS` registry entries + bidirectional drift telemetry

---

## Build dependency order (locked)

The 21 decisions reshape the build order. F-1 RLS interceptor fix remains PR #1.

1. **PR #1 — F-1 fix (security-critical, own audit cycle):** `rls-context.interceptor.ts` `user.sub` → `user.id`. Provision non-BYPASSRLS gym-owner DB role. Without this, the entire RLS wall below is inert.
2. **PR #2 — Redis provisioning + `FeatureFlagsModule` skeleton:** Upstash/Fly Redis, `REDIS_URL` configured in all envs, FeatureFlagsModule with pub+sub ioredis connections (no logic yet, just plumbing).
3. **PR #3 — Schema + RLS migration (ship dark):** All new tables in one append-only migration, behind `FEATURE_GYM_OWNER_ROLE=false`:
   - `Gym`, `GymOwnerProfile`, `GymOwnerGym`, `GymCoach`, `GymMembership` (B-Q3 join table)
   - `CoachCompensation`, `CoachCompensationAudit`
   - `CoachBusinessMetric`, `GymFinancialAggregate` (NO k-anonymity suppression per B-Q6)
   - `Cohort`, `ClientCohort`, `Tag`, `ClientTagAssignment`
   - `ClientActivitySummary` (uses existing payment-lockout per C-Q4)
   - `FeatureFlagAllowlist`
   - `ContentUnlockMap` + partial unique index for canonical
   - Index addition to `ClientPurchase`: `@@index([client_user_id, entitlement_active, access_expires_at])`
   - All `app.*` RLS helpers (`is_gym_owner`, `gym_owner_owns_gym`, `gym_owner_of_coach`)
   - All RLS policies (gym-owner walls + coach predicates + content-unlock policies)
4. **PR #4 — RLS live-DB test suite:** T1-T28 (PLAN_B §9) + T_RLS_1/_2/_3 (PLAN_C §8). Gate migration merge on green.
5. **PR #5 — `gym_owner` role plumbing:** `GymOwnerGuard`, `roleSatisfies` leaf-role update, GUC carries `'gym_owner'`. Invariant tests T26/T27/T28.
6. **PR #6 — `KNOWN_FLAGS` registry + evaluator service + endpoint:**
   - `known-flags.ts` registry (initially the 4 mobile-spec flags, status=active)
   - `EvaluatorContextLoader` with single-roundtrip CTE (includes `gymIds` per C-Q6)
   - Per-flag rules (4 rules wired)
   - `GET /me/feature-flags` controller + DTO (snake_case, `.strict()` envelope, throttled at 60/min)
   - LRU cache (lru-cache, 10k entries, 5min TTL)
   - Redis pub/sub invalidation (8 mutation hooks per PLAN_C §4.3, with wildcard for nightly activity)
   - Startup fail-loud validation (registry consistency, env-gate presence, allowlist flag-name validity)
   - Drift telemetry to PostHog
7. **PR #7 — Aggregation jobs:** Nightly `service_role` cron populating `CoachBusinessMetric` + `GymFinancialAggregate` (NO k-anonymity per B-Q6) + nightly `ClientActivitySummary` rebuild + nightly wildcard cache invalidation.
8. **PR #8 — Admin tooling + termination cascade:**
   - `promoteToGymOwner(targetUserId, gymIds[])` admin endpoint
   - `POST /admin/gyms`, `POST /admin/gyms/:id/owners`, `POST /admin/gyms/:id/coaches`
   - **Termination wizard endpoint** (B-Q4-FOLLOWUP):
     - `POST /admin/gyms/:gymId/coaches/:coachId/terminate` → triggers Roman draft generation
     - `GET /admin/terminations/:terminationId/drafts` → returns drafts for owner review
     - `POST /admin/terminations/:terminationId/approve` → sends drafts, revokes access, queues reassignment
     - 24h coach DM window: dedicated role-scoped policy on `CoachMessage` that allows write-only for terminated coaches within window
9. **PR #9 — Content↔package mapping + unlock picker (search slice):**
   - `ContentUnlockService.resolveForHits()` batch resolver
   - Wire into `community-search.service.ts` map site
   - Attach `unlockCta` (camelCase per A-Q1) to gated hits
   - Extend mobile `SearchResultRowSchema` with optional `unlockCta`
   - **`UnlockPickerScreen` (A-Q2)** — all packages as luxury cards, "Message coach" exit link
   - **Orphan-content message-coach default flow (A-Q3)**
   - **Shareable deep link `unlock://{kind}/{id}` (A-Q6)** — route registration + handler
   - **"Finishing your purchase…" interstitial (A-Q7)**
   - Wire onto existing `createCheckoutSession` → `BrandedCheckoutWebViewScreen`
10. **PR #10 — Coach Program Marketplace (R82-C3 — separate wave):** Coach-to-coach export/import pipeline (out of Wave 1.5 BIG scope).
11. **PR #11 — Coach content-unlock tagging UI (R82-A — separate wave):** Manual tagging surface for coaches (out of Wave 1.5 BIG scope; ships with orphan-→-message-coach as the safety net per A-Q3).

PRs 1-9 are Wave 1.5 BIG. PRs 10-11 are follow-up R82 streams.

---

## Adversarial audit checkpoint

After every PR in the build order above, GPT-5.5 adversarial re-audit cycle until `CLEAN_NO_FINDINGS`. No PR merges without that gate. Hectacorn quality standard applies.

---

*End of APPROVED_DECISIONS.md — Bradley Gleave, 2026-06-16*
