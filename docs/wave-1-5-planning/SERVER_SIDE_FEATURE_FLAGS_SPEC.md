# Server-Side Feature Flags — Backend Implementation Spec
(Extracted from mobile repo, 2026-06-16)

> ## Ref note (important)
> The feature-flag client is NOT on the shared-clone HEAD (`a24c02a`, a revert
> commit on `main`). It lives on branch **`fix/pr251-r81-rebuild-v2`** (PR #263),
> commit **`4920563`**, built atop `ba8657d` ("R81 rebuild of PR #251 —
> D4B/D5Bγ via /me/feature-flags. Refs #258"). All citations are from `4920563`.
> The backend source of truth is referenced in-code as **backend PR #414**
> (`growth-project-backend/src/feature-flags/feature-flags.{controller,dto}.ts`).
> This spec is what the mobile client already consumes; the backend
> implementation must match it exactly (the client Zod-validates with `.strict()`
> and any drift throws).

---

## 1. Endpoint contract

- **Method + path:** `GET /me/feature-flags`
- **Auth:** Bearer JWT — global `JwtAuthGuard`, NOT `@Public`. An unauthenticated
  caller gets 401.
- **Throttle:** 60 requests / minute / user.
- **Request shape:** auth header only. No query params. No body.
- **Client timeout:** 15_000 ms.
- **200 response:**
  ```json
  { "flags": { "<name>": true }, "evaluated_at": "2026-06-15T00:00:00.000Z" }
  ```
- **Status codes the client distinguishes** (`featureFlagsApi.ts` `classify`):
  401→unauthorized, 403→forbidden, 409→conflict, 410→gone, ≥500→server, 0→network,
  **404 / anything else → unknown**, Zod parse failure → `contract` (synthetic 200).

Source: `src/api/featureFlagsApi.ts` (header docstring + `getFeatureFlags`).

---

## 2. Response DTO (Zod-equivalent, NestJS-flavored)

Mirrors `FeatureFlagsResponseSchema` verbatim (`src/api/featureFlagsApi.ts`).
Wire shape is **snake_case**. The envelope is `.strict()`.

```ts
// Zod (mobile, authoritative)
export const FeatureFlagsResponseSchema = z
  .object({
    flags: z.record(z.string(), z.boolean()),   // open map: any string→boolean
    evaluated_at: z.string().datetime(),         // ISO 8601 datetime (UTC)
  })
  .strict();                                     // NO extra top-level keys
```

```ts
// NestJS DTO equivalent
interface FeatureFlagsResponse {
  flags: Record<string, boolean>;   // backend may return MORE than the typed 4
  evaluated_at: string;             // ISO 8601, UTC ("...Z")
}
```

Example payload:
```json
{
  "flags": {
    "community_search": true,
    "coach_community_wearable_prompts": false,
    "community_classroom": true,
    "community_events": false
  },
  "evaluated_at": "2026-06-15T00:00:00.000Z"
}
```

Contract obligations for the backend:
- Top level MUST be exactly `{ flags, evaluated_at }` — no extra sibling keys
  (`.strict()` rejects them → client `contract` error → all flags fail-safe OFF).
- `flags` values MUST be booleans (a non-boolean throws).
- `evaluated_at` MUST be a parseable ISO 8601 datetime string (a bare date or a
  non-datetime throws). UTC (`Z`) per the test fixture.
- `flags` is an OPEN map — adding new flag keys is backward-compatible; old
  clients only read the keys they type and ignore the rest.

---

## 3. Flag enum (exhaustive — the keys mobile reads)

`SERVER_FEATURE_FLAG_KEYS` (`featureFlagsApi.ts`) + `ResolvedFeatureFlags`
(`useFeatureFlags.ts`). All snake_case.

| Flag name (snake_case) | Used by (mobile file:line) | Notes |
| --- | --- | --- |
| `community_search` | `CommunityFindScreen.tsx:72` | runtime gate for the whole search surface |
| `coach_community_wearable_prompts` | `CommunityWearablePromptsScreen.tsx:80` | **role-gated**: server resolves OFF for non-coach; client does NOT re-check role |
| `community_classroom` | `CommunityFindScreen.tsx:137` | open-guard for `classroom_lesson` search hits |
| `community_events` | `CommunityFindScreen.tsx:147` | open-guard for `event` search hits |

**Semantics — open-set, absent = OFF, fail-safe OFF:**
- `flags` is `z.record(z.string(), z.boolean())` → backend may return extra flags;
  client ignores untyped keys.
- A typed key absent from the map → OFF (`resolve(): data?.flags?.[key] === true`).
- While loading OR on error → every typed flag OFF (`useFeatureFlags.test.tsx`).
- Client trusts server role-gating; never re-applies it (`coach_community_wearable_prompts`).

**Two-tier gating:** the static build flags in `src/config/featureFlags.ts`
(`EXPO_PUBLIC_*`, camelCase) gate route REGISTRATION (outer gate). `useFeatureFlags`
is the inner server-authoritative RUNTIME gate. A surface is reachable only if
BOTH are ON.

---

## 4. Kind→Flag mapping

Extracted from `CommunityFindScreen.tsx:99-158` (the `open()` switch).

| Community kind | Mapped flag | Default if no map | Source file:line |
| --- | --- | --- | --- |
| `post` | (none) | passthrough — always open | `CommunityFindScreen.tsx:122` |
| `voice_note_transcript` | (none) | passthrough — always open | `:124-131` |
| `classroom_lesson` | `community_classroom` | open-guard → "not available" notice | `:135-145` |
| `event` | `community_events` | open-guard → "not available" notice | `:146-155` |

Kinds come from `communitySearchApi.ts:39-46`
(`post|classroom_lesson|voice_note_transcript|event`, a strict `z.enum`).

> **⚠ Behavioral divergence the backend builder MUST resolve (see §9):** mobile
> applies γ as an **open-guard at navigation time** — lesson/event hits STILL
> APPEAR in the result list when their flag is OFF; tapping shows a calm "not
> available" notice instead of navigating. The task brief asks the search handler
> to **EXCLUDE** such hits from the result set. These are different behaviors.

---

## 5. Evaluator service contract

- **Inputs (explicitly documented by mobile):** per-flag **env gate**
  (`FEATURE_COMMUNITY_*`) + **per-caller allowlist** + **role**
  (`featureFlagsApi.ts` + `useFeatureFlags.ts` headers). Role-gated flags resolve
  OFF server-side for non-coach roles. Mobile assumes nothing about subscription
  tier / cohort / account age.
- **Outputs:** `{ flags: Record<string, boolean>, evaluated_at: ISO8601 }`.
- **Side effects:** none. Pure read.
- **Suggested signature:**
  ```ts
  evaluateFeatureFlags(userId: string, ctx: RequestContext):
    Promise<{ flags: Record<string, boolean>; evaluatedAt: string }>;
  // ctx carries role + workspace from the JWT auth context.
  // Each flag = (envGate AND allowlist AND roleAllows) for that flag.
  ```

---

## 6. evaluated_at semantics

- ISO 8601 datetime string, **UTC** (`...Z`), Zod-validated with `.datetime()`.
- Mobile does NOT compare or use it for cache invalidation. It is validated-but-
  unused observability metadata. Cache freshness is React-Query driven:
  `staleTime` 5 min + `AppState`-foreground invalidation (no interval poll).
  (`useFeatureFlags.ts`.)
- A non-datetime value (e.g. a bare `2026-06-15`) THROWS a `contract` error → all
  flags fail-safe OFF. Backend MUST emit a full ISO datetime.

---

## 7. γ intersection algorithm (for search handler)

The status-quo client γ is an open-guard (§4). If the backend implements
server-side γ as **result exclusion** (the brief), mirror this:

```pseudo
evaluation = evaluateFeatureFlags(userId, ctx)        // §5
kindToFlag = {
  post:                  null,                         // passthrough
  voice_note_transcript: null,                         // passthrough
  classroom_lesson:      'community_classroom',
  event:                 'community_events',
}
For each search hit:
  flag = kindToFlag[hit.kind]
  if (flag == null) include hit                        // passthrough
  else if (evaluation.flags[flag] === true) include hit
  else exclude hit
Return filtered list
```
- Unknown / unevaluated flag (`flags[flag]` undefined) → **DENY** (matches
  client `resolve(): === true` and the fail-safe-OFF doctrine).
- NOTE: `voice_note_transcript` is a **passthrough** kind on mobile (no flag
  guard) — do NOT gate it on `coach_community_wearable_prompts` or anything else.

---

## 8. RLS implications

- Endpoint requires an authenticated user of any role (client/coach/owner).
- No data modifications; pure read.
- The evaluator likely JOINs against: the per-caller **allowlist** table, and the
  caller's **role** (from JWT / membership). If env gates are config-only, no
  table needed for those. Subscription/cohort tables are NOT required by the
  mobile contract (only if the backend chooses those inputs — §9).
- **Per-request vs cached:** the search handler should **re-evaluate per request**
  (or memoize for the request lifetime only). Mobile caches the flag map 5 min
  client-side and refetches on foreground, so server-side per-request evaluation
  is fine and avoids cross-request staleness across a flag flip.

---

## 9. Open product decisions (the backend builder MUST make explicit)

- [ ] **γ behavior mismatch:** does the server search handler **EXCLUDE**
      lesson/event hits when the flag is OFF (brief), or keep the client
      **open-guard** (status quo, hits appear but can't be opened)? These are
      observably different. **Pick one and document it.** If the server excludes,
      the client open-guard becomes belt-and-braces (harmless) — but the result
      counts the user sees will change.
- [ ] **Default for unknown / unevaluated flags:** **DENY** (recommended; matches
      client `=== true` resolution and fail-safe OFF).
- [ ] **Evaluator inputs beyond env-gate+allowlist+role?** (tier, cohort, account
      age, org/coach overrides). Mobile assumes only the three; builder is free to
      add more as long as the output shape is unchanged.
- [ ] **Caching strategy:** per-request memoize / Redis / none? Recommend
      per-request, no cross-request cache that outlives a flip. Respect the
      60/min/user throttle.
- [ ] **Performance budget:** undefined by mobile beyond the 15s client timeout
      and 60/min throttle. Keep it well under a few hundred ms (called on app
      foreground across screens).
- [ ] **Coach/owner overrides for role-gated flags?** Not evidenced; builder's
      choice. The only evidenced rule is "non-coach → `coach_community_wearable_
      prompts: false`".
- [ ] **Which keys to emit:** at minimum the four typed keys. Emitting extras is
      safe (open map). Omitting a typed key is safe too (client treats absent as
      OFF) — but then that surface is dark, so only omit intentionally.

### CONTRADICTION / casing note
The mobile uses **snake_case** for `/me/feature-flags` (and `/community/me`) but
**camelCase** for the search slice (`communitySearchApi.ts` — `nextCursor`,
`targetId`, deliberately documented). The feature-flags endpoint MUST stay
snake_case to match `FeatureFlagsResponseSchema`. Do not assume camelCase.

---

## 10. Edge cases and failure modes

`featureFlagsApi.ts` `classify` + `useFeatureFlags.ts` fail-safe:
- **401** → unauthorized; flags map fails → all typed flags OFF.
- **403** → forbidden; all flags OFF.
- **404** → falls through to `unknown`; all flags OFF (no special handling).
- **410** → gone; all flags OFF.
- **5xx** → server; all flags OFF (React Query default retry applies).
- **timeout / no response (status 0)** → network; all flags OFF.
- **shape drift (Zod `.strict()` / non-datetime / non-boolean)** → `contract`
  (synthetic 200); all flags OFF.
- **Net rule:** there is NO default-allow path anywhere. EVERY failure mode
  resolves every gated surface to OFF. The backend's safe failure posture is
  therefore **fail-closed**: either return a valid `{flags, evaluated_at}` (with
  unavailable flags set false) or error — both end in the client showing the
  surface OFF. The backend should NEVER need to "default a flag on" to keep a
  surface alive.

---

## 11. Test scenarios (regression pack the backend builder must write)

Mirrors `useFeatureFlags.test.tsx` semantics, extended for the search handler:
- **T1:** `classroom_lesson` hit + `community_classroom: false` → per §9 decision:
  excluded (if server-side γ) OR present-but-open-guarded (status quo).
- **T2:** `voice_note_transcript` (passthrough kind) → **always included /
  openable**, never gated.
- **T3 (mixed set):** all four kinds, only `community_events: false` → every hit
  passes except `event` hits are excluded/guarded.
- **T4 (no eval / 404 fallback):** flags fetch fails (401/403/404/5xx/timeout) →
  client reads ALL flags OFF → every gated surface dark (search itself off if
  `community_search` unavailable). Backend test: confirm an unauthenticated or
  errored caller never receives a true flag.
- **T5 (malformed kind):** search MUST only emit
  `post|classroom_lesson|voice_note_transcript|event`; the client `z.enum`
  REJECTS an unknown kind (whole page → `contract` error). Backend test: never
  emit an out-of-enum kind.
- **T6 (absent key = OFF):** `flags` omits `community_classroom` → client treats
  it OFF. Backend test: omission and explicit-false are equivalent.
- **T7 (role gating):** non-coach caller → `coach_community_wearable_prompts:
  false` returned by the server (client does not re-check). Coach/owner → may be
  true subject to env gate + allowlist.
- **T8 (open map additive):** returning an extra flag key does not break the
  client (`.strict()` is on the ENVELOPE, not on `flags`).
- **T9 (evaluated_at):** must be valid ISO 8601 UTC datetime; a bad value throws
  `contract` → all flags OFF.

---

## 12. Evidence references

- **Endpoint + auth + throttle + response schema:** `src/api/featureFlagsApi.ts`
  (commit 4920563) — header docstring, `FeatureFlagsResponseSchema`,
  `SERVER_FEATURE_FLAG_KEYS`, `getFeatureFlags`.
- **Hook resolution / fail-safe / caching / foreground refetch:**
  `src/hooks/useFeatureFlags.ts` — `resolve`, `ResolvedFeatureFlags`,
  `FEATURE_FLAGS_STALE_TIME_MS`, `AppState` listener.
- **Fail-safe + absent-key + role-trust semantics (tests):**
  `src/hooks/__tests__/useFeatureFlags.test.tsx`.
- **γ open-guard + kind→flag map:** `src/screens/community/CommunityFindScreen.tsx:99-158`.
- **Role-gated surface consumer:** `src/screens/community/CommunityWearablePromptsScreen.tsx:70-95`.
- **Search kinds enum (strict):** `src/api/communitySearchApi.ts:39-46`.
- **Two-tier gating + paired backend env gates:** `src/config/featureFlags.ts`
  (communitySearch / communityWearablePrompts / communityClassroom /
  communityEvents docstrings).
- **Ref provenance:** `git log --all -- src/api/featureFlagsApi.ts` →
  `4920563` (PR #263) on `ba8657d` ("R81 rebuild of PR #251 — D4B/D5Bγ via
  /me/feature-flags. Refs #258"). Backend source of truth: backend PR #414.

### Evidence files (raw snippets)
- `evidence/endpoint-contract.md`
- `evidence/flag-enum.md`
- `evidence/kind-flag-mapping-and-gamma-site.md`
- `evidence/evaluator-inputs-and-edge-cases.md`
