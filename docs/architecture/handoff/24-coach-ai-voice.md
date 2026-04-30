# Handoff brief — Coach AI voice / tone setting

**Roadmap row:** #24.
**Status:** In discovery — spec drafted; runtime work not started.
**Spec:** [`../../specs/coach-ai-voice.md`](../../specs/coach-ai-voice.md).
**Cross-references:** PR #117 (AI Program Builder — downstream
consumer), PR #119 (parent roadmap), brief
[`23-weekly-recap.md`](./23-weekly-recap.md) (primary downstream).

## WHY

Every AI surface that emits text on behalf of the coach (recap
#23, AI Program Builder PR #117, in-app AI coach) currently uses
a single neutral voice. Without a single source of truth for the
coach's voice, every feature re-litigates voice. This item is
the upstream feature: one model, one service, every AI surface
reads it.

## WHEN

- The first user-facing AI text surface (planned: weekly recap
  #23) is at code-review and voice has been called out as the
  primary trust gap.
- AI Program Builder RFC §22 forward-compat note is closed and
  references this setting.

## WHERE

- New module: `src/coach-ai-voice/`.
- New table: `CoachAIVoiceSetting` (one row per coach).
- New routes: `GET /api/coach/ai-voice`, `PUT /api/coach/ai-voice`,
  `GET /api/coach/ai-voice/preview`.
- Read by: weekly recap (#23), AI Program Builder (PR #117),
  in-app AI coach (gated).

## WHO

- **Sign-off:** founder for field shape (especially
  `examples`); backend lead for the table.
- **On the hook:** backend platform.
- **Downstream:** every AI surface in the platform.

## WHAT

- **Already exists:** `CoachProfile` adjacent (separate table
  because edit cadence + audit posture differ).
- **Net-new:** one table, one module, one feature flag
  (`COACH_AI_VOICE_ENABLED`), a deterministic preview
  transformer (no LLM call), a `VoiceService.renderSystemPromptBlock`
  helper consumed by every AI feature for prompt-cache stability.
- **Non-goals:** no multiple voice profiles; no per-client
  override; no auto-derivation from prior outbound messages.

## HOW

PR-1 model + migration + module shell + preview transformer with
snapshot tests. PR-2 wires routes (404 when flag off). PR-3 has
recap (#23) consume. PR-4 has in-app AI coach consume. PR-5 has
AI Program Builder consume.

## Risks (top three)

1. **Prompt-injection via `notes_to_model`** — the field is
   appended *inside* a labeled XML sandbox in every consumer,
   never spliced raw. Integration test covers this.
2. **PII in `examples`** — server-side scrubber flags entries
   with `@`, phone-shaped, or email-shaped strings into a
   moderation queue.
3. **Coaches don't fill it in** — downstream features fall back
   to neutral; the ready-to-scale checklist (#25) nudges.

## Cross-references

- Spec: [`../../specs/coach-ai-voice.md`](../../specs/coach-ai-voice.md).
- Downstream: brief #23 (recap), PR #117 (Builder), brief #25
  (checklist).
