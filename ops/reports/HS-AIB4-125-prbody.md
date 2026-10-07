**Tier:** T4 (config + money state: AI gateway switches, approval rule, coach AI pool read)
**Why:** AIB-4 of AI_MASTER_BUILDER_PLAN.md (sections 3 and 5): server-driven "Ask AI" visibility for the workout builder, a read-only revision history, and manifest entries so the FLIP PR is a values-only change.
**T4 trigger scan:** auth/tenancy (new coach/owner route; revisions list reuses the autosave owner/visibility gate), money state (reads the coach AI pool, never writes), flags/config (ENV_RULES closed sets, manifest, fly-env-sync value regex), approval (workout capabilities always need a coach decision). No PII, no migrations, no destructive data.
**T3 trigger scan:** none (no mobile change).
**Bounded T1:** docs/runbooks/launch-flags.md rows.
**Canonical builder:** Claude Opus 5.5 (HS-AIB4-125 for agent 126, entry B-AIB4-126).
**Acceptance evidence:** see Tests below; PR CI.

## What it does
- `GET /ai/gateway/workout-builder/status` (coach/owner): `{ state: on|paused|no_credits|not_configured, create, edit, credits: { remaining_pct, resets_at }, label: 'AI-suggested, coach-approved' }`. paused = FEATURE_MWB_AI_LIVE_CREATE not 'true'; not_configured = flag on but neither workout capability resolves to a real provider; no_credits = coach pool used up (same test as the gateway pre-call gate). Read per call, no provider call, no client data.
- `GET /ai/gateway/status` now lists `draft.create_workout_plan` / `draft.edit_workout_plan` when allowed.
- `GET /workout-plans/:planId/revisions?limit=20` (max 50): newest first `[{ revision_index, author_kind, cause, created_at, summary }]`, same gate as autosave/undo (403 foreign coach, 404 unknown plan or FEATURE_MWB_AUTOSAVE_UNDO off). Summary is derived from snapshot counts only.
- `requireApprovalFor` always true for the two workout capabilities (AI_GATEWAY_REQUIRE_APPROVAL can no longer drop them).
- ENV_RULES closed sets (no boot validators: env-registration hygiene forbids new ones, and the manifest closed set is the gate): FEATURE_MWB_AI_LIVE_CREATE true|false, AI_GATEWAY_ENABLED true|false, AI_GATEWAY_PROVIDER stub|anthropic, AI_GATEWAY_CAPABILITIES = exactly `draft.create_workout_plan,draft.edit_workout_plan` (so `*` is rejected by the manifest check), AI_GATEWAY_REQUIRE_APPROVAL = the default list written out (so `false` is rejected).
- Manifest: the five names in `flags`, ALL "unset", gates name SAFE-AIB-127 GO + owner device tap; stale R2b `excluded` notes removed. New precondition `mwb-ai-live-needs-gateway`.
- Manifest loader reads quoted values that contain commas; fly-env-sync flag-line regex accepts `_` and `,` in values (values are passed as quoted argv, never evaluated) so the FLIP value can be staged.

## Tests (fail on main: the files/routes do not exist there)
- test/aib4-workout-builder-status.spec.ts (11): paused with flag off; on with flag + caps + key (head coach pool share 75%, resets_at); not_configured without caps / key / gateway; one cap only; no_credits; budget read failure -> null credits; gateway getStatus lists the two caps only while allowed; approval forced for workout caps; manifest: five names unset + gated + not excluded, comma value loads as one value, FLIP values validate, `*` and REQUIRE_APPROVAL=false rejected, precondition mwb-ai-live-needs-gateway.
- test/aib4-workout-plan-revisions.spec.ts (3): newest first with derived summaries and no notes; foreign coach 403 before any revision read, unknown plan 404, flag off 404; limit clamp, baseline row, pruned gap / malformed snapshot.
- test/ci/fly-env-sync-behavior.spec.ts (+1): the FLIP value `draft.create_workout_plan,draft.edit_workout_plan` passes the sync NAME=value guard and is staged.
- Local targeted runs green: the two new specs, fly-env-manifest (69), fly-env-sync-behavior (56), fly-env-workflows (15), env-validation (50), fly-env-classifier (53), env-registration (30), ai-gateway.config (7), mwb-5-feature-flag-gating (8).

## Checklist (Done / Remaining / Next step) — work complete, nothing uncommitted
**Remaining:** none from the builder; reviews + merge are operator/agent 126.
- [x] Status route: src/ai/gateway/workout-builder/workout-builder-status.controller.ts, workout-builder-status.service.ts; registered in src/ai/gateway/ai-gateway.module.ts
- [x] getStatus lists the two workout capabilities: src/ai/gateway/ai-gateway.service.ts
- [x] Revisions list: src/workout-builder/workout-builder-autosave.controller.ts, workout-builder-autosave.service.ts (listRevisions), workout-plan-revision-summary.ts
- [x] Approval always required for workout capabilities: src/ai/gateway/ai-gateway.config.ts (requireApprovalFor)
- [x] ENV_RULES closed sets: src/common/env-validation.ts
- [x] Manifest: .github/fly-env-desired-state.json; precondition + comma loader: scripts/fly-env/fly-env-manifest.js; sync guard: .github/workflows/fly-env-sync.yml
- [x] Tests: test/aib4-workout-builder-status.spec.ts, test/aib4-workout-plan-revisions.spec.ts, test/ci/fly-env-sync-behavior.spec.ts; runbook: docs/runbooks/launch-flags.md
- [x] main merged in (f71bb9a4, includes b#805)
- [x] PR CI green at 9487faa2 -> marked ready -> READY comment posted (17:38)
**Next step:** dual lenses (GPT-6.1 Sol + Claude Opus 5.5) at the exact head; agent 126 owns any fix round. The FLIP PR changes manifest values only.

Size: 607 additions + 8 deletions = 615 changed lines (over the entry's 400 target, under the 800 cap; about 280 are tests).

Overlap: none of the open PRs touch these files except b#805/#807 (ai-gateway.service.ts / ai-credits); this PR only adds two entries to the getStatus list.
