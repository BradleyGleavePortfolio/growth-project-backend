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

## [0.1.1](https://github.com/BradleyGleavePortfolio/growth-project-backend/compare/v0.1.0...v0.1.1) (2026-11-07)


### Features

* [180] SC-PURPOSE-BE - a space's purpose reaches its members ([7acfd4f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7acfd4fe9ee9e6f9f8dffa85f05c437362facb40))
* [192] FOOD-SEED-BE — a refused insert prints its reason on one deploy-log line ([8fb01df](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8fb01df58fde34fc7d2a02e61cb76d2d3d052cef))
* [192] FOOD-SEED-BE — each deploy adds the built-in foods production is missing ([d0982a0](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d0982a09850c916a0951ea960abd4c41bb9f1e88))
* [192] FOOD-SEED-BE — each deploy adds the built-in foods production is missing ([8b5b95e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8b5b95eb51f6b98241966f913943c15b36e48540))
* [192] FOOD-SEED-BE — step 5 runs in one transaction under an advisory lock, so two runs never add a food twice ([8055766](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/805576636e750e3747e16c25b940e9429b8ebaf3))
* [193] FOOD-USDA-BE — release step 6 adds every USDA SR Legacy and Foundation food the shared catalog lacks, built from USDA's own files ([fae26c5](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fae26c504174e6c5df6ab71e17dce92cca1d7d9c))
* [193] FOOD-USDA-BE — tests first for the word search and the USDA file: the file against a committed CSV cut, release step 6 live (adds once then 0, member food untouched, a fix survives), the seven foods found from the catalog alone ([cdf1ba7](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/cdf1ba71d2c0e6492a60c246db42c1f77e99e969))
* [193] FOOD-USDA-BE — the catalog's word search answers first, without pg_trgm (whose query failed on every search); the USDA file says where each left-out built-in food's numbers come from ([43fbe55](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/43fbe55f3f939f3cba6b78d00f900bfa994c4bcd))
* [193] FOOD-USDA-BE — USDA file carries the fat kinds and leaves out the 56 SR Legacy foods a built-in food stands for (committed map, checked by numbers) ([c146d98](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/c146d9816cfe729e4374043ae7d7fee52438b2fb))
* [193] TIMED-SETS-BE — each plan exercise says reps or seconds ([8a99e76](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8a99e76f0a74bd46650ddda1d5f9753c32afc160))
* [193] TIMED-SETS-BE — each plan exercise says reps or seconds ([a7ee931](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a7ee931bb4501ab0eea1fd14366356afc2b5b74f))
* [195] SET-ASKED-BE — each logged set keeps what the plan asked that day ([fce4538](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fce45387162013c78c31d46e988b3d3526a924c2))
* [195] SET-ASKED-BE — each logged set keeps what the plan asked that day ([8c2a103](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8c2a1038a530fdf29320b7b718011461e5e8668e))
* [198] ROMAN-HOLD — report target for a Roman reply (server half) ([d55dd48](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d55dd48f30128231e6d878e545fccf05d293a178))
* [199] MONEY-DAILY — the money check runs every day over every purchase and tells the owner clean or needs review ([491ed11](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/491ed1176868d9305c530867f094d21bbbade834))
* **EXID-BE:** routine exercises keep their library exercise id (catalog_exercise_id, migration 20270502010700) ([07d1050](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/07d1050ee29b17f10aa01f19541b00563b89046d))
* GC-3 web page trials (card saved, nothing charged that day, one trial per coach) ([16ecf85](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/16ecf857325e8ce5f56c538dabfcd1d76f649409))
* **PF-7-BE:** a renewal failing on a coach Stripe account that can't take payments waits, tells the coach, and is paid once fixed ([df78a93](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/df78a930adbff1e280f28ab13aeba5aa6b0a1b71))
* **plan-swaps:** swaps and recipe on a plan meal, today's plan changes, plan items on the grocery list (C2 S2) ([dc3ea4d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/dc3ea4d287f451a3ae907352c5870b8e3b39fd95))


### Bug Fixes

* [182] FIRST-PAY-WEB — a sale through the web pay page counts as the coach's first payment ([1bef2db](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/1bef2db66111c9e4bf8acd39d4159a114a7bccd5))
* [189] COUNT-DELETED-BE — every count a coach sees leaves out removed messages and blocked, banned or departed members ([b8c7ebd](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b8c7ebd66625426abd62c3940c5cb4c54a9b0728))
* [190] TRIAL-WORDS-BE — the web return page says a free trial is starting, not a payment ([02a904a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/02a904a60e95fcf9b1cd65cc3bf63e5a29324f1b))
* [191] HOLD-FU-BE — one readiness rule for every sale, a held renewal never shown as the client's failed charge, and the brief keeps every payment line ([2dde46f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2dde46fb9ffec6a0337f1b3d0f80f8e90d890c24))
* [191] HOLD-FU-BE — one readiness rule for every sale, a held renewal never the client's failed charge, the brief keeps every payment line ([68e0ef1](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/68e0ef1b0d7f34d4a2d2adab8ca6ee04c011ef51))
* [191] TRIAL-FU-BE — a web trial's dates in Pacific time, and Update card finds the card the trial saved ([74deade](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/74deade8cefa70e63d0accb4800dd83f5f2582e7))
* [191] TRIAL-FU-BE — a web trial's dates in Pacific time, and Update card finds the card the trial saved ([52be434](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/52be43402902107351c6286001398347d84c3785))
* [192] ACTUAL-AUTHOR-READS-BE — a blocked team coach's words stay out of the thread detail and AI context ([fac1940](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fac19400b83bf1a5cbb30ceaab1535676511f95c))
* [192] FR-1201 — a refused second web trial no longer blocks the coach archiving its package ([84cd05e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/84cd05ebb2d6619ace2423cc7a851a1e0ae4f914))
* [192] FR-1201 — the thank-you page's Next charge row is the buyer's Pacific day, from the pay page's one charge-day helper ([be55325](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/be553252a871b60c6b581e1597cbd4a07d879c2e))
* [192] FR-1202 — a held renewal on a plan paid before keeps its earlier payments in the phone installed today ([4b19cb6](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/4b19cb6b003173bf407a2ed1ef63e6458ad95d75))
* [192] WATER-WEIGHT-KEYS-BE — a water or weight save sent twice counts once ([0ce85dc](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0ce85dc55f89ab59c1f5613f920237a703b41882))
* [192] WATER-WEIGHT-KEYS-BE — a water or weight save sent twice counts once ([454af1f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/454af1f2624d4d746833d42b1515f6e70ddbd436))
* [193] 1TO1-FU-BE — a join the coach cannot take says the coach is not accepting clients ([7ac38e3](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7ac38e3fd1d0e354df5271e1f85e6bf73f451818))
* [193] 1TO1-FU-BE — a join the coach cannot take says the coach is not accepting clients ([2908c4a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2908c4a62d62bd8c7f44970d43baece9bf1cedcc))
* [193] FOOD-USDA-BE — after FR-1203's five SR Legacy seed values, the built-in map leaves out those five USDA foods too (8,056 foods); the compiled copy carries both release scripts ([ba1d332](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ba1d332ce1ea439d246c11cdeab566ca850b116f))
* [193] FR-1203 — R-SEED-1: five seed rows per 100 g from FDC SR Legacy (172388, 173709, 170108, 168322, 174289) ([b5c0d91](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b5c0d91081928ff76a80f8b4bd6ed127cab90836))
* [193] FR-1203 — step 5 folds names one way in SQL, key and after-check (LS-1203 B1) ([b8a77da](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b8a77dad943decfb85808ec8bdc9e46c0809bc82))
* [193] FR-1206 — a keyed resend that stores nothing new keeps Roman's context ([ef4db46](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ef4db462704795780faf6bcaf0b7ceb43538067b))
* [193] TIMED-SETS-BE — the AI applier copies a snapshot row's unit as is; tests expect the unit on saved and frozen rows ([e4e160e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e4e160ed7a3982dc506bdd35cb404b1d01cdbf49))
* [194] ALL-ON-FIX-BE — broadcasts and community lists leave out a moved client; card link reads dunning v2 ([56933e8](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/56933e88e3bd34415818fe1fcb080ea4535d41a4))
* [194] COACH-DAY-ORDER-BE — coach timeline files workouts by the day done ([7feb732](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7feb73272235516b8eda9dfd9b73e2b2dc4fc1f1))
* [194] COACH-DAY-ORDER-BE — the coach sees a workout on the day it was done ([7a1f1c6](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7a1f1c62ff021c6ac4dbff932bc4f4fdde53fd8f))
* [194] HELD-RENEWAL-BE — a renewal TGP holds is sent as held, not past due ([cb59ff5](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/cb59ff5d485b36904d91cd879202f9ddba42f6ae))
* [194] HELD-RENEWAL-BE — a renewal TGP holds is sent as held, not past due ([f5a9d2b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f5a9d2b6534be23b2bbb535e72e957053cda3eea))
* [194] HELD-RENEWAL-BE — keep CONTRACT-1's moved-client money record shape ([a6af1dc](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a6af1dcd97b87250a64b7dc2329d581300597c28))
* [195] FOOD-RESEND-ROMAN-BE — a resent meal, saved meal or workout keeps Roman's context ([f5ea160](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f5ea1601327041f32ce92fab50e9e0880c782d8c))
* [195] TIMED-SETS-CONTEXT-BE — Roman and the AI workout context read each exercise's reps or seconds ([da2f0f7](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/da2f0f7054005c0b7aa838d5e81cc881fa0ef5f3))
* [197] FIX-1222 b[#1222](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/1222) round 1: real low-energy foods, stored alcohol, held rows, legacy missing macros, 404 not 500 ([74fe516](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/74fe51649c74cc6f8adabacb0122c02654df5441))
* [197] FIX-1222 LO-1222 N2: search cache key v5 (a v4 answer may hide real foods); README names it ([17d8a00](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/17d8a0036b76916ff8a2ff2044035786c37bd098))
* [197] FIX-1222R2 lists tell a USDA Branded row by its stored brand (USDA gives one only on Branded); a generic USDA row's 0 g stays listed (round-1 matrix) ([d8bf5a8](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d8bf5a8ddf4ea93ad75e0cc8d98a8c921d97c444))
* [197] FIX-1222R2 one held-row check on every path: stored numbers read with what the source lists; a stored 0 g only when the source lists 0 (lists: USDA Branded too); fibre outside carbohydrate ([2d372d5](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2d372d50d8cfff22dbba63e95772868e67500382))
* [197] FIX-1222R2 search cache key v6 (a v5 answer may show a legacy Branded zero or hide a fibre-outside food); README names it ([89999e9](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/89999e912675e984c9bb46d82baccbb2ee903f5e))
* [197] FOOD-TRUE-BE — a food whose numbers cannot be true never shows; missing macros never read as 0 g ([1016add](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/1016add4d1f8c4c75795fb1df6b453afbf978a53))
* [197] FOOD-TRUE-BE — a food whose numbers cannot be true never shows; missing macros never read as 0 g ([93b87fa](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/93b87fab6201fc90a0ef01736084cdf4d6ccd0fa))
* [199] FIX-1181 — a trial's card save never claims the first-payment notice; the first paid invoice after a web trial does (owner [#198](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/198)-E9 op 1) ([bc29c3f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/bc29c3fdfdd366ce3c5f1155aa1205405a3dfc64))
* [199] NUDGE-REACH-BE — a coach's nudge reaches the client (inbox row and push) ([843cd82](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/843cd82a63d9a52d0d498c99bcbc414f9ba980f2))
* [200] FIX-1225 one money check per UTC day, every money state, the whole inbox text ([d117e32](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d117e329e7e19ab293d2d5a511c8cdbb2ab4ad20))
* [200] FIX-1225R2 every written money state checked, never charged means no charge of any kind ([708ee69](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/708ee69d6740dc53c460a6bb648d82963c28a0ae))
* [200] FIX-1226 a nudge resent after a lost reply is one nudge, one inbox row and one push ([3310358](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3310358b688465a173dd9821bfb1bf17eb9d98a0))
* [200] SEND-ONCE-SERVER — a challenge comment lands once under an Idempotency-Key ([4c9a615](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/4c9a61580f1f5cf37b2481c17c9c39d07cdf37d4))
* [200] SEND-ONCE-SERVER — a one-to-one message lands once under an Idempotency-Key ([f58ef2a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f58ef2a1f9413c664e66eb47b2082758c7d31ded))
* [200] SEND-ONCE-SERVER — a post lands once under an Idempotency-Key ([b1b08ed](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b1b08eda3acb8e1f56b66ace20ba6ecbe4e35c45))
* [200] SEND-ONCE-SERVER — a post's comment lands once under an Idempotency-Key ([66df11c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/66df11cef4657fa59ed1bb5e88ff5df43443dc64))
* [200] SEND-ONCE-SERVER — a Roman turn lands once under an Idempotency-Key ([07c0703](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/07c07031c8875db73b1c150e24d9097efa832cd2))
* [200] SEND-ONCE-SERVER — a Roman turn, a one-to-one message, a post and its comments land once under an Idempotency-Key ([b4972b4](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b4972b460d3ad5df10fbffa2471a8b851cd97b44))
* [201] FIX-1225R3 every known charge is read before ok, a web trial's SetupIntent is not a payment intent ([e9283bb](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e9283bb08e620c74ef04b0001d7452621a89d2a8))
* [201] FIX-1225R3 the ledger fallback reads the newest destination slice from the rows already loaded ([44194a0](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/44194a0356e25e91805a9ade7611ced2c0855390))
* a blocked team coach's words stay out of saved and derived text (FR-1205: LO-1205 B1, LS-1205 B1-B5) ([0222a44](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0222a44059512a174e256e54c789449629e9a335))
* a held money push waits when a read before the handoff fails (FR-1192R4 B1) ([78974d1](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/78974d141eb4d9c321f7dd9a4bdaa48b16885f73))
* a renewal failure with no fresh answer from Stripe gets main's ten days, never a guessed hold ([f998c12](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f998c12773006679e8550a2f3571097650b98c25))
* **ai:** validator checks the row the applier writes: unit, bounds and rep cap on the effective unit (LS-1211 B2) ([adda7c1](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/adda7c1dc1750dc64085b4553806437000cc636c))
* coach AI, gateway and client AI contexts read thread words by the actual author (LS-1197R2 B2) ([e66d2a4](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e66d2a4500695e964ea62d97410d1b5f797a9eb6))
* **coach-brief:** write today's brief again when a renewal entered or left the hold (LS-1195R2 B3, ruling R10) ([58e70b6](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/58e70b64d6f68cbe305a7664815f396fb91292f7))
* **coach-money:** leave held renewals out of the attention query before its limit (LS-1195R2 B2) ([b79027c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b79027cd590e348af592494a0b989a342f5b489c))
* **COUNT-DELETED-BE:** one count rule for every coach and member count and preview ([d19ec67](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d19ec67e1f53e6f2b6427364acdd90f6dbb35753))
* FIX-1221 copy a revision by spread (a revision is not a slot write) ([db03494](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/db03494a34cfa0b17c98579ef82a6a4370cefe3d))
* FIX-1221 template links checked in the database, freeze carries history and grocery links, feed bounded to the local day ([262bc79](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/262bc79a042e796668da0b872efc738444aa5ced))
* FIX-1221R2 a meal named only in a plan's changes is held for a moved client (service lookup and caller_keeps_meal_template) ([0233f25](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0233f25121d979b57802ac740ae76fe016a56e75))
* FIX-1221R2 one removal is one change (multiset per label); swap_template_ids null is a 400; tests ([5c724f8](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5c724f8e135379e44de5fb2117aad0483845d4ca))
* **food:** a built-in row named for the food sets the basic tier's own category (LO-1198R3 C1) ([592ba19](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/592ba19821b3f8ffdd9690cc23a2811313d95ac6))
* **food:** a dish named for its first ingredient no longer ranks as the plain food ([c244994](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/c2449945c2f15a166871abcf09de67866fceac0d))
* **food:** a head of the query words in another order names the food ([7c95adf](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7c95adfcd705c86fc77bfb13de5d9b2d49a08bf2))
* **food:** a head that also names another food later is the group-first form (LO-1198R3 B1) ([38789f2](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/38789f2eb24e9cdb0758de7c44d3653d4a67dba6))
* **food:** a row filed under another USDA category than the food's own rows ranks after them (LO-1198R3 C1, owner [#192](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/192)-D2 op 1) ([e3c7d1a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e3c7d1a8e125f80e41f90856488ffcf223969dfe))
* **food:** among equal matches the plain form (raw, whole) first ([c46b174](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/c46b174a3d626a20e02c60aa5912ebe794b99cb2))
* **food:** catalog answers alone only with a row named for the food; capitals brands in USDA names rank as brands; first-part rows before dishes, no Babyfood group credit (LS-1212 B1, LO-1212 B1 B2 B3) ([f898307](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f898307dde21e88d56d3454be3e56fd67e7a5722))
* **food:** keep "100 g" on one line (no-break space) ([d7cd86d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d7cd86d9a07fc8aa5a580b6c3ad913455f9da7fe))
* **food:** the exact whole name before a head match, a built-in row before a USDA row on a tie (LO-1198R3 C2) ([df70cd3](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/df70cd3eafe2761a8bc6292367057179a07cee4c))
* **food:** the right food first, no guessed portions, one stored log per save ([5c554bd](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5c554bd7ae4c7ee4935f652deb4202eb6cf7ead6))
* **FR-1192:** a held push re-checks community bans, the thread mute and broadcast blocks when it goes; locked phone stores its zone; nudges keep channel default (F1, F2, R1, R2) ([e48386c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e48386ce09f228fa81b8c96a985ef80ccbbfe850))
* **FR-1192R2:** a held payment reminder or trial-ending push is not sent once its cycle or trial ended ([fe7a6b1](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fe7a6b10e05898be35ef7872d294e23ce456dbc2))
* **FR-1192R2:** the coach's Day 7 payment alert push never folds another alert in, so dropping it loses none ([2054005](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2054005983af069bafb764f33c1ab0c75d526903))
* **FR-1192R3:** a renewal push whose read fails waits for the next pass too (ruling R4) ([f758086](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f75808639af71954c34d80eb1853cdcbfb2e7502))
* **FR-1192R3:** an unread held-push source waits for the next pass; a held workout reminder asks its sender again ([afe3962](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/afe396290bd06848c09554e38e698e97f6b4eabf))
* **FR-1192:** read a message's community with findFirst (community_messages key is id + created_at; TS2322) ([970c78b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/970c78b16c072f53caa3b989811d6daf1a85407a))
* FR-1195R3 F1 the history read shows today's brief by the same hold gate as today's read (LS-1195R3 B1, ruling R10) ([bf47166](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/bf471664c0f5a038855ff204ca9ef1d6763cf36a))
* FR-1195R3 F2 PF-W9 counts only renewals held on the coach's own Stripe account (head brief and its hold check) ([f50cfef](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f50cfef91511547feb619021885d50df9278c94d))
* FR-1195R3 F2 the brief SQL text without an owner stays as on main (no extra space before the waiting FILTER close) ([be6a0de](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/be6a0de2d417e78bf1da4f902949909bdc858291))
* FR-1217R1 broadcast replays hide moved exclusions; a dispute email is not a card link ([a2701dd](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a2701ddd9699959e8fe93c91f5e4047759f323a5))
* LO-1197 B1 v1 console chat list skips deleted messages and blocked authors ([d08e4c9](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d08e4c9fbb86b0ef9a64a1daa6d6f8ec4910a60c))
* LS-1197 B1 the count rule asks each message's author; LO-1197 C2 C3 count-rule names its readers, contactRings takes the counted roster ([50487b7](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/50487b789ba78c334f6da4cb995706bfeea44b6d))
* LS-1197 B2 Today pinned post takes the Hall author rule and keeps the next pin ([fcbdaca](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fcbdacabd2617ed407628f9f7213ea554653244d))
* **money-daily:** read Stripe's paid invoices for each subscription purchase (LS-1225R4 B1) ([6ebdc2c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/6ebdc2c9af706df9b8ba8d74ddd26951c9492b68))
* **notify:** register the coach account hold notice as a coach Money alert sender (LO-1195R2 B1) ([c97296f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/c97296fd564ac81d5f9eb89457e8de3ea5ef2cda))
* **onboarding:** consultation clone keeps the unit a master row states; extra-care cap reads it (LS-1211 B1, LO-1211 B1) ([133e1ea](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/133e1ea68950be96b2e6b5a3c11b89412273f72b))
* **pf-7:** held renewal reads active to the client; durable per-channel coach notice; every held invoice paid once (LO-1195 B1, LS-1195 B1, B2) ([d8a0f22](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d8a0f221586b5d09f50f0a3916be025b24bee912))
* **plan-swaps:** read ?date as a string only (CodeQL type confusion) ([9f7f6e6](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/9f7f6e646ad2a2ce6c3d66822f8af7b1a25461e5))
* **plan-swaps:** the client's today read drops the template's raw swap and recipe ids ([a0e2c59](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a0e2c597188022f35bc0b19e1b2066ad9807a4f9))
* POST /coach/clients/:id/nudges writes the client's inbox row in the nudge's ([f995955](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f9959555e7eb2c30cd2fc24a19d6af6fb10d7a2d))
* read the saved insight's excerpt author without a cast (R75) ([25bf0b2](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/25bf0b2b7777c42ce72ed6eda21960959d9f89f6))
* register FEATURE_COACH_ACCOUNT_HOLD as an open name (no closed set), so the Fly manifest needs no entry ([2efbc10](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2efbc10fd143ebf4719aeb24caf2324eab066f5d))
* register FEATURE_COACH_ACCOUNT_HOLD in ENV_RULES; read v2's switch directly in the hold sweep ([2c1209b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2c1209b3c3ff8e13f6effb8a683d6562e7f535a6))
* Roman and the AI workout context read each exercise's reps or seconds ([77246d2](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/77246d2756d7408c19e4a0200fe89edfbdf332a8))
* **storefront:** a card save still processing at the cap is closed, not left to convert after TW-F1 (FR-1199R2B F1) ([2f74a1a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2f74a1af4dd07503474932c6f38f04bb5cd27431))
* **storefront:** an outcome email whose record and send both failed at the ending leaves a pending try (FR-1199R2B F4) ([8f90a94](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8f90a94bbb490358d2ae0111b31866cdaea9c05e))
* **storefront:** end a web trial's card save at Stripe before TW-F1 and close its checkout (FR-1199R2B F1) ([6f4bd69](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/6f4bd697f0a20fab4a2dd33d0076314a04e62d06))
* **storefront:** FR-1199 keep the webhook replay a no-op; tag-only scan error log ([ffe2f97](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ffe2f977163d273e4d620882d1c98c94d1d23a83))
* **storefront:** FR-1199 let the TW-F1 pay page link wrap on a narrow phone ([9e691b2](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/9e691b2cb168297347e3754b60787655db28f927))
* **storefront:** no TW-F1 for a declined card or a buyer who started again on a later row (FR-1199R2B F2) ([796f353](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/796f353e043bcc5d880ef00c8c58b7b1a05e7fb0))
* **storefront:** one durable outcome email per guest checkout ending; trial return drops the trial-day line after the trial ends (FR-1199, LS-1199 B1-B3, LO-1199 C3) ([d62ee49](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d62ee4906c9d66cf6c45ebffdc3d33e6fb38312d))
* **storefront:** one Resend Idempotency-Key per outcome, the same body on every try (FR-1199R2B F3) ([2ac97ba](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2ac97baab4cbba21541c7c5d89f1749777f212f6))
* **storefront:** read Resend's 409 answer without a swallowed catch (R75) (FR-1199R2B F3) ([fcadf05](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fcadf05f200f1f8066482860c940312645ddcbc0))
* **storefront:** the guest retention scrub hashes the address on its outcome email send records (FR-1199R2B F5) ([cefb4f2](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/cefb4f23d2b098d03fcbc9a3a94d6bf260097ac7))
* **storefront:** the outcome email retry scan walks its whole backlog instead of rereading the newest page (FR-1199R2B F6) ([6e893cb](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/6e893cb0910779e57ae6d3acc848002255ce7fd7))
* **storefront:** the scrub's new log line uses describeFailure, not exception text (FR-1199R2B F5) ([9237483](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/9237483f085ea6a4ffe98ceba6a809e64ba7fb3a))
* TRIAL-WORDS-BE — a web trial's confirming and slow return page says a free trial is starting ([#189](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/189)-D1 op 1) ([998d62e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/998d62e76314d2feb4401ce61a96f8079f98466d))
* **usda-foods:** leave out a food with no protein, carbohydrate or fat figure, and one named like a built-in or SR Legacy food; rebuild the data file (LS-1212 B2, LO-1212 C1) ([274d278](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/274d2781bc9cbc9c3d45579805740064dd379931))
* v1 thread detail reads by the actual author, as the list does (LS-1197R2 B1) ([31be519](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/31be519ac93b3ef7f07abf22a7b1f229769bd043))
* **WK-1-BE:** one workout per resend key; exercise video links follow the assignment the client sees ([8d86c17](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8d86c1715a3dbb19f1d74a4cfd218f8125b9e296))


### Documentation

* [192] FOOD-SEED-BE — delivery controls and runbook name release step 5 ([ae33805](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ae33805e8c4dd9fdd38e6bababbecadce6c1732d))
* [193] FR-1203 — step 5 keys on folded name + brand ([f98feff](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f98feff0c01c6f0c7131bb7e48d76781a0358530))
* notifications README names the shared coach nudge sender ([985d8fa](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/985d8fa8fe40b162ef153d9c65d8fc8776b94371))

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
