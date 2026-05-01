# Voice Notes Spec

Status: DRAFT spec, docs-only. Conditional on OWNER_DECISION 1 = B
(or A; not in scope under C).

Voice notes are asynchronous audio messages. They are doctrine-
compatible because they are (a) one-to-one or one-to-many in the same
shape as text messages, (b) transcript-default-visible (not audio-
only), (c) moderable through the same pipeline as text, and (d)
participation is consent-gated (recipient may decline to be sent voice
notes).

This spec covers: recording (web + mobile), upload, transcription,
accessibility, retention, moderation hooks, storage cost rough budget,
and >= 5 failure modes.

---

## 1. Why voice notes ship

The doctrine is about *signal without spectacle*. A voice note delivers
signal that text cannot:

- Coach tone (warmth, urgency, inflection).
- Sub-coach corrections that benefit from demonstration of cadence
  (form-check coaching).
- Client check-ins that are easier to record while doing the activity
  than to type.

The cost — moderation surface, storage, transcription accuracy — is
real but tractable.

Voice notes are **not** a substitute for live coach 1:1 calls. They
are asynchronous, async-listened, and typically <2 minutes in
practice.

---

## 2. Recording

### 2.1 Web

`MediaRecorder` API. Codec: `audio/webm;codecs=opus` (Chromium /
Firefox) with `audio/mp4;codecs=mp4a.40.2` (Safari fallback). Bitrate
~32kbps voice-tuned.

UI surface:

- Press-and-hold mic button (mobile-style on touch devices).
- Click-to-start, click-to-stop on desktop.
- Live waveform (optional; doctrine-compatible — no public count).
- Live duration counter.
- Cancel slide-off-button.
- Re-record button (replaces in-progress draft).

The page captures `MediaStream` from `navigator.mediaDevices
.getUserMedia({ audio: true })`. Permission is requested once per
domain; subsequent recordings reuse the granted permission.

### 2.2 Mobile

Native bridge in the React Native shell (`growth-project-mobile`).
Uses platform native APIs — `react-native-audio-recorder-player` or
equivalent — with the same codec preference. The mobile spec is the
binding contract; this file is consumed by the mobile spec.

### 2.3 Local capture limits

| Limit | Value |
| --- | --- |
| Max duration | 5 minutes (OWNER_DECISION 3; recommended 5min) |
| Max file size | 10 MB (post-encoding) |
| Min duration | 1 second (avoids accidental micro-taps) |
| Sample rate | 24kHz (voice-band) |

Client enforces both limits. Server reasserts; over-limit uploads are
rejected with `VOICE_NOTE_TOO_LONG` (HTTP 400).

### 2.4 Consent

Recording consent (microphone permission) is captured at the OS layer
on first use. Sending consent (recipient is willing to receive voice
notes from this user) is captured per-Membership: the recipient may
toggle "voice notes from this channel: on/off" in their per-channel
settings.

If the recipient has disabled voice notes:

- Sender's UI hides the mic button in that channel's compose surface.
- If sender bypasses (e.g., racey state), `POST /voice-notes` returns
  `VOICE_NOTES_DISABLED_BY_RECIPIENT` (HTTP 403).

Default: voice notes enabled in cohort + room channels; disabled in
DMs (require explicit opt-in). Rationale: cohort / room consent is
implicit in joining; DM consent is explicit because it is more
intimate.

---

## 3. Upload pipeline

```
[Client]                     [Backend]                     [Storage]
   |                            |                              |
   |--POST /voice-notes/init -->|                              |
   |  {duration_ms, mime}       |                              |
   |                            |--gen signed PUT URL --------->|
   |<-- {voice_note_id, put_url}|                              |
   |                            |                              |
   |--PUT (audio bytes) -------------------------------------->|
   |                                                          |
   |--POST /voice-notes/finalise --------------------------->  |
   |  {voice_note_id}                                         |
   |                            |--HEAD audio --------------->|
   |                            |<-- size, content-type ------|
   |                            |--enqueue transcribe job---  |
   |<-- {voice_note_id, status: 'ready_for_transcribe'}       |
   |                            |                              |
   |--POST /messages -----------|                              |
   |  {voice_note_id, ...}      |                              |
   |                            |--Message row created -------|
   |                            |--ChannelEvent emitted ------|
   |<-- {message_id} ---------- |                              |
```

The two-phase upload (init → PUT → finalise) avoids buffering the
audio through the API server. The signed URL is short-lived (5min)
and scoped to the `voice_note_id`.

### 3.1 Storage backend

Cloudflare R2 (existing platform choice for media; see
`docs/stripe-setup.md` for analogy with attachments). Bucket:
`tgp-voice-notes-prod`. Key format:
`<org_id>/<voice_note_id>.<ext>`. Server-side encryption at rest.

CDN delivery: signed URLs from R2 directly (Cloudflare egress is
free; cost is dominated by storage and operations).

### 3.2 Transcription

Provider: `sonar-pro` (Perplexity), per the platform AI rule. Async
job:

1. `transcribe.enqueue(voice_note_id)`.
2. Worker fetches audio bytes.
3. Worker calls sonar-pro with audio + prompt
   ("Transcribe verbatim. Preserve speech cadence with punctuation.").
4. Worker writes `VoiceNote.transcript`, sets
   `transcript_status='ready'`.
5. Worker emits `ChannelEvent(community.voice_note.transcribed)`.

Cost cap: per the platform AI rule, transcription budget is part of
the org's monthly AI cap. Per-voice-note cost is small (~$0.01 / min);
even at 100 voice notes/coach/day at 10k coaches, monthly transcription
is bounded.

### 3.3 Transcript redaction

If a voice-note transcript triggers an auto-flag rule (banned content,
slur detection, etc), the moderation pipeline marks
`transcript_status='redacted'` and the audio purge is brought forward
to immediate (not the standard 90-day timer). UI renders "[voice note
removed]" tombstone.

---

## 4. Accessibility

Voice notes are accessible by default. The transcript is shown
**inline** in the message UI; the audio player is collapsible
secondary. There is no audio-only delivery path.

Concretely:

```
[message bubble]
@Coach Alex — voice note (2:14)
> "Big push this week. Form on the squat depth still needs to..."
[play 02:14]
```

The transcript is the primary content. The audio player is offered
for users who want tone. This:

- Satisfies WCAG 2.1 SC 1.2.1 (audio alternative).
- Aligns with the doctrine — voice is not a parasocial intimacy
  surface; it is signal.
- Lets text-search index voice notes (transcript participates in
  `body_tsv`).

If transcript is `pending`, the UI renders "transcribing..." and
disables the play button. If transcript is `failed`, the UI renders
the audio player only with a "transcript unavailable" banner — the
**only** state where audio-without-transcript is shown.

If transcript is `redacted`, the UI renders the tombstone.

---

## 5. Retention

Audio is retained 90 days by default (OWNER_DECISION 2). Transcript is
retained per the standard message retention window (lives as long as
the parent `Message`).

Why split? Transcript is text and cheap; audio is bytes and expensive.
For most use cases, the user re-reads the transcript days or weeks
later, not the audio. The 90-day window is a compromise between user
expectations (audio still available a few months later) and storage
cost.

Cron job: `voice_note_audio_purge`. Runs nightly. Purges audio files
where `audio_purge_at < NOW()`. Sets `VoiceNote.audio_storage_key` to
NULL. UI renders "[audio expired]" if a user attempts to play a purged
voice note; the transcript remains visible.

If the owner extends retention beyond 90 days, a cold-storage tier
should be introduced (R2 lifecycle policy: hot 30d → infrequent 60d
→ cold 1y). Cost analysis for cold tier is out of scope for v1.

---

## 6. Storage cost rough budget

Inputs (sizing for the Wave 5 finance budget):

- 32 kbps Opus → 240 KB / minute.
- Average voice note: 90 seconds → 360 KB.
- Per coach: 5 voice notes/day average (mix of coach + clients).
- 10k coach scale: 50k notes/day → 18 MB/day per coach × 10k = 180
  GB/day across all orgs.
- 90-day retention: ~16.2 TB resident at steady-state.

R2 storage cost (current pricing reference, conservative):

- Storage: 16.2 TB × $0.015/GB-month = ~$248/month at full scale.
- Class A operations (PUT): 50k/day × 30 = 1.5M/month × $4.50/M =
  ~$7/month.
- Class B operations (GET): assume 3x reads per upload = 4.5M/month
  × $0.36/M = ~$2/month.
- Egress: free (Cloudflare egress is free to internet via R2).

Rough total at full scale: ~$260/month. Rounded to **<$0.05 per coach
per month** at 10k coach scale. This appears as a line item in the
per-org bill computed in Wave 5; the value is read from a derived
per-org metric (not stored on `Message` rows).

At 100 coach scale (early): ~$3/month. Negligible.
At 1k coach scale: ~$26/month. Still negligible.

Transcription cost (sonar-pro, AI-rule budget):

- Per minute of audio: ~$0.01 (provider list price; subject to
  contract).
- 50k notes/day × 1.5 min avg = 75,000 min/day × $0.01 = ~$750/day at
  10k coach scale = ~$22.5k/month.
- This is the dominant cost and is per the platform AI rule —
  capped per org per month in the AI policy. Coaches who exceed the
  cap have voice-note transcription throttled (audio still stored;
  transcript queued for next month's allocation). Default cap: 1000
  voice-note minutes / org / month, with a per-coach AI add-on
  available.

---

## 7. Moderation hook

Voice notes participate in the standard moderation pipeline (see
`moderation-and-safety.md`). Specifically:

1. On transcript `ready`, the auto-flag rules run on the transcript
   text exactly as if it were a text message body.
2. If flagged, the parent `Message` is marked `redacted`,
   `transcript_status='redacted'`, audio purge brought forward to
   immediate, AuditLog written.
3. Manual review queue surfaces the transcript (and a coach-only
   playback button for context).
4. Resolution is via the same `moderation/decisions` API as text
   messages.

Edge case: a transcript that is benign while the audio is malicious
(e.g., the audio contains background sounds that violate policy but
the speech is innocuous). Mitigation: a future audio-content classifier
is out of scope for v1. The transcript-based moderation is the v1
contract; audio-content moderation may be added later behind a
separate flag.

Edge case: a transcript that is malicious while the audio is benign
(transcription error producing a slur from innocent speech). Mitigation:
the manual review queue lets a human listen to the audio and override.
False-positive rate is bounded by the auto-flag rule strictness; rules
are tunable per org.

---

## 8. Privacy

- The audio bytes are stored in R2 with server-side encryption.
- The signed URL is short-lived (5min) and scoped per voice note.
- Audio is never sent to PostHog. No PII to PostHog. The transcript
  is not sent to PostHog either; only metadata (voice-note ID, length,
  transcribed_at).
- Transcription via sonar-pro uses the platform's existing AI
  consent posture: the user (sender) has agreed at signup that AI
  may process content they create. If a coach toggles
  "no AI processing of my org's content" (Wave 2 AI rule), voice-note
  transcription is disabled for that org and the audio-only fallback
  applies (with the access-controls in section 4).

GDPR delete cascade:

- User hard-deletes account → all `VoiceNote` rows authored by the
  user are hard-deleted, audio purged immediately (not on the standard
  90-day timer), parent messages tombstoned per text message rules.
- Org hard-deletes (rare, full org wipe) → all VoiceNote rows in the
  org's channels purged.

GDPR export:

- The export bundle (`POST /users/me/data-export`) includes
  transcript text + a manifest of the user's audio files; audio bytes
  themselves are exported via signed URLs valid for 24 hours, listed
  in the manifest.

---

## 9. State-transition table

| From | Event | To | Side effects |
| --- | --- | --- | --- |
| (start) | `POST /voice-notes/init` | `init` | VoiceNote row created (no audio yet); signed PUT URL returned |
| `init` | (PUT to signed URL succeeds) | `uploaded` | R2 object exists; size + mime captured |
| `uploaded` | `POST /voice-notes/finalise` | `ready_for_transcribe` | Transcribe job enqueued |
| `ready_for_transcribe` | Transcribe worker starts | `transcribing` | sonar-pro call in-flight |
| `transcribing` | Transcribe worker success | `ready` | Transcript stored; ChannelEvent emitted; auto-flag run |
| `transcribing` | Transcribe worker failure (transient) | `transcribe_retry_pending` | Retry scheduled (exp backoff) |
| `transcribe_retry_pending` | Retry succeeds | `ready` | (as above) |
| `transcribe_retry_pending` | 3rd retry fails | `failed` | Audio still playable; UI shows "transcript unavailable" |
| `ready`, `failed` | Auto-flag triggers | `redacted` | Body cleared; audio purged immediately; AuditLog |
| `ready`, `failed` | (90 days pass) | `audio_purged` | Audio removed from R2; transcript remains |
| any | User hard-deletes account | `purged` | VoiceNote row hard-deleted; audio + transcript removed |

---

## 10. API surface

```
POST   /api/community/voice-notes/init        | author        | rate-voice    | reserve voice_note_id + signed URL
PUT    <signed-url>                            | (R2 direct)   | (R2)          | upload audio bytes
POST   /api/community/voice-notes/finalise    | author        | rate-voice    | confirm upload, enqueue transcribe
GET    /api/community/voice-notes/:id          | reader        | rate-read     | fetch transcript + signed audio URL
DELETE /api/community/voice-notes/:id          | author or COACH+ | rate-write | delete (cascade redacts host message)
POST   /api/community/voice-notes/:id/retry-transcribe | COACH+ | rate-write   | manually re-enqueue transcription
```

### TypeScript shapes

```ts
type VoiceNoteInitRequest = {
  duration_ms: number;     // estimated; server reasserts on finalise
  mime: 'audio/webm' | 'audio/mp4';
};
type VoiceNoteInitResponse = {
  voice_note_id: string;
  upload_url: string;      // signed PUT URL, 5min TTL
  upload_url_expires_at: string;
};

type VoiceNoteFinaliseRequest = {
  voice_note_id: string;
};
type VoiceNoteFinaliseResponse = {
  voice_note_id: string;
  status: 'ready_for_transcribe';
  duration_ms: number;     // server-measured
};

type VoiceNoteFetchResponse = {
  voice_note_id: string;
  transcript_status: 'pending' | 'ready' | 'failed' | 'redacted';
  transcript: string | null;
  audio_url: string | null;            // signed; null if purged
  audio_url_expires_at: string | null;
  duration_ms: number;
  audio_purge_at: string;              // when audio will be purged
};
```

### Error codes specific to voice notes

| Code | HTTP | Meaning |
| --- | --- | --- |
| `VOICE_NOTE_TOO_LONG` | 400 | Duration > 5min |
| `VOICE_NOTE_TOO_SHORT` | 400 | Duration < 1s |
| `VOICE_NOTE_INVALID_MIME` | 400 | Mime not in allow-list |
| `VOICE_NOTES_DISABLED_BY_RECIPIENT` | 403 | Recipient has disabled voice notes in this channel |
| `VOICE_NOTE_UPLOAD_NOT_FOUND` | 404 | Finalise called before PUT (or PUT failed) |
| `VOICE_NOTE_TRANSCRIPT_PENDING` | 425 | Caller fetched too early |
| `VOICE_NOTE_AI_CAP_EXCEEDED` | 429 | Org has hit the monthly AI transcription cap |
| `VOICE_NOTE_AUDIO_EXPIRED` | 410 | Audio purged; only transcript available |

---

## 11. Failure modes

### F-1. Audio upload fails after `init`

Client got a signed URL but the PUT failed (network, browser crash).

- **Detection**: `POST /voice-notes/finalise` finds no R2 object;
  returns `VOICE_NOTE_UPLOAD_NOT_FOUND` (404).
- **Recovery**: client re-runs the init → PUT → finalise flow with
  a new `voice_note_id`. The orphan VoiceNote row is cleaned up by a
  nightly garbage-collect job (rows in `init` state older than 24h).

### F-2. Transcription provider rate-limited

sonar-pro returns 429 during a traffic spike.

- **Detection**: transcribe worker catches 429.
- **Recovery**: exponential backoff (10s → 30s → 90s). After 3
  failures, mark `transcript_status='failed'` and emit a
  `transcribe_failed` ChannelEvent. Coach can manually retry.

### F-3. Audio bytes corrupted

R2 PUT succeeded but the bytes do not decode.

- **Detection**: transcribe worker fetches audio, attempts to decode,
  fails. Or sonar-pro returns "could not parse audio".
- **Recovery**: mark `transcript_status='failed'`; UI shows
  "transcript unavailable" + audio still available (the UI player will
  also fail to play, prompting the user to re-record).

### F-4. Transcript timeout

sonar-pro takes longer than the 60s p95 target.

- **Detection**: worker timeout at 120s.
- **Recovery**: kill the in-flight call; mark
  `transcript_status='transcribe_retry_pending'`; retry per F-2 logic.

### F-5. Audio purge race

Cron purges audio while a user is mid-fetch.

- **Detection**: `GET /voice-notes/:id` returns
  `audio_url=null`; client falls back to transcript-only display.
- **Recovery**: no recovery needed; this is the documented behaviour.
  The UI states "audio expired (>90 days)".

### F-6. AI cap exceeded mid-month

An org hits its monthly transcription cap on day 20.

- **Detection**: transcribe worker fetches budget; finds zero
  remaining for the org for this month.
- **Recovery**:
  - VoiceNote is left in state `transcribe_retry_pending` until the
    next month boundary.
  - Coach sees a banner in the admin console: "Voice-note
    transcription paused this month — cap reached. Add an AI add-on
    to enable continuous transcription."
  - Audio is still playable. Transcript is unavailable; auto-flag
    cannot run on the transcript, so messages are flagged as
    "moderation-pending" until transcript exists. Moderator can
    listen and decide manually if needed.

### F-7. Recipient disables voice notes mid-thread

A recipient toggles "voice notes off" in a channel where the sender
already drafted a voice note client-side.

- **Detection**: `POST /messages` with `voice_note_id` returns
  `VOICE_NOTES_DISABLED_BY_RECIPIENT`.
- **Recovery**: sender's UI prompts to send a text transcript instead
  (the transcript exists; transcript-as-text is doctrine-compatible
  even if the recipient turned off voice).

### F-8. Coach revokes AI consent for the org

The coach toggles "no AI processing" in the org settings. Active
voice notes are mid-transcription.

- **Detection**: org-AI-consent is checked before each transcribe job
  and at job start.
- **Recovery**:
  - Pending transcription jobs are cancelled.
  - Already-completed transcripts are retained (the consent existed
    at the time of transcription).
  - New voice notes uploaded after the toggle: audio stored, but no
    transcript. Audio-only fallback (see section 4) applies.
  - Moderation pipeline cannot auto-flag without a transcript;
    moderator must listen to the audio. This is documented as a
    consequence of revoking AI consent.

---

## 12. Performance budgets

| Operation | p50 | p95 |
| --- | --- | --- |
| `POST /voice-notes/init` | < 50ms | < 150ms |
| Direct R2 PUT (90s audio) | < 2s | < 6s |
| `POST /voice-notes/finalise` | < 100ms | < 300ms |
| Transcription end-to-end (90s audio) | < 30s | < 60s |
| `GET /voice-notes/:id` (cached) | < 30ms | < 100ms |

---

## 13. Audit log entries

| Action | actor | target | metadata |
| --- | --- | --- | --- |
| `community.voice_note.uploaded` | author | voice_note.id | `{duration_ms, mime}` |
| `community.voice_note.transcribed` | system | voice_note.id | `{transcript_length, ms_to_transcribe}` |
| `community.voice_note.transcribe_failed` | system | voice_note.id | `{retry_count, last_error}` |
| `community.voice_note.redacted` | moderator | voice_note.id | `{moderation_flag_id, reason}` |
| `community.voice_note.audio_purged` | system | voice_note.id | `{purge_reason: 'retention'|'redaction'|'gdpr'}` |
| `community.voice_note.deleted` | author or coach | voice_note.id | `{}` |

---

## 14. Test plan

### Unit
- Duration limit enforcement (client + server).
- Mime allow-list.
- State-transition table compliance.
- Audio purge calculator (ensures exactly 90 days from created_at).

### Integration
- init → PUT → finalise → message flow with valid audio.
- Init → PUT failure → finalise returns 404.
- Transcribe success → ChannelEvent emitted + auto-flag run.
- Transcribe failure → retries → final failure → audio still playable.
- Audio purge cron run → audio_storage_key cleared.
- GDPR delete cascade.

### E2E
- Browser test: record + upload + see transcript inline + play audio.
- Mobile mirror test: deferred to mobile spec.
- Recipient with voice notes off: sender UI hides mic; if bypassed,
  server rejects.
- Coach revokes AI consent: subsequent voice notes fall to audio-only.

### Load
- 100 concurrent voice-note uploads; R2 PUT pipeline holds; transcribe
  workers scale (queue depth bounded).
- Transcript retrieval at 1k coaches, average 50 notes/day each, p95
  GET < 100ms.

---

## 15. Rollback plan

- Schema is additive (VoiceNote table). Rollback = disable the
  voice-note feature flag; existing rows persist; audio purge cron
  continues running.
- If transcription provider needs to change (e.g., sonar-pro
  unavailable), the worker is provider-agnostic; swap implementation
  behind the same `transcribe.enqueue` interface.

---

## 16. Senior-engineer onboarding checklist

- [ ] R2 bucket provisioned with SSE.
- [ ] Signed URL service shares secret with R2.
- [ ] Transcribe worker deployed with sonar-pro credentials.
- [ ] AI cap policy enforced per org per month.
- [ ] Audio purge cron deployed and verified on a synthetic 90-day
      test (with a 90-min override for staging).
- [ ] Voice-note moderation hook integrated with
      `moderation-and-safety.md` pipeline.
- [ ] Recipient consent toggle wired in the per-channel settings UI.
- [ ] Transcript-default-visible UI shipped (web + mobile).
- [ ] Performance budgets met at 1k-coach load.

---

## 17. Accessibility notes (extended)

The transcript-default-visible policy is the headline accessibility
feature, but several additional considerations apply.

### 17.1 Screen-reader behaviour

The voice-note bubble is announced as "Voice note from <author>,
<duration>, transcript follows." The transcript is read inline.

The audio player is a secondary control with `aria-label="Play
original audio"` and is not auto-focused.

### 17.2 Keyboard navigation

- `Space` on the focused voice-note bubble toggles audio playback.
- `Tab` moves to the next message bubble.
- `Shift+Tab` moves to the previous.
- `Enter` opens the thread (if the message has replies).

### 17.3 Reduced-motion

The recording UI uses a live waveform. Under `prefers-reduced-motion`,
the waveform is replaced with a static "recording" indicator and a
duration counter.

### 17.4 Language and transcript quality

sonar-pro's transcription quality varies by language and audio quality.
The UI does not promise transcription accuracy. If a user spots an
error in their own transcript, they can:

- Edit the transcript inline (treated as a message edit; within the
  15-minute edit window).
- Re-record the voice note.

After the 15-minute edit window, the transcript is locked.

### 17.5 Coach voice as a relationship surface

Coaches sometimes record voice notes that are intentionally informal
("hey, just thinking about your form on the squat last week..."). The
transcript-default-visible policy means that intent is preserved in
text. Some coaches may worry about the texture of the transcript not
matching the texture of the voice. The response: the voice itself is
still there. The transcript is a parallel surface, not a replacement.

### 17.6 Client low-bandwidth path

A client on a poor connection may not be able to stream audio. The
transcript loads first; the audio is streamed on play. If the audio
stream stalls, the player surfaces a "low connection" message and
the user can read the transcript instead. This is doctrine-compatible
because the transcript is signal; the audio is texture.

---

## 18. Open questions deferred to implementation

These are not OWNER_DECISIONs; they are engineering-level open
questions to surface during implementation.

- **Concurrent transcribe workers per org**: how many workers can run
  in parallel for a single org? Current default: 5. May be tuned.
- **Per-message vs per-org cap accounting**: is the AI cap charged at
  voice-note creation or at transcription completion? Current: at
  completion (so failed transcribes don't burn budget).
- **Transcript editability**: who can edit a transcript? Current:
  the original author, within the standard 15-minute message edit
  window. Coaches cannot edit other people's transcripts (would be a
  speech-attribution risk).
- **Voice-note in announcements**: voice-note announcements from coach
  to all clients are permitted under Option B. Should there be a
  longer max length for announcement voice notes (10 minutes
  recommended for coach broadcasts)? Deferred.
