# AUD-OPUS-CAP1-122 notes (Opus lens) — m#379 @ 67d9aaa33afe9740201f8e110649967c832bd461

Backend refs read: backend main a70533d5 (ai.service.ts reserveDailyTokens L648-710, roman.controller.ts L96-180,
roman.service.ts assertWithinRateLimit L754-810, filters/http-exception.filter.ts, filters/throttler-exception.filter.ts,
ai.controller.ts @Throttle 20/h) and b#669 head 6386c00b (roman.controller.ts L106-142 crisis short-circuit before all three gates,
roman.service.ts assertDailyCapacity L1183 / reserveDailySpend L1224, roman-sse-error.ts toRomanSseErrorFrame).

Wire check:
- 429 ROMAN_RATE_LIMIT: HttpException body {code, retryAfterSeconds, message}; filter keeps `code`; controller sets Retry-After.
  Mobile fetch path reads header -> resetsAt = now + Retry-After (rolling 24h window frees a turn then). Correct.
- 503 ROMAN_CAPACITY_REACHED (b#669): HTTP pre-store (assertDailyCapacity) -> filter keeps `code`; retryAfterSeconds may be
  dropped by pickErrorDetails, fallback next UTC midnight == backend dayStart+24h. In-stream (reserveDailySpend) -> frame
  {code, message}, mobile schema z.string() accepts it -> dailyCap, turnStored=true. Correct.
- 429 AI_DAILY_QUOTA_EXCEEDED: body {error: CODE, message}; filter keeps body.error; capCodeOf reads `error` slot; getQuotaDate is
  UTC day -> next UTC midnight correct.
- Uncoded throttler 429 body error 'Too Many Requests' -> not a cap code -> no false pop-up.
- Crisis: b#669 controller skips rate limit, consent gate and spend cap for SafetyRouter emergency/self_harm; app composer never
  disabled by the cap (RomanComposer only gets `sending`), modal OK closes, draft kept. AI guide (/ai/chat) has no crisis exemption
  on the backend (pre-existing; operator ruled AI guide token limit a backend follow-up).
- Copy: title verbatim, body no first person / emoji / exclamation; reset time accurate for all three codes.
CI: Typecheck, lint, test pass; CodeQL pass.
