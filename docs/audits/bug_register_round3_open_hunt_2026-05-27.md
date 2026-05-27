# Bug Register — Round 3 (Open Hunt)
*All findings from direct source inspection of auth, notifications, scheduling, data export, meal plans, packages, GDPR scrub, and community layers. Every issue traced to the exact file.*

***
## 🔴 Experience-Ruining Bugs
---
### BUG-R1 — Coach Adds Video URL to a Session But Client Is Never Notified
**File:** `src/scheduling/scheduling-session-lifecycle.service.ts`, `setManualVideoLink()`

**The Problem**

When a coach attaches a video meeting URL to a confirmed session via `POST /scheduling/sessions/:id/manual-video-link`, the service writes the URL to the `CoachingSession` row and writes an audit log. That is all it does. There is no push notification, no email, and no in-app notification sent to the client.

The confirmed booking flow creates a session with `video_url = null` (because the only active video provider is `stub`). The client receives a booking confirmation email, opens their phone the morning of the call, sees no join link, and either messages the coach in a panic or simply misses the session. The coach added the link hours ago — the client just has no way to know.

This is a direct revenue/trust risk. A £200 coaching session is wasted because of a missing two-line notification call.

**The Fix**

In `setManualVideoLink()`, after the Prisma update and audit write, call:
```typescript
await this.notifications.createNotification({
  user_id: session.client_id,
  kind: NotificationKind.SESSION_VIDEO_LINK_ADDED,
  body: `Your session with ${coachName} now has a video link — tap to join.`,
  deep_link: `tgp://sessions/${sessionId}`,
  channel: 'push',
});
```
Also send an email via `EmailService` using a new `SESSION_VIDEO_LINK` template containing the URL and session date/time.

***
### BUG-R2 — Two Completely Parallel Meal Plan Systems Active Simultaneously
**Files:** `src/meal-plans/` (legacy) and `src/real-meal-plans/` (current)

**The Problem**

Both `MealPlansModule` and `RealMealPlansModule` are registered in `app.module.ts`. They write to different database tables (`MealPlan` vs `DailyMealPlan` + `MealTemplate`) and expose different routes:

- Legacy: `GET /meal-plans`, `POST /coach/clients/:id/meal-plans` → writes to `MealPlan` (JSON blob)
- Current: `GET /me/meal-plan/today`, `POST /coach/meal-templates`, `POST /coach/daily-meal-plans` → writes to `DailyMealPlan`

A coach who uses the newer `coach/daily-meal-plans` API to assign a meal template will write to `DailyMealPlan`. If the mobile client queries `GET /meal-plans` (the legacy endpoint), it reads from the `MealPlan` table and returns nothing — the client sees "no meal plan assigned" despite the coach having just built one.

There is no migration, deprecation notice, or cross-reference between the two systems. Whether the client sees their meal plan depends entirely on which endpoint their app version happens to call.

**The Fix**

Designate `real-meal-plans` as the canonical system. Add a deprecation wrapper to `GET /meal-plans` that queries `DailyMealPlan` for the most recently assigned plan for the client and reshapes it into the legacy `MealPlan` response format, so both endpoints return consistent data. Add a `GET /me/meal-plan` alias on the legacy path that proxies to the current system. Schedule `MealPlansModule` for removal once all mobile clients have migrated.

***
### BUG-R3 — Coach Can Archive a Package That Has Active Recurring Subscribers
**File:** `src/packages/packages.service.ts`, `archive()`

**The Problem**

`PackagesService.archive()` sets `archived_at = now()` and `is_active = false` on a `CoachPackage` row. It performs zero checks against `ClientPurchase` for active recurring subscriptions before doing so.

The consequences:
1. The package immediately disappears from the coach's public storefront. New clients cannot buy it.
2. Existing `ClientPurchase` rows with `status = 'active'` continue pointing to the archived `package_id`. Stripe will continue billing the client monthly because the Stripe subscription is unaffected.
3. The client is being billed for a package that, from the app's perspective, no longer exists. `GET /v1/checkout/purchases` returns the purchase with the archived package's name (via FK join) but the app's UI may not render it correctly since `is_active = false` triggers "not available" states in multiple service checks.
4. If the coach later creates a replacement package at a higher price, existing subscribers are still paying the old rate — but nothing tells them this.

**The Fix**

Before archiving, check for active subscribers:
```typescript
const activeCount = await this.prisma.clientPurchase.count({
  where: { package_id: packageId, entitlement_active: true }
});
if (activeCount > 0) {
  throw new ConflictException({
    message: `This package has ${activeCount} active subscriber(s). Cancel their subscriptions before archiving.`,
    active_subscriber_count: activeCount,
  });
}
```
Alternatively, allow archiving but automatically set `cancel_at_period_end = true` on all active Stripe subscriptions for the package, notify affected clients ("Your [Package Name] subscription will end at the close of your current billing period"), and let them run to natural expiry.

***
### BUG-R4 — GDPR Data Export Stored on Local Filesystem — Download URLs Are Unreachable in Production
**File:** `src/data-export/data-export.service.ts`

**The Problem**

`DataExportService.storeArchive()` writes the user's GDPR Subject Access Request export to the local filesystem at `/tmp/exports/{id}.json` and stores a `local:///tmp/exports/{id}.json` URL in the database. The service's own code explicitly states:

> *"S3 support is a future enhancement... Local filesystem files (local://) cannot be served to the client."*

When a user requests their data export (`POST /account/data-export`), the server processes the request, writes the file to disk, and marks the request as `READY`. When the user then calls `GET /account/data-export/download`, the service checks `download_available: false` when the URL starts with `local://` and returns a 404-equivalent response.

The user has exercised their legal GDPR right, the platform has "completed" the export, and the user cannot actually download their data. This is a regulatory compliance failure.

This is the same class of bug as the receipt PDF issue (BILL-7) — both features write to the local filesystem and return unreachable `local://` URLs in production.

**The Fix**

Wire `storeArchive()` to the same S3 pattern used by other file-serving features. The infrastructure is already partially designed — `DATA_EXPORT_BUCKET`, `DATA_EXPORT_S3_ENDPOINT`, and `AWS_*` env vars are documented in the file header. The S3 upload is ~15 lines using `@aws-sdk/client-s3`. Add the same startup guard as recommended for receipts: if `DATA_EXPORT_BUCKET` is not set in production, log a `WARN` at boot so the operator knows exports will fail.

***
### BUG-R5 — GDPR Scrub Does Not Cancel Active Stripe Subscriptions
**File:** `src/users/gdpr-scrub.service.ts`, `scrubOne()`

**The Problem**

When a user exercises their right to erasure and their `deletion_scheduled_at` grace period expires, `scrubOne()` tombstones their email to `deleted-{uuid}@scrub.invalid`, nulls out PII fields, and sets `deleted_at`. It does not:

1. Cancel any active Stripe subscriptions attached to the user's `ConnectCustomer` record
2. Cancel any Stripe customer record
3. Update `ClientPurchase.entitlement_active` to `false`

The result: a deleted user's Stripe subscription continues billing their payment method every month. Stripe has no awareness the customer account has been deleted — it will keep collecting money from a person who no longer legally exists in the platform's data model.

Under GDPR, processing a deleted subject's payment data (by actively billing them) after erasure is a clear violation of the regulation's purpose limitation principle.

**The Fix**

In `scrubOne()`, before the Prisma transaction, resolve and cancel all active subscriptions:
```typescript
const purchases = await this.prisma.clientPurchase.findMany({
  where: { client_user_id: candidate.user_id, entitlement_active: true, stripe_subscription_id: { not: null } }
});
for (const p of purchases) {
  if (p.stripe_subscription_id) {
    await this.stripe.cancelSubscription(p.stripe_subscription_id).catch(err =>
      this.logger.warn(`GDPR scrub: failed to cancel sub ${p.stripe_subscription_id}: ${err.message}`)
    );
  }
}
```
Then set `entitlement_active = false` on all purchases in the transaction. Also call `stripe.deleteCustomer(connectCustomer.stripe_customer_id)` to remove the customer record from Stripe entirely.

***
## 🟠 Serious Issues
---
### BUG-S1 — Single Push Token Per User: Multi-Device and Reinstall Silently Break Notifications
**File:** `prisma/schema.prisma` (`User.expo_push_token String?`), `src/users/users.service.ts`

**The Problem**

`User.expo_push_token` is a single nullable string field. When a user registers a new device or reinstalls the app, `PATCH /users/push-token` overwrites the existing token. The previous device immediately stops receiving push notifications with no indication to the user.

In practice: a coach uses their phone for daily work. They get a new phone. They log in on the new phone, which registers a new Expo push token. Their old phone — which they may still use occasionally — is now dark. More critically, if a coach uses a tablet for coaching sessions and their phone for messaging, only the most recently registered device receives push notifications. The tablet never sees a "New check-in from [Client]" alert.

**The Fix**

Create a `UserPushToken` table:
```prisma
model UserPushToken {
  id         String   @id @default(uuid())
  user_id    String
  user       User     @relation(fields: [user_id], references: [id], onDelete: Cascade)
  token      String   @unique
  device_id  String?
  created_at DateTime @default(now())
  last_seen  DateTime @default(now())
  @@index([user_id])
}
```

`NotificationsService.sendPush()` queries all active tokens for the user and sends to each. `DeviceNotRegistered` receipts delete the specific token row. On `updatePushToken`, upsert by token value (not user_id), updating `last_seen`. Add a cron to prune tokens with `last_seen > 90 days`.

***
### BUG-S2 — Notifications Accumulate Forever: No TTL, No Deletion, No Cap
**File:** `src/notifications/notifications.service.ts`, `prisma/schema.prisma`

**The Problem**

`Notification` rows are never deleted. There is no `expires_at` column, no cleanup cron, no `deleteMany` call in `NotificationsService`, and no max-notifications-per-user enforcement. A user who has been on the platform for a year with daily missed-checkin nudges, weight alerts, and coach messages will have thousands of unread notification rows. `GET /notifications` returns a paginated list (default 20, max 100) — the rows are never purged.

This creates compounding problems:
1. The `@@index([user_id, created_at])` and `@@index([user_id, read_at])` indexes grow unboundedly, degrading query performance for active long-term users
2. The unread badge count query (`SELECT COUNT(*) WHERE read_at IS NULL`) becomes a full index scan for users with thousands of unread notifications
3. GDPR scrub does not delete notification rows (they contain `body` text that may reference the user by name)

**The Fix**

Add an `expires_at DateTime?` column to `Notification`. When `createNotification()` is called, set `expires_at = created_at + 90 days` for transient kinds (`missed_checkin`, `weight_trend_alert`, `coach_alert`) and `null` for persistent kinds (`milestone_reached`, `payment_*`). Add a nightly cron: `deleteMany({ where: { expires_at: { lte: new Date() } } })`. Also add to GDPR `scrubOne()`: `deleteMany({ where: { user_id: candidate.user_id } })`.

***
### BUG-S3 — GDPR Data Export Missing Key Models: Purchases, Sessions, Bloodwork, AI Data
**File:** `src/data-export/data-export.service.ts`

**The Problem**

The GDPR data export is missing the following models that contain the user's personal data:

| Missing Model | Contains |
|---|---|
| `ClientPurchase` | Payment history, amounts paid, package names |
| `CoachingSession` | Scheduled/completed sessions with coach |
| `BloodworkPanel` | Medical biomarker data (highly sensitive) |
| `MacroTarget` | Nutrition prescriptions |
| `AIDraft` | AI-generated content created on behalf of the user |
| `Notification` | All in-app notification history |
| `ConnectCustomer` | Stripe customer binding |
| `ChargeRefund` / `ChargeDispute` | Refund and dispute history |

Under GDPR Article 15, the Subject Access Request must include all personal data held. A SAR export that omits the user's medical bloodwork panels, full payment history, and AI-generated coaching content is legally incomplete.

**The Fix**

Add these models to the `Promise.all()` in `buildArchive()`. Bloodwork is the highest priority given its special-category status under GDPR Article 9 — it must be included (and its omission is the most legally exposed gap).

***
### BUG-S4 — Community Wins Have No Content Moderation
**File:** `prisma/schema.prisma` (`CommunityWin` model)

**The Problem**

`CommunityWin` has `title String`, `description String`, and `visibility String` — no `reported_at`, no `reviewed_by`, no `hidden_at`, no `moderation_status`. Any authenticated user can post any text as a "community win" with `visibility = "public"`. There is no reporting mechanism, no moderation queue, and no way to hide a post without physically deleting the row.

On a platform that handles health data and has a coaching relationship dynamic (power imbalance between coach and client), unmoderated user-generated public content is a harassment vector and a liability.

**The Fix**

Add to `CommunityWin`:
```prisma
reported_at      DateTime?
report_reason    String?
hidden_at        DateTime?
hidden_by        String?
moderation_note  String?
```

Add `POST /community-wins/:id/report` (any authenticated user) and `PATCH /admin/community-wins/:id` (owner only, to hide/unhide). Add `hidden_at IS NULL` to all public-facing queries.

***
### BUG-S5 — No Notification When Coach Assigns a Workout Plan or Meal Plan
**Files:** `src/workout/workout.service.ts`, `src/meal-plans/meal-plans.service.ts`, `src/real-meal-plans/real-meal-plans.service.ts`

**The Problem**

When a coach assigns a workout plan to a client, no notification is sent to the client. When a coach assigns a meal plan (either system), no notification is sent. The client has no way to know new content has been added to their programme unless they actively open the app and navigate to the correct section.

This is particularly broken for the `DailyMealPlan` assignment flow (`POST /coach/daily-meal-plans/:id/assignments`), where the coach explicitly designates a specific client for a specific plan date — a deliberate, targeted action — and the client gets complete silence.

**The Fix**

In `WorkoutService.createWorkout()` (when `assigned_to` is set) and in `RealMealPlansService.assignDailyPlan()`, emit:
```typescript
await this.notifications.createNotification({
  user_id: clientId,
  kind: NotificationKind.PLAN_ASSIGNED,
  body: `Your coach added a new ${type} plan for ${dateLabel}`,
  deep_link: `tgp://plans/${planId}`,
  channel: 'push',
});
```

***
## 🟡 Notable Gaps
---
### BUG-N1 — `getAlerts()` Has No Cap: 200-Client Roster Returns 200+ Alerts
**File:** `src/coach/coach.service.ts`, `getAlerts()`

`getAlerts()` fires an alert for every client who hasn't logged a workout in 5 days and every client with 3 consecutive weight increases. For a coach with 200 clients, this could return 200 separate alert objects in a single API response. There is no `take` limit, no pagination, no priority ranking. The response payload grows linearly with roster size and the alerts become meaningless noise. Add `take: 20` with priority ranking (most days since last workout first) and a `has_more` flag.

***
### BUG-N2 — Check-In Unique Constraint Prevents Evening/Multiple Check-Ins
**File:** `prisma/schema.prisma`, `CheckIn` model

`@@unique([user_id, date])` enforces exactly one check-in per user per day. `CheckInType` enum exists (`morning`, and presumably others), but the unique constraint is on `(user_id, date)` with no `type` component. A user who submits a morning check-in cannot submit an evening check-in on the same day — the second upsert hits the unique constraint. If the product intends to support morning + evening check-ins, the constraint should be `@@unique([user_id, date, type])`.

***
## Summary Table
| Bug | Severity | Effort |
|---|---|---|
| BUG-R1: Video link added, client not notified | 🔴 Critical | 1 hour |
| BUG-R2: Two parallel meal plan systems | 🔴 Critical | 1 day |
| BUG-R3: Archive package with active subscribers | 🔴 Critical | 2 hours |
| BUG-R4: GDPR export stored on local filesystem | 🔴 Critical | Half day |
| BUG-R5: GDPR scrub doesn't cancel Stripe subscriptions | 🔴 Critical | Half day |
| BUG-S1: Single push token — multi-device broken | 🟠 Serious | 1 day |
| BUG-S2: Notifications accumulate forever | 🟠 Serious | Half day |
| BUG-S3: GDPR export missing purchases, sessions, bloodwork | 🟠 Serious | Half day |
| BUG-S4: Community wins — no content moderation | 🟠 Serious | Half day |
| BUG-S5: No notification on plan assignment | 🟠 Serious | 2 hours |
| BUG-N1: getAlerts() uncapped for large rosters | 🟡 Notable | 1 hour |
| BUG-N2: Check-in unique constraint blocks evening check-ins | 🟡 Notable | 1 hour (migration) |