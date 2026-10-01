# Client AI processing consent (R2)

Source: `src/roman/consent/*`, `src/ai/adapters/ai-subject-consent.gate.ts`.
Tests: `test/roman/roman-consent.spec.ts`, `test/rls/ai-processing-consent-rls.spec.ts`.

## One onboarding box (owner ruling 2026-09-30 16:31 #5)

The client ticks a single "I agree" during onboarding. It covers the
personal-training waiver and letting Roman and the coach's AI tools see the
client's in-app data, processed by the named third-party provider (Anthropic).
The copy is server-authoritative, versioned (`client-ai-v2`) and names every
data category of ruling #6: profile, consultation and safety-screen answers,
food logs, workouts and history, check-ins, wearable/health/sleep data,
messages with the coach, community posts the client wrote. Never another
client's data, never coach private notes.

Record: `AiProcessingConsent (user_id, processor='anthropic',
purpose='client_ai_processing')` with `consent_version`, `copy_sha256`,
`granted_at`, `revoked_at`, `waiver_version`, `waiver_accepted_at`, platform
metadata. RLS: owner-self SELECT/INSERT/UPDATE, service_role bypass, anon
deny-all, no public DELETE.

## Endpoints (`JwtAuthGuard + RolesGuard`; NOT behind the chat feature flag)

| Route | Body | Result |
|---|---|---|
| `GET /me/ai-consent` | – | `{roman: {granted, version, granted_at, revoked_at, current_version, needs_reconsent, waiver_version, waiver_accepted_at, waiver_current_version}, copy: {version, text, sha256, processor, data_categories}}` |
| `POST /me/ai-consent/onboarding` | `{ai_consent_version, waiver_version, copy_sha256?, platform?, app_version?, locale?}` | records the combined grant; 409 `CONSENT_VERSION_MISMATCH` if either version is stale |
| `POST /me/ai-consent/roman` | `{version, …}` | re-consent sheet (keeps an accepted waiver) |
| `DELETE /me/ai-consent/roman` | – | withdraw (idempotent). Works with `FEATURE_ROMAN_CHAT_ENABLED` off |

Env: `ROMAN_CONSENT_CURRENT_VERSION` (default `client-ai-v2`),
`PT_WAIVER_CURRENT_VERSION` (default `pt-waiver-v1`). Bump only with a copy change.

## Enforcement (the data subject's grant, at every client-data boundary)

- `POST /roman/sessions/:id/messages`: `assertAiConsent(req.user.id)` before
  the session lookup, the user-turn write and any model work → 403
  `ROMAN_CONSENT_REQUIRED {current_version, reason}`.
- Coach AI (`/coach/ai/workout-program|meal-plan|client-insight`, the weekly
  insight job): `AnthropicAdapter` consults the `AI_SUBJECT_CONSENT_GATE`
  (bound to `RomanConsentService` in `CoachAIModule`) for `opts.clientId`
  before EVERY upstream request, including retries and the structured-JSON
  repair pass → 403 `CLIENT_AI_CONSENT_REQUIRED`. The coach's own grant never
  authorises processing of a client's data. With no gate bound the adapter
  fails closed (403 `AI_CONSENT_GATE_UNAVAILABLE`).
- `POST /ai/chat` (AI Guide) is retired: deterministic 410 `AI_GUIDE_RETIRED`;
  `AiService.chat` is unreachable from HTTP. Roman is the consented surface.

Audit: `ai_consent.granted` / `ai_consent.revoked` rows carry ids, versions and
platform metadata only, never the copy text.

## Transcript storage, visibility and retention (owner ruling 2026-09-30 17:42)

- Roman conversations are persisted server-side (`RomanSession`, `RomanMessage`).
- Visible only to the client who wrote them: owner-self RLS on both tables and
  an owner-self controller (`/roman/sessions/:id/...` filters `user_id = caller`).
  No coach, sub-coach, admin or owner API returns transcript content; coach-facing
  features receive only Roman's routed escalations (e.g. "client asked about
  pain, message them"). Developers with direct database access are the only
  other readers. `test/roman/roman-transcript-privacy.spec.ts` pins this
  (coach / sub-coach / owner callers → 404; static scan: no other reader).
- Retention: `RomanRetentionService` (daily 04:11 UTC) hard-deletes sessions
  idle for 180 days and purges sessions the client deleted
  (`DELETE /roman/sessions/:id`), cascading to messages. Never logs content.
- The consent copy (`client-ai-v2`) discloses: stored securely, private from the
  coach, TGP staff access only for support, safety and debugging, 180-day
  auto-delete, delete any time.
