**Tier: T4** (production flags; client data to the AI provider; member-to-member content). B-FLAGS-123, agent 123. Matrix: FLAGS-D1-123 items (a)1-5.

**Supersedes growth-project-backend#650** (community core flip from 10-03, stale and never audited). Close #650 when this merges.

Desired-state flips only (`.github/fly-env-desired-state.json`):

- `FEATURE_COMMUNITY_API`, `FEATURE_COMMUNITY_POSTS`, `FEATURE_COMMUNITY_MESSAGES`, `FEATURE_COMMUNITY_PUSH`, `FEATURE_COMMUNITY_REALTIME`: `unset` -> `true` (master switch in the same PR, so the `community-subflag-needs-api` precondition holds). Voice notes, DM and every other community extra stay `unset`.
- `FEATURE_MESSAGING_CORE_V2`: `unset` -> `true`.
- `FEATURE_ROMAN_CHAT_ENABLED`: removed from `excluded`, now managed as `true`.
- `FEATURE_ROMAN_ADJUST_ENABLED`: newly managed as `unset`. It flips to `true` in a one-line follow-up after the mobile C-337 copy fix merges.
- Gates: new lines for both Roman switches; `FEATURE_MESSAGING_CORE_V2` rewritten to the day-1 gate; `FEATURE_COMMUNITY_API` notes #610 deployed and m#314 merged.

`src/common/env-validation.ts`: `values: ['true', 'false']` and `unsetIs: 'off'` for `FEATURE_ROMAN_CHAT_ENABLED` and `FEATURE_ROMAN_ADJUST_ENABLED` (both code paths turn on only for a case-insensitive `true`: `src/roman/roman.feature.ts`, `src/roman-adjust/roman-adjust.constants.ts`). Descriptive only; never read at runtime. Without it the plan fails closed ("no closed value set").

`docs/runbooks/launch-flags.md`: kill-switch table regenerated with `node scripts/fly-env/fly-env-manifest.js kill-switches .github/fly-env-desired-state.json src/common/env-validation.ts` (two new rows, both `off | fly secrets unset ... | unset`).

Unchanged and off on purpose: `FEATURE_COACHLESS_HOME`, `FEATURE_COACH_CODE_TOOLS`, `FEATURE_COACH_BROADCASTS` (mobile screens not built yet), `FEATURE_DUNNING_V2` (its own PR).

Merging changes nothing in production. Apply order (operator): deploy 7 (main e6f9a5ec or later, apply-migrations) -> read-only fly-env-truth run to re-confirm ANTHROPIC_API_KEY -> Fly Env Sync plan (expect 7 to set, 0 to unset) -> apply with deploy_staged=true -> /health, /readyz -> check each flag on the owner's account.

Mobile pairs: growth-project-mobile#383 (EXPO_PUBLIC_FF_ROMAN_CHAT + community tab in the store builds) and growth-project-mobile#384 (C-337).

Local single-spec runs (heavy.sh): test/ci/fly-env-manifest.spec.ts 67/67, test/env-validation.spec.ts 50/50, test/ci/fly-env-sync-behavior.spec.ts 54/54, test/ci/fly-env-workflows.spec.ts 15/15; `fly-env-manifest.js validate` OK. 3 files, 29 changed lines.
