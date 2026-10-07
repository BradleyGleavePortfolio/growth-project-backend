AUDIT Claude Opus 5.5 (LB-OPUS-126) — growth-project-backend#808 @ 9487faa216ac9fd79cffc704a9e1ac4ce3c09b1d — VERDICT: APPROVE

A=0 B=0 C=4. CI: every check on this head is green (build-and-test, danger, actionlint, shellcheck, CodeQL, rls/community/mwb-3 live tests, schema parity, banned casts). Mergeable: clean, 0 behind main f71bb9a4. Size 615 lines (607+/8-).

**Flag-sync change (owner asked for a careful look). It is safe.**
- How values flow: `.github/fly-env-desired-state.json` -> `fly-env-manifest.js` `validateManifest` checks each flag value against its closed `values` set in ENV_RULES (the process exits 1 on any error before prepare, plan or verify) -> `plan` writes `set-flags.txt` as `NAME=value` lines -> the stage step reads them with `IFS= read -r`, checks each line with the anchored grep `^[A-Z][A-Z0-9_]*=[a-z0-9_]+([.,][a-z0-9_]+)*$`, and adds it to a bash array -> `flyctl secrets set --stage -a "${APP}" "${args[@]}"`. Each value is its own argv element. Nothing passes through eval, word splitting or glob expansion.
- What the new regex rejects. `=` cannot appear in a value: the character class has no `=`, so the value can only start after the first `=`. `*`, `?`, `[`, spaces, quotes, `$`, `;`, `\r` and a leading `-` all fail. `read` strips newlines, so a line cannot hide a second one. An empty segment (`a,,b`) or a trailing comma also fails. The only characters added are `_` and `,`.
- The in-machine compare is not affected: values travel only as salted SHA-256 hashes inside a base64 payload, so commas never reach a shell.
- `extractEnvRules` now reads each quoted literal, so `'a,b'` stays one value. Lines that old and new code both accept give the same result, and the CI spec checks it against the imported ENV_RULES.
- `*` stays rejected for AI_GATEWAY_CAPABILITIES. Its closed set is exactly `['draft.create_workout_plan,draft.edit_workout_plan']`, so `validateManifest` refuses `*`, and the shell regex refuses `*` as well. A spec covers this (aib4 spec: "'*' and REQUIRE_APPROVAL=false are rejected").
- "unset" semantics, `planChanges`, the plan/apply `confirm=SET` gate and the `deploy_staged` handling did not change. The yml diff is a single line (359).
- Precondition `mwb-ai-live-needs-gateway` cannot be bypassed:
  - It runs inside `validateManifest`, which every subcommand runs.
  - With FEATURE_MWB_AI_LIVE_CREATE "true" it requires ENABLED "true", PROVIDER "anthropic" and CAPABILITIES not "unset". The closed set leaves only the two-capability value for CAPABILITIES.
  - At runtime the gateway also refuses the two capabilities while the flag is off (`ai-gateway.config.ts` `capabilityAllowed`).
- All five names are "unset" today, moved from `excluded` into `flags` with gates. I checked against Fly: the names-only log of secrets-list run 37536038425 (job 112517070421) lists none of FEATURE_MWB_AI_LIVE_CREATE or AI_GATEWAY_*. So the next apply plans "keep" for all five and unsets nothing live. ANTHROPIC_API_KEY is present on Fly.
- `requireApprovalFor` now returns true for both workout capabilities whatever AI_GATEWAY_REQUIRE_APPROVAL says (SAFE 4). The closed set for REQUIRE_APPROVAL is the full default list, and its kill (unset) falls back to the defaults, which is the safe direction.

**Routes**
- `GET /ai/gateway/workout-builder/status`: coach/owner (JwtAuthGuard + RolesGuard). It reads only `req.user.id` and the head coach's pool, and calls no provider and no client data. It reads the flag on every call, so the response is `paused` today. The response shape matches plan section 3 exactly, including the label "AI-suggested, coach-approved" (SAFE 8, 9, 11, 12).
- `GET /workout-plans/:planId/revisions`: coach/owner and behind FEATURE_MWB_AUTOSAVE_UNDO (on). It runs `authorisePlanAccess` before any revision read (foreign coach 403, unknown plan 404, both tested). It selects only index, author, cause, created_at and the snapshot. The summary is counts plus the cause label, with no notes or free text (SAFE 3, 10).

**C (never block)**
- C-808-1: `canCharge` -> `getOrCreateCurrentPeriod` can create the coach's budget row with default values on first status read. The PR body says "never writes". The behaviour is harmless (the same row the gateway would create); only the wording is off.
- C-808-2: on a tenant-shared program master the head coach gets 403 PROGRAM_READ_ONLY for the read-only history list. That builder is read-only anyway.
- C-808-3: the gates note says the secrets list was taken "15:52 10-06", but run 37536038425 was created 14:44 PDT. Doc wording only.
- C-808-4: `remaining_pct` is 0 while `state` is "on" if a pool has a total of 0 displayed cents. Not reachable with default config. C (edge, deferred to 10k clients).
