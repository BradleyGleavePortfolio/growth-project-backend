# Wave 1.5 — Locked Product Decisions
(For backend builder. Read this together with SERVER_SIDE_FEATURE_FLAGS_SPEC.md.)

Authored: 2026-06-16 by Bradley Gleave (R74 identity), via decision session with Computer.

Every decision below is FINAL for v1 of Wave 1.5. Any deviation = HALT and report.

---

## D1 — γ behavior: OPEN-GUARD + per-hit `unlock_cta` payload (NOT exclude)

**The brief originally asked for server-side EXCLUDE. That is REJECTED.**

The server search handler MUST:
1. Return ALL matching hits regardless of flag state (no exclusion).
2. For each hit whose `kind` maps to a disabled flag (per kindToFlag map in spec §4), attach an `unlock_cta` payload (see schema below).
3. Mobile retains its existing open-guard pattern (renders all hits, blocks navigation on disabled, shows the unlock CTA on tap instead of opening).

### `unlock_cta` payload schema (new, backend-defined)

```ts
interface UnlockCTA {
  kind: 'purchase' | 'message_coach' | 'upgrade';  // strict enum
  target_id?: string;                              // e.g. program_id, coach_user_id
  label: string;                                   // human-readable, e.g. "Buy Strength Program 2.0"
}
```

Attached to each gated hit as an optional `unlock_cta` field:
```json
{
  "id": "...",
  "kind": "classroom_lesson",
  "title": "Squat Mechanics 101",
  "unlock_cta": {
    "kind": "purchase",
    "target_id": "prog_abc123",
    "label": "Buy Strength Program 2.0 to unlock"
  }
}
```

**Per-flag fallback CTA (if no specific program/coach attached):**
- `community_classroom` disabled → `{ kind: 'upgrade', label: 'Upgrade to access lessons' }`
- `community_events` disabled → `{ kind: 'upgrade', label: 'Upgrade to access events' }`

CTA appears ONLY on tap (not in the result row). This is a backend-attached field; mobile UI to render it is **out-of-scope for Wave 1.5** (a follow-up mobile PR will extend the search-result Zod schema with an optional `unlock_cta` field). Backend ships the data first; mobile catches up.

---

## D2 — Fail-closed default-DENY on absent or undefined flags (locked)

Industry standard (Apple Gatekeeper, Google IAM, Tesla Autopilot, AWS IAM). Any flag not explicitly `true` in the evaluation = denied.

- `flags['community_classroom'] === undefined` → DENY
- `flags['community_classroom'] === false` → DENY (equivalent)
- `flags['community_classroom'] === true` → ALLOW

No default-allow path anywhere in the system.

---

## D3 — Expanded evaluator inputs: env + allowlist + role + tier + cohort

Coach slicing capability is the long-term value here. Evaluator takes:

```ts
interface EvaluatorContext {
  userId: string;
  role: 'client' | 'coach' | 'owner';      // 'owner' role doesn't exist yet — see D6
  tier?: SubscriptionTier;                  // optional — graceful degradation
  cohort?: string[];                        // optional — graceful degradation
}
```

For each flag, evaluation = `(envGate AND allowlist AND roleAllows AND tierAllows AND cohortAllows)`.

**Graceful degradation rule:** if a dimension's source table doesn't exist (e.g. cohort table not yet built), the evaluator treats that dimension as "not gated" (passthrough — does not restrict). Document this clearly in code comments.

**Before writing the evaluator, the builder MUST verify:**
- Does a `subscription_tier` (or equivalent) table linked to user exist? If yes, use it. If no, stub the `tier` check as passthrough and file an R82 follow-up.
- Does a `cohort` or `client_cohort` table exist? Same logic.
- Does the allowlist table exist? (Per spec §5 it should — confirm.)

If a table is missing, the evaluator function signature stays the same; the dimension just silently passes through. Document which dimensions are LIVE vs STUBBED in a comment header on `evaluator.service.ts`.

---

## D4 — Caching: Redis 5-min TTL preferred; per-request memoize fallback

**If Redis is provisioned in the backend infrastructure:** use it. 5-min TTL keyed by `userId`. Eviction on user logout (best-effort).

**If Redis is NOT provisioned:** fall back to per-request memoize (no cross-request cache). File an R82 P2 follow-up to add Redis specifically for feature-flag caching.

**Builder MUST report:** which caching tier was actually shipped, in the PR description.

**Why this matters:** the p95 < 100ms target (D5) is harder without Redis. Per-request DB hit with the tier + cohort + allowlist JOINs is likely 50-150ms. Redis read = 1-5ms. Sub-100ms only realistic with Redis.

---

## D5 — Performance budget: p95 < 100ms, p99 < 250ms, CI-enforced

Locked targets:
- p95 < 100ms for `GET /me/feature-flags`
- p99 < 250ms (upper safety net)

Builder MUST write a perf test in CI that exercises the endpoint under a load profile (suggested: 100 concurrent requests, measure p95/p99). If p95 > 100ms, CI fails. If p99 > 250ms, CI fails.

The search handler γ intersection is a separate concern (in-memory filter over result set, should be sub-1ms). Not in the perf budget for the endpoint; covered by existing search-handler perf tests if any.

---

## D6 — Role binary v1: coach vs not-coach; gym-owner is a documented extension point

**Today (v1):**
- `role === 'coach'` → coach-gated flags subject to env + allowlist + tier + cohort (no role-imposed restriction on top).
- `role !== 'coach'` (client today, owner later) → coach-gated flags forced OFF.
- Only flag this affects today: `coach_community_wearable_prompts`.

**Future (gym-owner role lands later, not in this PR):**
- `role === 'owner'` will be a superset of `role === 'coach'` — sees everything coaches see, plus franchise-level oversight.
- Builder must structure the role check so adding `'owner'` is a one-line change. Example:
  ```ts
  function roleAllowsCoachGated(role: Role): boolean {
    return role === 'coach' || role === 'owner';  // owner = superset of coach
    // (owner branch is a no-op today since 'owner' is not yet emitted by auth)
  }
  ```

**No per-client coach overrides in v1.** ("Coach can grant client X access to lesson Y" capability) = separate R82 follow-up with its own override table + audit.

---

## D7 — Emit exactly the four typed flags mobile reads

Backend response `flags` object MUST contain exactly these four keys in v1:
- `community_search`
- `coach_community_wearable_prompts`
- `community_classroom`
- `community_events`

No phantom flags. No extra keys "for future use." Adding a fifth flag = a new R82 coordinated mobile+backend PR pair.

(`flags` is an open map per Zod schema, so EMITTING extras wouldn't break mobile — but it pollutes the contract and creates dead code. Don't.)

---

## Bonus — Casing: `snake_case` on the wire for `/me/feature-flags`

Top-level response keys (`flags`, `evaluated_at`) and ALL flag names MUST be `snake_case`.

DO NOT confuse with the search slice (`communitySearchApi.ts`) which intentionally uses `camelCase` on the wire — that's a different convention deliberately documented in that slice.

Mobile's `FeatureFlagsResponseSchema.strict()` will throw a `contract` error on any case mismatch → every flag fail-safes to OFF → every gated feature dark across the app.

---

## What the builder MUST report in the PR description

1. Caching tier actually shipped (Redis or per-request memoize) — and link to R82 follow-up issue if memoize.
2. Which evaluator dimensions are LIVE (env, allowlist, role, tier, cohort) vs STUBBED (passthrough due to missing table). Link to R82 follow-ups for any stubbed dimensions.
3. Perf test results: actual p95 and p99 under the 100-concurrent load profile.
4. Confirmation that `snake_case` is used on the wire and `.strict()` envelope holds.
5. List of files added/modified.
6. Test coverage report (T1-T9 from spec §11 all must pass, plus the perf assertion).
