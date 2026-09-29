# AI Gateway — enterprise foundation

Status: scaffolded. AI is **disabled by default**. No real provider keys
are committed; no real LLM calls happen until an operator opts in via
env. Outputs return as draft until a human approves them.

This document describes what the gateway does today, what is real vs.
stubbed, how to plug in a real provider later, the security/compliance
posture, and remaining enterprise gaps.

## Why this exists

The repo already had an `AiService` that talks directly to Perplexity
from `POST /api/ai/chat`. That works for a single client-facing chat
surface, but it has none of the enterprise controls TGP needs:

- no provider abstraction (one hard-wired call site)
- no per-call audit row
- no human approval workflow for consequential outputs
- no redaction/minimization layer
- no fail-closed behavior at the capability level
- no shared data-quality / proof-provenance contracts

The new `src/ai/gateway/` layer adds those controls without removing
the existing chat surface. Capabilities migrate to the gateway one at a
time.

## Components

| File                                 | Owns                                                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `ai-gateway.config.ts`               | Feature gate + provider routing decisions. Default fail-closed.                                                   |
| `ai-redaction.service.ts`            | Email / phone / SSN / card / IP / bearer-token redaction with counts.                                             |
| `private-context.service.ts`         | Tenant-safe context retrieval. Coaches scoped to their roster, owners bypass, students self-only.                 |
| `providers/ai-provider.types.ts`     | Adapter contract.                                                                                                 |
| `providers/stub-provider.adapter.ts` | Deterministic disabled response. Always available.                                                                |
| `providers/provider-registry.ts`     | Resolves provider name → adapter. Real adapters plug in here.                                                     |
| `ai-gateway.service.ts`              | One entry point: redact → route → audit → open approval draft when required.                                      |
| `ai-approval.service.ts`             | Approve / reject / expire AiActionDraft rows. AI cannot self-approve.                                             |
| `ai-gateway.controller.ts`           | `POST /api/ai/gateway/invoke`, `GET/PATCH /api/ai/gateway/drafts`.                                                |
| `data-quality.types.ts`              | `ValidationStatus`, `ConfidenceLevel`, `ProvenanceRef`, `ProofClaim`, `ProofHook` — aligned with finance PR #112. |

## Persistence

Two new tables (migration `20260510000000_add_ai_gateway_audit_and_drafts`):

- `AiRequestAudit` — one row per AI gateway call. Captures requester,
  subject, tenant, provider, model, enabled flag, retrieval source
  count + refs/hashes, redaction summary, prompt/response hashes
  (NOT bodies), approval state, IP/UA, error.
- `AiActionDraft` — pending/approved/rejected/expired drafts for
  consequential outputs. Carries proposed action payload, rationale
  (truncated 1KB), redaction summary, provenance, decider, decision
  note, expiry.

Both tables are indexed for owner-side audit queries (capability,
requester, subject, tenant, status, created_at).

## Real vs. stubbed

| Concern                                                                   | Status                                                                                                                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fail-closed config (env-driven)                                           | **Real**                                                                                                                                                |
| Redaction (email/phone/SSN/card/IP/bearer)                                | **Real** with unit tests                                                                                                                                |
| Stub provider (deterministic disabled response)                           | **Real**                                                                                                                                                |
| Provider routing seam                                                     | **Real** (registry); real adapter implementations are stubbed — they log and fall back to stub                                                          |
| Audit write per call                                                      | **Real**                                                                                                                                                |
| Human-approval draft creation                                             | **Real**                                                                                                                                                |
| Approval decide endpoint with tenant boundary                             | **Real**                                                                                                                                                |
| Private context retrieval (subject `User` + profile + last coach message) | **Real**, returns sanitized prompt + provenance                                                                                                         |
| Data-quality / provenance / proof-claim contracts                         | **Real** as types; runtime hook integration with finance PR #112 is **stubbed** (`ProofHook` interface defined; no concrete hook registered in this PR) |
| Background sweeper for expired drafts                                     | Service method **real**; cron not wired in this PR                                                                                                      |
| Per-capability throttling                                                 | Default user-bucketed 20 calls / hour mirrors `/ai/chat`                                                                                                |
| Existing `/api/ai/chat` migration to the gateway                          | **Not done** — that path keeps working unchanged                                                                                                        |

## Fail-closed structured path — `importer.mapping` (L1-gw)

Review R581-B-B6 found that `AiGatewayService.invoke` silently falls back to
the stub provider (disabled gateway, disallowed capability, missing key, or ANY
provider error) and swallows 429/5xx. That posture is acceptable for chat-style
capabilities whose UI shows "[ai-disabled]", but it makes a fail-closed learn
step impossible: the caller cannot distinguish a model answer from a stub echo,
and cannot try a next model on 429/5xx.

`src/ai/gateway/structured/` adds a SEPARATE, capability-scoped path for the
importer's learn step (record `2026-09-27-learn-and-remember.md` D-L0-7). Every
other capability keeps its current behaviour — `AiGatewayService` is unchanged.

| Guarantee             | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fail closed           | `ImporterMappingConfig.resolve()` → `ok:false` on kill switch off, capability not allow-listed, gateway off, provider key missing, unwired provider, stub provider outside test/dev, model unset, spend cap unset in production. `ImporterMappingGatewayService.invokeStructured` throws `AiGatewayError('ai_unavailable')` and writes the audit row.                                                                                                                                                    |
| Stub only in test/dev | Stub runs only when `NODE_ENV=test`, or `AI_GATEWAY_DEV_ALLOW_OFFLINE_PROVIDER=true` outside production. It returns `enabled:false, output:null` — never anything parseable as a proposal. Production never gets a stub answer.                                                                                                                                                                                                                                                                          |
| Typed, closed errors  | `AiGatewayError.code` ∈ `ai_unavailable`, `ai_budget_exhausted`, `ai_timeout`, `ai_rate_limited`, `ai_provider_error`, `ai_request_rejected`, `ai_malformed_output`. Nothing is swallowed.                                                                                                                                                                                                                                                                                                               |
| Ordered models        | `AI_MODEL_IMPORTER_MAPPING` then `SCOUT_LEARN_MODEL_FALLBACKS` (comma list). The next model is tried ONLY on `ai_timeout` / `ai_rate_limited` / `ai_provider_error`, only when a fallback is configured, each model once. Malformed output and non-429 4xx are never retried.                                                                                                                                                                                                                            |
| Limits                | Hard per-request timeout (`SCOUT_LEARN_CALL_TIMEOUT_MS`, default 45 000; AbortSignal + race), max output tokens (`SCOUT_LEARN_MAX_OUTPUT_TOKENS`, default 4 096; a request may only lower it), temperature 0.                                                                                                                                                                                                                                                                                            |
| Daily spend cap       | `SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD` (owner D3 placeholder 20 outside production; production REFUSES when unset). Spent-today is summed from `AiRequestAudit.metadata.usd_estimate` for `capability='importer.mapping'` (UTC day) so it survives restarts; each call reserves input-estimate + max_tokens at `AI_PRICE_*` list prices, plus this process's in-flight reservations. Unreadable ledger ⇒ treated as cap reached. Timed-out calls are charged conservatively (input estimate + max_tokens). |
| Kill switch           | `SCOUT_LEARN_AI_ENABLED` (default OFF) in addition to `AI_GATEWAY_ENABLED` / `AI_GATEWAY_CAPABILITIES`.                                                                                                                                                                                                                                                                                                                                                                                                  |
| Observability         | One `AiRequestAudit` row + one `AICallLog` row per attempt: capability, provider, model actually used, token counts, latency, outcome code (`error` column = closed code or null), `usd_estimate`, `fallback_from`, `http_status`, schema hash. Prompt/response are hashed only — no content is persisted.                                                                                                                                                                                               |
| Structured output     | `AiStructuredProviderAdapter.completeStructured` REQUIRES a JSON schema; the real adapter sends it as a forced tool (`tool_choice: {type:'tool'}`) with `maxRetries: 0`, and the gateway validates the returned object with the caller's `parse` before returning it.                                                                                                                                                                                                                                    |
| Coach-AI credits      | `importer.mapping` is NOT metered against the coach's Coach-AI budget (`COACH_AI_METERED_CAPABILITIES` unchanged); the global daily cap is the spend control.                                                                                                                                                                                                                                                                                                                                            |

The learn service (later slice) calls `ImporterMappingGatewayService.invokeStructured`
and must map: thrown `AiGatewayError` → the run's stable failure code
(`learn_unavailable` / `learning_budget_exhausted`), and `enabled:false` (stub)
→ `learn_unavailable`. Tests: `test/ai/importer-mapping-gateway.spec.ts`.

## Plugging in a real provider

1. Add the API key as a Fly secret (e.g. `OPENAI_API_KEY`). Never commit values.
2. Implement `AiProviderAdapter` for the provider in `src/ai/gateway/providers/`.
3. Register it in `AiProviderRegistry.resolve()` behind its `AiProviderName`.
4. Set Fly secrets:
   - `AI_GATEWAY_ENABLED=true`
   - `AI_GATEWAY_PROVIDER=openai` (or `anthropic` / `perplexity`)
   - `AI_GATEWAY_CAPABILITIES=chat.client_self,draft.coach_message` (allow-list)
   - Optionally `AI_GATEWAY_REQUIRE_APPROVAL=draft.coach_message,draft.client_facing_claim` (override default)
5. The gateway is still fail-closed if the API key is missing or the
   capability is not in the allow-list. No further code changes needed
   to pause routing — set `AI_GATEWAY_ENABLED=false` and every call
   returns the stub.

## Security & compliance posture

- **AI disabled by default.** Master switch + capability allow-list +
  provider key all required to call out.
- **No prompt or response bodies persisted.** Audit row stores hashes,
  retrieval references, redaction counts, and provider metadata only.
  Bodies are out-of-band (provider-side logs governed by provider
  contract; mobile/console may show them to the user but not persist).
- **No PII in provider request bodies beyond what survived redaction.**
  The redactor catches email/phone/SSN/card/IP/bearer-token in
  free-text inputs. Structured CLIENT_CONTEXT is built from
  pre-sanitized fields.
- **Tenant isolation enforced at retrieval, not at the gateway.**
  `PrivateContextService.callerMaySee()` is the choke point; coaches
  scoped to assigned clients (`canCoachActOnClient`); owners bypass;
  students self-only.
- **Human approval for consequential actions.** Default
  `requireApproval` set covers `draft.coach_message`,
  `draft.meal_plan_change`, `draft.client_facing_claim`,
  `flag.escalation`. AI cannot self-approve; the original requester
  cannot approve their own draft.
- **No fake authority.** Outputs from the stub provider are explicitly
  marked `[ai-disabled]`; clients are required to render `draft_mode:
true` when set.
- **No training on client data.** No fine-tuning, no upload of client
  records to provider training endpoints. Provider adapters MUST opt
  out at the provider level (e.g. OpenAI `data_retention=zero`).
- **Audit trail covers approvals and expirations.** Every approve,
  reject, and bulk-expire writes a row to the existing `AuditLog` table
  alongside other sensitive admin actions.

## Remaining enterprise gaps (honest)

- Real OpenAI / Anthropic / Perplexity adapters not implemented in this
  PR. Registry returns stub for any non-stub name.
- Existing `POST /api/ai/chat` does not yet route through the gateway.
  That migration is its own PR — it requires the chat to emit a
  capability id, switch from direct Perplexity client to the registry,
  and add an audit row for each call.
- `ProofHook` runtime registration with finance PR #112 federation is
  not wired. The contract is defined; the federation client / DI seam
  is left for the finance-side PR to implement against.
- Background expirer for stale drafts has the service method
  (`AiApprovalService.expireStaleDrafts`) but no cron registration —
  add to `ScheduleModule` once the prod feature flag is on.
- Encryption-at-rest / object-storage scanning hooks: schema reserves
  `provenance` and `redacted_inputs` JSON columns so we can attach
  scanner output later, but no scanner is invoked in this PR.
- Owner audit-review console UI for AI requests is not built — surface
  is the existing `AuditService.list` admin endpoint plus a new
  `AiRequestAudit` admin query that should live in `src/admin/`.
- Per-capability rate limits beyond the default 20/hour throttle on
  `/ai/gateway/invoke` are not configured. Capability-specific limits
  should live next to capability definitions when added.
- Backup / restore / incident-response runbooks for the AI tables are
  out of scope here — they slot into `docs/audit-and-gdpr.md` once a
  real provider is enabled.

## Environment variables (names only — never commit values)

| Name                                                           | Default                                              | Purpose                                                                              |
| -------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `AI_GATEWAY_ENABLED`                                           | unset (off)                                          | Master switch. Must be `true` for any real provider call.                            |
| `AI_GATEWAY_PROVIDER`                                          | `stub`                                               | One of `stub`, `perplexity`, `openai`, `anthropic`.                                  |
| `AI_GATEWAY_CAPABILITIES`                                      | unset (deny-all)                                     | Comma list or `*` to allow everything.                                               |
| `AI_GATEWAY_REQUIRE_APPROVAL`                                  | default set                                          | Comma list of capabilities that gate on human approval.                              |
| `PERPLEXITY_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`  | unset                                                | Provider-specific key. Required for the matching provider.                           |
| `SCOUT_LEARN_AI_ENABLED`                                       | unset (off)                                          | L1-gw kill switch for `importer.mapping`.                                            |
| `AI_MODEL_IMPORTER_MAPPING`                                    | unset (refuse)                                       | Primary model id for `importer.mapping`.                                             |
| `SCOUT_LEARN_MODEL_FALLBACKS`                                  | unset (none)                                         | Comma list of fallback models; tried only on 429/5xx/timeout.                        |
| `SCOUT_LEARN_CALL_TIMEOUT_MS`                                  | 45000                                                | Hard per-request timeout for `importer.mapping`.                                     |
| `SCOUT_LEARN_MAX_OUTPUT_TOKENS`                                | 4096                                                 | Max output tokens per `importer.mapping` call.                                       |
| `SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD`                           | 20 outside production; production refuses when unset | Global daily spend cap (owner D3 placeholder).                                       |
| `AI_PRICE_INPUT_USD_PER_MTOK` / `AI_PRICE_OUTPUT_USD_PER_MTOK` | 10 / 50                                              | List prices used for `usd_estimate` and cap reservation.                             |
| `AI_GATEWAY_DEV_ALLOW_OFFLINE_PROVIDER`                        | unset                                                | Dev-only: permit the structured stub outside `NODE_ENV=test`. Ignored in production. |

## Tests

| File                                       | Covers                                                                                                                                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/ai-redaction.service.spec.ts`        | Email/phone/SSN/card/IP/bearer redaction; nested object walk; safe-text passthrough                                                                                                           |
| `test/ai-gateway.config.spec.ts`           | Fail-closed behaviors; allow-list; provider key gating; default approval set                                                                                                                  |
| `test/ai-gateway.service.spec.ts`          | End-to-end gateway invocation: stub path, redaction-before-provider, draft creation, audit-write swallow, requester required                                                                  |
| `test/ai-approval.service.spec.ts`         | Approve flow, no self-approval, cross-tenant block, idempotency, role check, bulk expirer                                                                                                     |
| `test/private-context.service.spec.ts`     | Self/coach/owner allow; cross-tenant deny; missing subject deny                                                                                                                               |
| `test/ai/importer-mapping-gateway.spec.ts` | L1-gw: fail-closed refusals, typed error codes, ordered-model fallback policy, timeout/max-tokens/spend cap, audit rows without content, structured-output requirement, legacy path unchanged |

Run: `npx jest test/ai-redaction.service.spec.ts test/ai-gateway.config.spec.ts test/ai-gateway.service.spec.ts test/ai-approval.service.spec.ts test/private-context.service.spec.ts`

## Related work

- Mobile PR #100 (`feat/invite-public-preview-fail-closed`) — the
  client-facing fail-closed behavior the gateway mirrors on the AI
  surface.
- Finance PR #112 — owns proof/signoff persistence; the
  `data-quality.types.ts` contracts here are the cross-app vocabulary.
- `src/audit/audit.service.ts` — global immutable audit log; AI
  approvals write into the same store under `ai.draft_*` actions.
