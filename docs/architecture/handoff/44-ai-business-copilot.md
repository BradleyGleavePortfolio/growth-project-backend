# Handoff: #44 AI Business Copilot for Coaches

> Operator brief. Engineer-facing long form is
> [`docs/specs/ai-business-copilot.md`](../../specs/ai-business-copilot.md).

## WHY

A coach with 30 clients spends most of their time on
**business** work that isn't coaching: writing the offer,
sketching the sales page, drafting the onboarding sequence,
deciding which client to nudge, writing the community post,
summarising a client's progress before a 1-on-1. The
platform already has every input the coach would type into
ChatGPT today (roster, check-ins, programs, messages,
billing, at-risk signals, recap data, community engagement,
events, library, bounties, public profile). Re-rendering
those as a typed `CoachAIContext` and exposing them through
a single coach-side assistant is strictly better than the
coach typing the same context into ChatGPT every morning —
on privacy, fidelity, audit posture, brand voice.

The Copilot is **not** the AI Program Builder (PR #117) and
**not** the GP client assistant (`src/ai/`). The Builder
writes programs for clients to follow; GP answers a client's
nutrition/training questions; the Copilot helps the coach
**run the business**.

## WHEN

Cannot start runtime PR-1 until: Anthropic confirmed as the
default provider; per-coach monthly budget shape confirmed
(PR #120 lane #05; defaults L1 $0, L2 $20, L3 $100);
prompt-versioning confirmed via `BuilderPromptTemplate`
(PR #117 §3); eval CI shared with PR #117 §13; coach-AI-
voice setting (PR #121 #24) is queryable; `CoachAIContext`
shape reviewed and frozen (spec §8.2); no-write-to-client
posture written into `docs/audit-and-gdpr.md`; cross-tenant
guarantee asserted in service-layer + integration test.

**The Copilot does not ship without PR #121 #22 (at-risk
detector), PR #121 #23 (weekly recap), and PR #121 #24
(coach AI voice).** All three are required inputs.

## WHERE

New module `src/copilot/` peer to `src/ai/`. Four new
tables: `CopilotThread`, `CopilotMessage`, `CopilotSuggestion`,
`CopilotUsage`. New env-var family `COPILOT_*`. Coach
console only — mobile is not affected. No `new-website`
change. No edits to `src/ai/` (GP stays untouched; Copilot
reads `ClientAIContext` via the existing service for per-
client summaries but does not modify the GP module).

## WHO

Founder owns: per-tier budget caps, whether Copilot is
bundled at L2 or L3 only, whether Copilot drafts public-
facing artefacts in v1 (sales page, public profile copy).
Backend lead owns: schema, provider, prompt-versioning
ownership, eval cadence (per-template-version vs per-PR;
spec defaults: per-template-version). Coach console owns:
chat UI, accept-suggestion-to-draft flow. OWNER on the
pager; provider outages must not break the coach console
(deterministic fallback returns templated checklist).

## WHAT

Already exists: provider abstraction pattern (`src/ai/`),
`BuilderPromptTemplate` (PR #117 §3), eval CI runner
(PR #117 §13), per-coach budget pattern (PR #120 lane #05),
audit-log convention, at-risk detector (PR #121 #22),
weekly recap (PR #121 #23), coach-AI-voice (PR #121 #24),
`MessageDraft`.

Net-new: 4 tables, eight closed-vocabulary use cases
(`offer_create`, `onboarding_message`, `sales_page_copy`,
`challenge_idea`, `content_draft`, `client_progress_summary`,
`at_risk_insight`, `business_ops_suggestion`), the typed
`CoachAIContext` bundle, prompt-template versions per kind
(`copilot.<kind>.v<n>`), 200-fixture eval suite (≥ 25
per kind), four guardrails (PII scrub, voice scrub, fact-
check, cross-tenant scrub), per-coach monthly cost ledger.

Non-goals: a free-text "Copilot, anything" kind (the
structured workflows are the moat); a "Copilot agent" that
runs autonomously; tool-use / function-calling; voice input;
multi-tenant federation; cross-coach analytics; any path
where Copilot writes to a client-visible surface without
coach review.

## HOW

8-PR rollout (spec §7.1). PR-1 is schema + empty `[]`
behind `COPILOT_ENABLED=false`. `CoachAIContext` build lands
PR-2; first two kinds (`onboarding_message`, `content_draft`)
land PR-3; per-client kinds land PR-4; remaining kinds land
PR-5/PR-6; budget cap lands PR-7.

Smallest first PR ships: schema, module mounted, empty `[]`,
smoke assertion, OpenAPI export update. Zero provider call,
zero context build.

## Risks (top 3)

1. Provider hallucination of client metrics. Mitigation:
   fact-check guardrail asserts numeric fields exist in the
   context bundle; per-kind JSON Schema forces structured
   output where possible.
2. Cost runaway. Mitigation: per-coach monthly cap,
   60/hour/coach throttle, OWNER alerts at 80% / 100%,
   Anthropic prompt caching reduces per-call cost ~75% on
   repeated context.
3. Cross-tenant leak. Mitigation: cross-tenant scrub
   guardrail re-prompts on any non-allowed proper-name token;
   any > 1% trigger rate on the cross-tenant guardrail is a
   P0 incident.

## Acceptance criteria (one-line)

Coach on L2 opens an `at_risk_insight` thread → Copilot
reads at-risk detector last run → returns 10 nudges (one
per at-risk client) inside 8s p95 → coach accepts 4 → 4
`MessageDraft` rows are written + 4 PostHog events fire →
deterministic fallback returns the templated checklist when
provider is off → per-coach monthly cap enforced as 0
remaining cents → revert = flag flip; in-flight threads
remain; new chat returns `feature_locked`.

## Operator handoff

- **Kill-switch:** `fly secrets set COPILOT_ENABLED=false
  -a tgp-backend-prod`.
- **Dashboards:** active-coaches-30d, acceptance-rate-30d
  per kind, cost-30d-platform-total, provider-error-rate-30d,
  guardrail-trigger-rate-30d-per-kind.
- **Runbook entry:** `docs/operations/copilot.md` (future
  doc) covers provider rotation, model pinning, eval-drift
  signal, cross-tenant assertion review.
- **First 30 days:** OWNER reads
  `copilot_guardrail_trigger_rate_30d_per_kind` daily; any
  kind > 5% triggers prompt-template review; cross-tenant
  guardrail > 1% is P0.

## Cross-references

- Engineer spec: [`docs/specs/ai-business-copilot.md`](../../specs/ai-business-copilot.md)
- Adjacent specs: [`community-spaces.md`](../../specs/community-spaces.md),
  [`events-live-calls.md`](../../specs/events-live-calls.md),
  [`replays-content-library.md`](../../specs/replays-content-library.md),
  [`rewards-and-bounties.md`](../../specs/rewards-and-bounties.md)
- Related drafts: **PR #117 (canonical first user — provider
  abstraction, prompt-template table, eval CI, budget shape)**,
  PR #118, PR #120 (lanes #01, #04, #05, #06, **#08**, #10),
  **PR #121 (#22, #23, #24 — required inputs)**, PR #122,
  PR #123 (#30, #36).
