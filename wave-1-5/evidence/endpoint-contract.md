# Evidence — Endpoint contract

## REF NOTE (read first)
The shared-clone HEAD (`a24c02a`, a revert commit on `main`) does NOT contain the
feature-flags code. The real D5=B+γ feature-flag client lives on branch
`fix/pr251-r81-rebuild-v2` (PR #263), commit `4920563`, built atop `ba8657d`
("R81 rebuild of PR #251 — D4B/D5Bγ via /me/feature-flags. Refs #258"). All
citations below are from commit `4920563`. The backend source of truth is
referenced in-code as **backend PR #414**:
`growth-project-backend/src/feature-flags/feature-flags.controller.ts` and
`.../feature-flags.dto.ts`.

## Endpoint
`src/api/featureFlagsApi.ts` (commit 4920563), header docstring + `getFeatureFlags`:
```
 *   GET /me/feature-flags
 *   Auth: Bearer JWT (global JwtAuthGuard; no @Public)
 *   Throttle: 60/min/user
 *   200:
 *     {
 *       "flags": { [name: string]: boolean },
 *       "evaluated_at": "ISO8601"
 *     }
```
```ts
export const FEATURE_FLAGS_REQUEST_TIMEOUT_MS = 15_000;

export const featureFlagsApi = {
  async getFeatureFlags(): Promise<FeatureFlagsResponse> {
    return call(FeatureFlagsResponseSchema, () =>
      api.get<unknown>('/me/feature-flags', {
        timeout: FEATURE_FLAGS_REQUEST_TIMEOUT_MS,
      }),
    );
  },
};
```
- **Method + path:** `GET /me/feature-flags`
- **Auth:** Bearer JWT (global JwtAuthGuard, no `@Public`)
- **Throttle:** 60 requests / minute / user
- **Request:** auth header only. No query params, no body.
- **Client timeout:** 15_000 ms (`AbortSignal.timeout` posture, mirrors search slice).

## Response Zod schema (verbatim)
`src/api/featureFlagsApi.ts`:
```ts
export const FeatureFlagsResponseSchema = z
  .object({
    flags: z.record(z.string(), z.boolean()),
    evaluated_at: z.string().datetime(),
  })
  .strict();
export type FeatureFlagsResponse = z.infer<typeof FeatureFlagsResponseSchema>;
```
- `flags`: `Record<string, boolean>` — an OPEN map (any string key, boolean value).
- `evaluated_at`: `z.string().datetime()` → **ISO 8601 datetime string, validated**.
- `.strict()` → **no extra top-level keys** allowed beyond `flags` and
  `evaluated_at`; a drifted envelope throws. (But `flags` itself is open — extra
  flag entries are fine.)

## Typed server flag keys the mobile reads
`src/api/featureFlagsApi.ts`:
```ts
export const SERVER_FEATURE_FLAG_KEYS = [
  'community_search',
  'coach_community_wearable_prompts',
  'community_classroom',
  'community_events',
] as const;
export type ServerFeatureFlagKey = (typeof SERVER_FEATURE_FLAG_KEYS)[number];
```
These are **snake_case** wire keys (NOT the camelCase local `featureFlags` keys).
The map may contain other flags; the client only types these four and treats any
absent key as OFF.

## Error / status classification
`src/api/featureFlagsApi.ts` `classify` (identical to communitySearchApi):
```ts
function classify(status: number): CommunityApiError['kind'] {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 409) return 'conflict';
  if (status === 410) return 'gone';
  if (status >= 500) return 'server';
  if (status === 0) return 'network';
  return 'unknown';                 // includes 404
}
```
Zod parse failure → `CommunityApiError(kind:'contract', status:200, "feature-flags
response shape drifted from the backend contract")`. Reuses `CommunityApiError`
from `communityApi.ts`.
