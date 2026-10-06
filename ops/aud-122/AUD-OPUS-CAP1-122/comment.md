AUDIT Claude Opus 5.5 — growth-project-mobile#379 @ 67d9aaa33afe9740201f8e110649967c832bd461 — VERDICT: APPROVE

AUD-OPUS-CAP1-122, agent 122. Full review, RUTHLESS SCOPE. A 0 / B 0 / C 4. CI at this head: Typecheck, lint, test pass; CodeQL pass.

Checked against backend main a70533d5 and the Roman stack b#669 @ 6386c00b:
- 429 `ROMAN_RATE_LIMIT`: HTTP filter keeps `code`, controller sets `Retry-After`; `romanApi.ts:509` maps it to the pop-up, reset = Retry-After (when a turn frees in the rolling 24 h window). Correct.
- 503 `ROMAN_CAPACITY_REACHED` (b#669 `assertDailyCapacity` before the turn is stored, and `reserveDailySpend` in-stream as a `{ code, message }` frame): `romanApi.ts:509` and `:566`; reset falls back to next UTC midnight, which is the backend's own day bucket. Correct, with the in-stream turn kept (`turnStored: true`).
- 429 `AI_DAILY_QUOTA_EXCEEDED` (`ai.service.ts` legacy `error` slot, kept by the filter; UTC quota day): `AIGuideScreen.tsx:229` shows the pop-up, puts the draft back, adds no generic reply. Correct.
- Uncoded throttler 429 (`error: 'Too Many Requests'`) never shows the pop-up. Correct.
- Roman chat, client and coach: `RomanChatScreen.tsx:191/365`, audience copy per surface; composer is never disabled by the cap, OK closes, the draft stays, so a later crisis message goes out and b#669 answers it with the SafetyRouter template before any of the three gates. Crisis not blocked by the app.
- Copy: title is the owner's words verbatim; body has no first person, emoji or exclamation; the reset time is true for all three codes.

B: none.

C (follow-ups, non-blocking):
- C-379-1: the AI guide's backend quota (`ai.service.ts` reserveDailyTokens) has no crisis exemption, so after the daily quota a crisis message on the AI guide gets this pop-up, not a safety answer (before this PR it got the generic error). Operator ruling: AI guide token limit is a backend follow-up. Recommend a backend ticket to skip the quota for SafetyRouter crisis messages on `/ai/chat`; also the comment at `aiDailyCap.ts:21` ("Crisis turns are exempt on the server") holds for Roman only.
- C-379-2: the platform-wide spend cap (503 `ROMAN_CAPACITY_REACHED`) reads "You've used your maximum AI allotment today." although the person did not use their own allotment. Operator ruling: backend follow-up.
- C-379-3: merge order: the Roman crisis exemption and `ROMAN_CAPACITY_REACHED` live in b#669 (not on backend main yet). This PR is safe on today's main (no worse than before), but ship it with the Roman stack.
- C-379-4: the AI guide's hourly throttle (20 per hour, uncoded 429) still shows the generic "problem with The Growth Project service" reply; pre-existing, not the daily cap. Copy follow-up.

Notes: /home/user/workspace/ops/aud-122/AUD-OPUS-CAP1-122/notes.md
