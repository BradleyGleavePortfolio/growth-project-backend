# Changelog

All notable changes to `growth-project-backend` are recorded here. Entries are grouped by phase; latest phase is at the top.

---

## Team Mode v1 — ADR-0001 §10 resolved (2026-05-10)

**Branch:** `feat/team-mode-foundation-rfc` (PR #118)

### What shipped

- **Sub-coach assignment surface**: `POST /team/sub-coaches`, `GET /team/sub-coaches`, `DELETE /team/sub-coaches/:subCoachId`. All endpoints carry per-route `@UseGuards(JwtAuthGuard, CoachGuard)` matching the Sprint B v2.1 pattern. Writes throttled at 30/min.
- **Curated audit feed**: `GET /team/audit-events` with cursor pagination, `event_kind` / `target_client_id` / date-range filters. Default page size 50, max 200. The 15 enum values in `TeamAuditEventKind` (session_held, message_sent, plan_assigned, checkin_logged, macro_target_set, meal_plan_assigned, workout_assigned, client_progress_logged, sub_coach_assigned, sub_coach_removed, client_reassigned, invite_sent_by_sub_coach, tier_changed, staff_seat_added, staff_seat_removed) deliberately bound the surface — not a CRUD firehose.
- **Stripe staff seats**: Pro tier adds one `subscription_item` (quantity = 1) per sub-coach. Removal deletes the item. Idempotency keys on both calls. Enterprise tier creates the assignment row but skips the Stripe call (included). When `STRIPE_SECRET_KEY` or `STRIPE_PRICE_STAFF_SEAT` is unset, the local row + audit events still land and the Stripe call is skipped with a logged warning.
- **Tier gate**: `TeamModeTierResolverService` resolves tier from `CoachSubscription.stripe_price_id` via env-var mapping. Pro and Enterprise pass; Growth and unknown receive a 403 with `{ kind: 'team_mode_locked', current_tier, required_tier: 'pro', upsell_url: '/pricing' }`. Defence in depth at both controller and service.
- **Sub-coach client invites (Q5)**: `InviteCodesService.createForCoach` auto-detects sub-coach context via a `TeamSubCoachAssignment` lookup. Invite is then attributed: `coach_id` is set to the head coach (so existing tenancy + signup flows keep working) and `invited_by_user_id` is the sub-coach. A matching `invite_sent_by_sub_coach` audit event is written best-effort.
- **Many-to-2 sub-coach relationship (Q2)**: A sub-coach may be assigned under up to 2 head coaches at once. Enforced at the service layer (clean 409 envelope) AND by a Postgres trigger `enforce_subcoach_head_cap()` so a concurrent double-write cannot exceed the cap.
- **Removal auto-reassigns clients (Q3)**: Removal flips `User.coach_id` from sub-coach to initiating head coach for every active student in a single Prisma transaction, writes one `client_reassigned` audit event per reassigned client, plus a `sub_coach_removed` summary event and a `staff_seat_removed` event when a Stripe item id was attached. Stripe failure does not roll back the local archive — the error is recorded in audit metadata for ops reconciliation.
- **2 new tables + 1 enum + 1 column**: `TeamSubCoachAssignment`, `TeamAuditEvent`, `TeamAuditEventKind` (15-value Postgres enum), `InviteCode.invited_by_user_id` (nullable, FK to User, ON DELETE SET NULL). Migration `20260510000000_add_team_mode/`. Additive only.
- **Validation**: `event_kind` query param validates against the 15-value enum and returns 400 (BadRequest) with `{ kind: 'invalid_event_kind', allowed: [...] }` on mismatch.
- **Env vars** (set in production): `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_ENTERPRISE`, `STRIPE_PRICE_STAFF_SEAT`. Documented in `.env.example` and `docs/architecture/adr-0001-team-mode-foundation.md` §10a.

### Tests

129 suites, 1237 passing, 0 failing (was 1103 baseline post-Sprint-B-v2.1; +101 from this PR's five new specs, +28 absorbed from AI Gateway #140 rebase, +5 from audit-fix specs).

### Out of scope (deliberate)

- Pro → Enterprise mid-flight tier upgrade is not handled in v1 (existing line items remain billable until removed). v2 follow-up.
- The broader 6-role permission matrix (`team_owner`, `setter`, `ops`, etc.) is preserved as documentation in `src/common/team-mode/` but not yet wired into the v1 runtime.
- Mobile screens for sub-coach add/remove are Sprint B-2 work.

### Known limitation

- The `enforce_subcoach_head_cap()` trigger has a millisecond race window under PostgreSQL `READ COMMITTED` if two concurrent inserts both observe `head_count = 1` for the same sub-coach. Recoverable by an admin archiving one row. Follow-up: add `SELECT … FOR UPDATE` on existing rows inside the trigger or escalate isolation.

---

## Phase 9 — Notifications Matrix (2026-05-07)

**Branch:** `feat/phase-9-notifications-matrix`

### What shipped

- **Notification center API**: `GET /notifications` (paginated, cursor-based, unread filter), `POST /notifications/:id/read`, `POST /notifications/mark-all-read`
- **Notification preferences API**: `GET /notifications/preferences`, `PATCH /notifications/preferences` — replaces Phase 6B `PUT` with semantically correct `PATCH`; 27 per-kind-per-channel flags plus global `muted` toggle
- **7 emitters** in `src/notifications/emitters/`:
  - `milestone-reached` — client hits a personal body/streak/build-week milestone
  - `message-received` — coach sends a message to a client
  - `missed-checkin` — client misses 3+ consecutive check-ins (notifies both client and coach)
  - `weight-trend-alert` — multi-day weight trend detected
  - `checkin-submitted` — client submits daily check-in (notifies coach)
  - `build-week-day-unlocked` — coach approves a gate and next day opens
  - `coach-alert` — mirrors `CoachAlert` table entries into the unified inbox
- **Email digest**: Handlebars templates for client daily, coach daily, client weekly, coach weekly. Templates in `src/notifications/templates/`
- **Digest cron jobs** (`DigestScheduler`): three configurable cron schedules; idempotency enforced via `NotificationDigestLog` unique constraint on `(user_id, digest_kind, window_date)`
- **2 new DB tables**: `Notification` (in-app inbox), `NotificationDigestLog` (idempotency guard)
- **Extended `NotificationPreferences`**: 27 new boolean columns (9 kinds × 3 channels) + `muted` global flag
- **Push rate limiting**: 1 push per user per kind per 60 seconds (in-process; Redis path documented for scale)
- **Privacy**: digest bodies use first names only; no weight/income/financial data from other users in any notification
- **READMEs**: `src/notifications/README.md` (full matrix, endpoint table, model table, env vars, tests), `src/notifications/templates/README.md`

### Migrations

- `prisma/migrations/20260507000000_add_notification_center/migration.sql` — adds `Notification` table, `NotificationDigestLog` table, 28 new columns on `NotificationPreferences`

### New env vars

| Var | Default | Notes |
|---|---|---|
| `EMAIL_DIGEST_CLIENT_ENABLED` | `on` | Set to `off` to disable |
| `EMAIL_DIGEST_COACH_ENABLED` | `on` | Set to `off` to disable |
| `CLIENT_DAILY_CRON` | `0 7 * * *` | UTC cron |
| `COACH_DAILY_CRON` | `0 6 * * *` | UTC cron |
| `WEEKLY_DIGEST_CRON` | `0 8 * * 0` | UTC cron, Sunday |
| `EMAIL_FROM_ADDRESS` | `noreply@thegrowthproject.app` | Sender address |
| `EMAIL_TRANSPORT` | `log` | `resend`, `sendgrid`, `postmark`, or `log` |
| `RESEND_API_KEY` | — | When `EMAIL_TRANSPORT=resend` |
| `SENDGRID_API_KEY` | — | When `EMAIL_TRANSPORT=sendgrid` |
| `POSTMARK_SERVER_TOKEN` | — | When `EMAIL_TRANSPORT=postmark` |
| `APP_URL` | `https://app.thegrowthproject.app` | Client digest CTA |
| `CONSOLE_URL` | `https://console.thegrowthproject.app` | Coach digest CTA |

### Follow-ups

- Wire real APNs/FCM SDK in `NotificationsService.pushToCoach` once `User.push_token` column is added
- Migrate in-process push rate-limit to Redis for multi-replica deployments
- Add `GET /notifications/digest-log` (owner-only) for send-history inspection

