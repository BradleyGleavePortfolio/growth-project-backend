FIX ROUND 1 (OPENING, M-ROMANCAP-122, agent 122) — growth-project-mobile#379 @ 67d9aaa33afe9740201f8e110649967c832bd461 — READY FOR AUDIT

Job: SoT A9 M-ROMANCAP-120 (owner 11:20, day 1). New PR on mobile main 2c88eae5. Size +657/-6 (8 files, tests included), under 1,500.

**Behaviour**
- Roman chat (client and coach surface) and the AI guide show one pop-up: title "You've used your maximum AI allotment today." (owner words verbatim), body "AI help resets today at 5:00 PM." in local time plus what keeps working. One OK button. Never the generic error row, never "Roman is not available".
- Mapped: 429 `ROMAN_RATE_LIMIT` (reset = Retry-After), 503 `ROMAN_CAPACITY_REACHED` over HTTP and in the stream frame (b#669; reset = next UTC midnight), 429 `AI_DAILY_QUOTA_EXCEEDED` in the legacy `error` slot (ai.service.ts; reset = next UTC midnight). Uncoded 429 (burst throttle) keeps the short-wait copy.
- Before the turn is stored the draft stays in the composer; in-stream (after store) the turn stays in the thread and is never re-sent on its own. AI guide: draft back in the input, nothing saved to history (was the generic "service problem" reply).
- Crisis turns: the server skips every Roman cap for them; the composer is never blocked after a cap hit, so a later crisis message still reaches the safety answer.
- Not wired: gateway surfaces (coach Ask AI, drafts, wearable insights, triage) never receive these codes; the coach pool code `COACH_AI_BUDGET_EXHAUSTED` keeps its own copy (separate job).

**Configured caps (backend)**
- Roman per person: `ROMAN_RATE_LIMIT_FREE_PER_DAY` 50 user turns per rolling 24 h (clients resolve to free; pro 500), constant in src/roman/roman.constants.ts, no env.
- Roman spend: env `ROMAN_DAILY_COST_CAP_USD`, default 25 USD per UTC day (b#669 6386c00b). Server-wide, not per client.
- AI guide: `DAILY_TOKEN_QUOTA` 12,000 tokens per UTC day per person, each call reserves 6,600 first; constant in src/ai/ai.service.ts, no env.

**Operator decisions (recommended defaults)**
1. `ROMAN_CAPACITY_REACHED` is server-wide: on a heavy day every client sees "You've used your maximum AI allotment today." after one message. Default: b#669 fix round scopes the spend cap per client (requester filter) or adds a per-client spend cap; mobile mapping is unchanged either way.
2. AI guide quota may not be rare: the pre-check refuses once the day's actual use passes 5,400 tokens. Default: backend raises `DAILY_TOKEN_QUOTA` and makes it env-configurable, or retires the AI guide in favour of Roman.
3. `/ai/chat` has no crisis short-circuit on the backend, so a capped client's crisis message in the AI guide gets the pop-up. Default: backend follow-up runs the SafetyRouter before `reserveDailyTokens`.

**Tests / CI**
- New: src/lib/ai/__tests__/aiDailyCap.test.ts (mapping, reset times, copy rules, real `romanApi.sendMessage` over mocked fetch), src/__tests__/aiDailyCapSurfaces.test.tsx (Roman client + coach, AI guide).
- CI lane ci/M-ROMANCAP-122-1 run https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37391654204: tsc + 15 related specs green.
- PR CI: green at this head, run https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37391878122 (attempt 1 hit one unrelated flaky suite, ConnectProviderSheet.attemptFence sign-out, which passes locally on this branch and on main; failed job re-run, attempt 2 green, no push). CodeQL green.
