# Spec — Coach AI voice / tone setting

**Roadmap row:** #24.
**Status:** Pre-work — spec only; no runtime, no migration, no
module wiring.
**Handoff brief:** [`../architecture/handoff/24-coach-ai-voice.md`](../architecture/handoff/24-coach-ai-voice.md).
**Cross-references:** PR #117 (AI Program Builder RFC — same
upstream consumer), PR #119 (roadmap row #24), spec
[`weekly-recap.md`](./weekly-recap.md) (#23 — primary downstream
consumer).

---

## WHY

Every AI surface that emits text on behalf of the coach (weekly
recap #23, AI Program Builder PR #117, the in-app AI coach,
upcoming "draft a check-in DM" in PR #117 §22) currently uses a
single neutral voice. A coach whose business is built on a
casual, profane, locker-room voice cannot send a recap that
reads like a corporate HR memo, and vice versa. Without a voice /
tone setting, every AI surface ships with a known limitation that
gets re-litigated per feature.

This spec defines a **single source of truth** for the coach's
voice — read by every AI surface — so each downstream feature
gets it for free.

## WHEN

Trigger conditions:

1. The first AI text-generation surface that ships to non-OWNER
   users (currently planned: weekly recap #23) is at code-review
   stage, **and** that surface's review identified voice as the
   primary trust gap.
2. The AI Program Builder RFC (PR #117) §22 forward-compat note
   on Outcome Graph + Team Mode is closed; this voice setting is
   referenced there as a planned input.

This is the *upstream* feature; it ships before the recap (#23)
is enabled for non-design-partner coaches.

## WHERE

- New module: `src/coach-ai-voice/` —
  `coach-ai-voice.module.ts`, `coach-ai-voice.service.ts`,
  `coach-ai-voice.controller.ts`.
- New table: `CoachAIVoiceSetting` (one row per coach).
- New routes (paths under `/api/`):
  - `GET /coach/ai-voice`
  - `PUT /coach/ai-voice`
  - `GET /coach/ai-voice/preview` — runs a no-cost deterministic
    transform of a fixed sample sentence with the current voice
    profile, so the coach sees what the model will see.
- Reads: nothing.
- Read by:
  - `src/weekly-recap/` (#23).
  - `src/program-builder/` (PR #117) once it lands.
  - The in-app AI coach (in `src/ai/`), behind a flag.

## WHO

- **Sign-off:** founder for the field shape (especially the
  "examples" field — see "Risks"); backend lead for the table.
- **On the hook:** backend platform.
- **Downstream consumers:** every AI surface listed under
  WHERE → "Read by."

## WHAT

### Already exists

- `CoachProfile` (`prisma/schema.prisma:194`) — adjacent. The
  voice setting is a **separate** table, not a column on
  `CoachProfile`, because the editing cadence and audit posture
  differ.

### Net-new

- `CoachAIVoiceSetting` table.
- `src/coach-ai-voice/` module.
- One feature flag, `COACH_AI_VOICE_ENABLED`.
- A deterministic preview transformer (no LLM call).

### Non-goals

- Not multiple voice profiles per coach. v1 is one.
- Not per-client voice override. v2 may add it (see the team-mode
  forward-compat note).
- Not auto-derived from the coach's prior outbound messages —
  that is a much harder problem and requires consent flows. v1
  is coach-typed configuration.

## HOW

Smallest first PR (PR-1):

- Adds the `CoachAIVoiceSetting` model + migration.
- Adds the empty module shell.
- Adds the deterministic preview transformer with snapshot tests.

PR-2 wires the routes and returns 404 when the flag is off.
PR-3 has the recap (#23) read this setting.
PR-4 has the in-app AI coach read this setting (gated).
PR-5 has the AI Program Builder (PR #117) read this setting.

## Data model sketch

```prisma
model CoachAIVoiceSetting {
  id                  String   @id @default(uuid())
  coach_id            String   @unique
  coach               User     @relation("CoachAIVoiceCoach", fields: [coach_id], references: [id])
  tone                String   // "warm" | "direct" | "playful" | "clinical" | "custom"
  formality           Int      // 1..5 (1 = locker room, 5 = corporate)
  emoji_preference    String   // "none" | "sparingly" | "freely"
  profanity_allowed   Boolean  @default(false)
  banned_phrases      String[] // e.g. ["literally", "synergy"]
  required_phrases    String[] // e.g. coach catchphrase
  examples            String[] // 1..5 short sample messages by the coach, in their voice
  notes_to_model      String?  // free-text notes (stops short of being a prompt)
  created_at          DateTime @default(now())
  updated_at          DateTime @updatedAt

  @@index([coach_id])
}
```

`examples` is the load-bearing field — the AI surfaces inject 1–3
of these as few-shot examples at prompt time. The field cap is
five entries to bound prompt cost.

## API sketch

```
GET /api/coach/ai-voice
→ 200 { setting: CoachAIVoiceSetting | null }
  COACH only.

PUT /api/coach/ai-voice
body { tone, formality, emoji_preference, profanity_allowed,
       banned_phrases, required_phrases, examples, notes_to_model }
→ 200 { setting: CoachAIVoiceSetting }
  COACH only. Upserts. Validation:
    - tone is in the enum
    - formality 1..5
    - examples length ≤ 5; each ≤ 500 chars
    - notes_to_model length ≤ 1000 chars
    - banned_phrases / required_phrases length ≤ 20 each

GET /api/coach/ai-voice/preview
→ 200 { sample: string, beforeSample: string }
  Deterministic transform of a fixed sample sentence (e.g. "Great
  week — three workouts hit, hydration steady. Let's tighten up
  recovery this weekend.") rewritten under the current voice
  config. Pure-function; never calls a provider. Lets the coach
  see the impact of formality / emoji / phrases without burning
  AI budget.
```

Throttle: PUT `10 req/min`, GET `60 req/min`.

## Service contract for downstream readers

A small helper module exports:

```ts
// src/coach-ai-voice/voice.service.ts
export interface CoachVoiceProfile {
  tone: string;
  formality: number;
  emoji_preference: 'none' | 'sparingly' | 'freely';
  profanity_allowed: boolean;
  banned_phrases: string[];
  required_phrases: string[];
  fewShotExamples: string[]; // up to 3, sampled from examples
  notesToModel: string | null;
}

export class VoiceService {
  /** Returns null if the setting is unset; downstream should fall
   *  back to a neutral default and continue rendering. */
  getProfile(coachId: string): Promise<CoachVoiceProfile | null>;

  /** Pure-function: assembles the system-prompt block downstream
   *  features prepend to their own prompts. Stable string output
   *  for prompt caching. */
  renderSystemPromptBlock(profile: CoachVoiceProfile): string;
}
```

Every AI feature reads through this service so the cache key for
prompt caching is consistent.

## Rollout / feature flags

- **Env var:** `COACH_AI_VOICE_ENABLED=true|false` (default `false`).
- **Kill-switch behavior:** when off, downstream features fall
  back to the neutral default — they degrade, never error.
- **Fan-out:**
  1. Migration + module + flag (off).
  2. Coach-console settings UI behind flag.
  3. #23 weekly recap reads the setting.
  4. AI Program Builder (PR #117) reads the setting.
  5. In-app AI coach reads the setting (gated independently).

## RBAC and privacy

- COACH role required.
- Per-row tenancy: a coach reads / edits only their own setting.
- Setting is not PII about a third party; it is the coach's own
  configuration. GDPR scrub on the coach's account deletion
  cascades. No client-side surface.
- OWNER never reads `notes_to_model` (the most subjective field);
  OWNER metrics expose only counts of coaches who have configured
  voice.
- Audit log: `coach.ai_voice.update` (with diffed fields, not the
  full body, to keep audit small).

## Tests

- **Unit (`test/coach-ai-voice-validation.spec.ts`):**
  - Tone enum reject.
  - Formality range reject.
  - Examples cap.
  - Banned-phrase array cap.
- **Unit (`test/coach-ai-voice-preview.spec.ts`):**
  - Preview transformer is byte-stable across runs.
  - Banned phrases are stripped from the canonical sample.
  - Required phrases are inserted.
- **Unit (`test/voice-service.spec.ts`):**
  - `renderSystemPromptBlock` produces the same string for the
    same profile (prompt-cache stability).
  - Profile with empty `examples` does not include the few-shot
    section.
- **Integration (`test/coach-ai-voice-routes.int-spec.ts`):**
  - Cross-coach 403 on PUT.
  - Idempotent PUT.
- **Smoke:** GET `/preview` returns 200 with both `sample` and
  `beforeSample`.

## Risks

1. **Misuse: prompt-injection via `notes_to_model`.** A coach
   pastes "ignore previous instructions and …" into the notes
   field. *Mitigation:* the field is appended **after** the
   system prompt and **inside** a labeled, sandboxed XML block in
   every consumer; never spliced raw. The integration test for
   the recap covers this.
2. **Misuse: PII in `examples`.** A coach pastes a real client
   message verbatim, including the client's name. *Mitigation:*
   client-side guidance + server-side scrubber that flags any
   `examples` entry containing `@`, phone-number-shaped, or
   email-shaped strings; logs to a moderation queue rather than
   blocking save.
3. **Stale cache after edit.** A voice change does not
   immediately invalidate the recap-prompt cache. *Mitigation:*
   the cache key includes a hash of the assembled
   `renderSystemPromptBlock` output, not the row id alone.
4. **Coaches don't fill it in.** The rollout assumes coaches
   configure voice; many won't. *Mitigation:* downstream features
   fall back to neutral; the coach console nudges via the
   ready-to-scale checklist (#25).

## Dependencies

- **#23 weekly recap:** primary consumer.
- **#25 ready-to-scale checklist:** "Configure your AI voice" is
  a checklist item.
- **PR #117 AI Program Builder:** consumer once it lands.

## Acceptance criteria

- [ ] Migration applied.
- [ ] Three routes shipped + tested.
- [ ] Voice service exposed; recap (#23) consumes it.
- [ ] Audit log entry on every PUT.
- [ ] Moderation queue for suspicious `examples` entries.
- [ ] Help center article: "How to set your AI voice."

## Operator handoff

- **Kill-switch:** `COACH_AI_VOICE_ENABLED=false`. Downstream AI
  features keep working with the neutral default.
- **Moderation:** moderation queue exposed via OWNER reports
  (`/api/admin/reports/ai-voice-flags`) for human review.
- **Runbook entry:** added under "AI features" alongside the
  weekly recap entry.
