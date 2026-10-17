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

---

## [0.1.1](https://github.com/BradleyGleavePortfolio/growth-project-backend/compare/v0.1.0...v0.1.1) (2026-10-17)


### Features

* [143] CODEGEN — new invite codes are TGP- plus 7 characters; old codes keep working ([900fda5](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/900fda5a22f7c8e70fe0121aa0c04e75f0e3b426))
* [144] BILLQUOTE — the server says what is due today and when the first charge is ([4f5399b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/4f5399b178efcf946e932713635a9e37430a7513))
* [144] BILLQUOTE — the server says what is due today and when the first charge is ([3616e22](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3616e22d27b8d52bdbd460252abae9decab6d4d3))
* [144] JOINQUOTE — the join screen gets the server's due-today amount too ([1354577](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/1354577ec8871bcc9286a5d2235f8b0568abb3b4))
* [144] JOINQUOTE — the join screen gets the server's due-today amount too ([558c965](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/558c965b2eda4a7da4a1bd7f2ab514e5dde3bef6))
* [145] C4MOVED — sessions record when and by whom they were last moved ([62fb0a3](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/62fb0a35eed916c5286941865c32d6b2c160c73f))
* [145] C4MOVED — sessions record when and by whom they were last moved, so the client can see what changed ([ca90de1](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ca90de1d39477364e15d449be62c0e75fb6fc5b2))
* [145] C4NOTICE — each coach sets how much notice clients need to move or cancel a session (default 24 hours), enforced on the server ([0265e18](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0265e18934f7ee6dbc0121ef41f2a8b33b70c2e6))
* [145] C4NOTICE — each coach sets how much notice clients need to move or cancel a session (default 24 hours), enforced on the server ([06e6e30](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/06e6e300389056875a96c041f431ba4a17cd8979))
* [145] C5RECEIPTS — clients get their own receipts with refunds and a paid-this-year total, all from the server ([8f88676](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8f886766cbdfd66a825ff175882f5163eb3cf6aa))
* [145] FOODSAVED — clients can favourite foods and save meals to log again in one tap (server) ([a3ccdae](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a3ccdaedc89d944fab9df1df0f7bd378067a3a5b))
* [145] FOODSAVED — favourite foods and saved meals (server) ([1358abf](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/1358abf5c805ce936dbfdbf1fc28afe6a43314c0))
* [145] ROMANCOUNT — each client gets 100 Roman messages, 3 files and 5 Roman changes a day, counted on the server ([2e8eb23](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2e8eb233366a6d5cc3db6be64c10fb6d427888ce))
* [145] ROMANCOUNT — each client gets 100 Roman messages, 3 files and 5 Roman changes a day, counted on the server ([f582cbd](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f582cbdb806ad120de4a31d1d8624c24c45dc3ec))
* [145] ROMANCOUNT-USAGE — clients can see today's Roman usage and when it resets ([76279c7](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/76279c7efe698d3db3b31613d4b96b7f1faa6041))
* [145] ROMANCOUNT-USAGE — clients can see today's Roman usage and when it resets ([045ffad](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/045ffad5bce4bf0e094a20b5dbcc753f859602bb))
* [147] C6-BVIS — a sender edits or deletes their own space message only while the rule lets them write there ([2b7f663](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2b7f663a94ae7bce2ec247d668cf98b5e7c867c2))
* [147] C6-BVIS — one rule decides who sees each community space ([8fc2168](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8fc21683757946c26bc355116dc410de1f1b7546))
* [147] C6-BVIS — one rule decides who sees each community space ([9f5212a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/9f5212a463f2cc0bd41ca4394b7cf4ea0ba6d2fa))
* [147] CRISISLINES — a crisis reply that alerted the coach says so, and the privacy page says it while the switch is on ([63a85e4](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/63a85e48bf9641aae1730a38aa494d54756baa03))
* [147] HB1 — coach-set habits, safe edits, archive keeps history ([866c2a7](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/866c2a73d8d88bd382a58d1d0616d30fe7a40658))
* [147] HB1 — coach-set habits, safe edits, archive keeps history ([4caa162](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/4caa1629b82bd750f27301619951127ac7f43792))
* [149] C1V2-C1 — workout data for the Coach's page logging screens ([faa15d4](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/faa15d4b8366e5331dd3bc8c17fae7065ec44b28))
* [149] C1V2-C1 — workout data for the Coach's page logging screens ([52b58fc](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/52b58fcf2e10fd676187225ed2f9eb542f26febc))
* [149] ROMANMARK-B1 — a message Roman drafted records its draft ([09c9fe2](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/09c9fe2d9e3889a2ddae82de66f5a31a83ba8db3))
* [149] ROMANMARK-B1 — a message Roman drafted records its draft ([40692c0](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/40692c0fb3f5259c356a971600d2e7d05ea7a52b))
* [150] C10RT — private per-person community realtime topics ([06d6c98](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/06d6c989fab3876e8a87ef59b78f7ee0d677e81c))
* [150] C10RT — private per-person community realtime topics ([351d953](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/351d9535b4407fcff439188b1b708045e78164ab))
* [150] K1WEEK — coach read of one client's week of workouts ([ca48f0b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ca48f0b527bc9ef3d61b7691332be5b78e4053df))
* [150] K1WEEK — coach read of one client's week of workouts ([aa858d8](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/aa858d8e374ef238dec3b95dbd6a3a2e789a17d2))
* **coach:** urgent safety push breaks quiet hours; push and inbox tap open that alert (R1F-2) ([42897f7](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/42897f783a98862d4b6a50117eba3d85009c3e85))
* **consent:** [145] W-CONSENT — a client with no coach can allow AI help once; Roman and the wearable insight wait for a coach ([97038db](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/97038dba4a6e1cf483a4065d21aca3886a3afb05))
* **consent:** coach-free consent versions, no clinic sentence, privacy referral and safety-alert lines ([008daa4](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/008daa4920aa9ba3b611ee8c3d32d620d067ab29))
* **consent:** safety-reply exception in coached consent texts, coach-free P0 without Roman, no AI grant without a coach ([edec90a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/edec90a949e4aab24704b3f05962472d0fc9ae84))
* **invite-codes:** new codes are TGP- plus 7 characters with no look-alikes ([b3196d1](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b3196d173532fd84ad53cc935920f42ff1a8b39b))
* **onboarding:** both flag alerts open the client's answers, headed by name (FLAG-2) ([cf468d8](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/cf468d8ade1239c698e6ccd16d57dc11823b1f16))
* **roman:** coach safety alerts for urgent and eating-disorder replies (B-R1F) ([5a0b067](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5a0b0673e198fe0f84e38e255cfd45d9c2cc78e9))


### Bug Fixes

* [138] R4c — Roman's safety correction uses the floor for every number it shows ([33b991d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/33b991d65cf5af4c711afe7edbf416dd1ce3fc7b))
* [138] R4d — The context Roman reads uses the floor-lifted target ([2d912bb](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2d912bbc27e662dc0a5c651d5fae93c5cb5e65cd))
* [139] B-R1F — Roman's urgent and eating-disorder safety replies alert the client's current coach ([a5aef64](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a5aef646a2132dfe31d802177f8c02da60101dcb))
* [142] HIST3 — a former coach reads none of a moved client's adjustment rows ([aa7670d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/aa7670d8a03f8d206254515bd135bc1453e70ef3))
* [142] HIST3 — a moved client's archived (frozen) meal plan stays in Roman's context ([11056f6](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/11056f65040d6bdd1f47ad53d73878dddef2941d))
* [142] HIST3 — apply the meal plan archive rule in the query ([59f0bcd](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/59f0bcd03c967902cb0ceb316c8324a0dec94169))
* [142] HIST3 — Roman's context follows the client from coach to coach ([4831df1](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/4831df1ae5b6e7016298c6abde685d77dc7c39b0))
* [142] HIST3 — Roman's context follows the client from coach to coach ([8fd261f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8fd261fe126de3291c50388e8ce2a3e3bfa0b967))
* [142] MOVE-RLS — A moved client's program copies, meal-plan assignments and stored briefs leave the former coach in row security too ([c25cde0](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/c25cde0f245af91e9f8308cda43c503e5eb49820))
* [142] MOVERLS2 — a former coach loses row-layer access to a moved client's frozen meal plan and guidelines ([98b37ad](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/98b37ada4015919b736bf7914b88a87a1f3ec37c))
* [142] MOVERLS2 — a former coach loses row-layer access to a moved client's frozen meal plan and guidelines ([7e2c304](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7e2c304dc86eb393300a018a0881303533cffdbf))
* [142] READTESTS — a removed sub-coach keeps no head's catalog or clients ([4ae9728](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/4ae97283603d67bea70f951c4169dd7f0657c8d7))
* [142] SUBREVOKE — removing a sub-coach ends their client assignments ([9d83418](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/9d83418b293b6b0e94e278c21c5029d6c8a44df4))
* [142] SUBREVOKE — removing a sub-coach ends their client assignments ([57892bd](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/57892bd90b9c4e4757eeb37bcaee527899dd0afa))
* [142] SUBREVOKE2 — a removed sub-coach loses row-layer access to the head's shared programs ([02f9878](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/02f9878ed8ece92f2554086ec6bd2fdb047533e9))
* [142] SUBREVOKE2 — a removed sub-coach loses row-layer access to the head's shared programs ([f27981a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f27981a3f1cd06b1f279a928a83df82c2be07033))
* [142] SUBREVOKE2 — a team member reads the shared library of the team they are seated on ([0e10ae3](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0e10ae30dd414297f3b1fd41e35a44140fdf146f))
* [143] AIBUDGET — AI usage is charged only to the right coach's credit pool ([171e55c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/171e55cfeb7f33b26acb668250c81625a08b6ed2))
* [143] MOVEBILL — a client's move stops the old coach's billing and drops them from that coach's active and MRR ([2e2d522](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2e2d5225c8810b92553b9924d4e56174c1a253bb))
* [143] MOVEBILL — a client's move stops the old coach's billing and drops them from that coach's active and MRR ([363a18f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/363a18f59daed21cc15c96bd1e756bdeb3128797))
* [143] MOVEBILL — delegation moves stamp the sub-coach left; a moved plan cannot be kept ([35db3fe](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/35db3fe748944023bef4af0fdd2bed5533ed557d))
* [143] MOVEBILL — the Day-10 lock never falls on a moved client over the old coach's plan ([05332b3](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/05332b35afe69e21240a19b5eb348fa6693cdc09))
* [143] MOVEBILL2 — moved trials never convert for the old coach ([1544b3b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/1544b3b27ba9020e9798e3544edfe5f04fb9dff0))
* [143] MOVEBILL2 — moved trials never convert for the old coach ([b8285d0](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b8285d085a74b6b39b5bcc5efb6685b9169a3de5))
* [143] PLANPROG — keep program days inside their program's tenant ([7b05ee4](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7b05ee43f918ecfc00e9b2850bb5dc28d382194f))
* [143] PLANPROG — keep program days inside their program's tenant ([fc18630](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fc18630a3bae435a991a99145a9bbca2d428b8ee))
* [143] PROGINSERT — a program is written only into a tenant its writer belongs to ([7aaaaa2](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7aaaaa2e0402adb14559ff75bc5fea1cb8a054e6))
* [143] PROGINSERT — a program is written only into a tenant its writer belongs to ([ab58909](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ab589094a83dad5f47873f484c58f0ca0b30418c))
* [143] ROMANHOUR — coach AI generation allows 60 calls an hour per route (ROMAN-HOURLY) ([1fc22dd](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/1fc22dddae5657ac44ce3d50c0d88228445b74f3))
* [143] ROMANHOUR2 — five AI routes allow 60/hour for coaches only ([2404b56](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2404b56735206ccc0823e3b4ae91d0c2df67f6f7))
* [144] FIX998 — the quote shows the dates of the checkout it resumes ([a5041b0](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a5041b01f8f503b784e4dac7bffaedd7e7bf349e))
* [144] FIX998B — a same-key trial retry past the reuse window follows the quote's rule ([92b92b2](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/92b92b2a50d3317c3a86d87711eb99969f104297))
* [144] GUIDEWRITE — only coaches write coach guidelines ([0a6d974](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0a6d9748f61e126d3c55c6873f071aa8c7761799))
* [144] GUIDEWRITE — only coaches write coach guidelines ([7c82370](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7c823708ff9852069fd90d9014a9c81b8de599e7))
* [144] health history follows the client at the row layer; safety alerts stay with the coach ([a6eae96](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a6eae966cc046dc7f6461593fd681a71148fe0a5))
* [144] RLSDIAG — diagnostic rows need a signed-in owner at the row layer ([1fd0879](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/1fd087942ec38719661614dae28f3407534a75b5))
* [144] RLSDIAG — diagnostic rows need a signed-in owner at the row layer ([3f463b0](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3f463b04dbd95a57ad031189b789a2dd03efa28b))
* [144] RLSDIAG — flat principal type so the live spec type-checks ([f3f936e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f3f936e30960a2e976d0562458b6fb9eafd41344))
* [144] RLSIDENT — coach branch reuses app.is_current_coach_of, cross-user write cases, REVOKE guard ([bc6f1a0](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/bc6f1a0b744173ace1b27b69d6e0fbb2ece30b28))
* [144] RLSIDENT — users cannot rewrite their own role, coach or login id at the row layer ([54b3e9b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/54b3e9befbc5a8786869133f5beef752b96248db))
* [144] RLSIDENT — users cannot rewrite their own role, coach or login id at the row layer ([a1eb9a9](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a1eb9a9815a56802b50c252c8fb90d82e48ccab7))
* [144] RLSLIVE2a — coach notes and nudges stay with the coaching relationship ([48fbc90](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/48fbc909c3de7585ea22f671ca598588eb30d868))
* [144] RLSLIVE2a — coach notes and nudges stay with the coaching relationship ([e2a1b86](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e2a1b86a921e47e8a9aaa90a095d443ded03a208))
* [144] RLSLIVE2a — create the DM helper with OR REPLACE, like every app helper ([15e9f00](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/15e9f00a517882a6aaef58e88d52f777fbb71504))
* [144] RLSLIVE2a — the client reads every review marker of their threads; the coach's DM needs a recipient in his workspace ([0c06edc](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0c06edcec87d8707e61d0e881f2d80bdc3edffe9))
* [144] RLSLIVE3a — health history follows the client, safety alerts stay with the coach ([01d9595](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/01d9595f16bc985536c79ee7f56f07efbad59d7d))
* [144] RLSLIVE3b — money rows are written by the server only ([42034ae](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/42034ae52d0e93613c1da7849699be232e8c17ba))
* [144] RLSLIVE3b — money rows are written by the server only ([6c0c141](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/6c0c1412ee001ce99c0c34031e8e70a48624ce30))
* [145] C4MOVED — migration and down.sql take the CoachingSession lock with a 5 s lock_timeout ([b8fad55](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b8fad55897e3485c5c16e32d02f458c4ababf97d))
* [145] C4MOVED — the reminder and expiry jobs select only the session columns they use ([22d4e13](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/22d4e13b4d91d9c0ab4ffb5325eb3230bf1f75e8))
* [145] C4NOTICE — controller doc string quote ([8f8f131](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8f8f131197794a1136d64a2be3be930964158e1e))
* [145] COACHLESSDAY1 — clients without a coach get a fixed Day One note from Roman, with no AI call ([379a65d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/379a65d42c235a41b587046324f3bb2b16a04475))
* [145] COACHLESSDAY1 — clients without a coach get a fixed Day One note from Roman, with no AI call ([8215a50](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8215a5090a372bbf62d61e46517ea4944f311793))
* [145] FOODSAVED — account deletion erases favourites and saved meals ([29b8285](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/29b828585984065cc02cfa868c6f4b71efd52a08))
* [145] RLSGRANTS — no regrole constant in the migration view ([93e7b38](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/93e7b38251f2d25d672370d67fb8846d780d119e))
* [145] RLSGRANTS — public API roles lose TRUNCATE/TRIGGER/REFERENCES and anon writes ([bba0f9e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/bba0f9e47389d83c3de1fe45dd7b0befba2a0274))
* [145] RLSGRANTS — self-test grant snapshot casts the "char" object type ([8e6aac0](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8e6aac0e103cc9fe3682179f836f3605a116d017))
* [145] RLSGRANTS — the public API roles can no longer truncate tables, add triggers or write as a signed-out visitor ([7845576](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/784557613ce455cba4ae66ab64aacba3194f0827))
* [145] RLSLIVE1a — a plan or template grant needs the owning coach's own pairing (FIX ROUND 1, B1/B2) ([d92de4f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d92de4f9a050a6c2074fd55fa9717fa120b1700c))
* [145] RLSLIVE1a — coaches read only their current clients' food, weight and profile rows; clients read their assigned meal plans and can no longer write plan assignments ([66f04bd](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/66f04bd93a209f0b0900647a1d8eaff0f97c3333))
* [145] RLSLIVE1a — food, weight, profile and meal-plan row rules follow the coaching relationship ([2faacfc](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2faacfc031e781b942e7ec9b9a164655f5c38425))
* [145] RLSLIVE1b — workout plan and assignment row rules use the same user id as every other rule ([2f31f46](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2f31f463f64c58825fdef0f76df82e4a176ee269))
* [145] RLSLIVE1b — workout plan and assignment row rules use the same user id as every other rule ([0799f37](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0799f3701a6e8d09378899ab0677019f056ec6a0))
* [145] RLSLIVE1c — drop the session-owner definer helper; sets stay on main's p_exerciseset_select ([de059c1](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/de059c152bd002a5fff8bc4aadc4e29288d9c74d))
* [145] RLSLIVE1c — the current coach reads a client's workout history; clients read their own program copy and their coach's lessons ([0ed1583](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0ed158340e1d1e4f9c5b666d8ee8ef63d35b4030))
* [145] RLSLIVE1c — the current coach reads a client's workout history; clients read their own program copy and their coach's lessons ([394896d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/394896d3d8c0d08b766fe733a7b1cc6925c722a1))
* [145] RLSLIVE2b — clients can request sessions only with their coach and never touch the coach's notes ([130b74d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/130b74d96fc8e41604b7998c921e320814deb829))
* [145] RLSLIVE3c — only the client grants consent, and analytics rows are server-written ([2cc7cff](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2cc7cffd00caa6c932ca58052e4cc7d13e4ac7cd))
* [145] RLSLIVE3d — Roman's drafts and audits are server-written, and a former coach loses his private drafts ([a037e82](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a037e824f0e809863655368a707a1e11e68ce2d7))
* [145] RLSLIVE3d — Roman's drafts and audits are server-written, and a former coach loses his private drafts ([6ca31f8](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/6ca31f841c2a924d9106e7a131d969d650c03c8e))
* [145] RLSMEALLEGACY — a former coach loses row access to a moved client's legacy meal plans ([7cc64eb](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7cc64eba08e31c81fde92a1206b7ca372764881a))
* [145] RLSSTORAGE — voice notes are reachable only through the server ([b152f23](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b152f23c59c2707937996fdbfb1747ec37c9bbfc))
* [145] RLSSTORAGE — voice notes are reachable only through the server, and the hand-made storage rules are replaced by a migration ([adad13b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/adad13b4ae75956f8fce1e6b00fe9ae7b8852c30))
* [145] ROMANCOUNT — safety turns and refused admissions never use up a message; usage route moves to the stacked PR ([d59b4e4](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d59b4e40fb3c19cfe0a2c04c94b704d61eba93ce))
* [146] C5RECEIPTS2 — a refunded receipt whose card amount is unknown has an unknown status, never one guessed from settlement debits ([a1c8de3](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a1c8de3073a0cec25c73cd9d570ea36b98a98dae))
* [146] C5RECEIPTS2 — converted receipts stay in one currency when Stripe is down; the summary reads no Stripe ([3fcb061](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3fcb0619fab68664a572a300c9e1ccc2cf9ee08d))
* [146] C5RECEIPTS2 — receipts stay in one currency when Stripe is down, and a page reads only its own rows ([a1a1943](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a1a194381688fe7868b1eebfec63764ad9f8a3c8))
* [146] FIX1016B — the owner exemption returns null (nothing counted); the spend-refusal regression proves the next turn counts once ([918b33b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/918b33be4cce32fa06e3afcd36c316b613c96a03))
* [146] FIX1020F — GET /me/roman/usage refuses coaches and the owner; a live test proves each client reads only their own counts ([f8ee4cc](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f8ee4cc8dc29cccad2623678672409336827abb8))
* [146] FOODSAVED-EXPORT — a client's data download includes their favourite foods and saved meals ([3dcd880](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3dcd880988d8a201691f21daaf570d9169b4a138))
* [146] FOODSAVED-EXPORT — the data download carries favourite foods, saved meals and their ordered items ([e7fcdfd](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e7fcdfdd66c45c48fc8d54d8a46c1b2acdd8bda9))
* [146] FOODSAVED-EXPORT — type the archive id helper for typed and parsed rows ([9dfe96d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/9dfe96daea636b99d731effe100d4478f35f495d))
* [146] RLSGRANTS — dry-run reset drops app; [#996](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/996)'s spec expects anon to stop at the grant ([b4ca06d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b4ca06daedbd411ad287004cd5110dc3da46c94b))
* [146] ROMANCTX-ROLE — GET /roman/context/me refuses coaches and the owner (the [#1020](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/1020) rule) ([d975772](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d9757727463cd2878aa4c662251cd9f5802319c5))
* [146] ROMANCTX-ROLE — Roman's context route answers clients only ([c216d0f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/c216d0f14baf387212686172e865ff3db2f20a88))
* [147] AGEGATE16 — every client confirms 16 or older before entering ([453cdcb](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/453cdcb86bb94d3e08a2bbc009c144b4133fad44))
* [147] AGEGATE16 every client confirms 16 or older before client routes answer ([4f7fb13](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/4f7fb13c9665d2f7642f36ad08fbd7ea74fa9fa5))
* [147] C6-BVIS — the workspace member helper asks the rule directly, so 20270502000200's down.sql still applies ([0886099](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0886099a8bf4ae12a90ef66438918d9daa1d12ae))
* [147] C6-BVIS — workspace helpers ask the rule through one definer function, so no helper reads a table under row security ([a056709](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a056709b1418f27e58c939253792a5fc1322d2e0))
* [147] C8-S — a coach read sends a weight only while Weigh-ins is shared ([5ef0772](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5ef0772f06593899279012bcfbca3bc84c6b7e44))
* [147] C8-S — weigh-ins stay private unless the client shares them ([3b28761](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3b28761a746591a9537c1f6cd5473b28b343f536))
* [147] FIX1030 — a former coach loses a moved client's alerts and alert inbox rows at once; crisis alert behind a default-off switch ([bdbcf62](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/bdbcf622eaad1d19fc92ebad486689d2c7ec6768))
* [147] MOVEGAPS — four more routes follow the move rule ([31da150](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/31da150deacb9672cd550dc751d45a43c467a1d3))
* [147] MOVEGAPS — four more routes follow the move rule ([cad3bc3](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/cad3bc3e9bb7b4d51e5bb505235064a956044109))
* [147] NOTIFYMOVE — a moved client's notifications leave the old coach ([8630a36](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8630a36e12095efb340f4447966b7c5dd1fd60a8))
* [147] NOTIFYMOVE — a moved client's notifications leave the old coach ([0318510](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/031851057b792b49a8f5069a83e50464bb5fcfe1))
* [147] ROMANROUTES — /ai context reads answer clients only (assertRomanClient); /ai/gateway needs a coach before the paywall ([ed1871f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ed1871fb8f5e662f5387f59a96b0008cd869226d))
* [147] ROMANROUTES — Roman's other context routes answer clients only ([f08effd](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f08effd98b24260bf45e4c352e93c43ab7d98c1e))
* [147] SAFETYWORDS — Roman's crisis replies alert the coach, and the urgent reply says doctor or prescriber ([095000c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/095000c8f20bdf7bd8d62d663e570e703ad949ea))
* [147] SAFETYWORDS — Roman's crisis replies alert the coach, and the urgent reply says doctor or prescriber ([52077dc](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/52077dcae56f6ee52c6d31470570eb18f45a7b1c))
* [148] AGESAVE — a date of birth saves on its own ([e24cce2](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e24cce27138a5f2fce54d09ee01b957c11276c50))
* [148] AGESAVE a date of birth saves on its own through PUT /profile ([f11d3a2](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f11d3a2dadfca7eb71d40ed0c4b2af7e93ef9cc4))
* [148] AGESAVE keep updateProfile's return a stored row (never null) ([46ef93b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/46ef93b0b05824a5ce37a9d2ee08c2174784e307))
* [148] C6-BVIS — the coach keeps managing a current client's invitation; Today and the reply and reminder pushes follow the rule ([022077b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/022077b36d5e9182dbdfff65e9f247a9cfac2de3))
* [148] CRISISAPP — the crisis sentence in the app's consent texts ([b260176](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b26017600ccecec784281618e6c57ab3d766d815))
* [148] CRISISAPP — the crisis sentence in the app's consent texts ([870b4ab](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/870b4ab0f935f53157578e7b49d76695518cb319))
* [148] CRISISPRIV — the crisis sentence follows every Roman safety-reply exception on the public pages ([ec0a887](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ec0a887f5238a7f397f76ab971c3f444e16a9fe3))
* [148] FIX1037 — a habit and its ticks stay with their client; keep today's habit order ([49de980](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/49de9809b903a05c129b5404ae10f6e21dd26538))
* [148] WEIGHTWALL — Weigh-ins off hides every weight and every number made from it ([9e8418e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/9e8418ec290ab7f14bb00dfe027ecf6eb5c01f71))
* [148] WEIGHTWALL — Weigh-ins off hides every weight and every number made from it ([ebfd1f5](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ebfd1f5f37915ea3ee99c5734c106a2cde2129f6))
* [149] CONSENTV7 — the memory-on grant records the text the client was shown ([85b5164](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/85b5164e52c82d86316dbe682c7f1ed4e25d09df))
* [149] CONSENTV7 — the memory-on grant records the text the client was shown ([f28e1ee](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f28e1eeb256c66bbdddfb7104d984614461edfd3))
* [149] FIX1042-TARGETS — worked-out targets reach the coach AI drafts again (owner ww-targets op 2) ([686d1fc](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/686d1fc10d476b9aaa1795cb502a6b5146af55f8))
* [149] FIX684 — accept the coachless consent screen with the Roman section ([493b1c6](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/493b1c664b84dce8e2095c599c823820a9c3aada))
* [149] FIX684 — accept the coachless consent screen with the Roman section ([855a2cc](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/855a2cca1c213182322c5e3ec98a6834d22ad1b3))
* [149] MEALPLAN-RETIRE — live test stub without a banned cast ([238b315](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/238b315ffe77335992c4f05efd7b41bfb29a21bb))
* [149] MEALPLAN-RETIRE — readers move to MEAL:DAY; former coach loses the meal tag ([a9ef3b5](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a9ef3b5db8037cd262b1ab8e010bb589c0cb78fa))
* [149] MEALPLAN-RETIRE — readers move to MEAL:DAY; former coach loses the meal tag ([de74f6a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/de74f6aaa34ff3204294f2cdce5f15bc45efe485))
* [149] NOTIFYMOVE — a current delegated sub-coach keeps their notifications ([ed3d102](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ed3d102cb2fdee6b3fae04987057053395c16fb7))
* [149] NOTIFYMOVE — who still coaches whom costs a fixed number of reads ([19b40e1](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/19b40e1c4b5cb2a0d018e8919924bb97726d4cef))
* [149] PKG-MOVE-FULFILMENT — a paid package still delivers after the source client moves ([92f680b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/92f680bafc66b1e8dfab82b67c0d77f7c4ccf996))
* [149] PKG-MOVE-FULFILMENT — a paid package still delivers after the source client moves ([5a6d9fb](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5a6d9fb8e995a169122d5eb0d0105ffb30bcfaef))
* [149] ROMANCACHE — a change you just made reaches Roman's next answer ([8c964a5](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8c964a523974870e0c36f0b784e65523266ec997))
* [149] ROMANCACHE — a change you just made reaches Roman's next answer ([ff60565](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ff60565107a74e155cc6a7959b323cec5c4eb5e6))
* [150] C1V2-C1 — migration 20270502002900, export date assertion, snapshot swaps and the assigning coach's write in the live row-rule test ([cd35a10](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/cd35a10a2f7f06a6b7ad1b8a381f39596c81ce2f))
* [150] C1V2-C1 — no API role writes the day row before the move either, the assigning coach included (live row-rule test and migration comment) ([ca42a36](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ca42a3651bf6bba70ab22fedfa87b228accd1a48))
* [150] CONSENT-TWINS — the coachless crisis twins of the consent screen with the Roman section ([0fc89e8](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0fc89e85e529bcbbd24aa95e19f1e7c48730bce4))
* [150] CONSENT-TWINS — the crisis ask offers the memory text the crisis build shows ([01d99e5](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/01d99e5408f50408a5315d6931c14cbac2db41ff))
* [150] FIX974R4 — the tax export cuts a moved client's package on head-coach share rows too; one shared cut, shorter helpers and tests ([a1d1f29](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a1d1f294dcc429315ec702ee1030cc85061d30cc))
* [151] BILLRAW — signed-in callers can no longer read raw billing rows ([f90596a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f90596a81c6a9c7c5f75fa3eef059c7b94be0320))
* [151] BILLRAW — signed-in callers can no longer read raw billing rows ([47bd358](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/47bd3585e98263990138b83855443aacb1669c5c))
* [151] C10RT — a DM reaction pings only while the DM is open to both people ([29127eb](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/29127eb6f45a8f359b69d12bbd1c48ca7a3a8a6f))
* [151] C10RT — force row security on the bootstrap realtime.messages stub too ([0a7985b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0a7985bcedd38fe8f9752d9f633ec82572e0d159))
* [151] C1V2-C1 fix round 1 — swaps take the builder's exercise ids; a coach note replies with the note only ([5776784](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/577678449742f8015f274c1bf027751d92feb62d))
* [151] C1V2-C1 fix round 1 — the coach's shared week reads skipped_at ([204da3d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/204da3d22a64003685534f83c2db63ab7811680b))
* [151] C6-SERVER — server-side wording sweep (owner rule C-6) ([1d48ce6](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/1d48ce6ad568b4f57c0701551a9d4b1b6eee218e))
* [151] C6-SERVER fix round 1 — whole-src wording guard, prompt version bumps, P-01 persona line ([61744c3](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/61744c36028ca3aa654d4d566f7ea3c4d15eebf1))
* [151] FIX988 — delegation_end_marks_plans() is SECURITY DEFINER (it reads "User"; RLSIDENT) ([7b052fb](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7b052fb9a9c0e9a80bd7a2268d1603614085bce2))
* [151] ROMANMARK-BE — the Roman mark follows consent when Roman wrote the draft ([9e3d7a6](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/9e3d7a660cd9c753266bab23e178b2b552486f88))
* [151] SHARE-UNWIND — workouts, food logs, weigh-ins, check-ins and habits always reach the current coach ([#1061](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/1061)) ([73cd30e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/73cd30e65962f93a4fe22ba02c40c60342234043))
* [152] MOVEPROG — a former coach can no longer reach a moved client's program copies ([fe47637](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fe47637c38b9699c42d94e04f72ae0c45de6dcc3))
* [152] MOVEPROG — a former coach can no longer reach a moved client's program copies ([cdfec87](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/cdfec872a58df2da24e20632118fee797ec87120))
* [152] MSGRT — coach and client message live updates go only to the two people in the chat ([7a0c764](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7a0c7642bc73da09246c042b1378e1252d7b4341))
* [152] MSGRT — coach and client message live updates go only to the two people in the chat ([1ed7d7a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/1ed7d7a68ba09ef76e20084ab7dcdf695436d5f3))
* [152] PLAYBOOK-WITHDRAW — a client who turns AI off leaves Roman's coach playbook at once ([7304045](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/73040453d51f07d2768b5a74280c64e2f7e7d32b))
* [152] PLAYBOOK-WITHDRAW — a client who turns AI off leaves Roman's coach playbook at once ([d6b1be2](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d6b1be2f607b0c65e6c88d241993e488f1450975))
* [152] PLAYBOOK-WITHDRAW — AI one-off plans keep their client; client programs count in figures only for eligible clients; a roster read error retires and rebuilds (operator ruling 4) ([f4b90e4](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f4b90e48fa875032bfc33a1ebd89234c35558f30))
* [152] PLAYBOOK-WITHDRAW — any eligible client who turns AI off or leaves retires the coach playbook (operator ruling, Sol round 1) ([78c41af](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/78c41aff70994e04fccfd07a83931b7c16bc8004))
* [152] PLAYBOOK-WITHDRAW — every client a playbook names must stay eligible; joins never retire it; client program copies count only for eligible clients (operator ruling 3) ([ecb43f1](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ecb43f1cb9e1966831ec442c89d969e368c7c9e1))
* [152] PLAYBOOK-WITHDRAW — the ledger names every client a playbook learned from (signals included); a pre-fix or altered ledger is not used ([4fc3283](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/4fc3283eb5dd8b29fc945f89df856e00d3f45cb3))
* [153] C6-SEEDSCAN — cover seeds and rendered consent ([c742289](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/c742289d3f6158ea37e4af95ca89846f647381c4))
* [153] C6-SEEDSCAN — cover seeds and rendered consent ([342dec2](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/342dec219e5347a0c842f0d98dbd366e635d89f1))
* a client's session request leaves the coach's side empty ([2aab3c9](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2aab3c9598ff8b8ccb66c6b95ba487d9332d6d12))
* a coach may name only a current client in AI context and the gateway roster; meter the typed drafts ([6d10644](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/6d10644eb689522aa5d78189b5f98d01ee535bf2))
* a coach-side wearable insight is cached per coach, so a moved client's old coach insight never passes on ([4228f30](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/4228f30e156e1c4bd7df6355acb8d2762eb98d70))
* a former coach loses row access to a moved client's legacy meal plans ([dcbb48a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/dcbb48a26d533867f77bba1b572c8b16fcb413ec))
* a moved client's sessions leave the old coach's reads and row policies ([ff7bd12](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ff7bd12b79f55d62c5095fdd0667074d61841512))
* **age-gate:** sign-out push-token clear and the locked age save pass (FIXAGE2 R5, R8) ([fbfa7da](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fbfa7da56dc9c080722462ebcb6ccd09868a389e))
* AI usage of a coach is charged to their own pool, never their coach_id's ([2f6fedc](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2f6fedc3fb60336f8a4e372f8c3dc2c24b20d65c))
* **ai:** R7 - text a client writes reaches the coach AI as data, never as instructions ([63313df](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/63313df7cbd1754f83455d4b29a2969dfaf41a3b))
* clients request sessions only with their coach and never write the coach's side ([418b78a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/418b78a9cfc6050dc61a1fd38677e88b9dbbf8d9))
* coach AI generation routes allow 60 calls an hour (ROMAN-HOURLY) ([c396381](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/c3963814cc7d491c2db13311dc69ccc72992804b))
* **coach-brief:** [#939](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/939) and [#964](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/964) hold together; history checks previews only on briefs it shows ([440bc68](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/440bc68e6bdb3fe354f9c2cd122f458ccdff9d86))
* **coach-brief:** a stored brief shows a message preview only from the coach's own thread (owner 4b) ([c5cef00](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/c5cef00122fa97718616b4d4e7f1ebd6bc542b66))
* **coach-brief:** a stored brief that names a moved client is written again today and shows no content in history (B-939-1) ([2e4bf59](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2e4bf594f41ff6e8b86f3b2c8ff80ae67efbe79c))
* **coach-brief:** a stored brief with no record of its clients is written again today and hidden in history (B-939-1 round 3) ([e528589](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e528589b64e9c7ef099be698cdb27cc6f8a90aed))
* **coach-brief:** head-coach briefs record their client set too, so stored team totals also drop a moved client (B-939-1 round 2) ([1a93aa1](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/1a93aa19ccb0a1db60d4b6c3268af896ef92bb98))
* **coach-brief:** leave out clients who have moved from the old coach's brief ([7d959e1](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7d959e1ad53487b8cf1dba28d858978b79dbb016))
* **coach-brief:** store whose data a brief was built from, so a count-only brief is also rebuilt or hidden after a move (B-939-1 round 2) ([753412a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/753412a1e889545efb2f365d1089f884c79052b6))
* **coach-brief:** the new coach's brief reads only the client's current chat thread (owner 4b) ([fb453f4](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fb453f40cdd85909315ccbdab9fb69dcd66ba3c0))
* coach-only hourly AI route limits follow approved 60-call scope ([07df24b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/07df24b829871ef92a04ea788cb00f3e276658be))
* **coach:** a client with no coach has left the tenant for older program copies too (HIST2A fix round 1) ([847c618](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/847c618130c1be78f048fd179c5ec389449cab4c))
* **coach:** a client's move deletes the drafts other coaches hold about them (A1g) ([f3790a7](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f3790a79728f93e5aacd47993d535ab9c8c4f156))
* **coach:** a move also deletes a sub-coach's approval drafts in the head coach's tenant (A1g B1) ([78293f5](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/78293f547ff3163988322860c788023a500e30f8))
* **coach:** a moved client keeps their daily meal plan as it was ([d68028b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d68028b06354c10cf6857be262377357928b3dbc))
* **coach:** former coach keeps no reads of a moved client ([5f0d2aa](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5f0d2aa7477aea2d5d1d947862cafb3015df7ca3))
* **coachless:** coach codes resolve under the same typed forms as every other code path ([07136c6](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/07136c606201ed78cb5474b28ee3919725bc53dd))
* **coachless:** count already_attached code checks as wrong guesses ([2ce0ddb](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2ce0ddb64fd7ef9cc1252087e8733e9e76f169cb))
* **coach:** one plan rule for the former coach's lists and reads; moved clients keep a later meal plan; past-session cancel and link 404 (HIST2A fix round 1) ([12db2a6](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/12db2a61a28ba5c291d359a67666887bacdd9fd0))
* **coach:** Roman safety alerts for the client's current coach only, not team assistants (B-R1F B1) ([becde24](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/becde2464b156d28a5c47895672bdeaac18eb8a6))
* **command-center:** a team sub-coach's Action Queue shows the safety alerts written to them (AQSUB) ([69e3a96](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/69e3a96146cefe475b0b1d835ed5cd6eaa5f5083))
* **consent:** a plain GET reads a live coach-free grant as needs_reconsent ([34ea9e6](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/34ea9e6b70005be598e97f3cbd25f2ee370f875d))
* **consent:** coach-free AI grants cover the client's own AI use only ([6a58024](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/6a58024697f4a30c35b49353865a88e63a68cd03))
* **consent:** decide has-a-coach from User.coach_id, not from the GET query ([e56ca71](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e56ca71a99d41d8b2d9ffacbe6c111e00bab7ac1))
* **data-export:** a former coach's own export leaves out moved clients (B-DP-4-1) ([cfdd186](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/cfdd186a455ebfee57e2ae3553a2bf6d486fc89e))
* **data-export:** keep coach drafts out of client exports; retire a sub-coach archive when a delegated client moves (F-938 B1, B2) ([a6dc778](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a6dc778d5e730ec4ef19e6c131b45aad7b7c8d75))
* **data-export:** retire a coach archive once a client moves away; drop moved clients from invite codes (B-938-1, B-938-2) ([e4771aa](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e4771aa6ef71bf5f3953ff348c3ab1503eee0ea1))
* every by-id read or action checks the moved-client rule ([3b4ac91](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3b4ac91f1a28a567f2965cf8cc1a18856ac583a2))
* **guide:** R2 - retire the old Guidance chat so Roman is the only chat ([b1011a8](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b1011a85e89a266213e53e54b9ab2d9e6dfbd53b))
* **guide:** R2 - the retired Guidance reply points to Roman on the Home screen (owner 5, 5w) ([a3bdd79](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a3bdd79a80638a57c83e5e8b2476f8513dfa1f62))
* HIST2A fix round 1: a moved client's meal plan and program copy leave the former coach's writes and copies ([d22bad7](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d22bad74c6f25d183926ee11e62f61c6166fc1a6))
* HIST2A-2 round 5: a completed assignment replay re-checks the client its cached rows belong to ([044ddd3](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/044ddd3896752291d1049f6577ffebcf9b2c9de5))
* HIST2A-2: a former coach can't reach a moved client's program copy through named regimes or a repeated save ([16faf20](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/16faf2001e6acf5df9c249be8d2e63e72704588f))
* **invite-codes:** count wrong codes on signed-in and signup code routes ([78431f6](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/78431f621c99c95a9a74ab66ad9ce74a914ee84d))
* **macros:** a held client's live MacroTarget follows the refreshed maintenance ([b21ad0e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b21ad0e3999a9e69fc069c095cd3c43cf931b291))
* **macros:** decide an automatic MacroTarget from its server-set id, not the note ([2e86e09](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2e86e09fcae4e0001829fc0a3d97f872c96a8755))
* **macros:** no deficit under 18 keeps the muscle-gain surplus; a readiness yes still holds maintenance ([4b07673](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/4b076735dab352b6cb20bf2fb68f413ad76c5e56))
* **messaging:** B-DP-4-2 - an old team's sub-coach loses a moved client's thread ([b6ffdef](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b6ffdef6916a679e08776d8695d4f7bd3d631218))
* **money:** a coach the client left can no longer pause, resume or cancel their plan ([f5323ba](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f5323ba780384dbb6e5c85825f27910a5272b72f))
* **money:** a moved client's charges and tax export drop the package and cadence ([ec110ef](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ec110efe9353e8d4d2e22590db1ff5a9318de156))
* **money:** a moved client's money record drops access and renewal state ([a47e27a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a47e27afcdea68b66e0b79b7eee9e9e78209c198))
* **money:** a sub-coach the head coach removed keeps only the money records ([9897094](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/989709416b6e4f4142708614defcaaf06ceb00b9))
* **money:** build a moved client's money record as a typed object, no cast ([8363f60](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8363f604a59e2056a0471fab58d497a27ddb5dc4))
* **money:** decide a moved client by the roster's own rule ([57594a8](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/57594a829ce13191b72821fee4f1554a29e84fb3))
* **money:** the seller refunds a moved client's sale by its id alone ([1af0bb9](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/1af0bb9c5e4e64967a0f55bae7265ba24f00a0fe))
* **onboarding:** stop the house flag alert; tell the coach a flagged coachless client joins ([5d8c3f4](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5d8c3f46f17e4d7d0dfffe2123bcdb6441ca1247))
* one wiring comment on every move path (owner HIST-2b move cancels) ([fec6370](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fec6370275f51b56d018674c8e767593c5cba7ab))
* only the client grants consent, and analytics rows are server-written at the row layer ([8f49223](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8f492230277e75dc8435f15f21ffe659b3949e18))
* **privacy:** a moved client leaves the old coach's chat list, digest, review ring and invites ([add1662](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/add1662bc22f180c684d68382e0f74ebdd0d7309))
* **privacy:** former-coach rows leave row security too; revoke keeps the list's rule ([c57ef80](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/c57ef802f6c1a546039ca34b7b1a903cf06c6b75))
* **privacy:** match vendor deletion and retry retention wording ([7f8113e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7f8113e5bdbeb47be2b4bcc480c0ab2f96dfc75d))
* **privacy:** only a line's author writes it, into a current thread ([db44055](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/db44055813e06cd5bc85656c4672a0c12d144dde))
* **push:** an ordinary push never folds into an urgent one (R1F-2 fix round 1) ([61017b3](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/61017b34272cf8fc1e101f993340ea448caad2c4))
* **push:** the eating-disorder push is never taken over while it waits for 08:00 (EDPUSH) ([98b4ed1](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/98b4ed114a00963e326743d1411aac0da1e4addd))
* **push:** the safety alert line survives the push outbox (B-R1F B1) ([e8f156f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e8f156f0039bcf5f1b986ee68a66dbcb452dc019))
* **rls:** [142] MOVE-RLS — moved client's program copies, meal-plan assignments and stored briefs leave the former coach in row security ([3f49439](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3f49439c992b99e5e08058d7be2c3c42b5ed5146))
* **rls:** [142] READTESTS — a former coach no longer reads or writes a moved client's macro targets ([5778eb6](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5778eb67fcf18f8b1ce976fa403c208c03894ac6))
* **rls:** [142] READTESTS — consultation rows: a removed sub-coach is no member (SQL twin) ([6189907](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/618990716cae495109527c09b9175ff181ffe87b))
* **rls:** [142] READTESTS — the new coach reads the moved client's macro history ([c03f794](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/c03f794d0fbf30d845223ba9ac69054b9eab914a))
* **rls:** a coach reads only the coach-side wearable insight row cached for them ([6bb3105](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/6bb31054bd49e8c6744abd96615f78382bd76de8))
* **rls:** D3 - core health row rules live in a real migration; force RLS on ConnectAccount and Invoice; retire rls_fitness_backend.sql ([9928379](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/9928379ba3eea09254c599331fc13182f0a3c665))
* Roman mark follows consent when Roman wrote the draft, not at send (#ROMANMARK-CONSENT-MARK op 1) ([87af5ac](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/87af5acdc1811f9e23822db05864d42c724e9a60))
* Roman mark only on server-written Roman drafts while the client allows AI help ([69ca9a0](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/69ca9a0c3d3798d95b02bf08f2cb9559611e436e))
* **roman:** a client with no coach gets 403 ROMAN_REQUIRES_COACH on Roman's context reads (139-15) ([29d8a39](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/29d8a39d052fa14795342d600776c6dbe7af0275))
* **roman:** a floor-lifted correction shows grams and kcal left from the same number ([ba7faf8](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ba7faf85f15cb424f0ab6c73a79cd67b4c97cbe2))
* **roman:** coach line follows the coach sentence in the eating-disorder fallback (B-R1F) ([d996c90](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d996c90646e4c106969af4d817409745f26d4da7))
* **roman:** fix round 2 on the urgent-symptoms route (intensity wording, mid-clause questions) ([e4f79db](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e4f79db87a952b367b057c93ec90a796b9b884cc))
* **roman:** fix round 3 on the urgent-symptoms route (clause after but/because, what's this pain) ([393d2e7](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/393d2e7899b59b55179ad7c7531b1e6d4daca2cd))
* **roman:** fix round 4 on the urgent-symptoms route (plural stomach pain, leaflet questions) ([fd5104a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fd5104a12a7992519c7538bba9aa7b7709a1fb1a))
* **roman:** fix round 5 on the urgent-symptoms route ("this side effect" and "these warning signs" are still reports) ([aae5b3c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/aae5b3c050b6dd0f872fab450e7e876c8a4ac14c))
* **roman:** the client context shows the floor-lifted daily target ([06d18c7](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/06d18c72fce9db7f7f41ce9b1a08abadae526db5))
* **scout:** importer stores only the payload fields the mapping declares (PRIV-04) ([0d029ed](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0d029ed4ef83c826d277c0caa6918cd0be33c9eb))
* **security:** voice keys and sign-up markers get their own signing secrets (K5, SEC-06) ([136531a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/136531aa305fa5191dc64214ad9127dad832941c))
* server-side wording sweep (owner rule C-6) ([69b5d41](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/69b5d41ea609104a2cceda8cc780b3bb9f6ace02))
* **throttler:** log invite miss storage failures without exception text ([523422f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/523422f1ff6b6ece28c1fb8231f18814fafc0e93))
* **throttler:** one IPv6 /64 is one wrong invite-code budget ([16323da](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/16323da84ab90c4e4e468ab51418bbeae952525d))
* wearable approve marks only Roman's stored suggestion text or an explicit edit of it ([2d23c9f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2d23c9f3b60a2c4e25f723156e550b3a1860a339))
* wearable approve sends Roman's stored suggestion or is refused; a sync expires it ([b7a9e44](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b7a9e4463784cf604c4dace503541341adae2a1e))
* **workout-builder:** a moved client leaves the former coach's plan assignment list ([79ee6b5](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/79ee6b5ed07fc6efb9b459c50b28b31c8d847806))


### Documentation

* [143] MOVEBILL2 — point the two comments at the renamed migration 20270502001800 ([f2bb540](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f2bb54046d03bdfe523b62a2c9ddb45b96fef394))
* [152] FIX1063 — add Zoom kill line to runbook ([31ad212](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/31ad2129730e6ca2ab5e0ba78f96ce2004780fc8))
* [152] GUARD2 — roman-safety-copy names the current prompt version (roman-client-v5) ([cb572ec](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/cb572ec1805135a960b998ac2b664364fd7a2f3d))
* [152] MSGRT — read-receipt comments name both people ([382b673](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/382b673edb1333469f09342ca88b52cdddd81f1d))
* coach-message materialiser comment names the Roman mark gate ([0259479](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/025947922e5dd71b41b702d439dd97a2a00009c9))


### Refactors

* **v1-coach:** leave owners' thread list unscoped explicitly ([8caa560](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8caa560f6121df6f29c45ffa1575b59e229b15ab))

## 2026-05-15 — Phase 10: Observability

### What shipped

**New module: `src/observability/`**

Production-grade observability for The Growth Project backend.

- **Structured logging** (`app-logger.service.ts`): replaces the default NestJS
  pretty-printer with a JSON logger.  Every line is a single-line JSON object
  with `timestamp`, `level`, `context`, `request_id`, `user_id`, `method`,
  `path`, `status`, `latency_ms`, and `message`.  Controlled by `LOG_LEVEL`
  and `LOG_FORMAT` env vars.

- **Log redaction** (`log-redaction.ts`): recursive `redactObject` walk
  replaces 31 sensitive key names (passwords, tokens, bloodwork, Stripe keys,
  CVV) with `"[REDACTED]"` before any line is written.  A belt-and-suspenders
  `redactLogLine` pass runs on the serialised string as well.

- **Request tracing** (`request-id.middleware.ts`): `RequestIdMiddleware`
  generates a cryptographic `X-Request-ID` per request (or honours an incoming
  one), attaches it to the log context, and returns it as a response header.
  Added to all error response bodies via `HttpExceptionFilter` so support
  engineers can correlate mobile client errors to server logs.

- **Request logging** (`logging.interceptor.ts`): `LoggingInterceptor` emits
  one structured log line per request on completion (success and error paths)
  and drives Prometheus counter/histogram updates.

- **Prometheus metrics** (`metrics.service.ts`, `metrics.controller.ts`):
  `GET /metrics` (no auth) serves Prometheus text format 0.0.4 with:
  - `http_requests_total` (counter, labels: method/route/status)
  - `http_request_duration_ms` (histogram, buckets: 10/25/50/100/250/500/1000/2500/5000 ms)
  - `db_query_total` (counter, labels: model/operation)
  - `redis_op_total` (counter, labels: command)

- **Deep health check** (`health-deep.controller.ts`): `GET /health/deep`
  (no auth) checks DB connectivity via `SELECT 1` and Redis connectivity via
  `PING`.  Returns 200 when all dependencies are healthy; 503 with an `errors`
  array when any fail.

- **CPU profiler** (`profiling.controller.ts`): `GET /debug/profile` starts a
  30-second V8 CPU profile and streams the `.cpuprofile` file.  Requires OWNER
  role AND `PROFILE_ENABLED=on`.  Defaults to off.

**Updated: `src/filters/http-exception.filter.ts`**
- Added `request_id` field to all 4xx/5xx JSON response bodies.
- Added `request_id` to Sentry scope tags for cross-tool correlation.

**Updated: `src/app.module.ts`**
- `ObservabilityModule` registered as the **first** module import so
  `RequestIdMiddleware` runs before `JwtAuthGuard` and `AuditModule`.

**New env vars** (all optional, safe defaults):
- `LOG_LEVEL=log`
- `LOG_FORMAT=json`
- `METRICS_ENABLED=on`
- `SENTRY_TRACES_SAMPLE_RATE=0.1`
- `PROFILE_ENABLED=off`

**Tests** (`test/observability.spec.ts`):
- 30 assertions covering: redaction, request-id generation, metrics format,
  health check response shapes.

### Not changed
- `src/audit/` — owned by the audit-logging agent; untouched.
- No Prisma migrations — this module adds no database tables.

---

## Phase 10 — Rate limiting (2025-01)

### Added

- **Extended throttler config** (`src/throttler/throttler.config.ts`): replaced the single `auth-login` named throttler with a two-layer set of 10 named throttlers covering every route family in the spec. New throttlers: `auth-login-per-min` (5/min/IP), `auth-login-per-hour` (30/hr/IP), `auth-password-reset` (3/hr/IP), `auth-signup` (5/hr/IP), `coach-messages` (30/min/user), `notifications-prefs` (30/min/user), `bloodwork-write` (30/min/user, applied when module ships), `coach-command-center` (60/min/user, applied when module ships), `diagnostic-submit` (5/hr/IP), `default` (300/min/user or 100/min/IP). All limits are overridable via env vars with sane defaults and clamped ranges.

- **`LoginThrottleResetService`** (`src/throttler/login-throttle-reset.service.ts`): clears both `auth-login-per-min` and `auth-login-per-hour` counters for the caller's IP after a successful login. Called from `POST /auth/login`, `/auth/apple`, and `/auth/google`. Prevents a user on a bad Wi-Fi connection from being locked out for an hour after eventually succeeding.

- **`ThrottlerModule`** (`src/throttler/throttler.module.ts`): lightweight module that exports `LoginThrottleResetService` for injection into `AuthModule` and any future module that needs to interact with throttler state.

- **Updated `UserThrottlerGuard`** (`src/throttler/user-throttler.guard.ts`): added `canActivate()` override to skip all throttle checks for health-probe paths (`/health`, `/healthz`, `/readyz`) so Fly.io liveness probes can never exhaust the per-IP quota. Added `Fly-Client-IP` header support as the highest-priority IP source in `getTracker()` (before `X-Forwarded-For` and `req.ip`).

- **Updated `ThrottlerExceptionFilter`** (`src/filters/throttler-exception.filter.ts`): 429 responses now include a `Retry-After` HTTP header (integer seconds, RFC 7231) and a `retryAfter` field in the JSON body. The sanitized body still reveals no internal limit details.

- **Updated `AuthController`** (`src/auth/auth.controller.ts`): login/apple/google handlers now use `auth-login-per-min` + `auth-login-per-hour` dual throttlers (5/min + 30/hr per IP, down from 10/min). Password-reset uses `auth-password-reset` (3/hr, down from 5/15min). All `@Throttle` decorators reference `THROTTLER_NAMES` constants rather than bare strings.

- **Updated `CoachMessagingController`** (`src/messaging/coach-messaging.controller.ts`): `POST /coach/clients/:id/messages` now uses the named `coach-messages` throttler instead of the anonymous `default` bucket.

- **Updated `NotificationsController`** (`src/notifications/notifications.controller.ts`): `PUT /notifications/preferences` now uses the named `notifications-prefs` throttler (30/min/user).

- **Env vars**: 10 new optional env vars (`RATELIMIT_ENABLED`, `RATELIMIT_AUTHED_PER_MIN`, `RATELIMIT_ANON_PER_MIN`, `AUTH_LOGIN_PER_MIN`, `AUTH_LOGIN_PER_HOUR`, `AUTH_PWD_RESET_PER_HOUR`, `COACH_MESSAGES_PER_MIN`, `NOTIF_PREFS_PER_MIN`, `BLOODWORK_WRITE_PER_MIN`, `COACH_CMD_CENTER_PER_MIN`). Added to `.env.example` and `src/common/env-validation.ts`.

- **`src/throttler/README.md`**: full route table (route → limit → window → tracker key), 429 response shape, env-var reference, storage backend docs, future-work notes.

- **`test/rate-limit.spec.ts`**: comprehensive test suite — named limit table, `@Throttle` metadata assertions on every throttled handler, `getTracker` IP resolution (Fly-Client-IP priority, XFF fallback, IP fallback, unknown), health-path skip, 429 response shape + `Retry-After`, global `APP_GUARD` wiring, Redis/in-memory fallback, `THROTTLER_NAMES` uniqueness + completeness.

### Changed

- `auth-login` (single 10/min limit) → split into `auth-login-per-min` (5/min) + `auth-login-per-hour` (30/hr). Both must be declared in the `@Throttle` decorator on each login endpoint; the throttler fires whichever is exhausted first.
- `auth-password-reset` window: 5/15min → 3/hr (tighter sustained cap, wider window).
- Default catch-all limit: 60/min → 300/min for authenticated users (was conservative; user-id keying makes 300/min safe), 100/min for unauthenticated.

### Notes for the next operator

- The `bloodwork-write` and `coach-command-center` throttlers are fully configured in the limit table and tested but not yet applied as `@Throttle` decorators — those route families don't exist yet. Add the decorator to the handler when the module ships.
- Set `REDIS_URL` before scaling beyond one Fly machine so limits are shared across the fleet.

---

## Phase 10 — GDPR delete (right to erasure) — 2026-05-08

Added a complete two-phase deletion flow in `src/account-deletion/`.

**What changed:**

- New module `src/account-deletion/` with controller, service, tests, and README.
- New endpoints:
  - `POST /me/delete-account` — requests deletion, sends a single-use 24-hour email confirmation link.
  - `GET /me/delete-account/confirm?token=...` — confirms deletion via one-time token; starts the 14-day grace period.
  - `POST /me/delete-account/cancel` — cancels a pending deletion within the grace window.
  - `GET /me/delete-account/status` — returns machine-readable deletion state (`none | requested | confirmed | deleted`).
  - `POST /admin/users/:id/delete` — admin (OWNER role) force-delete; bypasses confirmation and grace period; fully audited.
- New Prisma migration `20260507100000_add_gdpr_deletion_flow`:
  - Adds `deletion_requested_at`, `deletion_confirmed_at`, `deletion_token_hash`, `deletion_token_expires_at` to `User`.
  - Creates `deletion_audit` table for GDPR audit trail.
- Per-model cascade strategy: documented inline in service. Hard-delete for user-owned data; delete for cross-party rows with non-nullable FKs; anonymize (null actor) for AuditLog; delete for CoachMessage threads (sender body cleared).
- Nightly finalize cron (default 03:00 UTC via `DELETION_FINALIZE_CRON`) scrubs PII on accounts past the grace period. Idempotent.
- New env vars: `DELETION_GRACE_DAYS=14`, `DELETION_FINALIZE_CRON`, `DELETION_TOKEN_TTL_HOURS=24`.
- `AccountDeletionModule` wired into `AppModule`.

**Dependencies / follow-ups:**

- Data export (Phase 10 Wave C) must ship before this flow is enabled in production — GDPR Art. 20 portability must precede erasure.
- Email confirmation is logged to console in this PR; wire to Phase 9 transactional mailer before go-live.
- Supabase Auth user cleanup (delete auth row when account is finalized) is a follow-up.

---

## Phase 10 — Data Export (2026-05-08)

### Added

- **GDPR right to data portability (Article 20)** — users can request a complete JSON export of all their personal data.
  - `POST /v1/me/data-export/request` — enqueue export; rate-limited to 1 per 24 hours.
  - `GET /v1/me/data-export/status` — poll export status (`PENDING` → `RUNNING` → `READY`).
  - `GET /v1/me/data-export/download?token=` — redirects to S3 presigned URL; never pipes file through API.
  - Export includes: user profile, weight/food/water/workout logs, fasting windows, habits, check-ins, meal plans, coaching messages (own messages verbatim, third-party messages redacted), build week progress, diagnostic submissions, PTM signals, audit log entries about the user, and more. Full model table in `src/data-export/README.md`.
  - 7-day signed download link emailed to user on completion.
  - S3-compatible storage with server-side AES256 encryption. Falls back to local filesystem when `DATA_EXPORT_BUCKET` is unset.
  - Nightly cleanup cron (03:00 UTC) marks expired exports and deletes files from storage.
  - Prisma migration: `data_export_request` table with `DataExportStatus` enum.

- **Mobile: Data Export screen** — `src/screens/settings/DataExportScreen.tsx`
  - "Request my data" button with explanation of what's included.
  - Status display: pending / in-progress (auto-polling every 5 s) / ready / failed / expired.
  - "Download file" button when ready — opens signed URL in external browser.
  - Wired into Client Settings and Coach Settings screens.

- **Compliance docs** — `docs/compliance/data-portability.md` (GDPR Article 20 implementation notes).

### New env vars

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATA_EXPORT_TOKEN_SECRET` | (must set in prod) | Signs the download JWT. |
| `DATA_EXPORT_BUCKET` | — | S3 bucket. Falls back to filesystem if unset. |
| `DATA_EXPORT_S3_ENDPOINT` | AWS default | Custom S3 endpoint (Fly/MinIO). |
| `DATA_EXPORT_FS_DIR` | `/tmp/exports` | Filesystem fallback directory. |
| `DATA_EXPORT_EXPIRY_DAYS` | `7` | Days the download link stays valid. |
| `DATA_EXPORT_RATE_LIMIT_HRS` | `24` | Hours between requests per user. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | — | Email delivery for the ready notification. |

---

## [Unreleased] — Phase 10: Audit Logging Expansion

### Added

- **`AuditAction` enum expanded** — 16 new action constants in `src/audit/audit.service.ts`:
  `auth.login`, `auth.login_failed`, `auth.apple_signin`, `auth.password_change`,
  `auth.biometric_unlock_setup`, `coach.assigned_client_change`, `coach.viewed_client_data`,
  `ptm.risk_board_view`, `notification.pref_change`, `bloodwork.view`,
  `bloodwork.disclaimer_acked`, `bloodwork.entry_created`, `bloodwork.entry_updated`,
  `leaderboard.optin_changed`, `consent.granted`, `consent.revoked`.

- **`AuditController`** — new `GET /admin/audit/log` endpoint (owner-only, JWT + RolesGuard).
  Identical filter and pagination contract to the legacy `/admin/audit-log`. Added to
  `AuditModule` controllers array.

- **`AUDIT_LOGGING_ENABLED` kill switch** — optional env var read on every `AuditService.write()`
  call. Set to `off` to suppress audit writes without touching call sites. Documented in
  `.env.example` and `src/audit/README.md`.

- **Auth hooks** — `auth.service.ts` writes `auth.login` on successful email/password login,
  `auth.login_failed` on credential failure (metadata: `{ reason: "invalid_credentials" }` —
  password never stored), and `auth.apple_signin` on successful Apple Sign-In. Controller
  passes `auditContext(req)` for IP and user-agent capture.

- **Coach hooks** — `coach.service.ts` writes `coach.viewed_client_data` after the client
  ownership check passes in `getClientTimeline()` and `getClientSummary()`. Fire-and-forget
  (`void`), so failures never block the response.

- **PTM hooks** — `admin-ptm.service.ts` writes `ptm.risk_board_view` when the controller
  supplies an actor context. Existing `ptm.outcome_labelled` hook unchanged.

- **Notification hooks** — `notifications.service.ts` writes `notification.pref_change` on
  `updatePreferences()`. Metadata contains only the changed key names, never the new values.

- **`src/audit/README.md`** — full module README covering the endpoint contract, Prisma model,
  the complete action enum table with metadata fields, redaction policy, services wired,
  test coverage, retention policy, and future work.

- **`test/audit-phase10.spec.ts`** — 11 test groups covering kill switch behavior, action
  constant correctness, append-only contract enforcement, `AuditController` role guard, auth
  audit payload shapes (login, login_failed never contains password, apple_signin never
  contains token), coach/PTM/notification audit payload shapes.

### Changed

- **`src/audit/audit.module.ts`** — added `AuditController` to the `controllers` array.
- **Root `README.md`** — added `AUDIT_LOGGING_ENABLED` to the variable matrix; updated the
  `AuditLog` section to reference Phase 10 wiring; added `GET /admin/audit/log` to route
  contracts; added Phase 10 row to the Open Work / merge-order table.

### Notes

- No new Prisma migration required — the `AuditLog` model and all required indexes already
  existed on `main` from PR #73.
- Bloodwork (`bloodwork.*`) and leaderboard (`leaderboard.optin_changed`) constants are defined
  in this PR; wiring lives in PR #103 (`feat-bloodwork-rails`) and PR #148
  (`feat/phase-7c-peer-leaderboard`) respectively.
- All new service method params use `= {}` defaults to preserve backward compatibility with
  existing tests that construct services without the audit context argument.

---

## 2026-05-08 — Phase 10 Track 7: Secrets Rotation

**Branch:** `feat/phase-10-secrets-rotation`

### What shipped

- **Secrets rotation module** (`src/secrets/`): OWNER-only admin surface for tracking when secrets were last rotated and whether any are stale.
  - `GET /admin/secrets/status` — returns the full secret inventory with per-secret rotation metadata (last rotated date, tier, cadence, staleness). Never returns secret values.
  - `POST /admin/secrets/:name/rotation-log` — records a rotation event in the database after the operator has rotated the secret in Fly.

- **Migration** (`prisma/migrations/20260515100000_add_secret_rotation_log/`): Adds the `secret_rotation_log` table with indexed columns for secret name, rotation timestamp, and the user who performed the rotation.

- **`src/common/redact-secrets.ts`**: A utility that strips sensitive values from any object, string, or error before it reaches a log line or HTTP response. Redacts JWTs, database URLs, Stripe keys, and any field whose key matches common secret-naming patterns.

- **JWT dual-key rotation support**: The app now reads `JWT_SIGNING_KEY` and `JWT_SIGNING_KEY_PREVIOUS` to support zero-downtime rotation of the JWT signing key. During a 24-hour transition window, tokens signed with either key are accepted. New tokens are always signed with the current key.

- **Helper scripts** (`scripts/secrets/`):
  - `list.ts` — scans the source tree for `process.env.X` references and cross-references them against the `SECRET_INVENTORY`, flagging any secrets referenced in code but missing from the rotation inventory.
  - `rotate-jwt.ts` — generates a new JWT signing key and prints copy-paste-ready `flyctl secrets set` commands for every step of the dual-key rotation process.
  - `check-staleness.ts` — queries the rotation log and prints a table showing which secrets are overdue for rotation; exits 1 if any are stale.

- **Runbooks** (`docs/runbooks/`):
  - `secrets-rotation.md`: per-secret playbook for JWT_SIGNING_KEY, DATABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SENTRY_DSN, FLY_API_TOKEN, PERPLEXITY_API_KEY, and FINANCE_SERVICE_TOKEN. Each entry covers: purpose, cadence, generate command, set command, verify command, rollback command.
  - `incident-secrets-leak.md`: incident response playbook for a secret exposure — fast revocation commands, audit steps, root-cause prevention.

- **`src/auth/README.md`**: Documents how Supabase JWKS verification works, the JWT dual-key rotation design, and every environment variable this module reads.

- **`.env.example`**: Added `JWT_SIGNING_KEY` and `JWT_SIGNING_KEY_PREVIOUS` with documentation.

### New env vars

| Variable | Tier | Purpose |
|---|---|---|
| `JWT_SIGNING_KEY` | feature | HMAC-SHA256 JWT signing key (current). `openssl rand -hex 32` to generate. |
| `JWT_SIGNING_KEY_PREVIOUS` | feature | Previous JWT signing key. Set during 24h rotation window. Clear after 24h. |

### New tables

| Table | Purpose |
|---|---|
| `secret_rotation_log` | Immutable audit trail for secret rotation events. No secret values stored. |

### Security invariants

- Zero secret values in any log line, HTTP response, or error message (enforced by `redact-secrets.ts`).
- The `/admin/secrets/status` endpoint returns only metadata, never values.
- The `POST /admin/secrets/:name/rotation-log` endpoint does not accept secret values — the `notes` field is limited to 500 characters.
- All endpoints are OWNER-only (403 for coach/student roles).

---

## Phase 10 — Track 8: SOC 2 Prep Stubs (2025-05-07)

**Branch:** `feat/phase-10-soc2-prep`

Stages the compliance foundation for The Growth Project's eventual SOC 2 Type I audit. No audit is being conducted now — this track puts the policies, controls documentation, evidence-collection tooling, and quarterly review runbook in place so that when Bradley is ready to book an auditor, the paperwork and evidence trail are already started.

### Documentation shipped

| File | Purpose |
|---|---|
| `docs/soc2/README.md` | SOC 2 journey overview: Type I vs Type II, where we are, pre-audit checklist, expected timeline |
| `docs/soc2/policies/information-security-policy.md` | Master security policy template — Bradley fills `<<PLACEHOLDERS>>` and signs |
| `docs/soc2/policies/acceptable-use-policy.md` | Staff / contractor system-use rules |
| `docs/soc2/policies/access-control-policy.md` | Logical access lifecycle (grant, review, revoke); references role-gating track |
| `docs/soc2/policies/data-classification-policy.md` | Four-tier classification (Public → Highly Confidential); bloodwork is Highly Confidential |
| `docs/soc2/policies/incident-response-plan.md` | P1–P4 severity tiers; 5-phase response; GDPR 72-hr notification; secrets-leak runbook cross-ref |
| `docs/soc2/policies/business-continuity-plan.md` | RTO/RPO targets; Fly.io multi-region strategy; Supabase PITR backup discipline |
| `docs/soc2/policies/vendor-management-policy.md` | Subprocessor table with DPA status and SOC 2 cert for each vendor |
| `docs/soc2/policies/change-management-policy.md` | PR review gates, CI requirements, branch protection, emergency change process |
| `docs/soc2/controls/controls-matrix.md` | AICPA Trust Services Criteria CC1–CC9, A1, P mapped to implementing code |
| `docs/soc2/controls/evidence-collection.md` | Step-by-step guide: how to gather audit evidence for each control |
| `docs/soc2/runbook-quarterly-review.md` | 8-step quarterly procedure: access review, snapshot, backup test, secrets rotation, vuln scan, audit log review |

### Code shipped

| File | Purpose |
|---|---|
| `src/admin/soc2/soc2-evidence.controller.ts` | OWNER-only `GET /admin/soc2/evidence-snapshot` |
| `src/admin/soc2/soc2-evidence.service.ts` | Builds snapshot bundle: Fly config, schema hash, route list, redacted audit log, deploy history |
| `src/admin/soc2/soc2-evidence.module.ts` | NestJS module wiring |
| `src/admin/admin.module.ts` | Updated to register `Soc2EvidenceController` + `Soc2EvidenceService` |

### Tests shipped

| File | What it asserts |
|---|---|
| `test/soc2-evidence.spec.ts` | Role guard: owner allowed, coach/student/unauthenticated rejected with 403. Snapshot shape: all top-level keys present, `snapshotAt` is valid ISO-8601, `roleDecoratedRoutes` is non-empty with correct structure, `evidence-snapshot` route carries `owner` role. PII safety: actor email is redacted (`br...@example.com`), IP excluded, user-agent excluded, metadata (health data) excluded. Resilience: empty audit log and Prisma error both handled gracefully. |

### Placeholders Bradley must fill before any policy is "live"

Every policy document is a template. Before signing, fill these placeholders (search across `docs/soc2/` for `<<`):

| Placeholder | Appears in | What to fill |
|---|---|---|
| `<<COMPANY_NAME>>` | All policies | Legal company name (e.g. "The Growth Project Ltd.") |
| `<<EFFECTIVE_DATE>>` | All policies | Date of signing |
| `<<POLICY_OWNER_NAME>>` | All policies | Person responsible for the policy (likely Bradley) |
| `<<POLICY_OWNER_TITLE>>` | All policies | Job title |
| `<<POLICY_OWNER_EMAIL>>` | Incident Response | Contact email |
| `<<DPO_EMAIL>>` | Data Classification, Vendor Management | DPO or privacy contact email |
| `<<CEO_NAME>>` | All policies | Founder name |
| `<<CEO_OR_FOUNDER_TITLE>>` | All policies | Title (e.g. "Founder & CEO") |
| `<<NEXT_REVIEW_DATE>>` | All policies | 12 months from effective date |
| `<<JWT_EXPIRY>>` | Access Control, Controls Matrix | JWT expiry hours (check Supabase settings) |
| `<<FLYIO_ADMINS>>` | Access Control | Names/emails with Fly.io org access |
| `<<SUPABASE_ADMINS>>` | Access Control | Names/emails with Supabase project access |
| `<<GITHUB_ADMINS>>` | Access Control | GitHub org admin list |
| `<<STRIPE_ADMINS>>` | Access Control | Stripe team admin list |
| `<<SENTRY_ADMINS>>` | Access Control | Sentry org admin list |
| `<<ACCESS_LOG_LOCATION>>` | Access Control | Google Drive folder path or URL |
| `<<TRAINING_LOG_LOCATION>>` | Information Security | Location of training records |
| `<<EXCEPTION_LOG_LOCATION>>` | Information Security | Location of policy exception log |
| `<<VULN_SLA_CRITICAL_DAYS>>` | Information Security | Days to fix critical CVEs (recommend: 7) |
| `<<VULN_SLA_HIGH_DAYS>>` | Information Security | Days to fix high CVEs (recommend: 30) |
| `<<UPTIME_TARGET>>` | Information Security, BCP | e.g. "99.5%" |
| `<<RTO_HOURS>>` | BCP | Recovery Time Objective in hours (recommend: 4) |
| `<<RPO_HOURS>>` | BCP | Recovery Point Objective in hours (recommend: 1) |
| `<<SUPABASE_PLAN>>` | BCP | Supabase billing plan (Pro/Enterprise for PITR) |
| `<<PITR_ENABLED>>` | BCP | Yes/No — check Supabase dashboard |
| `<<BACKUP_RETENTION_DAYS>>` | BCP, Quarterly Runbook | Supabase backup retention window |
| `<<PRIMARY_REGION>>` | BCP | Fly.io primary region (e.g. "iad") |
| `<<SECONDARY_REGION>>` | BCP | Fly.io secondary region (e.g. "lhr") |
| `<<FLY_APP_NAME>>` | BCP, IRP, Quarterly Runbook | Fly.io app name |
| `<<STATUS_PAGE_URL>>` | BCP | Public status page URL |
| `<<SUPPORT_EMAIL>>` | BCP | Public support email for user communication |
| `<<INCIDENT_LOG_LOCATION>>` | IRP | Google Drive folder for incident records |
| `<<BACKUP_STORAGE_LOCATION>>` | BCP, Quarterly Runbook | S3 or GCS bucket for manual backups |
| `<<EVIDENCE_FOLDER>>` | Evidence Collection, Quarterly Runbook | Root path for evidence files |
| `<<VENDOR_EVIDENCE_LOCATION>>` | Evidence Collection | Path for vendor SOC 2 reports |
| `<<VENDOR_LOG_LOCATION>>` | Vendor Management | Log of vendor changes |
| `<<INFRA_CHANGE_LOG_LOCATION>>` | Change Management | Log of infrastructure changes |
| `<<REQUIRED_APPROVERS>>` | Change Management | Number of required PR reviewers |
| `<<RECOMMENDED_PASSWORD_MANAGER>>` | Acceptable Use | Recommended password manager (e.g. "1Password") |
| `<<BLOODWORK_MODEL>>` | Data Classification | Prisma model name for bloodwork (add when feature ships) |
| `<<HIGHLY_CONFIDENTIAL_RETENTION_YEARS>>` | Data Classification | Health data retention (recommend: 7) |
| `<<CONFIDENTIAL_RETENTION_YEARS>>` | Data Classification | PII retention (recommend: 3) |
| `<<SUPABASE_REGION>>` | Vendor Management | Supabase project region |
| `<<FLY_REGIONS>>` | Vendor Management | Active Fly.io regions |
| `<<POSTHOG_REGION>>` | Vendor Management | PostHog cloud region |
| `<<EMAIL_PROVIDER>>` | Vendor Management | Transactional email provider (e.g. Resend, SendGrid) |
| `<<OBJECT_STORAGE_PROVIDER>>` | BCP | Object storage provider (e.g. AWS S3, Cloudflare R2) |
| `<<RISK_REGISTER_LOCATION>>` | Controls Matrix | Location of formal risk register |
| `<<DEFICIENCY_LOG_LOCATION>>` | Controls Matrix | Location of control deficiency log |
| `<<JWKS_CACHE_TTL>>` | BCP | JwksVerifierService cache TTL (check src/auth/jwks.service.ts) |

### Cross-references to other Phase 10 tracks

These are referenced in the docs and code. Link to the final PR once each track merges:

- `feat/phase-10-audit-logging` — `AuditLog` table and `AuditService` backing the audit log sample
- `feat/phase-10-role-gating` — `RolesGuard`, `@Roles()` decorator, `RolesEnforced` meta-test
- `feat/phase-10-observability` — Sentry + structured logging referenced in controls matrix
- `feat/phase-10-rate-limiting` — `ThrottlerModule` referenced in CC6.6
- `feat/phase-10-gdpr-delete` — `GdprScrubService` referenced in P6.6
- `feat/phase-10-data-export` — DSAR endpoint referenced in P6.1
- `feat/phase-10-secrets-rotation` — secrets rotation runbook referenced in IRP and quarterly review

### No new env vars, no new Prisma models, no migrations

This track is docs + minimal backend code only. Zero schema changes.

### No new env vars added to `.env.example`

The evidence-snapshot endpoint reads existing env vars (`FLY_APP_NAME`, `FLY_PRIMARY_REGION`, feature flags). A new optional var `FLY_API_TOKEN` is read by `Soc2EvidenceService` for the Fly.io releases fetch — it defaults to empty and the endpoint gracefully returns an empty `deploymentHistory` array when absent.

## Phase 10 — Role-Gating Hardening (2026-05-08)

**Branch:** `feat/phase-10-role-gating-hardening`  
**Track:** 5 of 10 (Phase 10)

#### What shipped

- **Comprehensive role audit.** Every one of the ~115 backend route handlers was audited for role decoration. Found 23 controllers (~65 routes) that relied solely on `JwtAuthGuard` without an explicit `@Roles(...)` decorator.

- **@Roles('student') added to 23 student-facing controllers.** Routes that return user-owned data now declare `@Roles('student')` at the class level. This is documented intent — it means "any authenticated user (student, coach, or owner) can access their own copy of this data." Combined with service-layer `user_id` scoping, this is defense-in-depth.

- **RecentAuthGuard.** New guard (`src/auth/recent-auth.guard.ts`) that validates a short-lived HMAC token on sensitive actions. The token is issued by `POST /auth/recent-auth-token` after the user re-enters their password. Default validity: 5 minutes. Token is bound to the authenticated user's id.

- **RecentAuthGuard applied to `DELETE /users/me/account`.** Account deletion now requires re-authentication within 5 minutes. This is the highest-impact irreversible action available to a student.

- **RolesEnforced meta-test.** `test/roles-enforced.spec.ts` walks every controller in `AppModule` via NestJS metadata reflection. If any new handler is added without `@Roles(...)` or `@Public()`, the test fails CI with the exact route name. Bradley sees "Route is ungated: MyController.myMethod" in the build log.

- **Cross-tenant isolation test.** `test/cross-tenant-isolation.spec.ts` asserts service-layer `userId` scoping — user A's query never returns user B's data.

- **`docs/security/role-gating.md`.** Full per-route table: route → roles → guard → notes, generated from the audit.

- **`src/auth/README.md` extended.** Added role taxonomy, decoration rules, re-auth flow diagram, new env vars, new test coverage.

- **`.env.example` updated.** Added `RECENT_AUTH_SECRET` and `RECENT_AUTH_TTL_MS`.

#### Files changed

- `src/auth/recent-auth.guard.ts` — New: RecentAuthGuard + issueRecentAuthToken helper
- `src/auth/auth.service.ts` — Added issueRecentAuthToken method
- `src/auth/auth.controller.ts` — Added POST /auth/recent-auth-token endpoint
- `src/auth/auth.dto.ts` — Added IssueRecentAuthTokenDto
- `src/auth/auth.module.ts` — Export RecentAuthGuard
- `src/auth/README.md` — Extended with Phase 10 section
- `src/users/users.controller.ts` — Added @Roles('student') + RecentAuthGuard on DELETE /users/me/account
- `src/profile/profile.controller.ts` — Added @Roles('student')
- `src/timeline/timeline.controller.ts` — Added @Roles('student')
- 20 × student-facing controllers — Added @Roles('student') + RolesGuard
- `docs/security/role-gating.md` — New: full per-route audit table
- `.env.example` — Added RECENT_AUTH_SECRET, RECENT_AUTH_TTL_MS
- `test/roles-enforced.spec.ts` — New: meta-test, fails CI on ungated routes
- `test/recent-auth.guard.spec.ts` — New: 8 unit tests for RecentAuthGuard
- `test/cross-tenant-isolation.spec.ts` — New: service-layer scoping tests

#### Follow-ups

- Apply `RecentAuthGuard` to `POST /admin/users/:id/promote` and the Phase 10 GDPR force-delete endpoint when those PRs land.
- Migrate legacy bespoke guards (`CoachGuard`, `CoachOrOwnerGuard`, `OwnerGuard`) to `@Roles(...)` to eliminate the legacy-guard allowlist in `roles-enforced.spec.ts`.
- Add biometric re-auth token path on mobile (currently password-only).
