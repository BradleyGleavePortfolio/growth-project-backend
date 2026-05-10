# Coach Experience — Phases 6C + 6D

This doc covers the two coach-experience surfaces shipped in Phase 6:
async voice notes on the messaging thread (6C) and the 6-step coach
onboarding wizard (6D). Phases 6A (effectiveness score) and 6B
(red-flag alerts) are documented in
[`coach-signals.md`](./coach-signals.md).

## 6C — Async Voice Notes

### What

Coach <-> client one-on-one messages can now carry an audio
attachment. Either party can record (UI permitting); the message
record adds four columns:

| Column | Type | Meaning |
|---|---|---|
| `voice_url` | `String?` | Public (or signed) URL of the audio object in Supabase Storage. |
| `voice_duration_sec` | `Int?` | Duration in whole seconds, validated server-side. |
| `voice_size_bytes` | `Int?` | Object size, validated server-side. |
| `voice_content_type` | `String?` | MIME type (allowlist enforced). |

`body` is now nullable: a message must have at least one of `body` or
`voice_url`. The `MessageEmpty` cross-field check fires on the service
layer, not the DTO.

### Validation rules

Server-side, never trusted from the client:

- `content_type` ∈ `{ audio/mp4, audio/m4a, audio/aac, audio/webm, audio/ogg }`
- `duration_sec` ≤ `VOICE_NOTE_MAX_DURATION_SEC` (default 300, clamp `[10, 600]`)
- `size_bytes` ≤ `VOICE_NOTE_MAX_SIZE_MB` × 1 MiB (default 5, clamp `[1, 25]`)

Both the signed-upload issuance and the message-send path re-run the
same validator, so a stale upload URL with new env limits is rejected
on send.

### Signed-upload flow

```
client                                    server                       supabase
  │   POST /messages/voice-upload            │                              │
  │   { duration_sec, size_bytes,            │                              │
  │     content_type }                       │                              │
  │ ───────────────────────────────────────► │                              │
  │                                          │  validate against limits     │
  │                                          │  storage.from(bucket)        │
  │                                          │   .createSignedUploadUrl()   │
  │                                          │ ───────────────────────────► │
  │                                          │ ◄─────────────────────────── │
  │                                          │  { signedUrl }               │
  │   { upload_url, public_url, expires_at } │                              │
  │ ◄─────────────────────────────────────── │                              │
  │                                          │                              │
  │   PUT <upload_url> (audio bytes)         │                              │
  │ ──────────────────────────────────────────────────────────────────────► │
  │                                          │                              │
  │   POST /messages                         │                              │
  │   { voice: { url: <public_url>, … } }    │                              │
  │ ───────────────────────────────────────► │                              │
  │                                          │  validate again              │
  │                                          │  prisma.coachMessage.create  │
  │   201                                    │                              │
  │ ◄─────────────────────────────────────── │                              │
```

If the Supabase JS SDK does not expose `createSignedUploadUrl()`, the
upload endpoint returns `501 VOICE_STORAGE_UNAVAILABLE` so the
operator can upgrade the SDK to >= 2.30 without disrupting the rest of
messaging.

### PTM signal weighting

Voice messages count harder than text. From `MessagingService.sendAs*`:

| Direction | Signal | Value | Metadata |
|---|---|---|---|
| coach → client (voice) | `message_received` | `duration_sec * 10` | `{ voice: true, duration_sec }` |
| coach → client (voice) | `coach_note_received` | `1` | `{ voice: true }` |
| client → coach (voice) | `message_sent` | `duration_sec * 10` | `{ voice: true, duration_sec }` |

The `userId` on every PTM call is the **client** — the model only
scores clients. The text-path emits are owned by Phase 1A and are
independent of these voice-path emits; a body+voice message fires both.

### Endpoints

| Method | Path | Who | Notes |
|---|---|---|---|
| `POST` | `/coach/clients/:client_id/messages/voice-upload` | coach | 20 req/min throttle. Verifies tenancy first. |
| `POST` | `/messages/voice-upload` | client | 20 req/min throttle. |
| `POST` | `/coach/clients/:client_id/messages` | coach | Body now accepts `{ body?, voice? }`. |
| `POST` | `/messages` | client | Same DTO. |

## 6D — Coach Onboarding Wizard

### What

A 6-step server-tracked onboarding flow that runs once per coach the
first time they log in after promotion.

### Steps

1. **profile** — `business_name`, `bio`, `timezone`
2. **invite_code** — surface the default invite code; copy reminder
3. **first_invite** — log that the coach has shared their code
4. **message_template** — coach drafts their first message template
5. **guidelines** — coach sets their default client guidelines
6. **confirm** — terminal step; freezes the row

### Auto-start

`AdminService.promoteUser` calls
`CoachOnboardingService.startWizard(coachId)` whenever a user
transitions to `role='coach'`. Wrapped in try/catch — wizard creation
failures are logged and swallowed so a transient DB hiccup never
blocks a promotion. Disable globally with
`COACH_ONBOARDING_AUTO_START=false`.

### Step-ordering doctrine

`advanceStep(n)` accepts only:

- `n === current_step` (resume on the current step, e.g. the coach
  reopens the wizard mid-flow), OR
- `n === current_step + 1` (forward by one)

Skips and rewinds return `400 STEP_OUT_OF_ORDER`. After
`completed_at` is set the row freezes — `advanceStep` returns
`409 ONBOARDING_COMPLETED` and `completeWizard` is idempotent (no-op
that returns the frozen row).

`completeWizard` requires `current_step === 6`. Calling earlier
returns `400 STEP_OUT_OF_ORDER` so we cannot accidentally complete a
half-finished wizard.

### Endpoints

| Method | Path | Who | Notes |
|---|---|---|---|
| `GET`  | `/coach/onboarding`             | coach | Caller's own progress. 404 if not started. |
| `POST` | `/coach/onboarding/start`       | coach | Idempotent. |
| `POST` | `/coach/onboarding/steps/:n`    | coach | Body is the per-step JSON blob. Persisted to `step_data[n]`. |
| `POST` | `/coach/onboarding/complete`    | coach | Requires step 6 already reached. Idempotent. |
| `GET`  | `/admin/coach-onboarding`       | OWNER | List all coaches' progress. `?completed=true|false&limit=`. |

The OWNER endpoint is the operator's view into who is stalled and who
is finished. The default sort is `started_at DESC` so newest coaches
land at the top.

## Env flags (cross-reference)

| Variable | Default | Tier | Notes |
|---|---|---|---|
| `VOICE_NOTE_MAX_DURATION_SEC` | `300` | optional | clamp `[10, 600]` |
| `VOICE_NOTE_MAX_SIZE_MB` | `5` | optional | clamp `[1, 25]` |
| `SUPABASE_VOICE_BUCKET` | `voice-notes` | optional | bucket name |
| `COACH_ONBOARDING_AUTO_START` | `true` | optional | suppress with `false` |

All four are registered in `src/common/env-validation.ts` so the
boot-time banner mentions them explicitly when they are missing.

## Tests

| File | Covers |
|---|---|
| `test/messaging-voice.spec.ts` | Voice persistence, content-type / size / duration validation, body-required-when-no-voice, voice-path PTM emits |
| `test/coach-onboarding.service.spec.ts` | Idempotent start, sequential step ordering, `completeWizard` freeze, `autoStartEnabled` env parse |
| `test/coach-onboarding.controller.spec.ts` | Caller-scoped progress (no path leak), step-data forwarding, surface of 400 / 409 from the service |
