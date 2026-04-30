# Handoff brief 01 — AI Program Builder

> Operator-facing pre-work brief for expansion-roadmap item **#01**.
> Companion to the engineer-facing RFC at
> [`docs/rfcs/ai-program-builder.md`](../../rfcs/ai-program-builder.md)
> and to draft PR **#117**. Read this brief first, then the RFC.

**Status:** In discovery — RFC drafted, no runtime code merged.
**Last updated:** 2026-04-30.
**Roadmap row:** [`expansion-roadmap.md` row 01](../expansion-roadmap.md).

---

## WHY

A coach onboarding a new client today re-types their own
methodology each time: building a `WorkoutRoutine` from
`RoutineExercise` rows by hand, authoring `MealPlan` JSON,
authoring `Lesson` rows one at a time, pasting the same paragraphs
into `CoachGuideline`. Their IP — PDFs, sheets, unlisted videos,
prior client programs — is *outside* the platform.

The AI Program Builder lets a coach ingest those assets once, then
**review and edit AI drafts** of per-client programs rather than
authoring from scratch. The intent is not a generic LLM template
generator; it is to make the coach's own system the substrate the AI
builds against, so the output is recognizably *their* program.

This is a **growth lever**, not a cost-saver: the same coach can
serve more clients without diluting their voice. It is also the
substrate for items #03 (Outcome Graph), #04 (per-client
adaptation), #05 (plateau detection), and #09 (group programs) on
the [expansion roadmap](../expansion-roadmap.md).

## WHEN

Not yet. The work is gated on:

1. **RFC review.** §17 of the RFC enumerates 12 numbered open
   questions, each with an owner and a default bias. None of the
   runtime PRs (PR-1…PR-9 in §20 of the RFC) starts until those
   questions close.
2. **A `BUILDER_ENABLED` feature flag** gating every code path
   added by the runtime PRs. The flag must default to **off** in
   every environment until Stage 5 of §18.
3. **Provider posture decisions.** §9 of the RFC ("LLM and provider
   strategy") proposes Anthropic for drafting and OpenAI-compatible
   embeddings, with a deterministic fallback. The choice and the
   no-retain posture must be confirmed by the founder before the
   first provider key is added to a Fly secret.
4. **Cost ceiling decisions.** §15 of the RFC ("Cost controls")
   proposes a per-coach monthly budget and a per-draft cap. Those
   numbers must be set, not just sketched, before the first paying
   coach hits a draft endpoint.

The work starts in earnest at **Phase 1** of the rollout plan in
§18 of the RFC, after Stage 0 (RFC merge) is signed off.

## WHERE

The RFC proposes one new module and additive schema. Nothing
existing is renamed or rewritten.

- **New module:** `src/program-builder/` (per §4 of the RFC). The
  module is module-isolated; nothing in `src/ai/`, `src/coach/`, or
  the workout/meal/lesson modules imports from it. PR-1 is a
  no-op skeleton behind `BUILDER_ENABLED`.
- **New tables (additive only):** `CoachAsset`, `CoachAssetChunk`,
  `ProgramDraft`, `ProgramDraftSection`, `ProgramPublication`,
  `BuilderPromptTemplate`. All FKs concrete; all follow the
  conventions documented in [`prisma/README.md`](../../../prisma/README.md).
- **Existing tables read on publish:** `WorkoutRoutine`,
  `RoutineExercise`, `MealPlan`, `Lesson`, `CoachGuideline`. The
  publish path writes into them transactionally and emits an audit
  entry. Re-publish never mutates history (§12 of the RFC).
- **Queues:** parse / embed / draft, on the existing `REDIS_URL`
  (the same Redis backing the throttler — see roadmap item #19).
  Per §7 of the RFC, queues are idempotent and `Idempotency-Key`-aware.
- **Storage:** Supabase Storage prefix per coach (§8 of the RFC).
- **Routes (proposed, not yet shipped):** under
  `/api/program-builder/*` for coach-facing actions and under
  `/api/admin/program-builder/*` for OWNER-only operational reads.
  See §6 of the RFC for the full list.
- **Observability:** PostHog events under the existing taxonomy in
  `src/analytics/events.ts`; OWNER metrics counters under the
  shape documented in [`docs/metrics.md`](../../metrics.md);
  Sentry posture per [`docs/audit-and-gdpr.md`](../../audit-and-gdpr.md).

## WHO

- **Owner / decision-maker:** founder (Bradley) for the open
  questions in §17 of the RFC; backend lead for technical
  acceptance.
- **On the hook for the runtime work:** backend platform — the
  module, queues, schema, and provider integration.
- **Stakeholders that must sign off before Phase 1 starts:**
  - Founder — for §17 open questions, §9 provider posture, §15
    cost ceilings.
  - Backend lead — for the data model in §5 and the API surface
    in §6.
  - Product — for the human-in-the-loop editing surface in §11
    and the publishing UX in §12.
- **Audience for the *output* of this work:** coaches (for
  drafting), and OWNER admin (for the operational reports added
  in §16 / §6.OWNER admin).

## WHAT

**Already exists (what a future operator can read today):**

- The RFC at [`docs/rfcs/ai-program-builder.md`](../../rfcs/ai-program-builder.md)
  — long-form, table-of-contents linked, covering problem framing,
  non-goals, user stories, architecture, data model, API surface,
  queues, ingestion, LLM strategy, prompt versioning, HITL editing,
  publishing, evaluation, safety/privacy, cost controls,
  observability, open questions, rollout, test plan, follow-up PRs,
  links to existing models, and forward-compatibility notes for
  Outcome Graph and Team Mode.
- Draft PR **#117** carrying the RFC. The PR is **docs-only**: no
  migration, no module wiring, no provider code, no env vars added.

**Still to produce (in roughly this order):**

1. Closure on the 12 open questions in §17 of the RFC.
2. PR-1: no-op `src/program-builder/` skeleton behind
   `BUILDER_ENABLED`. Module loads, registers no routes by default.
3. PR-2: additive Prisma migration for the six new tables. No
   backfill; tables start empty.
4. PR-3: `CoachAsset` ingestion endpoint + parse queue +
   Supabase-Storage write path.
5. PR-4: chunk + embed pipeline (pgvector) + retrieval read path.
6. PR-5: draft queue + `BuilderPromptTemplate` table-backed prompts
   + provider-pluggable interface.
7. PR-6: HITL editing surface (state machine in §11; `body_initial`
   preserved for evals + recovery).
8. PR-7: transactional publish into `WorkoutRoutine`,
   `RoutineExercise`, `MealPlan`, `Lesson`, `CoachGuideline` with
   audit entry.
9. PR-8: OWNER admin reads (operational metrics, prompt-template
   diffs, cost dashboards).
10. PR-9: entitlement gate — wire the Builder into the
    `fitness_only` / `performance_os` bundles per
    [`docs/entitlements.md`](../../entitlements.md).

Each runtime PR must carry the new env vars in
[`README.md`](../../../README.md) under the same operator-facing
"Environment variables" structure already used for Stripe,
Supabase, and Sentry. Each runtime PR must update
[`docs/deploy-runbook.md`](../../deploy-runbook.md) if it adds
any Fly secret or migration that affects deploy ordering.

## HOW

Rollout follows §18 of the RFC end-to-end. The smallest first
non-doc PR is **PR-1: no-op skeleton behind `BUILDER_ENABLED`**.

- The skeleton lands disabled in every environment.
- It registers no routes when the flag is off.
- It is reverted by setting the flag off, not by reverting the PR.
- It passes the existing CI: `npm test`, `npm run lint`,
  `npm run build`, `npx tsc --noEmit`.

Subsequent runtime PRs (PR-2…PR-9) follow the same shape: each is
small enough to review in under an hour, each is independently
mergeable, deployable, and revertable, each is gated on
`BUILDER_ENABLED`, and each updates this brief's **WHAT** section
to reflect the new state.

When all nine runtime PRs are merged and the flag is on for the
first cohort, this brief moves to **in flight** in
[`expansion-roadmap.md`](../expansion-roadmap.md). When the rollout
in §18 reaches Stage 6 (GA), the row moves to **shipped** and this
brief is rewritten to point at the live module READMEs instead of
the RFC.
