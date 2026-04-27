# ai

GP — the in-app coach assistant. Builds a typed context bundle from the
client's profile / macros / recent activity, hands it to a Perplexity
chat model, and runs every reply through a guardrail pass before it
reaches the user.

The provider is Perplexity's OpenAI-compatible endpoint. The fallback
responder runs whenever the API key is unset or the call fails, so the
endpoint always returns a usable answer.

## Purpose

- Give the user an answer that is consistent with what they see in
  their own app — never invented macros, never below the safety floor,
  never contradicting their coach.
- Strip "AI tells" (em-dashes, exclamation marks) and provider
  fingerprints so the assistant sounds like part of the product.
- Surface a debug payload in non-prod (`guardrails_applied`,
  `model_used`, `context_generated_at`) so QA can verify the chain
  without inspecting server logs.
- Expose the structured context to the mobile debug surface so the
  user can see exactly what the assistant knows about them.

## Key files

| File | What it owns |
|---|---|
| `ai.controller.ts` | `POST /api/ai/chat`, `GET /api/ai/context`, `GET /api/ai/structured-context` |
| `ai.service.ts` | System-prompt assembly, Perplexity call, deterministic fallback |
| `ai-guardrails.service.ts` | Post-response rewrite: calorie floor, macro contradictions, referrals, banned-substance redaction, AI-tell scrub |
| `client-ai-context.service.ts` | Builds the typed `ClientAIContext` from Prisma; 30s per-user cache |
| `client-ai-context.types.ts` | Type definitions used by the prompt and the guardrails |
| `ai.module.ts` | Wires the three services |

## Request flow (`POST /api/ai/chat`)

1. Controller pulls `userId` from `req.user`. The body provides
   `message` and `conversation_history`. **Profile, macros, and logs
   are never read from the body** — anti-spoof.
2. `ClientAIContextService.build(userId)` returns a cached or freshly
   built `ClientAIContext` (TTL 30s).
3. `AiService.buildSystemPrompt(ctx)` renders the absolute rules and
   the `CLIENT_CONTEXT` block. The prompt forbids contradicting
   `APP_PRESCRIBED` macros and refers questions about medical /
   injury / extreme restriction to the coach.
4. `chat.completions.create` hits Perplexity with the system prompt,
   the last 10 turns of conversation history, and the user message.
   Failures fall back to the deterministic responder.
5. `AIGuardrailsService.validate(userMessage, rawReply, ctx)` rewrites
   the reply if needed (calorie floor, macro contradiction, referral,
   banned substance, AI-tell scrub). The list of applied guardrails
   is returned in non-prod debug mode.

## The structured context

`ClientAIContext` is the source of truth for every prompt. Its shape
covers identity, profile, prescribed targets, today's macros, recent
workouts / weights / habits / check-ins, the coach relationship, and
the active guardrails. Rendering for the prompt is centralized in
`ClientAIContextService.renderForPrompt`.

Token-budget knobs are exported from
`client-ai-context.service.ts` (`CONTEXT_LIMITS`) so tests can reason
about trim points. The assembled context stays well under ~3 KB of
JSON in the typical case.

## Guardrails

| Rule | Behavior |
|---|---|
| Calorie floor | Reply mentioning sub-floor kcal gets a corrective sentence appended |
| Macro contradiction | Reply emitting a `protein_g`/`carbs_g`/`fat_g` *daily target* that diverges from `APP_PRESCRIBED` by >15% gets a corrective reminder |
| Referral | User question matching medical / injury / ED / mental-health patterns gets a "consult coach / qualified professional" line prepended |
| Banned substance | Anabolic steroids, SARMs, clenbuterol, ephedrine, DNP, water-fast / HCG language is redacted |
| AI-tell scrub | Em-dashes become `-`, exclamation marks become periods |

The list of applied rules is returned in `debug.guardrails_applied`
when `NODE_ENV !== 'production'`.

## Caching

`ClientAIContextService` keeps a per-user cache with a 30-second TTL.
Justification: chat bursts ("how am I doing?" → "what should I eat
next?") reuse the same context without reads exploding the database;
30 seconds is short enough that "I just logged a meal" feels fresh.
Tests use `buildFresh(userId)` to bypass the cache.

## Throttling

`POST /api/ai/chat`: 20 / hour / user. The throttle key is the
authenticated user, not the IP, so shared NAT does not penalize
legitimate users.

## Security and tenancy rules

- The user's `userId` is always taken from `req.user.id`. The body's
  `message` and `conversation_history` cannot influence the resolved
  identity.
- Profile, macros, and logs are pulled from Postgres — never from the
  request body.
- Guardrails are a two-layer defense: the system prompt instructs, the
  post-check enforces. The post-check is what protects when the model
  drifts on long conversations.
- Banned-substance redaction replaces the matched span with
  `[redacted]` rather than blanking the response, so the user sees
  the rest of the answer.
- The model is told it is the AI assistant inside the app and must
  disclose that if asked. The post-check does not police this — the
  prompt does.

## Environment variables

| Var | Tier | Purpose |
|---|---|---|
| `PERPLEXITY_API_KEY` | optional | Perplexity / OpenAI-compatible API key. When unset, the fallback responder handles every request. |
| `NODE_ENV` | hard | Switches the debug payload off in production. |

The fallback responder is deterministic and built from the same
`ClientAIContext`, so the contract stays consistent whether or not
the API key is configured.

## Failure modes

- `PERPLEXITY_API_KEY` unset / empty → fallback responder, `model_used:
  "fallback"`.
- Provider call throws → fallback responder, warning logged.
- Empty/blank message body → 400 from the global validation pipe.
- Guardrail rewrites → reply still returns 200; the rewrite is not an
  error.

## Tests

| File | Covers |
|---|---|
| `test/ai.service.spec.ts` | Prompt assembly, fallback responder, end-to-end chat with guardrails |
| `test/ai-guardrails.service.spec.ts` | Each guardrail rule on representative inputs |
| `test/client-ai-context.service.spec.ts` | Builder shape, trim points, cache TTL |

## Operational notes

- A surge in `Perplexity chat failed; falling back` warnings is the
  signal that the upstream is degraded. The endpoint stays up; users
  see fallback replies until upstream recovers.
- The structured-context endpoint is the surface mobile uses for the
  "what GP knows about you" disclosure screen. Treat its shape as
  semi-public and version-bump rather than break it.
- Em-dash and exclamation-mark scrubbing is project style, not safety.
  If the brand voice ever changes, drop step 5 from
  `AIGuardrailsService.validate`.
