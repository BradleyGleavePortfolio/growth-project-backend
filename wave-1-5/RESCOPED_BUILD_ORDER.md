# Wave 1.5 BIG + Phase 2 — RESCOPED Build Order

**Author:** Chief of Product
**Date:** 2026-06-16
**Status:** LOCKED, ready for user review before any code lands
**Trigger:** "Re-scope phase 2 as some PRs have gained massive scope — break down into sizeable chunks across ALL PRs. Make sure no god-files were already planned. Biggest/most-complex to easiest/smallest order."

---

## 1. Sizing rules (apply across all PRs)

Borrowed from hyperscaler PR-hygiene practice (Stripe, Linear, Google):

| Tier | LOC budget (added) | Files touched | Audit lane |
|---|---|---|---|
| **XL** (forbidden) | 1500+ | 20+ | NEVER ship — split |
| **L** (max allowed) | 800–1499 | 10–20 | Full GPT-5.5 audit, then merge |
| **M** (preferred) | 300–799 | 5–10 | Full GPT-5.5 audit |
| **S** (cleanup) | 50–299 | 1–5 | GPT-5.5 audit |
| **XS** (one-liner) | <50 | 1–2 | Spot-check |

**Hard rules:**
- No PR may add more than **800 LOC of production source** (tests excluded from count but counted for review fatigue).
- No PR may add more than **400 LOC to any single existing file** without splitting that file first.
- No new file may exceed **600 LOC at first commit** — if it would, ship the skeleton + a second PR for the meat.
- Every PR must have ONE clear purpose statable in one sentence. If your PR title needs "AND" or "PLUS", split it.
- God-file watch list (existing files that must NOT grow): see §3 below.

---

## 2. God-file scan results

### Existing mobile god-files (must not grow)
| File | LOC | Why it's a god-file | Already planned for refactor? |
|---|---|---|---|
| `src/screens/coach/CoachWorkoutBuilderScreen.tsx` | 1783 | Mixed concerns (autosave, command stack, AI, package gating) | YES — todo #17, 4-hook split + 4-auditor cycle |
| `src/hooks/useAutosave.ts` | 1391 | Logic-heavy hook | NO — flag, see §3 |
| `src/screens/client/ProgressScreen.tsx` | 1219 | UI + analytics + cohort logic | NO — flag, see §3 |
| `src/screens/client/ActiveWorkoutScreen.tsx` | 1181 | Workout runtime | NO — flag, see §3 |
| `src/screens/community/CoachCommunityEventsScreen.tsx` | 1133 | Event lifecycle UI | NO — flag, see §3 |
| `src/screens/client/WorkoutScreen.tsx` | 1072 | Workout list | NO — flag, see §3 |
| `src/components/coach/CoachAiSection.tsx` | 1068 | AI UX surface | NO — flag, see §3 |
| `src/screens/community/CommunityChallengeDetailScreen.tsx` | 1050 | Challenge UI | NO — flag, see §3 |
| `src/services/api.ts` | 893 | All-API barrel | NO — flag |
| `src/screens/coach/AIWorkoutDraftScreen.tsx` | 892 | AI draft UX | NO |
| `src/navigation/RootNavigator.tsx` | 876 | Root nav | NO — but legitimately broad |
| `src/components/command-center/CoachLtvDashboard.tsx` | 864 | LTV dashboard | NO — and Wave 1.5 BIG WILL touch this; risk |
| `src/screens/coach/AIMealPlanDraftScreen.tsx` | 838 | AI meal draft | NO |
| `src/screens/client/EditProfileScreen.tsx` | 829 | Profile edit | NO |
| `src/screens/client/BrandedCheckoutWebViewScreen.tsx` | 816 | Branded checkout — A-Q7 interstitial host | YES — must be touched cautiously for A-Q7 |

### Existing backend god-files (must not grow)
| File | LOC | Why | Plan |
|---|---|---|---|
| `src/checkout/checkout.service.ts` | 1234 | Stripe orchestration + entitlement | DO NOT touch in Wave 1.5; create new `entitlement-evaluator.service.ts` instead |
| `src/messaging/messaging.service.ts` | 826 | Coach/client messaging + ConversationReview | DO NOT grow in Wave 1.5 |

### Planned-but-oversized Wave 1.5 PRs (rescoped below)
- **PR #3 (Schema + RLS)** — was 16 tables + RLS in one PR. Too big. SPLIT.
- **PR #6 (Evaluator + endpoint + LRU + Redis pub/sub + drift telemetry)** — was 5 concerns in one PR. SPLIT.
- **PR #8 (Admin tooling + termination cascade)** — was 2 different surfaces. SPLIT.
- **PR #9 (Content↔package mapping + UnlockPickerScreen + orphan + deep link + interstitial)** — was 5 concerns. SPLIT.

---

## 3. The RESCOPED build order — 23 PRs, biggest/most-complex first

Order rationale: build the **highest-risk and broadest-impact security/infra** first while the rest of the team is fresh. Cleanup work (Phase 2) goes LAST as planned because it's serial-fixer hectacorn polish, not new architecture, and depends on nothing.

### Tier 1 — Critical security + infra (must land first, blocks everything)

#### **W1.5-PR1 — F-1 RLS interceptor fix + non-BYPASSRLS gym-owner DB role (SECURITY-CRITICAL)** [S, ~150 LOC]
- `rls-context.interceptor.ts`: `user.sub` → `user.id`
- `prisma/migrations/.../create_gym_owner_role.sql`: non-BYPASSRLS role
- Live-DB test: gym_owner connection cannot select from BYPASSRLS-only tables
- **OWN audit cycle. Solo PR. No batching.** Without this every other Wave 1.5 RLS rule is inert.
- Audit: GPT-5.5 + a manual security-grade re-read by Opus 4.8 (two auditors).

#### **W1.5-PR2 — Redis provisioning + FeatureFlagsModule skeleton** [S, ~200 LOC]
- Upstash or Fly Redis provisioned, `REDIS_URL` in `.env.example` + secret in prod/staging
- `FeatureFlagsModule` with `RedisPubSub` ioredis pub+sub connections (no logic, just plumbing)
- Health check: `GET /healthz/redis` returns pong+latency
- E2E test on staging: pub/sub round-trip under 50ms

### Tier 2 — Schema chunks (PR #3 SPLIT into 4 PRs, build order = dependency order)

#### **W1.5-PR3a — Core gym + ownership schema** [M, ~500 LOC migration + ~200 RLS]
- Tables: `Gym`, `GymOwnerProfile`, `GymOwnerGym`, `GymCoach`
- RLS: enable + force on all 4, owner-scoped predicates
- Behind `FEATURE_GYM_OWNER_ROLE=false`
- Live-DB tests T1–T8 (Plan B §9)

#### **W1.5-PR3b — Membership + redundancy-safe FKs (per addendum)** [M, ~400 LOC migration + ~300 RLS + ~200 tests]
- Tables: `GymMembership` (join), `ClientPurchase.gymId NOT NULL` migration (with backfill from package), `WorkoutCompletion.gymMembershipId` (nullable add)
- ClientCoachAssignment.gymMembershipId, ProgramAssignment.gymMembershipId
- RLS on GymMembership scoped to membership owner + gym owner
- T_ROLLUP_1, T_ROLLUP_2, T_ROLLUP_3 tests (from addendum)
- **This is THE rescope-critical PR — depends on PR3a, blocks everything else.**

#### **W1.5-PR3c — Compensation + audit schema** [M, ~400 LOC migration + ~200 RLS]
- Tables: `CoachCompensation`, `CoachCompensationAudit`
- RLS: coach reads own + audit row, owner reads roster, append-only audit
- Live-DB tests T13–T18

#### **W1.5-PR3d — Metric aggregation + cohort + tag schema** [M, ~500 LOC migration + ~300 RLS]
- Tables: `CoachBusinessMetric`, `GymFinancialAggregate`, `Cohort`, `ClientCohort`, `Tag`, `ClientTagAssignment`, `ClientActivitySummary`
- All carry `gymId NOT NULL` per addendum
- NO k-anonymity (per B-Q6)
- Cohort/Tag are per-gym vocabularies (gymId NOT NULL)
- RLS scopes everything to owner's gyms
- Live-DB tests T19–T25 + T_ROLLUP_4, T_ROLLUP_6

#### **W1.5-PR3e — FeatureFlagAllowlist + ContentUnlockMap** [S, ~250 LOC migration + ~150 RLS]
- Tables: `FeatureFlagAllowlist`, `ContentUnlockMap` (+ partial unique index)
- RLS for allowlist (admin-only writes)
- T_RLS_1, T_RLS_2 tests (Plan C §8)

### Tier 3 — RLS test suite + role plumbing (depends on all of Tier 2)

#### **W1.5-PR4 — RLS live-DB test suite consolidation** [M, ~600 LOC tests]
- Wires up the full T1–T28 + T_RLS_* + T_ROLLUP_* suite as a CI gate
- Adds `jest.rls.config.js` extension
- Adds linting rule blocking aggregations without `gymId` in GROUP BY
- Adds CI workflow `rls-live-tests-wave-1-5.yml` gating merges

#### **W1.5-PR5 — gym_owner role plumbing** [M, ~400 LOC]
- `GymOwnerGuard`, `roleSatisfies` leaf-role update
- GUC carries `'gym_owner'` through the request-scoped Prisma client
- Invariant tests T26/T27/T28
- Smoke E2E: gym_owner JWT can hit `/healthz/gym-owner` only

### Tier 4 — Evaluator infrastructure (PR #6 SPLIT into 3 PRs)

#### **W1.5-PR6a — KNOWN_FLAGS registry + drift telemetry skeleton** [S, ~300 LOC]
- `KNOWN_FLAGS` constant (single source of truth)
- `flagRegistryDrift.spec.ts` — fails if any flag emitted but not registered
- PostHog drift event registered (`feature_flag.unknown_flag_emitted`)
- No evaluator yet — just the registry + drift detection scaffolding

#### **W1.5-PR6b — Entitlement evaluator service (single-roundtrip CTE)** [L, ~800 LOC service + ~400 LOC tests]
- New `src/feature-flags/entitlement-evaluator.service.ts`
- One CTE query per C-Q6 option (a): all dimensions including gymIds in one roundtrip
- Derives from `ClientPurchase.entitlement_active + package_id` per C-Q2 (NO `ClientSubscription`)
- p99 < 250ms test (C-Q5 missile)
- Unit tests for every emit-all flag combination
- **DO NOT touch `checkout.service.ts` — instantiate independently**

#### **W1.5-PR6c — /me/feature-flags endpoint + LRU + Redis invalidation** [M, ~500 LOC]
- `GET /me/feature-flags` controller behind global auth
- LRU cache wrapper around evaluator (10k entries, 60s TTL)
- Redis pub/sub: invalidate by user_id or wildcard
- Endpoint metadata + throttle pinned
- Snake_case envelope per A-Q1

### Tier 5 — Aggregation + admin (PR #8 SPLIT into 3 PRs)

#### **W1.5-PR7 — Aggregation jobs (nightly metrics + activity)** [L, ~700 LOC]
- Nightly `service_role` cron: populates `CoachBusinessMetric`, `GymFinancialAggregate`, rebuilds `ClientActivitySummary`
- Uses payment-lockout for churn (C-Q4)
- Lapsed = 7d no logs per membership (per addendum §3.9)
- NO k-anonymity (B-Q6)
- Linting rule: every aggregation `GROUP BY gymId`
- T_ROLLUP_4 test enforces lapsed-at-A / active-at-B correctness

#### **W1.5-PR8a — Admin tooling: gym + owner CRUD + coach attach** [M, ~600 LOC]
- Admin endpoints: create gym, attach owner, attach coach, attach membership
- Admin UI is out of scope here — CLI/API only
- Roles guarded as `'admin'` exclusive

#### **W1.5-PR8b — Termination cascade backend (Roman draft generator)** [L, ~800 LOC]
- New `src/admin/termination-cascade/` module
- `POST /admin/gyms/:gymId/coaches/:coachId/terminate`: triggers cascade
- Roman draft generator: takes `(coach, gym, affected_clients[])`, produces N personalized DM drafts via existing Roman service (NO new LLM scope; reuses existing prompts)
- Owner-approves-all UI endpoint: `GET /admin/gyms/:gymId/termination-drafts/:cascadeId` returns array of drafts
- `POST .../approve` flips drafts to "queued"
- Background worker delivers DMs over 24h coach DM write-only window (RLS-enforced: coach can WRITE messages but cannot READ replies after termination)
- Audit-flagged: every action logged to `CoachCompensationAudit` + new `TerminationAudit` table (additive within this PR; not in PR #3 since it's cascade-specific)
- Parallel client reassignment: clients re-pooled to gym's available-coach pool (round-robin or owner-specified)
- T_TERM_1..T_TERM_5 tests

#### **W1.5-PR8c — Termination cascade frontend (admin UI)** [M, ~500 LOC]
- React Native admin screen: list pending terminations, view drafts, edit-then-approve UX (owner can edit any draft before approving), one-click approve-all
- Honest progress UI ("3 of 14 messages sent over 22h remaining")
- Behind `EXPO_PUBLIC_FF_TERMINATION_CASCADE_UI=false`

### Tier 6 — Content↔package + unlock UX (PR #9 SPLIT into 4 PRs)

#### **W1.5-PR9a — Content↔package mapping backend** [M, ~500 LOC]
- `ContentUnlockMap` populated via admin endpoint
- `/me/content-unlocks/:kind/:id` returns `{ unlocked: bool, packageIds: [], unlockCta: {...}}`
- Snake_case API per A-Q1
- Strict Zod responses

#### **W1.5-PR9b — UnlockPickerScreen (mobile, picker-page-first per A-Q2)** [M, ~600 LOC]
- NEW screen `src/screens/unlock/UnlockPickerScreen.tsx` (< 600 LOC at first commit)
- All packages as luxury cards
- Small "Message Coach Maya →" exit link
- Behind `EXPO_PUBLIC_FF_UNLOCK_PICKER=false`
- Honest empty/error states
- Quiet Luxury doctrine
- **DOES NOT touch CoachWorkoutBuilderScreen, ProgressScreen, or any other god-file.** Routes from a deep link only.

#### **W1.5-PR9c — Orphan content message-coach default (A-Q3)** [S, ~250 LOC]
- New `src/screens/unlock/MessageCoachScreen.tsx` (calm Roman-voiced page, prefilled "Hi Maya, can I get access to ...")
- Routes from unlock map "orphan + assigned coach" branch
- Telemetry: `unlock.orphan_to_message_coach`
- Behind `EXPO_PUBLIC_FF_UNLOCK_PICKER=true` (chained)

#### **W1.5-PR9d — Shareable deep link + post-purchase interstitial (A-Q6 + A-Q7)** [M, ~450 LOC]
- iOS universal link + Android app link: `unlock://{kind}/{id}`
- Deep-link handler in `RootNavigator.tsx` (CAREFUL — that file is 876 LOC; only +20 LOC added, lint-checked)
- Post-purchase interstitial: "Finishing your purchase…" Roman-voiced screen, dismisses on entitlement-evaluator confirms unlock
- Quiet Luxury: middot price separator per A-Q5
- Behind `EXPO_PUBLIC_FF_UNLOCK_PICKER=true`

### Tier 7 — Wave 1.5 BIG audit cycle (one PR per surface)

#### **W1.5-AUDIT — Big-bang GPT-5.5 audit cycle across all 17 W1.5 PRs**
- Spawn 17 parallel GPT-5.5 auditors, one per PR
- Each loops Opus 4.8 fixer until CLEAN_NO_FINDINGS
- Merge in dependency order only after ALL CLEAN

### Tier 8 — God-file refactor (separate, before any Wave 1.5 god-file touching)

#### **GOD-PR1 — CoachWorkoutBuilderScreen.tsx → 4 hooks (already planned, todo #17)** [L, 0 net LOC]
- Extract `useWorkoutBuilderState`, `useWorkoutBuilderAutosave`, `useWorkoutBuilderAI`, `useWorkoutBuilderPackageGate`
- Original screen file shrinks to <500 LOC orchestrator
- 4 parallel GPT-5.5 hook auditors
- Token-equivalent diff: ~zero net LOC, but disentangles the 1783-line god-file
- **Must land BEFORE any Wave 1.5 PR that touches it (none currently do, but R82-A coach-tagging will).**

### Tier 9 — Phase 2 cleanup (SERIAL one-at-a-time, hectacorn quality, biggest-debt first)

Total Phase 2 findings: **27 findings across 8 PRs** (10 P2 + 17 P3 by my count, weighted to P2-heaviest first).

| Order | PR | Findings | LOC | Why this order |
|---|---|---|---|---|
| 1 | **PHASE2-PR1 (backend #400 cleanup)** | 5 P2 + 3 P3 | ~400 | Biggest finding count; touches new `coach-home/` (small surface, contained); Zod envelope + composite index + throttle pin + cache-prune + telemetry register/emit; tracks PR400-FOLLOWUP issue |
| 2 | **PHASE2-PR2 (backend #396 classroom cleanup)** | 5 P2 + 2 P3 | ~350 | Storage-key correctness (P2 security-adjacent), media array bounds, telemetry emit, read-throttle, R82 tracking issue |
| 3 | **PHASE2-PR3 (backend #398 coach-review cleanup)** | 3 P2 + 2 P3 | ~300 | Throttle + Zod envelope + atomic update; touches `check-ins.service.ts` (must NOT add >300 LOC); telemetry register+emit |
| 4 | **PHASE2-PR4 (backend #397 voice-notes cleanup)** | 3 P2 + 1 P3 | ~250 | Read-route throttle + e2e supertest rewrite + R82 tracking + R74 process note |
| 5 | **PHASE2-PR5 (mobile #252 onboarding-polish cleanup)** | 2 P2 + 1 P3 | ~250 | D6B host wiring (`CoachConnectScreen` + package screen) + CTA touch target + dead-branch cleanup |
| 6 | **PHASE2-PR6 (mobile #250 competence-pill cleanup)** | 2 P2 + 2 P3 | ~200 | Flag-off pin test + Zod runtime guard on `HabitsScreen` + dead-branch + copy test coverage |
| 7 | **PHASE2-PR7 (mobile #249 voice-notes cleanup)** | 2 P2 + 1 P3 | ~200 | Player touch target hit-slop + screen test + mobile telemetry |
| 8 | **PHASE2-PR8 (mobile #254 three-arc cleanup)** | 0 P2 + 2 P3 | ~100 | Smallest debt; focus-refresh docstring fix + `isLoading` prop + busy state |

Each Phase 2 PR: serial Opus 4.8 fixer → GPT-5.5 audit loop → CLEAN → R64 GitHub checkpoint update → merge → next PR. No parallel. No batching.

### Tier 10 — Final merge sequence

After all Tier 1–9 are CLEAN:
1. Merge W1.5-PR1 (RLS fix)
2. Merge W1.5-PR2 (Redis)
3. Merge W1.5-PR3a..3e in order
4. Merge W1.5-PR4 (test suite)
5. Merge W1.5-PR5 (role plumbing)
6. Flip `FEATURE_GYM_OWNER_ROLE=true` in staging, soak 24h, run live RLS suite
7. Merge W1.5-PR6a..6c
8. Merge W1.5-PR7
9. Merge W1.5-PR8a..8c
10. Merge W1.5-PR9a..9d
11. Merge GOD-PR1 (refactor) — independent track
12. Merge Phase 2 PRs serially
13. Flip `FEATURE_GYM_OWNER_ROLE=true` in prod with allowlist of 1 owner first
14. R82-A and R82-C (tagging UI, coach marketplace) become their own follow-on waves

---

## 4. Summary

| Tier | PRs | Total LOC (added) | Audit lane |
|---|---|---|---|
| 1 — Security/Infra | 2 | ~350 | Solo audits |
| 2 — Schema (5 chunks) | 5 | ~3,500 (migrations + RLS + tests) | Parallel GPT-5.5 audits |
| 3 — RLS tests + role | 2 | ~1,000 | Parallel GPT-5.5 |
| 4 — Evaluator (3 chunks) | 3 | ~2,000 | Parallel GPT-5.5 |
| 5 — Aggregation + admin (3 chunks) | 4 | ~2,600 | Parallel GPT-5.5 |
| 6 — Content+unlock (4 chunks) | 4 | ~1,800 | Parallel GPT-5.5 |
| 7 — Wave 1.5 audit | (loop) | (loop) | GPT-5.5 |
| 8 — God-file refactor | 1 | ~0 net | 4 parallel hook auditors |
| 9 — Phase 2 cleanup | 8 | ~2,050 | SERIAL Opus 4.8 fixers + GPT-5.5 |
| 10 — Final merge | (sequencing) | — | — |

**Total: 25 PRs.** No PR over 800 LOC of production. No god-file grown. Phase 2 fully serial. Wave 1.5 fully parallel within tiers. Biggest/most-complex → easiest/smallest.

---

## 5. What's different from prior plan

| Prior plan | Rescoped |
|---|---|
| PR #3 (schema, 16 tables, one PR) | PR3a/3b/3c/3d/3e — 5 chunks by domain |
| PR #6 (evaluator + endpoint + LRU + Redis + drift, one PR) | PR6a/6b/6c — registry, evaluator, endpoint |
| PR #8 (admin tooling + termination cascade, one PR) | PR8a/8b/8c — admin CRUD, cascade backend, cascade UI |
| PR #9 (content map + picker + orphan + deep link + interstitial, one PR) | PR9a/9b/9c/9d — backend, picker, orphan, deep link+interstitial |
| Phase 2: "8 P2/P3 PRs, serial" (no order) | Phase 2 explicit: biggest debt (#400) → smallest (#254), ordered by finding count + impact |
| God-file refactor: in Wave 1.5 BIG | God-file refactor: own track (Tier 8), only required if a Wave 1.5 PR would touch it |

---

## 6. Sign-off needed before any code

User must approve:
1. ✓ The 21 OQs (already locked in APPROVED_DECISIONS.md)
2. ✓ Multi-gym redundancy addendum
3. **PENDING — this RESCOPED build order**

Once approved → spawn W1.5-PR1 immediately (Opus 4.8 builder + dual auditor).
