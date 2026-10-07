**Tier:** T3 (core flow: client first run, Day One win message). Backend only, pairs with growth-project-mobile#441.
**Why:** AUDIT-01-125 U-01-3 (FU-FIRSTRUN-126, agent 126). The Day One win is recorded when a card is tapped, before anything is logged; the message then claimed the client had already logged or submitted it, and the habits card fallback talked about a check-in and a coach.
**T4 trigger scan:** AI text only. The prompt is still one of four fixed strings chosen by the `WinType` enum, sent under `noClientDataSubject('fixed_template')` through the same egress call; no egress gate, consent, data-subject, provider or model change. No auth, RLS, money, PII, credentials or data change. `test/ai-egress/coach-ai-consent.spec.ts` (fixed-template proof, 22 tests) passes unchanged.
**T3 trigger scan:** core flow copy (POST /me/first-win/complete response text). No route, DTO, schema or flag change. Older app builds get the same response shape.
**Bounded T1:** `src/first-win/first-win.service.ts` (fallback copy for `first_checkin` / `first_meal`, the four labels, one system-prompt sentence), `src/first-win/README.md`, new spec.
**Canonical builder:** FU-FIRSTRUN-126 (Claude Opus 5.5).
**Acceptance evidence:** new `test/first-win-step-copy.spec.ts`: on main 2 of 2 fail; with this change 2 of 2 pass. `test/ai-egress/coach-ai-consent.spec.ts` 22/22 pass. Targeted eslint clean.

## Fixes
- **U-01-3 (Day One message).** A client who taps "Log your first meal" on the Day One screen is shown a message saying they have already logged their first meal (the model was told "The client has just logged their first meal"), before anything is logged.
  - Labels now say what the client chose: "The client has just chosen to log their first meal as their first step." (still matches the fixed-template proof regex). The system prompt adds: do not say or imply the action is already done, do not mention a coach (the service has no client data, so it cannot know whether there is one).
  - `first_checkin` fallback no longer says "check-in" or "your coach adjust your plan": the card opens the habit list and is shown to coachless clients. `first_meal` fallback no longer says "tells your coach".
- Mobile side (eyebrow "YOUR FIRST STEP", card "Check off today's habits") is growth-project-mobile#441.
