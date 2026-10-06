**Tier:** T1 (tap routing only; no money, auth, PII, schema or data paths).

**Why:** The app routes a push tap only by `data.actionScreen`. Community pushes, workout reminders, check-in nudges and several other pushes from the current production backend carry only `data.kind`, so tapping them opens the app wherever it was, with no navigation.

**T4 trigger scan:** none (no auth, RLS, PII, money, credentials or destructive data).
**T3 trigger scan:** none (no cross-module contract change; the backend payload is unchanged and read as it is sent today).
**Bounded T1:** `src/services/pushNotifications.ts` (kind fallback when `actionScreen` is absent), `src/services/pushTapRouter.ts` (one client route, `Community` -> CommunityTab, behind `featureFlags.communityTab`), `src/services/notificationsApi.ts` (notification center rows: kind fallback when `actionScreen` is absent).
**Canonical builder:** AUDIT-09-125 (agent 125 worker, Claude Opus 5.5).
**Acceptance evidence:** PR CI. New tests in `src/services/__tests__/pushPermissionDeferral.test.ts` and `src/services/__tests__/notificationsNormalize.test.ts` fail on main (main passes `undefined` as the screen for a push or a center row with only `kind`).

## Finding fixed
- **U-A09-1** (broken navigation target): a client gets "New reply on your post" (or a workout reminder, or a check-in nudge), taps it, and the app opens on whatever screen was last open instead of Community, Workouts or the notification center.

- **U-A09-2** (dead tap): a client opens the notification center and taps "New message from Coach" (or a workout reminder, a content drop or a community reply), and nothing happens; only booking rows carried a target screen.

Behaviour: a push that carries `actionScreen` routes exactly as before. Without it, `kind` decides: `community_*` -> Community tab (client, flag on; coach and flag-off land on the notification center), `workout_reminder` -> Workouts, any other kind -> the role's notification center (where its inbox row is). No `kind` -> unchanged (no navigation). Center rows without `actionScreen`: `community_*` -> Community, `message*` -> Messages, `workout_reminder` -> Workouts, `drip_released` -> Deliverables; other kinds stay in the center as today. The router's role, flag and user checks are unchanged.

Works against the current production backend (it reads the `kind` key the backend already sends). Pairs with backend growth-project-backend#792 (coach alert, purchase and content pushes go through the push stack and carry `actionScreen: NotificationCenter`), but does not depend on it.

## Overlap with open PRs
m#412 also edits `src/services/pushTapRouter.ts` (import rename and the CreditPackCheckout comment, lines 28 and 100-108). This PR adds one route at the end of `CLIENT_PUSH_ROUTES` (a different hunk); either merge order applies cleanly.

No lockfile, dependency, flag, eas.json or backend change. No clinic partner name, no secrets.
