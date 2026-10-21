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
  "current_version": "client-ai-v4",
  "needs_reconsent": false,
  "copy": {
    "version": "client-ai-v4",
    "processor": "anthropic",
    "paragraph": { "text": "Roman, the assistant in this app, ...", "sha256": "56d14fb9..." },
    "box_label": { "text": "Optional: I allow Roman and my coach's AI tools ...", "sha256": "77da153d..." },
    "sha256": "fbf82140..."
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

Pinned digests for `client-ai-v4` (current):

| Part | sha256 |
|---|---|
| paragraph | `56d14fb96b9f7b6abdd43242f5ce9eaee419bc0d9fb4302bc283ecc1529d430b` |
| box_label | `77da153df7f06a045e1abbbb83b771f8a33941d47268e276becc6b4ffe5e5eba` |
| combined (`copy.sha256`) | `fbf821401d4313c6a301a6cc08d3870bb117c293fbb970e321bf87f49abe34f4` |

v4 changed only the retention sentence of the paragraph: v3 said Roman
conversations are "kept for 180 days, and you can delete them at any time";
v4 says they "are kept until you delete them or delete your account" (owner
decision 2026-10-01 20:32, operator ruling OR-110-1; there is no time-based
purge, a client delete erases the conversation, and account deletion erases
all of them).

How older grants are treated (the exact-match rule, unchanged): a grant of
`client-ai-v3` (combined sha256 `d8738c900ed2bfbb12b7ca6423132a532fc47e2cd0fe52854cc38e34c427840f`)
or any older copy stays in the append-only history and is never rewritten,
but it is not consent: `GET` shows `state: "needs_reconsent"`,
`granted: false`, `hasClientAiConsent()` is false and every AI path refuses
with `ai_consent_required` until the client allows the v4 text. A `POST`
that names `client-ai-v3` is a 409 `CONSENT_VERSION_MISMATCH` carrying the v4
`current_version` and `copy_sha256`; nothing is written. A `DELETE` while the
latest decision is a v3 grant records the withdraw against `client-ai-v3`.

### client-ai-v5: the memory scope (Roman v1.1)

Owner decision D1 (2026-10-06 12:01, A-ROMAN11-124 section 6) added
`client-ai-v5`. Its paragraph replaces v4's "Only your own data is used, never
another client's, and never your coach's private notes" with Roman's notes and
summaries (kept when a chat is deleted, removed with the account) and learning
the coach's methods, including from the coach's private session notes, never
quoted. Box label unchanged.

| Part | sha256 |
|---|---|
| v5 paragraph | `768ae3451fd1fbd22c65fd7758b51604a9ee0696c6ae7fab694c8238a6584782` |
| v5 combined (`copy.sha256`) | `8c19fca94c2455094c47b1802bb6693aff47d24c7b6df3b256d0a0e8e90fe8ee` |

Accepted grants (`CLIENT_AI_CONSENT_ACCEPTED`; version AND its exact sha256):

| Live grant | `scope` | Covers |
|---|---|---|
| `client-ai-v4` | `base` | every day-1 AI path (Roman chat, coach AI drafts, brief, triage) |
| `client-ai-v5` | `memory` | `base` + Roman v1.1 notes, summaries, coach-method learning |
| `client-ai-v4-coach-free` | `base` | the client's own AI use only (`audience` 'client': Roman chat and other client-facing paths); never coach AI drafts, brief or triage (owner 62: v4 text with every coach sentence or clause removed) |
| `client-ai-v5-coach-free` | `memory` | as `client-ai-v4-coach-free` + Roman v1.1 notes and summaries; never coach-method learning (owner 62: v5 text with every coach sentence or clause removed) |
| `client-ai-v6` | `base` | as `client-ai-v4` (owner 57c: v4 text + the safety-reply exception sentence) |
| `client-ai-v7` | `memory` | as `client-ai-v5` (owner 57c: v5 text + the safety-reply exception sentence) |
| `client-ai-v8` | `base` | as `client-ai-v4` (CRISIS-APP-COPY: v6 text + the approved crisis sentence right after the exception; combined sha256 `af4cc4fa55aa72cab8e7c6cdcee881d6ba1f448df048088e47acd5e7d479e0ef`) |
| `client-ai-v9` | `memory` | as `client-ai-v5` (CRISIS-APP-COPY: v7 text + the approved crisis sentence right after the exception; combined sha256 `16074f18ce0e985e35ba7cfb3f12233cd993159585a35759c4580a730ed3c9dd`) |
| `client-ai-v10` | `memory` | as `client-ai-v5` (owner #162-6: v7 text + the approved WEAR-AI-03 Health-notes sentence right after the purpose sentence; combined sha256 `61ea52ec78fed32eae4df3ac74e696677cd78fcba0ab96266bbffae1f4e0be04`) |
| `client-ai-v11` | `memory` | as `client-ai-v5` (owner #162-6: v9 text + the same sentence; combined sha256 `fe3d8e294d1fc0d4868fb20969fdb9528c4f19a13a94a0339da87efc384b7b28`) |
| `client-ai-v12` | `base` | as `client-ai-v4` (owner #162-6, memory off: v6 text + the same sentence in the same place; combined sha256 `8f29d9a5185e3fbe01c1e4b3de445d1057b5cbe1c44e10568c81a805e8b9aac0`) |
| `client-ai-v13` | `base` | as `client-ai-v4` (owner #162-6, memory off: v8 text + the same sentence; combined sha256 `495b3c623df2b09c74c7163388a8e56abfc90469896537d7a785bd4fc4fd434d`) |

- Safety-reply exception (owner 57c, 2026-10-12): `GET /api/me/ai-consent?variant=safety_exception`
  (the app sends it from the CONSENT-2 build on) offers `client-ai-v6` as `copy` and
  `client-ai-v7` as `upgrade` / `memory_copy` when there is no live grant. A plain `GET`
  keeps offering v4 / v5, the text installed builds pin. A live grant reads the copies of
  its own generation (v4 / v5, or v6 / v7) whatever is asked, but a new agreement is offered
  in the asked copies: a live v4 holder asking `safety_exception` gets `client-ai-v7` as
  `upgrade` / `memory_copy` (CONSENTV7). `POST` and `DELETE` take the same `?variant=` for
  the status they return; without one they read the copies on file.
- Crisis sentence (CRISIS-APP-COPY, owner op 1, 2026-10-15): `GET /api/me/ai-consent?variant=crisis_alert`
  offers `client-ai-v8` as `copy` and `client-ai-v9` as `upgrade` / `memory_copy` when there is no
  live grant and `FEATURE_ROMAN_CRISIS_ALERT` is on; while it is off the same ask gets v6 / v7. A live
  v8 / v9 grant reads its own copies while the switch is on and the v6 / v7 copies (same scope, the grant
  still counts) while it is off, so no response carries the sentence while the switch is off. A plain
  `GET` and `?variant=safety_exception` never offer v8 / v9. v4 to v7 stay accepted with unchanged text,
  so no one is asked again; a live v6 / v7 grant keeps reading v6 / v7. As with `safety_exception`, a
  new agreement follows the ask: a live v4 / v6 holder asking `crisis_alert` gets `client-ai-v9` as
  `upgrade` / `memory_copy` while the switch is on (`client-ai-v7` while it is off). The P0 twins are
  `consult-consent-v9` / `v10` (paragraph 4 + box 2 = the v8 / v9 copy). `GET /api/me/feature-flags`
  carries `roman_crisis_alert` (the same switch) for the app's Trust Center and Roman chats lines.
- Health notes (owner #162-6, "EVERYTHING should be covered in the inital acceptance of roman"):
  `GET /api/me/ai-consent?variant=health_notes` reads as `crisis_alert`, but `upgrade` / `memory_copy`
  is `client-ai-v10` (`client-ai-v11` while `FEATURE_ROMAN_CRISIS_ALERT` is on), which name Roman's
  Health-page notes and the coach's AI note; `copy` (the memory-off agreement) is `client-ai-v12` /
  `v13`, the v6 / v8 text with the same sentence. A live v4 to v9 grant keeps reading its own copies
  and is never asked again; withdrawal is unchanged. P0 twins: memory on `consult-consent-v15` / `v16`,
  `consult-consent-v16-coach-free` / `v17-coach-free`; memory off `consult-consent-v17` / `v18`
  (coached only: a client with no coach gets no Health notes).
- Asked once, before a coach (owner W-CONSENT): `POST /api/me/ai-consent/roman` from a client with no
  coach is recorded exactly like a coached grant. Roman and every AI route stay `403 ROMAN_REQUIRES_COACH`
  until a coach is linked; then that grant applies with no new ask. `GET` and `DELETE` stay open.

- Coach-free copies (owner 62, 2026-10-12): `GET /api/me/ai-consent?variant=coach_free`
  (the app sends it for a client with no coach) offers `client-ai-v4-coach-free` as
  `copy` and `client-ai-v5-coach-free` as `upgrade` / `memory_copy`. For a client
  with a coach (`User.coach_id`), `GET` always offers the coached copies and reads
  a live coach-free grant as `needs_reconsent`, so the app asks for the coached
  text. Otherwise a live grant reads the copies of its own family, whatever is
  asked; without a live grant `GET` follows the ask, and a POST / DELETE response
  follows the latest decision on file. Coach-audience reads (`hasClientAiConsent` /
  `clientsWithAiConsent` / `memoryGrantTimes` with `audience` 'coach', the default)
  never count a coach-free grant, also after the client joins a coach; coach AI for
  that client needs a coached grant.

- v4 holders are never re-prompted and keep day-1 Roman unchanged. The 10-07
  app build pins v4: it POSTs v4 from the consultation and its Settings screen
  treats any other `current_version` as "update the app". So `GET` keeps
  offering the v4 copy (`current_version: "client-ai-v4"`, `copy` = v4) to
  everyone without a live v5 grant, and a v4 holder still reads
  `state: "granted"`, `granted: true`, `needs_reconsent: false`.
- A live v5 holder reads `current_version: "client-ai-v5"` and the v5 `copy`.
- New fields (additive; older apps ignore them): `scope` (`"base"`,
  `"memory"`, or `null` with no live grant), `upgrade` (for a v4 holder while
  `FEATURE_ROMAN_MEMORY` is "true": the v5 copy, same shape as `copy`, one
  optional tap; otherwise `null`) and `memory_on` (that flag). Servers before
  B-R11C-126 sent `upgrade` to every v4 holder and no `memory_on`, so an app
  shows the v5 offer only when `memory_on` is `true`.
- A withdrawal ends both scopes (it is recorded against the grant it ends).
- `hasClientAiConsent(id, scope = 'base')`, `clientsWithAiConsent(ids, scope =
  'base')` and `clientDataSubject(ids, audience, scope = 'base')`: a `memory`
  subject is refused by the egress gate (`ai_consent_required`, before any
  provider call) unless every listed client holds a live v5 grant.
- Onboarding P0 `consult-consent-v4` is the v3 screen with the v5 paragraph 4;
  v3 and v4 are both accepted by default.

### `POST /api/me/ai-consent/roman` -> 200 (same body as GET)

Request (JSON; only these fields):

| Field | Required | Rule |
|---|---|---|
| `version` | yes | string, `client-ai-v4`, `client-ai-v5`, `client-ai-v6`, `client-ai-v7`, `client-ai-v8`, `client-ai-v9`, `client-ai-v10`, `client-ai-v11`, `client-ai-v12`, `client-ai-v13`, `client-ai-v4-coach-free` or `client-ai-v5-coach-free` |
| `copy_sha256` | no | 64 hex chars; when sent must equal that version's combined sha256 (case-insensitive) |
| `platform` | no | `ios`, `android` or `web` |
| `app_version` | no | max 32 chars, `[0-9A-Za-z.+-]` |
| `locale` | no | max 16 chars, BCP-47 shape (e.g. `en-US`) |

Optional fields are OMITTED when not sent; `null` for any of them is a 400.

Idempotent: if the latest decision is already a live grant of the same version,
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
| 409 | `CONSENT_VERSION_MISMATCH` | `version` is not `client-ai-v4` or `client-ai-v5`, or `copy_sha256` differs from that version's | `GET /api/me/ai-consent`, show the new copy, ask again |
| 409 | `AI_CONSENT_CONFLICT` | concurrent writers kept colliding (bounded retries exhausted) | retry once |
| 503 | `AI_CONSENT_UNAVAILABLE` | switch off, or any ledger read or write failed | treat as "unavailable right now"; never block onboarding |

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
- `test/ai-consent/ai-consent-v5-scope.spec.ts` — v4/v5/withdraw scope
  matrix, the 10-07 build contract (POST v4, GET for a v4 holder), `upgrade`,
  egress refusal of a memory subject for a v4 holder, consult-consent v3 + v4.
- `test/ai-consent/ai-consent-dunning-lockout.e2e.spec.ts` — a billing-locked
  client can GET, POST and DELETE through the real lockout guard.
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

## Billing lockout

Exactly three operations are on the `DunningLockoutGuard` allow-list, matched
by method AND normalized path equality (`isPrivacyOperationWhileLocked`):
`GET /api/me/ai-consent`, `POST /api/me/ai-consent/roman`,
`DELETE /api/me/ai-consent/roman`. Any other method on those paths, any
descendant path (for example `/api/me/ai-consent/export`) and the rest of
`/me/*` stay locked. Reading, granting and withdrawing AI consent is a privacy
control and billing state never blocks it (operator ruling on #622). Proven by
`test/dunning-v2-lockout-privacy-exact.spec.ts` (real guard),
`test/ai-consent/ai-consent-dunning-lockout.e2e.spec.ts` (over HTTP, including
mounted lookalike routes) and the method-aware route-table spec
`test/dunning-v2-lockout-allowlist-route-table.spec.ts`.
