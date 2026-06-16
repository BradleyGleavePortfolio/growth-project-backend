# Evidence — Flag enum

All citations from commit `4920563` (branch `fix/pr251-r81-rebuild-v2`, PR #263).

## Server-evaluated flags (the contract the backend MUST honor)
`src/api/featureFlagsApi.ts` `SERVER_FEATURE_FLAG_KEYS` and
`src/hooks/useFeatureFlags.ts` `ResolvedFeatureFlags`:

| Flag name (snake_case, wire) | Used by (file) | Human description (inferred) | Role-gated? |
| --- | --- | --- | --- |
| `community_search` | `CommunityFindScreen.tsx:72` (`runtimeEnabled = flags.community_search`) | runtime gate for the search surface itself | no |
| `coach_community_wearable_prompts` | `CommunityWearablePromptsScreen.tsx:80` (`runtimeEnabled = flags.coach_community_wearable_prompts`) | coach-only wearable coaching prompts surface | **YES** — server resolves to `false` for non-coach roles; client must NOT re-apply role gating |
| `community_classroom` | `CommunityFindScreen.tsx:137` (open-guard on `classroom_lesson` hits) | classroom-lesson surface live for caller | no |
| `community_events` | `CommunityFindScreen.tsx:147` (open-guard on `event` hits) | events surface live for caller | no |

The hook resolves exactly these four (`useFeatureFlags.ts`):
```ts
const flags: ResolvedFeatureFlags = {
  community_search: resolve(data, 'community_search'),
  coach_community_wearable_prompts: resolve(data, 'coach_community_wearable_prompts'),
  community_classroom: resolve(data, 'community_classroom'),
  community_events: resolve(data, 'community_events'),
};
```
where `resolve` returns `data?.flags?.[key] === true` — i.e. **absent or non-true
key → OFF (fail-safe)**.

## Semantics: OPEN-SET, absent = OFF
- `flags` schema is `z.record(z.string(), z.boolean())` → any string→boolean
  entries are accepted; the backend may return MORE flags than the four typed
  ones without breaking the client (`featureFlagsApi.ts`).
- A flag absent from the map is treated as OFF
  (`useFeatureFlags.ts` header + `resolve`).
- FAIL-SAFE: while loading AND on error, every typed flag reads `false`
  (`useFeatureFlags.test.tsx` "fail-safe OFF" suite).
- Client does NOT re-apply role gating for role-gated flags; it trusts the
  server's evaluation (`coach_community_wearable_prompts`).

## Two-tier gating (important architecture note)
The server flags are the INNER runtime gate. There is also an OUTER build-time
gate: the static `featureFlags.*` in `src/config/featureFlags.ts`
(`EXPO_PUBLIC_*` env, camelCase) controls **route REGISTRATION**. So a surface is
reachable only if BOTH the static build flag (route registered) AND the server
runtime flag (`useFeatureFlags`) are ON. (`useFeatureFlags.ts` header, "outer
gate ... route REGISTRATION; this hook is the inner, server-authoritative RUNTIME
gate".)

Relevant static (camelCase) flags and their env vars (`featureFlags.ts`):
- `communitySearch` ← `EXPO_PUBLIC_FF_COMMUNITY_SEARCH` (default false)
- `communityWearablePrompts` ← `EXPO_PUBLIC_FF_COMMUNITY_WEARABLE_PROMPTS` (false)
- `communityClassroom` ← `EXPO_PUBLIC_FF_COMMUNITY_CLASSROOM_POSTS` (false)
- `communityEvents` ← `EXPO_PUBLIC_FF_COMMUNITY_EVENTS` (false)

Each docstring notes a paired backend env gate `FEATURE_COMMUNITY_*`. The server
`/me/feature-flags` evaluator resolves "env gate + per-caller allowlist + role"
(`featureFlagsApi.ts` header) — so `FEATURE_COMMUNITY_*` is one of the inputs the
evaluator ANDs together to produce each `flags.<x>` boolean.
