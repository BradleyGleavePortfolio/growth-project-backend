# 08 — AI governance & prompt ops

> **Last reviewed:** 2026-04-30. Docs-only. No runtime change.

## WHY

Today the AI footprint is small and contained:

- **GP assistant** (`src/ai/`): typed `ClientAIContext`, system
  prompt assembly, post-response guardrails, deterministic
  fallback when `PERPLEXITY_API_KEY` is unset or the provider
  errors. Uses Perplexity (OpenAI-compatible).

The next wave is much larger:

- **AI Program Builder** (PR #117 RFC, draft): a coach-asset →
  draft-program pipeline. New `src/program-builder` module,
  BullMQ jobs, async LLM, per-coach budget cap, prompt
  templates table, eval baselines.
- **Future**: AI on check-ins (extraction), AI on revenue
  dashboards (insights), AI in support (canned reply
  drafting).

Without an explicit AI governance brief, the next wave has no
shape: how prompts are versioned, where evals live, how cost is
capped, what guardrails prevent prompt-injection from coach
assets, and what content the model is allowed to generate.

**Cross-feature impact:**

| Feature | Why this lane carries it |
|---|---|
| AI Program Builder | The full set of governance concerns shipped at once. This brief is essentially "the rule for Builder, generalized so future AI features inherit it". |
| Team Mode | Tenant boundary for prompt context — never include another team's asset chunks. Composes with lane #03. |
| Check-ins v2 | Future AI extraction (e.g., parsing free-text body into structured fields) inherits the same prompt-as-code rule. |
| Public profiles | No AI on public profiles; this brief documents that as an explicit non-goal. |
| Templates marketplace | AI content moderation when a coach publishes an AI-drafted template (proposed: yes, gated by lane #09 support tooling). |
| Revenue dashboards | Future AI insights inherit the cost-cap and provider-abstraction rules. |

## WHEN

Settle this brief **before** PR #117 (AI Program Builder) leaves
draft. The first runtime PR for Builder (`program-builder`
skeleton) is the one that needs this brief in place.

## WHERE

- `src/ai/` — the GP assistant. The reference implementation;
  this lane formalizes its conventions.
- `src/program-builder/` (future) — the Builder module from PR
  #117. New ground.
- `docs/ai-governance.md` — new doc; the operator's
  AI-governance handbook.
- `docs/rfcs/ai-program-builder.md` (PR #117) — the long-form
  Builder RFC; this brief references it for Builder
  specifics.

## WHO

- **Owner:** backend lead.
- **Reviewers:** founder (for cost ceilings + content
  guardrails), legal advisor when one is engaged.
- **On the hook in production:** OWNER. Provider outage flips
  the deterministic fallback; cost-cap breach pages OWNER per
  lane #06.

## WHAT

### What already exists

- GP assistant module in `src/ai/`.
- Deterministic fallback when provider is unconfigured or
  errors.
- Typed `ClientAIContext` — context assembly is explicit, not
  implicit.
- Post-response guardrails (existing in `src/ai/`).
- Per-surface throttling (PR #93) — per-user rate limits.

### What is missing

1. **Prompt-as-code.** Every system prompt and template lives
   in source. Versioned. Reviewed in PRs.
   - For Builder, this means the `BuilderPromptTemplate` table
     described in PR #117 is *seeded* from a file in
     `src/program-builder/prompts/*.md`, not authored in the
     DB by hand. The DB row is the operational copy; the file
     is the source of truth.
   - Diff-able. PR review of a prompt change is a real review,
     not a free-form text edit.
2. **Eval baselines.** Each prompt template has an in-repo
   fixture set (`src/.../prompts/__evals__/*.json`). A manual
   eval runner (`npm run ai:eval`) compares model output to
   the fixture. CI runs the eval against the deterministic
   fallback so we always have a green smoke; humans run the
   real eval before promoting a prompt.
3. **Provider abstraction.** A single `LlmProvider` interface
   in `src/ai/providers/`. Today's Perplexity client implements
   it. Builder's drafting client implements it. Adding a new
   provider (Anthropic, OpenAI direct, local) means writing a
   new adapter, not ripping out call sites.
4. **Cost ceilings.** Per-coach monthly budget for Builder.
   When the coach hits the budget, drafts are rejected with
   `402 Builder budget exhausted`. OWNER can override via the
   admin surface (lane #09).
5. **Content guardrails.**
   - **Prompt injection from coach assets:** asset content is
     placed into a strictly-bounded section of the prompt
     (e.g., between sentinel tokens). The system instruction
     forbids treating that content as instructions.
   - **Off-topic / unsafe output:** post-response guardrails
     (already exist for GP assistant) extend to the Builder.
   - **PII in prompts:** prompt assembly strips client PII
     before sending. Coach asset chunks are sent as-is — that
     is the coach's own content.
6. **Provider no-retain posture.** Document which providers we
   use and their data-retention contract. Today: Perplexity (no
   data retention per their API terms). Future: Anthropic
   (zero-retention with the right headers — see PR #117).
7. **Auditing.** Every Builder draft logs: coach id, prompt
   template id, prompt template version, asset chunk ids
   referenced, draft id, latency, token counts, cost. Logged
   to `AuditLog` + a dedicated `BuilderJobRun` row (proposed,
   from PR #117).
8. **Determinism for tests.** `LlmProvider` has a
   `DeterministicLlmProvider` adapter that produces a fixed
   output per prompt. Unit tests use it. CI eval runs against
   it.

### Non-goals (explicit)

- We do not run our own model.
- We do not fine-tune.
- We do not embed RLHF / human-feedback loops in v1 (the
  human-in-the-loop is at the *draft review* level, not at the
  prompt-tuning level).
- We do not generate content for public surfaces (no AI on
  public profiles).

## HOW

### Operator handoff

- A new `docs/ai-governance.md` documents the seven items above
  plus the non-goals.
- Per-coach budget config: `BUILDER_BUDGET_USD_PER_COACH_MONTH`
  env var (proposed, from PR #117 RFC §15). OWNER can override
  per coach via the admin surface (lane #09).
- Provider switch: `BUILDER_LLM_PROVIDER=perplexity|anthropic|deterministic`
  (proposed). `deterministic` is the kill switch.
- Prompt rollout: a prompt change is a code change → PR review
  → eval run → merge. The DB template row is updated by a
  one-shot script that reads from `src/program-builder/prompts/*.md`.

### Prompt-template versioning

Each template file has a frontmatter version:

```markdown
---
id: builder.draft.workout
version: 3
notes: tightened JSON output schema
---

# System
You are drafting a workout block for a client based on the coach's
program assets.

[ASSET]
{{asset_chunks}}
[/ASSET]
…
```

The `BuilderPromptTemplate` row mirrors this version. A draft
records the version it ran against.

### Eval shape

Each template has a sibling `__evals__/` folder with one or more
`*.json` fixtures: input asset chunks, expected output shape (not
exact text — schema), expected non-empty fields, expected
absences (no instruction-following from asset content).

The manual eval runner (`npm run ai:eval -- builder.draft.workout`)
executes the prompt against the configured provider and prints a
table of pass/fail per fixture. CI runs against
`DeterministicLlmProvider` only — humans run real provider evals.

### Cost ceiling enforcement

At call time:

1. Read the coach's month-to-date Builder cost from
   `BuilderJobRun` (sum). Cached for 60s.
2. If the next call's *estimated max cost* would exceed
   `BUILDER_BUDGET_USD_PER_COACH_MONTH`, reject with
   `402 Builder budget exhausted`.
3. Log the rejection to `AuditLog`.
4. OWNER can grant a one-month override (admin surface, lane
   #09).

The estimated-max-cost calculation is conservative: it uses
the prompt template's worst-case token count plus a 20%
fudge factor.

## Risks

- **Provider retention drift.** Mitigation: provider-no-retain
  posture is checked at every contract refresh; documented in
  the lane.
- **Prompt-injection from coach assets.** Mitigation: sentinel
  tokens, system instruction forbids instruction-following
  from asset content, eval fixtures explicitly include
  injection attempts and assert they are ignored.
- **Cost runaway.** Mitigation: per-coach monthly cap +
  per-draft cap (PR #117 §15) + `BUILDER_LLM_PROVIDER=deterministic`
  as the kill switch.
- **Prompt drift between source file and DB row.** Mitigation:
  a startup check warns if the DB row's version doesn't match
  the current source file's version.
- **PII leaks via the prompt.** Mitigation: prompt assembly
  strips client PII; tests assert this for every prompt
  template.

## Dependencies

- Lane #01 (resolver) — `BUILDER_ENABLED` and per-coach
  entitlement flow through it.
- Lane #03 (security) — prompt injection sits inside the
  threat model.
- Lane #05 (billing) — Builder is a paid add-on; the cost cap
  here is *operational* (per-coach), and the billing cap is
  *commercial* (per-bundle).
- Lane #06 (observability) — Builder traces include prompt
  template id and token counts (PII-scrubbed).
- Lane #09 (support) — OWNER overrides for cost-cap and
  per-coach Builder failures live in the admin surface.

## Acceptance criteria

1. ✅ `docs/ai-governance.md` exists with all seven items above
   and the non-goals.
2. ✅ The `LlmProvider` interface is defined (runtime PR; not
   this docs PR).
3. ✅ The `DeterministicLlmProvider` adapter ships before any
   Builder runtime code (so tests can rely on it).
4. ✅ Prompt source files live in
   `src/program-builder/prompts/*.md` with frontmatter version.
5. ✅ Eval runner is documented and ships before the first
   non-trivial prompt change.
6. ✅ Per-coach budget cap is enforced by the
   resolver+throttler combination (lane #01 flag + per-coach
   read of `BuilderJobRun` sum).
7. ✅ Provider no-retain posture is documented.

## Test strategy

- **Unit:** prompt assembly is unit-tested with PII fixtures.
  The asserts verify that no PII fields make it into the
  outgoing prompt.
- **Eval (manual):** `npm run ai:eval -- <template>` against
  the real provider before promoting any prompt change.
- **Eval (CI):** `npm run ai:eval -- <template> --provider=deterministic`
  on every PR.
- **Integration:** existing GP assistant tests pass; Builder
  integration tests cover the happy path + provider error +
  budget exhausted.

## Rollout & kill-switch

- New AI features ship behind `BUILDER_ENABLED=false` (or the
  equivalent flag).
- Provider kill switch:
  `BUILDER_LLM_PROVIDER=deterministic` returns a deterministic
  output.
- Cost kill switch: `BUILDER_BUDGET_USD_PER_COACH_MONTH=0`
  effectively disables drafts.
- Prompt rollback: revert the source file PR; run the
  one-shot DB-row updater to roll the row back too.
