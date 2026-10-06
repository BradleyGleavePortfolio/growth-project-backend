**Tier:** T4 (notification delivery that carries client PII on the lock screen; touches the coach-alert, coach new-purchase and package content-unlocked push paths). No schema, no migration, no flag, no money logic.

**Why:** Three push senders bypass the push stack's one sender (`NotificationsService.sendPush`) and call the raw Expo send directly. On a normal day:
- they put a client's name (and for alerts a risk percentage, for purchases the amount paid) on the coach's lock screen;
- they ignore "Mute all notifications" (the settings screen promises "Turns off all push, in-app and email notifications"), the per-kind switch (`coach_alert_push`, `coach_new_purchase_push`, `drip_released_push`) and quiet hours (9:00 PM to 8:00 AM);
- the tap carries no `actionScreen`, so it opens nothing.

**T4 trigger scan:** PII on the lock screen: yes, fixed (the lock screen now shows only fixed templates). Auth, RLS/tenancy, credentials, destructive data: none. Money: none (no Stripe, billing, ledger or payout code is touched; only the notification call after a purchase and after a drop fires).
**T3 trigger scan:** Cross-module wiring: `CoachAlertsService` now injects `CoachAlertEmitter` (exported by `NotificationsModule`, which `CoachModule` already imports; `CoachModule` is the only provider of `CoachAlertsService`). No new module edges.
**Bounded T1:** copy-only additions to `lock-screen-copy.ts` (two fixed templates).
**Canonical builder:** AUDIT-09-125 (agent 125 worker, Claude Opus 5.5).
**Acceptance evidence:** PR CI (full suite + tsc). The changed specs: `test/coach-alerts-push-delivery.spec.ts`, `test/coach-alerts-emitters.spec.ts`, `test/purchase-fanout-coach-new-purchase.spec.ts`, `test/drip-dispatcher.cron.spec.ts`, `test/package-push.service.spec.ts`, `test/mwb-program-dispatcher-e2e.spec.ts`, `test/privacy/no-pii-in-logs.spec.ts`, `test/push-lock-screen-copy.spec.ts`. On main the new assertions fail: `pushToCoach` is called with the alert text, `sendPush` is never called by the purchase and drip paths, and `lockScreenCopy(DRIP_RELEASED | COACH_NEW_PURCHASE)` returns the generic default.

## What changes
- `src/coach/coach-alerts.service.ts`: `tryPush` delivers through `CoachAlertEmitter.emit` (one inbox row in the coach's notification center plus one quiet push through `sendPush`) instead of `NotificationsService.pushToCoach` (title = alert text with the client's name, body = the raw alert type such as `risk_red_transition`).
- `src/packages/purchase-fanout.service.ts`: the coach new-purchase push goes through `sendPush` (the inbox rows are unchanged).
- `src/packages/drip-dispatcher.cron.ts`, `src/packages/package-push.service.ts`: the content-unlocked push goes through `sendPush` (the inbox rows are unchanged).
- `src/notifications/push/lock-screen-copy.ts`: fixed templates "New content / New content from your coach is ready. Open the app to see it." and "New purchase / A client bought a package. Open the app to see it."

`sendPush` gives each of these the gates every other push already has: `muted`, `<kind>_push`, quiet hours in the recipient's zone (deferred, never dropped), the outbox with retries, fixed lock-screen copy, and `actionScreen: NotificationCenter` in the tap data (the matching inbox row is there).

## Findings fixed
- **B-A09-1** (private data on the lock screen, Mute all ignored): a client misses three check-ins or falls into the red risk band, and the coach's lock screen shows "Jordan Smith crossed into the red risk band (82%)." with "risk_red_transition" under it, even with Mute all on or at 2 AM; the tap opens nothing.
- **B-A09-2** (payment detail on the lock screen, Mute all ignored): a client buys a package and the coach's lock screen shows "Jordan Smith just bought 12-Week Coaching ($199.00)", including with Mute all on.
- **B-A09-3** (Mute all ignored, false claim on the settings screen): a client with Mute all on still gets a push for every package content drop, with the coach-written content title on the lock screen.

## Overlap with open PRs
None. No open PR touches these files (checked b#776-b#785; b#762 merged as main ef5e514a, flags file only).

No schema, migration, lockfile, dependency, flag, Fly, Stripe or Expo change. No clinic partner name, no secrets.
