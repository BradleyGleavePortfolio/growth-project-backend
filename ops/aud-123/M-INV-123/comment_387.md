FIX ROUND 1 (OPENING, M-INV-123, agent 123) — growth-project-mobile#387 @ b54bea80c5c9948ec71465d4361dd0a1f36d76f7

Tier T4 (linking). Part 2 of 2 for M-INV-120 (mobile side of b#658): the coach Codes screen on /coach/codes. Part 1 is #385 (client refusal copy), independent, both on main. Dark until FEATURE_COACH_CODE_TOOLS=true on the server.

Story: a coach whose code leaked sees "Many more signups today than usual" on it, turns it off, creates a new code and shares its QR; clients who already joined stay connected.

- Entry (`CoachCodesEntry.tsx`, the existing `InviteCodes` route): one `GET /coach/codes`. Success -> Codes screen; 404 (`coach_code_tools_disabled` or a bare 404) -> legacy `InviteCodesScreen` unchanged; other failures -> plain message + Try again (no silent fallback).
- API (`src/api/coachCodesApi.ts`): `Idempotency-Key` header minted once per create attempt and reused on retry; `expected_code` = code on screen for `coach-link` rotate; `grace_hours` 0 / 24 / 168; one sentence per server refusal, never the raw string.
- Screen (`CoachCodesScreen.tsx`): coach link first; status; today / 7-day / total signups; `unusual_today` warning; Share (text + link); QR sheet with Share QR image; Rotate with a grace sheet; Turn off with confirmation (not on the coach link); retiring codes can only be turned off early; Bulk invite and Who joined links kept from the legacy screen.
- QR: `toqr` 0.1.1 (already in the lockfile via the Expo CLI, MIT, pure JS; one root lockfile line) on `react-native-svg`. Decoded with OpenCV: the matrix for a join link reads back the same URL. Justification vs react-native-qrcode-svg in the PR body.
- Tests: CoachCodesScreen 9/9, coachCodesApi 6/6, qrMatrix 3/3, plus existing navigation/wiring/dependency suites. Size 1,168 counted lines, 11 files. No new cast, no empty catch.
- Commits: 2c7801ed (feature), 326f3a63 (bulk invite + who-joined kept), b54bea80 (font weight 600: the quiet-luxury doctrine suite failed at 326f3a63, run 37407002778; that run's other 8,084 tests passed).

CI at this head: CI https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37407516837 success (Typecheck, lint, test); CodeQL https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37407516840 success.

Needs after audit: device pass on iOS and Android (scan the QR from the sheet, Share QR image), then the operator flips FEATURE_COACH_CODE_TOOLS.

READY FOR AUDIT
