# AI processing consent ledger (R2a)

Box 2 of the onboarding consent screen (D2 consent contract, operator ruling
2026-10-01) is optional: "Roman and my coach's AI tools may use my information,
processed by Anthropic". This module records that choice. It does not enforce
it: enforcement on every AI path is R2b (#601), which calls the read interface
below. Box 1 (training waiver + collection and use for coaching) is recorded by
the onboarding intake (#607), not here.

Code: `src/ai-consent/`. Migration: `prisma/migrations/20270203000000_ai_processing_consent_ledger/`.

## Switch

`FEATURE_AI_CONSENT_LEDGER_ENABLED` (default OFF; `prod-switches.yml`, tier
`feature`, `prod_default: OFF`, never auto-flipped). ON only for the exact value
`true` (case-insensitive).

While OFF:
- every `/api/me/ai-consent` route returns `503 {code: "AI_CONSENT_UNAVAILABLE"}`
  (before body validation);
- `hasClientAiConsent()` is `false` and `clientsWithAiConsent()` is empty for
  every user, so an AI path that requires consent stays closed. A user cannot
  withdraw while the switch is off, so no stored grant is honoured either.

Why OFF by default: the box-2 copy is DRAFT v2 pending owner sign-off, and the
contract allows an in-place text edit before launch only because the switch has
never been on. Turn it on together with the copy sign-off.

## API

Base path `/api` (global prefix). Auth: Supabase JWT (`JwtAuthGuard`), roles
`student`, `coach`, `owner`. The subject is always the authenticated caller;
no request field can name another user (unknown body fields are a 400). No
Roman or entitlement guard: reading and withdrawing never depend on Roman chat
being on. Every response carries `Cache-Control: no-store`.

### `GET /api/me/ai-consent` -> 200

```json
{
  "purpose": "client_ai_processing",
  "processor": "anthropic",
  "granted": false,
  "state": "not_granted",
  "version": null,
  "granted_at": null,
  "withdrawn_at": null,
  "current_version": "client-ai-v3",
  "needs_reconsent": false,
  "copy": {
    "version": "client-ai-v3",
    "processor": "anthropic",
    "paragraph": { "text": "Roman, the assistant in this app, ...", "sha256": "77c0e706..." },
    "box_label": { "text": "Optional: I allow Roman and my coach's AI tools ...", "sha256": "77da153d..." },
    "sha256": "d8738c90..."
  }
}
```

- `state`: `granted` (latest decision is a grant of the current copy),
  `withdrawn` (latest decision is a withdraw), `needs_reconsent` (latest
  decision is a grant of an older version or different text), `not_granted`
  (no decision on record).
- `granted` is true only for `state = "granted"`.
- `version`: copy version of the latest decision (null if none).
- `granted_at` / `withdrawn_at`: ISO-8601 time of the latest decision; only the
  one matching its action is set.
- `copy.sha256` = sha256 (hex, UTF-8) of `paragraph.text + "\n\n" + box_label.text`.

Pinned digests for `client-ai-v3`:

| Part | sha256 |
|---|---|
| paragraph | `77c0e7062adb29cf59a532b130e50d5b373789c3564972cc309d8361bf57227b` |
| box_label | `77da153df7f06a045e1abbbb83b771f8a33941d47268e276becc6b4ffe5e5eba` |
| combined (`copy.sha256`) | `d8738c900ed2bfbb12b7ca6423132a532fc47e2cd0fe52854cc38e34c427840f` |

### `POST /api/me/ai-consent/roman` -> 200 (same body as GET)

Request (JSON; only these fields):

| Field | Required | Rule |
|---|---|---|
| `version` | yes | string, must equal `current_version` (`client-ai-v3`) |
| `copy_sha256` | no | 64 hex chars; when sent must equal `copy.sha256` (case-insensitive) |
| `platform` | no | `ios`, `android` or `web` |
| `app_version` | no | max 32 chars, `[0-9A-Za-z.+-]` |
| `locale` | no | max 16 chars, BCP-47 shape (e.g. `en-US`) |

Idempotent: if the latest decision is already a grant of the current copy,
nothing is written and the current status (with the original `granted_at`)
returns. Two concurrent identical grants record one row.

### `DELETE /api/me/ai-consent/roman` -> 200 (same body as GET)

No body. Idempotent: with no decision on record, or when the latest decision
is already a withdraw, nothing is written. Withdrawing a stale-copy grant is
allowed and recorded.

### Errors

The global exception filter returns
`{statusCode, code, message, error, timestamp, path, request_id}`; only `code`
is machine-readable.

| Status | `code` | When | Client action |
|---|---|---|---|
| 400 | (none) | body fails validation or carries an unknown field | fix the request; do not retry as-is |
| 401 | (none) | no or invalid JWT | re-authenticate |
| 409 | `CONSENT_VERSION_MISMATCH` | `version` is not current, or `copy_sha256` differs | `GET /api/me/ai-consent`, show the new copy, ask again |
| 409 | `AI_CONSENT_CONFLICT` | concurrent writers kept colliding (bounded retries exhausted) | retry once |
| 503 | `AI_CONSENT_UNAVAILABLE` | switch off, or a database write failed | treat as "unavailable right now"; never block onboarding |

A 404 means the backend predates this PR; treat it like 503.

## Data model and database rules

`AiProcessingConsentEvent`: one append-only row per decision.

| Column | Notes |
|---|---|
| `id` | uuid |
| `user_id` | FK `User.id`, ON DELETE CASCADE (account erasure removes the history) |
| `processor` / `purpose` | `anthropic` / `client_ai_processing` |
| `seq` | 1-based per (user, processor, purpose); unique with them |
| `action` | `grant` or `withdraw` (CHECK) |
| `consent_version` | the copy version the decision refers to (a withdraw carries the withdrawn grant's version) |
| `copy_sha256` | server `copy.sha256` the decision refers to (CHECK: 64 lowercase hex) |
| `platform`, `app_version`, `locale` | optional client metadata (grant only) |
| `created_at` | decision time |

- Current state = the row with the highest `seq`. Effective consent = that row
  is a `grant` whose `consent_version` AND `copy_sha256` equal the current
  copy. A text edit (even under the same version) therefore invalidates
  earlier grants instead of re-pointing them at new text.
- Writers: read latest, insert `seq + 1`; a unique-index collision (P2002)
  means another writer won, so the service re-reads and re-decides (3 attempts).
- Append-only: a `BEFORE UPDATE` trigger rejects every UPDATE for every role,
  including `service_role` and the table owner.
- RLS enabled and forced. Policies: `service_role` all; SELECT for every other
  principal only where `user_id = app.current_user_id()`; anon RESTRICTIVE
  deny plus REVOKE. No owner, coach or sub-coach branch, and no INSERT, UPDATE
  or DELETE policy for non-service principals.
- No AuditLog row is written: the ledger is itself the immutable record. No IP
  or user agent is stored. Logs carry ids, version, seq and Prisma error codes
  only, never exception messages or copy text.

## Read interface for R2b and AI paths

```ts
import { Inject } from '@nestjs/common';
import { CLIENT_AI_CONSENT_READER, type ClientAiConsentReader } from '../ai-consent/ai-consent.reader';

constructor(@Inject(CLIENT_AI_CONSENT_READER) private readonly aiConsent: ClientAiConsentReader) {}

if (!(await this.aiConsent.hasClientAiConsent(clientId))) { /* do not send */ }
const allowed = await this.aiConsent.clientsWithAiConsent(authorIds); // <= 200 ids
```

Import `AiConsentModule`. Pass the DATA SUBJECT's id (the client), never a
coach's id for a coach-initiated call. Call before every provider request,
including retries and repair passes; nothing is cached. `false` covers: no
decision, withdrawn, stale copy, switch off, read failure (fail closed). The
batch form throws `RangeError` above 200 ids (chunk the input) and returns an
empty set on a read failure.

## Tests

- `test/ai-consent/ai-consent.service.spec.ts` — copy and digests, 409s,
  idempotency, concurrency, append-only history, stale copy, flag, reader,
  log hygiene.
- `test/ai-consent/ai-consent.controller.spec.ts` — the HTTP contract above
  through the production ValidationPipe options, HttpExceptionFilter and
  CacheControlInterceptor.
- `test/ai-consent/ai-consent-wiring.spec.ts` — migration shape, CI wiring,
  flag registration, module mount, no AI call site touched.
- `test/rls/ai-processing-consent-ledger-rls.spec.ts` — live Postgres, run by
  the `rls-live-tests` CI job: RLS, append-only trigger, CHECK / unique / FK,
  cascade, down/up.

## Rollout and rollback

1. Merge and deploy with the switch OFF (routes answer 503; no rows).
2. Owner signs off the box-2 copy. If the text changes, update
   `ai-consent.constants.ts` (text and, once any real grant exists, the
   version) and the pinned digests in the tests.
3. Set `FEATURE_AI_CONSENT_LEDGER_ENABLED=true`.

Rollback: switch OFF (all reads become "not granted"; no data change).
`down.sql` drops the table and the trigger function and deletes every recorded
decision; it does not restore them. Run it only before real decisions exist or
after exporting the rows.

## Known limits

- `DunningLockoutGuard` (global `APP_GUARD`, a no-op while `FEATURE_DUNNING_V2`
  is off) does not allow `/me/ai-consent` while a client is in a billing
  lockout, so a locked-out client cannot read or withdraw through the API until
  the lockout clears, while `/roman/*` stays allowed. Clinic clients are on a
  free package. Changing the lockout allowlist is outside this PR; flagged for
  an operator decision (recommended: allow `me/ai-consent` while locked).
