# Private AI gateway — design note (Phase 0)

Status: **design only**. No new tables, no runtime changes, no env vars
added. This document is the merge-ready scoping artefact for a follow-up
PR that introduces the gateway layer.

This is the contract every later PR has to honour. It exists so the
implementation work lands in small, individually green increments
instead of one large unreviewable change.

## Why a gateway

Today `src/ai/ai.service.ts` calls `https://api.perplexity.ai` directly,
with the API key bound to a single global env var. That is the right
shape for one model and one-tenant chat. It is the wrong shape for what
the platform now sells:

- **High-ticket private coaching UX** — clients pay for a coach. The AI
  assistant must feel like it belongs to the coach's brand and respect
  the coach's editorial guidelines, not the platform's house default.
- **Per-coach spend control** — `CoachProfile.ai_monthly_spend_cap_cents`
  already exists in the schema (default `5000`). It is not enforced
  anywhere because there is no per-call accounting of cost or token
  spend. A single runaway client can today exhaust the cap with no
  signal until the Perplexity invoice arrives.
- **Auditability** — `AuditLog` covers privileged human actions. AI
  responses are not audited. A coach asked to defend a number the AI
  gave their client today has no transcript, no model version, and no
  prompt-hash to point at.
- **Vendor neutrality** — Perplexity is the current upstream. The
  product roadmap calls for swapping in or layering a second provider
  (OpenAI / Anthropic / on-prem). Doing that today would mean
  rewriting `AiService.chat` end-to-end.

A gateway that wraps the upstream call solves all four problems with
the same shape.

## Scope (Phase 0)

Phase 0 is what this design note locks down. Phase 0 does **not** ship
code; it commits to the contract so each later PR is mechanical.

In scope for the gateway:

1. A single chokepoint, `AiGatewayService.complete(args)`, that every
   caller in `src/ai/` and `src/coach/` (any future coach-side AI
   feature) will route through. Today's only caller is
   `AiService.chat`.
2. A typed request envelope that carries the coach tenant id, the
   acting user id, the model name, the prompt hash, the token caps,
   and a request id. The gateway is the *only* place the upstream
   API key is read.
3. An append-only `AiRequestLog` table — additive migration only —
   that records every gateway call: tenant coach, acting user,
   model, prompt-hash, prompt-token estimate, completion-token
   estimate, cost-cents estimate, guardrails applied, status
   (`ok` / `fallback` / `denied_by_cap` / `provider_error`), and
   `created_at`. No prompt body, no completion body — just the
   counters and the references that make the row auditable.
4. A spend-cap pre-check that reads the rolling 30-day sum from
   `AiRequestLog` for the calling coach's tenant, compares it against
   `CoachProfile.ai_monthly_spend_cap_cents`, and short-circuits to
   `denied_by_cap` when over. The student sees the deterministic
   fallback responder; the coach sees the cap event in their console.
5. A provider-neutral fallback path. The gateway already owns the
   upstream call, so the existing deterministic fallback responder
   moves behind the gateway and runs on every `provider_error` and
   every `denied_by_cap` outcome.

Out of scope for Phase 0 (deferred to a later phase, called out so a
reviewer does not infer them from the gateway shape):

- Multi-provider routing. The gateway exposes a `model` field on the
  request envelope, but Phase 0 keeps a single hard-coded
  `provider=perplexity` mapping. Phase 1 adds the second provider.
- Streaming. The current `/api/ai/chat` is a single-shot completion;
  the gateway preserves that. Streaming lands when the mobile client
  is ready to consume it.
- Coach-authored prompt overrides. Coaches today get the same system
  prompt; per-coach overrides are a follow-up after the gateway
  exists. The gateway does not block this work — it enables it.
- Per-coach API keys. Vendor keys stay platform-wide in Phase 0. A
  coach-supplied key is a feature decision, not a gateway decision.

## Contract

### Request envelope

```ts
interface AiGatewayRequest {
  // Tenancy. Required. Used for spend accounting.
  coach_id: string;
  // Acting user. Required. Used for the AuditLog cross-reference.
  acting_user_id: string;
  // Logical model name. Phase 0 only accepts 'gp.assistant.v1'.
  model: 'gp.assistant.v1';
  // Already-rendered system prompt and user message. The gateway does
  // not assemble prompts; that stays in AiService.buildSystemPrompt.
  system_prompt: string;
  user_message: string;
  conversation_history: Array<{ role: 'user' | 'assistant'; content: string }>;
  // Hard caps. The gateway forwards these to the upstream and uses
  // them for cost estimation.
  max_tokens: number;
  temperature: number;
}
```

### Response envelope

```ts
interface AiGatewayResponse {
  reply: string;
  model_used: 'perplexity' | 'fallback';
  status: 'ok' | 'fallback' | 'denied_by_cap' | 'provider_error';
  // Filled in by the gateway. The caller forwards these to the
  // existing /api/ai/chat debug payload in non-prod.
  prompt_tokens_estimate: number;
  completion_tokens_estimate: number;
  cost_cents_estimate: number;
  // The id of the AiRequestLog row written for this call. Always
  // present, even on `denied_by_cap` / `provider_error` — the row is
  // written before the gateway returns.
  request_log_id: string;
}
```

The `cost_cents_estimate` is computed from the published per-million
token rate of the active provider, baked into a constants file under
`src/ai/gateway/`. The number is an estimate, not a Stripe charge —
the upstream invoice remains the source of truth — but it is the
number `ai_monthly_spend_cap_cents` is compared against, and it is
the number the OWNER admin metrics endpoint will surface.

### Storage

`AiRequestLog` (additive migration, Phase 1 of implementation):

| Column                       | Type       | Notes                                                                              |
| ---------------------------- | ---------- | ---------------------------------------------------------------------------------- |
| `id`                         | uuid (pk)  |                                                                                    |
| `coach_id`                   | uuid (fk)  | `User(id)`. Indexed.                                                               |
| `acting_user_id`             | uuid (fk)  | `User(id)`.                                                                        |
| `model`                      | text       | The wire model name, e.g. `gp.assistant.v1`.                                       |
| `provider`                   | text       | `perplexity` in Phase 0.                                                           |
| `prompt_hash`                | text       | SHA-256 of the rendered system+user prompt. Lets us deduplicate without raw text. |
| `prompt_tokens_estimate`     | int        |                                                                                    |
| `completion_tokens_estimate` | int        |                                                                                    |
| `cost_cents_estimate`        | int        |                                                                                    |
| `guardrails_applied`         | text[]     | Mirrors `AIGuardrailsService.validate` output.                                    |
| `status`                     | text       | One of `ok`, `fallback`, `denied_by_cap`, `provider_error`.                       |
| `error_class`                | text?      | Filled when `status='provider_error'` (`timeout`, `rate_limited`, `5xx`, `other`). |
| `created_at`                 | timestamp  | Indexed `(coach_id, created_at)` for the spend window read.                       |

No prompt body, no completion body. The row is the audit trail; the
content is intentionally not retained because the platform has no
contractual requirement to retain it and not retaining it removes a
GDPR-export and breach-blast-radius surface.

## OWNER surface

The gateway lights up two new OWNER reads, both additive, both behind
existing `@Roles('owner')`:

- `GET /admin/ai/usage?since_days=&coach_id=` — aggregated usage from
  `AiRequestLog`. Reuses the metrics-doc pattern: clamped
  `since_days`, no synthesis, all values come from the table.
- `GET /admin/coaches/:id/ai/usage` — per-coach roll-up surfaced on
  the coach overview screen on the admin console.

`/admin/metrics` gains a `ai_usage_30d_cents` counter so the existing
operator dashboard reflects the new signal without a new screen.

## Migration order

The gateway exists so each PR can be reviewed in isolation. The
recommended sequence:

1. **PR A — gateway scaffold (no behavior change).** Add
   `src/ai/gateway/` with the interface above and a single
   implementation that delegates to the existing Perplexity call.
   `AiService.chat` switches to the gateway. No new env vars.
   `AiRequestLog` is *not* yet a Prisma model — the gateway returns
   `request_log_id: ''` and writes nothing. Smoke contract unchanged.
2. **PR B — additive migration for `AiRequestLog`.** Phase 0 storage
   shape, indexed on `(coach_id, created_at)`. The gateway starts
   writing rows in `status='ok'` / `status='provider_error'` /
   `status='fallback'`. Spend cap is **not** yet enforced — the rows
   exist for observation only. Operator can read raw rows via psql
   to confirm cardinality before flag-flipping the cap.
3. **PR C — spend-cap enforcement.** Read the 30-day sum from
   `AiRequestLog`, compare against
   `CoachProfile.ai_monthly_spend_cap_cents`, return
   `status='denied_by_cap'` past the cap. Behind a feature flag
   `AI_SPEND_CAP_ENFORCED` (default unset = observe-only) so a
   bad-cost calculation cannot lock every coach out of the
   assistant.
4. **PR D — admin surface.** `/admin/ai/usage`,
   `/admin/coaches/:id/ai/usage`, and the new
   `ai_usage_30d_cents` counter on `/admin/metrics`. Pure read; no
   schema change.
5. **PR E — multi-provider routing (deferred).** Out of Phase 0.

Each PR ships with the corresponding module README update under the
existing README-with-every-PR rule.

## Risk register

- **Cost-estimate drift.** The estimate is a published-rate
  multiplication, not a Stripe charge. We accept up to one provider
  rate change of drift between estimate and invoice. Mitigation: the
  rate constants file is dated; an OWNER report compares the rolling
  estimate to the actual Perplexity invoice once a month.
- **Cap miscomputed.** A bad sum query could lock every coach out at
  once. Mitigation: PR C lands behind a default-off flag; we watch
  one month of observe-only data before flipping.
- **Log table growth.** `AiRequestLog` grows roughly linearly with
  AI invocations. At today's `20 / hour / user` cap the worst-case
  is small. Mitigation: a follow-up retention worker (90 days) is
  out of Phase 0 but reserved on the roadmap.
- **Prompt hash leak.** `prompt_hash` is a SHA-256, not a body, so a
  read of the table does not reveal client conversation content.
  Mitigation: spot-checked in PR B's migration review.

## What this does *not* do

- It does not change the `/api/ai/chat` wire contract. The mobile
  client sees the same response shape.
- It does not introduce a new env var in Phase 0. `PERPLEXITY_API_KEY`
  remains the only credential.
- It does not introduce per-coach prompts, per-coach keys, or
  multi-provider routing. Those are explicit future-phase items.

## Cross-references

- `src/ai/ai.service.ts` — the only Phase-0 caller of the gateway.
- `src/ai/ai-guardrails.service.ts` — runs *after* the gateway
  returns. Guardrails are a property of the response, not the
  upstream call; they stay where they are.
- `prisma/schema.prisma` — `CoachProfile.ai_monthly_spend_cap_cents`
  exists today and is the cap field this design uses.
- `docs/audit-and-gdpr.md` — `AuditLog` is the privileged-action
  trail; `AiRequestLog` is the AI-call trail. They are separate by
  design: a privileged human action is not the same shape as an AI
  inference, and conflating them would break the audit-log read API.
- `docs/metrics.md` — the Phase-D admin counter follows the same
  "no synthesis, source-data only" rule.
