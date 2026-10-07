DRAFT (pre-read at 91ab6aa7 before READY; re-check head before posting)

Reviewed: 3 files (first-win.service.ts, README, new spec), copy only. Pairs with m#441.
Traced:
- POST /me/first-win/complete records the win when the Day One card is tapped, before anything is logged. The AI label now says
  the client "has chosen to ..." and the system prompt adds "Do not say or imply the action is already done, and do not mention a
  coach", so the message stops claiming a check-in or meal that has not happened and stops promising a coach to clients without one.
- Fallbacks: first_checkin now describes daily habits (the card opens the habit list; there is no client check-in screen) and
  first_meal drops "tells your coach". No schema, route, auth or money change; idempotency of first_win_completed_at unchanged.
- R75 scan: no new as any / as unknown as / as never / empty catch.
B: none.
C: none.
