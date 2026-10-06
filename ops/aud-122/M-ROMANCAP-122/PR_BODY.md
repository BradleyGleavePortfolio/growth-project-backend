M-ROMANCAP-122 (agent 122). Owner 2026-10-04 11:20, day 1: when a client hits the daily AI cap, every AI entry point shows a graceful pop-up with the owner's words "You've used your maximum AI allotment today." plus when it resets (local time), never a generic error or "Roman is unavailable".

## What changes
- `src/lib/ai/aiDailyCap.ts` (new): one place that decides "daily AI limit reached" from status + machine code, computes the reset time, and writes the pop-up copy.
  - 429 `ROMAN_RATE_LIMIT` (roman.service.ts assertWithinRateLimit, per person, rolling 24 h): reset = now + `Retry-After`.
  - 503 `ROMAN_CAPACITY_REACHED` (backend #669 assertDailyCapacity before the turn is stored, and reserveDailySpend as the in-stream `{ code, message }` frame after it): reset = next UTC midnight (the ledger day).
  - 429 `AI_DAILY_QUOTA_EXCEEDED` (ai.service.ts reserveDailyTokens, legacy `error` slot): reset = next UTC midnight (UserAIQuota day).
  - An uncoded 429 is the burst throttle (clears in a minute) and keeps the existing short-wait copy; the pop-up never comes from message text.
- `src/components/ai/AiDailyCapModal.tsx` (new): the pop-up. Title is the owner's words verbatim; body "AI help resets today at 5:00 PM." (local time) plus what keeps working (client: coach in Messages, plan and logs; coach: clients, messages and the rest of the app). One OK button.
- `romanApi.ts`: new error kind `dailyCap` on the send route (HTTP 429/503 and in-stream) and the axios paths. The 503 previously fell through to the generic "That request did not complete" row.
- `useRomanChat.ts` / `RomanChatScreen.tsx`: the cap travels in `sendError`; the screen shows the pop-up instead of the inline error row. Before the turn is stored the draft stays in the composer; after (in-stream) the stored turn stays in the thread and is never re-sent on its own.
- `AIGuideScreen.tsx`: 429 `AI_DAILY_QUOTA_EXCEEDED` previously showed the generic "Guidance could not answer this time because of a problem with The Growth Project service" reply. Now: the pop-up, the draft goes back in the input, nothing is saved to history.

Crisis turns: the server skips every Roman cap for a crisis message (roman.controller.ts sendMessage `crisis` short-circuit). The app never disables the composer after a cap hit, so a crisis message sent after the pop-up still gets the safety answer.

Other AI surfaces checked: coach Ask AI / drafts / wearable insights / triage go through the AI gateway, which has no per-person daily cap (only the coach pool, `COACH_AI_BUDGET_EXHAUSTED`, which gets its own copy in a separate job). They cannot receive these three codes, so they are not wired.

## Configured caps (backend)
| Surface | Cap | Scope | Where |
| --- | --- | --- | --- |
| Roman turns | 50 user turns / rolling 24 h (free; clients resolve to free), 500 pro | per person | `ROMAN_RATE_LIMIT_FREE_PER_DAY` / `ROMAN_RATE_LIMIT_PRO_PER_DAY`, src/roman/roman.constants.ts (no env) |
| Roman spend | 25 USD / UTC day | all Roman turns together (not per client) | env `ROMAN_DAILY_COST_CAP_USD` (b#669, default `ROMAN_DAILY_COST_CAP_USD_DEFAULT` 25) |
| AI guide | 12,000 tokens / UTC day; each call reserves 6,600 first | per person | `DAILY_TOKEN_QUOTA` / `PER_CALL_TOKEN_RESERVATION`, src/ai/ai.service.ts (no env) |

## Tests
- `src/lib/ai/__tests__/aiDailyCap.test.ts`: every code maps, uncoded 429 and other 503s do not, reset times, copy rules (owner words verbatim, no first person, no exclamation), and the real `romanApi.sendMessage` over a mocked fetch (429 coded / 503 / in-stream / uncoded 429).
- `src/__tests__/aiDailyCapSurfaces.test.tsx`: Roman chat client + coach surface show the pop-up with no inline error row, OK clears it, composer stays; AI guide 429 shows the pop-up, the draft returns, nothing saved, no generic reply.
