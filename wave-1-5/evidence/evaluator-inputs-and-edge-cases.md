# Evidence — Evaluator inputs, evaluated_at, error/edge cases

All citations from commit `4920563` (branch `fix/pr251-r81-rebuild-v2`, PR #263).

## Evaluator inputs the mobile assumes
The mobile docstrings state the evaluator inputs EXPLICITLY (unlike the
`/community/me` surface). `src/api/featureFlagsApi.ts` header:
> "...it asks the server, which evaluates each flag from its own env gates +
> per-caller allowlist + role, and returns a flag map."

`src/hooks/useFeatureFlags.ts` header:
> "The server evaluates each flag from its own env gate + per-caller allowlist +
> role... Role-gated flags (e.g. `coach_community_wearable_prompts`) already
> resolve to OFF server-side for non-coach roles."

So the backend evaluator inputs the mobile ASSUMES are:
1. **Env gate** per flag (the `FEATURE_COMMUNITY_*` backend env vars).
2. **Per-caller allowlist** (some per-user allow table / list).
3. **Role** (client / coach / owner) — used to force role-gated flags OFF.

The mobile does NOT assume subscription tier, cohort membership, or account age.
Roles come from `COMMUNITY_MEMBER_ROLES = ['client','coach','owner']`
(`communityApi.ts:37-38`); the wearable-prompts screen reads
`me.data?.membership?.role` (`CommunityWearablePromptsScreen.tsx:70`) but for the
FLAG it trusts the server value, not the local role.

## evaluated_at
`src/api/featureFlagsApi.ts`: `evaluated_at: z.string().datetime()` — an ISO 8601
datetime string, **validated** (a non-datetime string throws a `contract` error).
The header documents it as `"ISO8601"`.

- Timezone: the test fixture uses `'2026-06-15T00:00:00.000Z'`
  (`useFeatureFlags.test.tsx`), i.e. **UTC (`Z` suffix)**.
- Does mobile COMPARE / use it for cache invalidation? **No.** The hook keeps
  `data` (including `evaluated_at`) but never reads or compares the timestamp.
  Cache freshness is purely React-Query driven (see below). `evaluated_at` is
  validated-but-unused observability metadata.

## Caching / staleness on the mobile side
`src/hooks/useFeatureFlags.ts`:
```ts
export const FEATURE_FLAGS_STALE_TIME_MS = 5 * 60 * 1000;  // 5 minutes
// useQuery({ queryKey: ['me','feature-flags'], staleTime: FEATURE_FLAGS_STALE_TIME_MS })
```
- `staleTime`: **5 minutes** — a fetched map is reused across screens without
  refetch on every mount.
- **Foreground refetch:** an `AppState` listener invalidates
  `['me','feature-flags']` when the app returns to `active` (RN equivalent of
  `refetchOnWindowFocus`), so a server-flipped flag takes effect on the next
  resume rather than only on cold start.
- No `refetchInterval` (unlike `/community/me`'s 60s poll).

## Error / edge cases (what mobile does on failure)
- `classify` maps 401→unauthorized, 403→forbidden, 409→conflict, 410→gone,
  >=500→server, 0→network, **404/other→unknown** (`featureFlagsApi.ts`).
- Zod fail → `contract` (status 200).
- FAIL-SAFE on ANY non-success: while `isLoading` OR `isError`, every typed flag
  reads `false` (`useFeatureFlags.test.tsx` — both "OFF while loading" and "OFF on
  error" tests). A failed flags fetch NEVER enables a gated surface.
- This is a hard **default-DENY** posture. There is no default-allow path.

## Consuming screens AND the flag-load gate
`CommunityWearablePromptsScreen.tsx:78-95`: the list query is enabled only when
`runtimeEnabled && !flagsLoading && !prerequisiteLoading && isCoachOrOwner &&
Boolean(workspaceId) && ...` — i.e. the screen will not fire its data fetch until
the flag map has RESOLVED and the flag is ON. `flagsLoading` (the
`useFeatureFlags().isLoading`) is ANDed into the enable condition so there is no
premature fetch against a not-yet-known flag.
