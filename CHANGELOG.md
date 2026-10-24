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

## [0.1.1](https://github.com/BradleyGleavePortfolio/growth-project-backend/compare/v0.1.0...v0.1.1) (2026-10-24)


### Features

* [142] FOODLINK — a food log entry can name the plan meal it was logged for ([ba46198](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ba4619891251ed3ce2c37c6a922303fa38231e15))
* [145] C4MOVED — sessions record when and by whom they were last moved, so the client can see what changed ([ca90de1](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ca90de1d39477364e15d449be62c0e75fb6fc5b2))
* [145] C4NOTICE — each coach sets how much notice clients need to move or cancel a session (default 24 hours), enforced on the server ([0265e18](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0265e18934f7ee6dbc0121ef41f2a8b33b70c2e6))
* [145] FOODSAVED — clients can favourite foods and save meals to log again in one tap (server) ([a3ccdae](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a3ccdaedc89d944fab9df1df0f7bd378067a3a5b))
* [145] ROMANCOUNT — each client gets 100 Roman messages, 3 files and 5 Roman changes a day, counted on the server ([2e8eb23](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2e8eb233366a6d5cc3db6be64c10fb6d427888ce))
* [145] ROMANCOUNT-USAGE — clients can see today's Roman usage and when it resets ([76279c7](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/76279c7efe698d3db3b31613d4b96b7f1faa6041))
* [147] C6-BVIS — one rule decides who sees each community space ([8fc2168](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8fc21683757946c26bc355116dc410de1f1b7546))
* [147] HB1 — coach-set habits, safe edits, archive keeps history ([866c2a7](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/866c2a73d8d88bd382a58d1d0616d30fe7a40658))
* [149] C1V2-C1 — workout data for the Coach's page logging screens ([faa15d4](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/faa15d4b8366e5331dd3bc8c17fae7065ec44b28))
* [149] ROMANMARK-B1 — a message Roman drafted records its draft ([09c9fe2](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/09c9fe2d9e3889a2ddae82de66f5a31a83ba8db3))
* [150] C10RT — private per-person community realtime topics ([06d6c98](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/06d6c989fab3876e8a87ef59b78f7ee0d677e81c))
* [150] C10RT — private per-person community realtime topics ([351d953](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/351d9535b4407fcff439188b1b708045e78164ab))
* [150] K1WEEK — coach read of one client's week of workouts ([ca48f0b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ca48f0b527bc9ef3d61b7691332be5b78e4053df))
* [150] K1WEEK — coach read of one client's week of workouts ([aa858d8](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/aa858d8e374ef238dec3b95dbd6a3a2e789a17d2))
* [154] C2-C0 — the coach's planned meal and workout times ([f93a134](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f93a134a7687b2862145ac9c817e137332cf8b26))
* [154] C2-C0 — the coach's planned meal and workout times ([96f2006](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/96f20061f9a067f0957d52603e6d1193d0003519))
* [154] C6-B1 — Each coach starts with Announcements and Everyone, and a space's kind and posting policy decide who starts a message ([f494731](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f4947319e7a9c66b51d5fe366af95350fe5e9529))
* [154] C6-B1 — each coach starts with Announcements and Everyone; a space's kind and posting policy decide who starts a message ([50b229d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/50b229dd411d8cca022741c8dd55ad04a72687ef))
* [154] CRISIS-BTN-BE — safety_actions on Roman's crisis reply, open_safety_alert on the client summary ([3331412](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/33314124bfb339dfd88d0b93cf95ef31d609890b))
* [154] CRISIS-BTN-BE — safety_actions on Roman's crisis reply, open_safety_alert on the client summary ([cf163d9](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/cf163d95ed1eb27ae97f9df9f58587bbc8e3b56b))
* [155] SHARE-BE — a client's share card goes into the coach thread ([88c6e8f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/88c6e8fb46eb099f0d09b6efc0dca21e6e67ea51))
* [155] SHARE-BE — a client's share card goes into the coach thread ([a787d1a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a787d1a50f2e2f4f6e3ba3504bb45054f316084a))
* [157] C5-S1 — purchases[].first_charge_cents: what the checkout charged first, from pinned terms ([b88ab00](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b88ab00f8b122f3a4fb6adf31df7989d269dfe13))
* [157] C5-S1 — server quote is on main; purchases say what the checkout charged first (slice 2) ([a18c79c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a18c79cf154d69b16696ef655f05283c7845cc93))
* [157] C6-BVIS — every path to a community space answers to the one access rule ([9b3ac8e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/9b3ac8eb1b8d9dbb2ad31554cc274db00742886d))
* [157] C6-BVIS — the coach picks who a space opens to, and sees why each person is in ([5f3b3d9](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5f3b3d9077503ec367ec6d635d2f7e52c43245c5))
* [157] MEALBUILD-BE — a day plan keeps the meals archived after they went into it ([5e297fe](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5e297fea28629db6a1aae4e8420868fdde5df116))
* [157] MEALBUILD-BE — a day plan keeps the meals archived after they went into it, so it can still be edited ([4a65e5f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/4a65e5f2a4d6fd8dd7be6d4a3075377e0cef679d))
* [158] C6-NAMES — in a space open to all of a coach's clients, members see each other's full names ([027c9a1](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/027c9a1fde0d7a07df95a229f383eb11b54b1ee3))
* [158] C6-NAMES-ALL — in a space open to all of a coach's clients, posts, comments, wins and the leaderboard show full names ([33816fc](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/33816fcb8e10d3dfd8e984c0a282851481511564))
* [158] GC-1 — guest pay page at /p/&lt;code&gt; behind its switch ([77dac96](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/77dac96ab8ac1fcba1c11675fbf1ae7b22f0c119))
* [158] GC-1 — Guest pay page at /p/&lt;code&gt;, off until its switch is on ([7bcd941](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7bcd9414b03dec94924cb4a577cf8d7c0670f794))
* [158] HB3 — habit runs, week counts and GET /habits/summary on the server ([abc155d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/abc155d0a71be4f22d7a2b124003c3d76d454c57))
* [158] HB3 — habit runs, week counts and GET /habits/summary on the server ([d1e7c47](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d1e7c47f2957c8fb682a4140014f2e4fc0c19dc7))
* [158] LEARN-BE1 — course and week tables with row security ([e7cb369](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e7cb3699263cc68125ac25e021713846c57790e2))
* [158] LEARN-BE1 — course and week tables with row security ([d91e299](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d91e299d054036304a0dc58d4c3c7067ab03d4f5))
* [158] MEALPLAN-END — a coach can end a client's meal plan ([d23fa79](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d23fa79451dd03df7c84521d38ae8f8df2fa4c4e))
* [158] MEALPLAN-END — a coach can end a client's meal plan ([bcd7ff5](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/bcd7ff5e2c1478c360dd9ce7642ebb9a7d8c4db7))
* [158] TRAIN-BE2 — exercise history over all workouts and a coach comment per workout ([26cd46f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/26cd46f643851662b1d9d4b41c4d4da5836b05bb))
* [158] TRAIN-BE2 — exercise history over all workouts and a coach comment per workout ([d9f2c2d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d9f2c2d6428c0f69665057c91410dac7c9986bff))
* [160] BRAND-AGREEMENT — accept the TGP Fitness agreement versions next to the old ones ([e96e28a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e96e28a93110c370b151b0845b939175c1330900))
* [160] BRAND-AGREEMENT — accept the TGP Fitness agreement versions next to the old ones ([0dd821d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0dd821d5a5c7ca7748568e3c1c47bed2aafd7923))
* [160] GC-PHONE — phone number on the web pay page ([74a493e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/74a493ef3ab956f3de64148eac139baa9362ff1b))
* [160] GC-PHONE — phone number on the web pay page ([0235b4a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0235b4ae9f680740b4400d6fcedf5ac4cd31d9ac))
* [161] INVITE-COPY-CODE — the invite page offers Copy code for after install ([683248d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/683248d9bac8d0e5f679ffa65573836ac0734d97))
* [161] INVITE-COPY-CODE — the invite page offers Copy code for after install ([c762f20](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/c762f20efc3b8e191cb85768077a26daf07ac3e7))
* [161] LEARN-BE2 — course week release rule and client course read endpoints ([dd2bb22](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/dd2bb224c1b771962867cbaa401bac4815797bcf))
* [161] LEARN-BE2 — course week release rule and client course read endpoints ([ab50026](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ab50026083c5e18896643e3d7f9a34a49ffbfc84))
* [162] ROMAN-EXTRAS-BE — brief check-in review and new-client rows, check-in streak ([0fec095](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0fec095c1afb58347745a43a98e8364c038561bc))
* [162] ROMAN-EXTRAS-BE brief check-in review and new-client rows, check-in streak ([98d621d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/98d621d53850cdab2b295ecccfc5d31b2a71ac9f))
* [162] WEAR-AI-PRIVACY — wearable insight allow-list value and the Health notes privacy sentence ([00987b1](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/00987b1a8d4644a3c3cdf1dea296d329e8d5dfde))
* [163] COPILOT-BE — Copilot plan changes: send, coach decide with edit and note, apply handlers, paged queue ([81ec285](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/81ec2856609961d7b3e960f71353e9bda3ec1c9a))
* [163] COPILOT-BE — Copilot plan changes: send, coach decides with edit and note, apply, paged queue ([9af41c0](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/9af41c02ac59dfc15a287f330915b15dbce271f4))
* [163] HOME-BE — coach Home day: this week's client wins, today's replies and reach-outs ([6d83506](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/6d83506f3437963ccb528c54166b3c41d78d6df4))
* [163] VOICE-BE — voice notes server half: names, coach flag, waveform, heard, consent, reply link ([ca78c2f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ca78c2f88aa636dc2a5d25d4759cd3925a7d6daf))
* [164] COPILOT-BE2 — Path Copilot turns: numbered facts, suggestion line, week block, past questions ([7393b7c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7393b7cc28bd0ea445e2ae40ef466179146631c5))
* [164] COPILOT-BE2 — Path Copilot turns: numbered facts, suggestion, week block, past questions ([d976388](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d9763883bb970b4f38cc195155e2a38489caf52e))
* [164] COPILOT-BE2 — reserved migration name; week target set_by and the coach's note ([6593117](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/65931176589aded0a8db8e924ae0946e73dc1f44))
* [164] RENEWAL-BE — plan renewal schema, migration and cadence ([bb716c1](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/bb716c141e19d7f3ae41e4219995e5fa13cda4fa))
* [164] RENEWAL-BE — plan renewal sequence (Day 0, 1, 7 notification and pop-up, Home banner data) after a plan ends ([e7eb939](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e7eb939e512db0138f51871e361064d319cc75a8))
* [164] RENEWAL-BE — renewal sweep, entitlement block, pop-up ack, coach switch, client preference ([b0e8917](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b0e891717f5691215220b0ff3f3a75008049fd74))
* [165] CHURN-BE — the coach's churned-clients list and Roman's win-back draft ([0213a93](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0213a9309f6eb1f556fdc98b0ba856ad7dfcaa63))
* [165] CHURN-BE — the coach's daily churned-clients list and Roman's win-back draft ([7359c3f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7359c3f9061b63f6117a4d1f002d6defc0604b68))
* [166] HOUSE-JOIN-BE — renewal door to the house coach's packages, move after payment ([4bf7c7b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/4bf7c7b66bd67d0e21270d24c7891fa93d970622))
* [166] HOUSE-JOIN-BE — renewal door to the house coach's packages, move after payment ([fd861cc](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fd861ccc528e3fcb170636349c9149ea53b3c4c0))
* [167] REACHED-TODAY-BE — the coach Home says which Reach-outs clients were reached today ([31ca5d6](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/31ca5d6e48e646fbc00411f38da9d43768f309ce))
* [167] REACHED-TODAY-BE — the coach Home's Reach-outs says who the coach reached today ([5ac87b9](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5ac87b98370be79a77ded4cb2fc0dc93e2e961c4))
* [167] SWITCH-TELL-BE — the coach a client left for the house coach gets one in-app alert and a dated Money line ([54c0e58](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/54c0e58e187e35c9fbfe2dfea0300fbb9864d52d))
* [169] FX-860 — house coach full name ([62b9c4c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/62b9c4cca104a3d349c4bb733d8737b06214fc02))
* [169] FX-860 — house coach full name in the renewal block ([d081a82](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d081a82f61a8a2665abdfeed3bd5a7cbda201bcc))
* **coach:** Home day on the overview: this week's client wins, today's replies and reach-outs ([0f2b659](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0f2b659a8632f8b02c69211adf7b992c812fc936))
* **community:** every space path answers to the one rule; an archived space opens to its coach only ([ab70e56](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ab70e56f3175064d5823f1118fff4afc1c5d8106))
* **community:** in a space open to all of a coach's clients, members see each other's full names (#C6-MEMBER-NAMES) ([8a1d95e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8a1d95e9a6ba9e339005080c812687b2e33020a2))
* **community:** posts, comments, wins and the leaderboard show full names inside a space open to all of a coach's clients (#C6-NAMES-EVERYWHERE) ([b64d60c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b64d60c10b4431290fe640b2863362a40fc8d948))
* **community:** the coach picks who a space opens to; the roster says why each person is in ([17289af](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/17289af4359984d5a8dcb27d07b84cb7344f7658))
* **community:** voice notes server half: author name, coach flag, waveform peaks, heard marker, consent, reply link ([9b05a59](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/9b05a5937558703840537073076061e9e95dc483))
* **switch-tell:** the coach a client left for the house coach gets one in-app notification and a dated Money line; the new coach is never named ([eed988e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/eed988ea261304f3b78b35aeef829b4b8fa7e8ef))
* **wearables:** [162] second allow-list value for the wearable insight capabilities, and the Health notes sentence on both privacy pages ([ea25929](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ea259292987bb737c5d544f834d927b4edc7d23f))


### Bug Fixes

* [139] A1G-2 — Delete the old coach's drafts on every other path that moves a client ([f565bff](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f565bffb89f2a4ba8678daf205f6d0efbdb31168))
* [143] MOVEBILL — a client's move stops the old coach's billing and drops them from that coach's active and MRR ([2e2d522](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2e2d5225c8810b92553b9924d4e56174c1a253bb))
* [143] MOVEBILL2 — moved trials never convert for the old coach ([1544b3b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/1544b3b27ba9020e9798e3544edfe5f04fb9dff0))
* [145] COACHLESSDAY1 — clients without a coach get a fixed Day One note from Roman, with no AI call ([379a65d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/379a65d42c235a41b587046324f3bb2b16a04475))
* [145] RLSMEALLEGACY — a former coach loses row access to a moved client's legacy meal plans ([7cc64eb](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7cc64eba08e31c81fde92a1206b7ca372764881a))
* [145] RLSSTORAGE — voice notes are reachable only through the server, and the hand-made storage rules are replaced by a migration ([adad13b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/adad13b4ae75956f8fce1e6b00fe9ae7b8852c30))
* [146] FOODSAVED-EXPORT — a client's data download includes their favourite foods and saved meals ([3dcd880](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3dcd880988d8a201691f21daaf570d9169b4a138))
* [147] AGEGATE16 — every client confirms 16 or older before entering ([453cdcb](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/453cdcb86bb94d3e08a2bbc009c144b4133fad44))
* [147] NOTIFYMOVE — a moved client's notifications leave the old coach ([8630a36](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8630a36e12095efb340f4447966b7c5dd1fd60a8))
* [148] AGESAVE — a date of birth saves on its own ([e24cce2](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e24cce27138a5f2fce54d09ee01b957c11276c50))
* [148] CRISISAPP — the crisis sentence in the app's consent texts ([b260176](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b26017600ccecec784281618e6c57ab3d766d815))
* [148] WEIGHTWALL — Weigh-ins off hides every weight and every number made from it ([9e8418e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/9e8418ec290ab7f14bb00dfe027ecf6eb5c01f71))
* [149] CONSENTV7 — the memory-on grant records the text the client was shown ([85b5164](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/85b5164e52c82d86316dbe682c7f1ed4e25d09df))
* [149] FIX684 — accept the coachless consent screen with the Roman section ([493b1c6](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/493b1c664b84dce8e2095c599c823820a9c3aada))
* [149] MEALPLAN-RETIRE — readers move to MEAL:DAY; former coach loses the meal tag ([a9ef3b5](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a9ef3b5db8037cd262b1ab8e010bb589c0cb78fa))
* [149] PKG-MOVE-FULFILMENT — a paid package still delivers after the source client moves ([92f680b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/92f680bafc66b1e8dfab82b67c0d77f7c4ccf996))
* [149] ROMANCACHE — a change you just made reaches Roman's next answer ([8c964a5](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8c964a523974870e0c36f0b784e65523266ec997))
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
* [152] COACH-AI-CONSENT-BE — a coach's own text reaches Anthropic only after the coach allows it ([3cfcc00](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3cfcc00d616cd95363d386b1fccb1481c4ec104e))
* [152] COACH-AI-CONSENT-BE — a coach's own text reaches Anthropic only after the coach allows it ([95ef694](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/95ef6944793523e50083ecff8acddf7297e61d36))
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
* [153] COACH-TEXT-EGRESS — a coach's own words reach their client's Roman only while that coach allows AI ([6cc4248](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/6cc42488fc7a284e3ac11354fb090244f1c73b67))
* [153] COACH-TEXT-EGRESS — a coach's own words reach their client's Roman only while that coach allows AI ([8d649db](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8d649dbfd3f743d64bb2d6b87b9be5ce12b99cff))
* [153] COACH-TEXT-EGRESS — re-read coach grants on every context memo hit ([7c8e1ce](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7c8e1cead6be5bd72cb644d9d1b22561be41f25a))
* [153] WEARDISMISS — accept the shipped wearable dismissal ([f7281a5](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f7281a510fcc832e78572e05a94decf979458157))
* [154] FIX1067 — CAC-NAME: until a coach allows AI, Roman gets "your coach" and generic plan, program and meal plan titles (owner #CAC-NAME op 1) ([1613989](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/16139894f2a14f3358c95fa2ac3548851d7e8001))
* [154] SECALERTS-BE — signature headers parse into a Map; Mux reuses the one verifier ([ff7ef46](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ff7ef46fdf4fa141eaed9c2db8aede150b9ee899))
* [154] SECALERTS-BE — Stripe and Mux signature headers refuse prototype-named keys; 11 code-scanning alerts triaged ([54427ac](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/54427ac5a6439b1b17e02701a15be5ce2308a978))
* [155] FIX-CRISIS911 — call_911 in safety_actions, in the order each fixed reply names it ([0b33567](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0b335674370826ca11a208bcffcc8b4c8642252b))
* [155] FIX1071H — CAC-HIDE: until a coach allows AI, Roman gets generic booking, habit, meal and logged-workout titles and "your coach" in the client's messages (owner #CAC-HIDE op 1) ([7928a10](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7928a100a6f79fba1bcfa31f12617d6210a1ae45))
* [155] SHARE-BE — type the thread read rows once ([3ba366d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3ba366dc64abdcbf92ed8fe2644bb726f0a92a3c))
* [156] LEARN-B — coach can delete a lesson; guidelines and lessons never lock ([fb3af1c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fb3af1c58864871b16cd7d6e417a49a55a681261))
* [156] LEARN-B — coach can delete a lesson; guidelines and lessons never lock ([85e183e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/85e183e03df3bbef329b16562c61ba2e6366285b))
* [156] SHARE-BE — inboxes keep kind text|voice|deleted and add card_type; the brief shows no preview for a share ([1d79278](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/1d7927813c85a2fac9a838eedb344cafcf8c0f4d))
* [156] TIMELINE — Timeline wording, no coach lane ([16d639c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/16d639c3b1c0ab52796ea0685ee359e1f779697b))
* [156] TIMELINE — Timeline wording, no coach lane ([5dd3471](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5dd3471bf1a1b4fa3fb104b585dc87df8e5264c5))
* [157] MUX-RAW-BODY — Mux signatures verify the exact bytes Mux sent ([ec25536](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ec255367c9983e551b2798dbec18bbbe8a8e466e))
* [157] MUX-RAW-BODY — Mux signatures verify the exact bytes Mux sent ([47b7ccf](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/47b7ccfda54ffed33eff0a405f74860a8cfa6f91))
* [158] C6-ACCESS — a draft space opens to its coach only; package ids stay with the coach; only live packages link ([7c55b63](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7c55b633ddfc48fc89f056ee31f97a9a3c273634))
* [158] CI-HEAP — give the Type-check step a 6 GB heap ([64ce174](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/64ce1744b0bc9f10b9f24abdab3250e87e08b65f))
* [158] CI-HEAP — give the Type-check step a 6 GB heap ([619950b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/619950bae1b56777a199069fcbd3653ad97e1c96))
* [158] FOODLINK — a moved client's logged meals follow the frozen copy of their plan (plan and meal edits) ([8da5648](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8da5648342f6e2f8ca77d42c26840969fbaa3dc2))
* [158] FOODLINK — renumber the three migrations to 20270502005200-5400, above main ([85c44e4](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/85c44e410c6ab688ce068e94945cca5cba870397))
* [158] GC-1 — a failed attempt rolls the checkout key, so Pay again starts a fresh checkout ([1dda312](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/1dda31231d4797577bfcd89cfc96aca699aaf8d3))
* [158] GC-1 — sheet corners 24, calm ink message line ([703acf4](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/703acf44eca9bafedd760f6174673836dac33b41))
* [158] GC-1 — wallets return the buyer's name with the billing contact ([20c268e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/20c268ec639f99002f421f6bd34dad27f68e0809))
* [158] HB3 — a tick before a habit's start moves the start back instead of a refusal (main's list shows a habit before its start); the future day is the one refusal ([a46d35a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a46d35a593180ba39d01c25be5cee9578cf516ec))
* [158] HB3 — any day from the habit's start to today ticks, a future day is refused with a code only; the latest tied week is the best week; ticks read two years back ([da29c25](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/da29c2500784fbf659865bf68d372c0c230e81f6))
* [158] HB3 — runs and the best week look back two years at most ([9d61ec1](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/9d61ec1186f3373a88e5b539e9b95c1d4abfcfcd))
* [158] LEARN-BE1 — down.sql drops the enrolled-read policy before its table ([6371609](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/637160972fa31c5bf729d593b0ff1bdb65e9a3c9))
* [158] LEARN-BE1 — single-lesson routes never list or complete course lessons ([d971c42](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d971c4243d6b05161d13aa15b0ab4ae33d887c87))
* [158] live Roman eval sends each case its own question in a fresh world at the fixture clock (B1) ([750744d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/750744d24c8625535dd9c12cb9a59ac698e7e4c4))
* [158] MEALPLAN-END — each end write re-checks its rule in its WHERE, so two ends at once keep the earlier day ([aa10b27](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/aa10b271ef94f44883613110f076716dc5c73d63))
* [158] MEALPLAN-END — type the test double's coach filter (TS18046) ([ed55fe6](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ed55fe6e724a7c749a959d1a1429c380aa93df48))
* [158] pass the egress gate to RomanClientContextService in the live Roman eval script (main added the third argument) ([5297f1f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5297f1f31d23108250ce5b0a1f157811cf50a188))
* [158] TRAIN-BE2 — renumber its two migrations to 20270502006200 and 20270502006300 so they sort after main's newest (6100, b[#1091](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/1091)) ([fe234da](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fe234da68b163dfb1a37feddad460c115f5166e2))
* [158] TRAIN-BE2 — the four comments that name the migrations use the new numbers (6200, 6300) ([84d4c4a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/84d4c4a1175904dd0b52cc12f01b40959e29fcde))
* [159] C6-MOVED-PRIVILEGED-READS — a moved client leaves the former coach's inbox, in the query ([cdad16c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/cdad16cc9b76d46347b0d0456790277500741ee7))
* [159] C6-MOVED-PRIVILEGED-READS — a moved client leaves the former coach's inbox, in the query ([47ebcce](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/47ebcce6b124f37752e45ba5e539d05a94e81aab))
* [159] C6-WINS-MOVE — a moved client leaves the former coach's community ([8165f59](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8165f598ed4439bf84d6ec8d29255925d74af36c))
* [159] C6-WINS-MOVE — a moved client leaves the former coach's community ([1bc944d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/1bc944da5a042eed0953d3b0ac8c8414e0c260a9))
* [159] C6-WINS-MOVE — reports follow the same rule ([a483a70](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a483a70df27275dfa20f4c6cbd51c4f799d99355))
* [159] C6-WINS-MOVE — the two CI failures: the safety stand-in answers the stay rule, the row count compares ids as text ([2479ecb](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2479ecb0c903859dfb58900a8189d619f0601844))
* [159] KEYS-READY — scrub Supabase keys and drop the legacy key format ([301b9c2](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/301b9c2ccf6fc9450416b9cd187fa72be59462b2))
* [159] KEYS-READY — the backend is ready for the legacy Supabase keys to go off ([acad313](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/acad313a2abd4b21fed9c3907e286fe772a71cbc))
* [159] PRIVACY-SWEEP — data export carries course enrolments and lesson progress; coach deletion keeps an enrolled course whole ([6e2b7c9](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/6e2b7c931b7b1e6fc2c26d110b82e194c18752d6))
* [159] PRIVACY-SWEEP — data export carries course enrolments and lesson progress; coach deletion keeps an enrolled course whole ([44724cb](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/44724cbe97d94adaf80ee600377457880c77fb8b))
* [159] PRIVACY-SWEEP — say what a deleted coach's enrolled course keeps: its week and lesson rows and the client's progress ([d78d3f9](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d78d3f94b90d78db33c6665f1c52036228d0e9ec))
* [160] C6-AI-TRIAGE — the former coach's AI triage never reads a moved client ([fb22fed](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fb22fed90247d3ce9ecf761283ee74cd33433dac))
* [160] C6-AI-TRIAGE — the former coach's AI triage never reads a moved client ([0449015](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0449015267bd690039f924e2083acc18d33fe8d4))
* [160] C6-MOVED-SEARCH — community search follows the moved-client rule ([b11e56e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b11e56e3decd30fd7b6e26694049dd296dc9cd09))
* [160] C6-MOVED-SEARCH — community search follows the moved-client rule ([8d08124](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8d081245c33afb041e145c58bf5cb704081a5acc))
* [160] COACH-GONE-DELIVERY — clients keep what they paid for when their coach deletes his account ([62bd622](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/62bd622a94c35bbbb4459423e1bc213babdf114a))
* [160] COACH-GONE-DELIVERY round 2 — delivered content stays after a plan ends, Keep plan refused for a leaving coach, client's own cancel never resumed; migration 7300 ([fc376ae](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fc376ae78735bbe9aac234e0e6c879cc72137c2f))
* [160] COACH-GONE-DELIVERY round 3 — both shipped statuses owed, null-safe owed keys, a leaving coach sells nothing new by any route ([37e33ab](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/37e33aba12e461169782f42349abb48d766850b3))
* [160] COACH-GONE-DELIVERY round 3 — null-safe owed match only on nullable references (id stays a plain IN) ([d0c7c6c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d0c7c6ce4948e772ef7bd874e920ca1d5bf66954))
* [160] GC-1R — renewal line names the TGP Fitness app (#GC-CANCEL-WORDS op 1), amount stays the package's own ([56fe6af](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/56fe6afd29eaa42b73fadc68f561eefaa827b56e))
* [160] GC-2c — one storefront URL for every link ([a245f4b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a245f4beb7b1f5bf1925f4aed4fccfa2b9be5c9a))
* [160] GC-2c — one storefront URL for every link ([501e983](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/501e983a1f2072cc7ec6e3795d6e33e8c82cdada))
* [160] LEARN-FROZEN-MEDIA — a client's kept course lessons keep their videos after the coach deletes ([bcaad73](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/bcaad7386f85c17df3d0d197df695796d584b283))
* [160] LEARN-FROZEN-SINGLE-READS — a client keeps reading the single lessons they completed when their coach deletes ([3478adc](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3478adcd932221de377f36103c8c246ca75587c1))
* [160] LEARN-FROZEN-SINGLE-READS — a client keeps reading the single lessons they completed when their coach deletes ([5715163](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/571516387ee09eae08809f425e1dea2b7b937f1f))
* [160] LESSON-LOCK — nobody signed in can rewrite a lesson completion ([d53d73e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d53d73e354bdf859f608536d33d0a64d9b140fe3))
* [160] LESSON-LOCK — nobody signed in can rewrite a lesson completion ([b59cc0a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b59cc0acecbbbc498cbce16467d0253853f9ae22))
* [160] PRIVACY-PAGES — a coach's deletion leaves clients their kept lessons and the media those lessons play ([7c25adf](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7c25adf0cd50f65f004fac1baedc3de5c00046c2))
* [160] PRIVACY-PAGES — the diagnostics bullet speaks without first person ([554fa6b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/554fa6b8fe16fe40c5263cbb36cf588a8be3298f))
* [160] PRIVACY-PAGES — the privacy pages say what the app really does ([da9cffd](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/da9cffde9590c8f7f1584bb7954095597cdb2d67))
* [160] PRIVACY-PAGES — the privacy pages say what the app really does ([3976c44](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3976c4484c8234562ee7a24ea9794e427e31370d))
* [160] UPTIME-FU — improve production uptime probes ([1eaee7d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/1eaee7dd63f8a66b04b30b8b60fd858c72125d21))
* [160] UPTIME-FU — uptime probe off minute 0, app host probed, runbook link fixed ([54317a5](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/54317a5e6c2ccfc5b2a928f0a72bc2b3b84d2088))
* [161] INVITE-COPY-CODE — the code stays on one line at 360 pt with larger text ([b9220e2](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b9220e22fa18d2c7a3384b63781a27fb8398c5d9))
* [161] LEARN-BE2 — course row contract, one release day, course completion, video route ([9082d11](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/9082d11f00d3381b3d9d5dc8667d0384f8b3b950))
* [161] LEARN-BE2 round 3 — 7-day finish-by, client-day enrolment end, archived course video plays, archive guard counts course lessons ([64c2646](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/64c2646b67d8e4256d279e65b534892a9c967dbe))
* [162] MEDIA-ARCHIVE-BUYER — a buyer keeps paid media after the coach archives it ([a6e4c35](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a6e4c35a207fae3c198b625c173f8f94d96ba1f4))
* [162] ROMAN-EXTRAS-BE spec mock carries the new aggregate fields ([a539b0f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a539b0f4e0fc5554ce5f6e98611c80c84bae1e23))
* [163] COPILOT-BE — drop the three cast tokens (R75) ([ced6753](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ced6753b3269fab1f94e78edbee41c9217bdd5b8))
* [163] COPILOT-BE — type the spec mocks (no Array.at, typed mock calls) ([a4f7964](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a4f7964fa592538e799ead16d3dcff86aac9fbde))
* [163] COPILOT-BE round 1 — auto- target ids, Edit refreshes the live baseline, 4xx kept, #CP-LAPSE enforced, move window ([a0c11f8](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a0c11f80bc6e9640e7cd8a23bd1f5a27f86619a8))
* [163] FIX-1118-R1 — brief counts review and join rows; store the coach join time ([36fb07a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/36fb07a33c8b4f3528e1a9abded74c3b7d317ce3))
* [163] FIX-1123-R1 — Home counts only messages a person sent, goal weight once, lifts by workout-history identity ([cfc0fcf](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/cfc0fcfb34f9f173717c32d79e3ef1dcca901e8b))
* [163] MEDIA-ARCHIVE-DRIP — a drip file archived before its drop still reaches the buyer; a refund stops only undelivered drops ([638e68f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/638e68f073bc146120e7a8e2d16f7a7ec5c92371))
* [163] MEDIA-ARCHIVE-DRIP — paid drip files survive an archive; a refund stops only undelivered drops ([7f0b548](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7f0b548716575ea990ebaa1dd69f46288741c5b1))
* [163] PATCH-FR — follow-redirects 1.16.1 for two high advisories ([e851bcd](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e851bcd2373946caf8799fe7aa44ee087a873580))
* [164] COPILOT-BE2 — typed stored shapes (no banned casts), auto- targets never 'set by', [n] stripped outside Copilot, coachless refused on Copilot reads, consented workout titles only ([9ec9c52](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/9ec9c5233e9c3915b2a9a0f2e88b9f859d1044ec))
* [164] PUBLIC-WEB — public pages: 44 px targets, 12/16 radius, help deletion row matches the app ([b531f22](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b531f2246ff12af5e6f13a9858a71f09348bacd4))
* [164] PUBLIC-WEB — public pages: 44 px targets, 12/16 radius, help deletion row matches the app ([5a4e9e1](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5a4e9e1b8318d979852b364c1bf75a1a02b07214))
* [164] RENEWAL-BE — a card declined at checkout is not a failed payment ([adb8adc](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/adb8adce3195733e23be5daabb14b1ff379ee181))
* [164] RENEWAL-BE — HOUSE_COACH_USER_ID adds no boot validator (inventory rule); the revoked case no longer depends on the wall clock ([e7b22dc](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e7b22dca1b4807630a94130a83e02ebcd41f0477))
* [164] RENEWAL-BE — OPERATOR RULING 6327651587: Day 0, Day 1 and Day 7 each an app notification and a pop-up, Home banner for 30 days ([b8bf612](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b8bf612f622b002e69a764e217f14aad0ed149c1))
* [164] RENEWAL-BE — OPERATOR RULING v3 6328335815: renewal notifications carry no buttons (the tap opens Home and its pop-up) ([70a8548](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/70a8548405a3dd4b5bb93cbf9132662f35b7b32a))
* [164] RENEWAL-BE — owner #RENEWAL-PUSH cadence (Day 0/1 pop-ups, one Day 7 push with two buttons), latest plan only, stable plan end, recovered declines never block ([da43c60](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/da43c60bbdcd46cc1609afa12c6d43b5d3fd7119))
* [164] RENEWAL-BE — unmanaged flag rule, popup-ack on the reviewed lockout list, renewal message marked automated ([b37f8a1](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b37f8a199c053777ac29c3fd0954a09b7ae3a9c2))
* [164] ROMAN-EXTRAS-BE2 — brief rows carry a time, newest first, up to 100 per type ([ae9b7d7](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ae9b7d7aa90968a43dbf7d3a5ea11b5b88d8ec16))
* [165] CHURN-BE — any client id not on the list is the same 404 (no id-format 400) ([a2ff5b6](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a2ff5b6c33370f2c1536024b21cb1978374723f5))
* [165] CHURN-BE — follow FIX-1127-R1's plan-end rule: planEndedAt from the state file, latest plan only (latestPlanEnd), as the sweep ([bca9482](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/bca9482b9619155745064a77fa3c1b682f595236))
* [165] CHURN-BE — owner's 7-day window (OPERATOR RULING v3 6328335815, point 5) and the list's total for "Plan ended last 7 days, {N}" ([48f329d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/48f329dea30658d9bd851f6b1e27ed43fdcc215b))
* [165] CHURN-BE — the draft's caller is the signed-in user row (Role type) ([da1a559](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/da1a559eec9618ac544e7d2c08698e666526a1e6))
* [165] COPILOT-BE2-FIN — CI type errors: weight_unit read from the profile, one randomUUID import, spec types and a real-clock expiry ([f6882cc](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f6882cced45e56b1e2e57d5f61296d2d44cd7363))
* [167] MUTED-TEXT — public pages' small grey text becomes [#2](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/2)C2C2C (owner yes, AA contrast) ([ecc966c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ecc966c9e2671bcf59942034f93dc647de09fbfc))
* [168] FX-JOIN — paid join codes and web storefront deliver immediate package content ([d8a5008](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d8a50083db6b17a57d57012e27b37f1817fc1a57))
* [168] FX-JOIN — paid-join content reads the attach in its own transaction ([92dcbe3](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/92dcbe35524d6c27481cf4cfc1cb6e8b8abb3e94))
* [169] COHORT-BE — invited clients can join their space ([ac4a1d8](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ac4a1d82a2a3075415961bd484389b96542d4fff))
* [170] GUEST-OUTER-TX — guest payment claim stays in the webhook tx; account setup and delivery run after commit ([5c628ae](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5c628aebd86729c7f92544ae4665813e02124307))
* [170] GUEST-OUTER-TX — post-commit guest conversion warning logs describeFailure, not exception text ([5375201](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/53752011e647c051ffd0aa4116958f6cc7965270))
* [170] GUEST-OUTER-TX — web purchases stop holding the payment save open across Stripe and account setup ([53dc5e5](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/53dc5e5cf298547e1b8797fe2b5011ecc616cd75))
* a buyer keeps paid media after the coach archives it ([634f10c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/634f10c8ebdf18155293b750ba061395374df721))
* a client's kept course lessons keep their videos after the coach deletes ([a66c627](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a66c6273af6d1c36b13c6fc51a8d923116ed699f))
* a move to another coach starts a new coach join time ([a579272](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a579272e7f36a5c0b518061270e3d28a19e30f7d))
* accept the shipped wearable dismiss contract ([2335e98](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2335e98efff69aaa378ceeae66a0d2fa3e6c0ddf))
* brief rows carry occurred_at, newest first, up to 100 per type (ROMAN-EXTRAS-BE2) ([a4396e5](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a4396e54cb22ff5212a02d2f62b623e53122a918))
* **checkout:** the async-payment case comment sits above the shared cases (no-fallthrough) ([21854bc](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/21854bc3c48fce4ad2c7d3e21483ce44838fe7ce))
* COACH-GONE-DELIVERY — clients keep what they paid for when their coach deletes his account ([74b011b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/74b011bbb8d80fa789fc7d0d3b6513e85be1a5f4))
* COACH-GONE-DELIVERY — type the package sale flip and the test prisma stub ([7fb32b8](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7fb32b8aad535ede785e5f2aa2c3802d5a947877))
* **community:** a draft space opens to its coach only; package ids go to the coach; only live packages link ([a212fa1](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a212fa1371349ca271dc009eb198c3921bf31fd3))
* **community:** a member may reply by voice in a coach-only space (FIX-1122-R1 B1) ([40f6320](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/40f63207d048002400b00e4c452676424db977f9))
* **community:** a space post's reactions, pings and reply push stay in the space; a row-less client RSVPs; the table walks reactions ([7afc64b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7afc64b54ceef23b15811a4ab9b9dcad7008e32e))
* **community:** adding a space member by email makes them active; remove never writes a row back ([d23c388](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d23c38886ef1f53054df78dd44a560d9a81fc79a))
* **community:** archiving a space removes its rows, not its people, for wins; RSVP test expects the 404 outside the rule ([3f0ae66](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3f0ae6655c5a4b37ecd2ebc64c701cc50b61adba))
* **community:** DELETE is the one way to archive a space; a deleted space is not patched ([f5e2915](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f5e291526d21865c996529dd44aecf7f23cf384f))
* **copilot:** questions cursor is the cuid message id, a string of at most 64 characters (Opus B1) ([bd5d654](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/bd5d6543277f1cc4d68413d11e9f33e8a46f1e9d))
* **deps:** [171] zod 4.4.3 -&gt; 4.6.6 (GHSA-mrhx-c7xc-m3w5, high) ([967c671](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/967c67120c85912cab617c59116e99262310ad67))
* **deps:** [172] AUDIT-1024 multer 2.5.0, body-parser 2.4.0, undici 7.30.1 (three high advisories) ([b23fa9f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b23fa9f1b31253218fa794fde7d8814d8aec770a))
* **deps:** [172] AUDIT-1024 multer 2.5.0, body-parser 2.4.0, undici 7.30.1 (three high advisories) ([6057ca3](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/6057ca31ca3c87b7d3b2f047411e055bc559892a))
* **deps:** zod 4.4.3 -&gt; 4.6.6 (GHSA-mrhx-c7xc-m3w5, high: memory exhaustion on oversized constrained collections) ([cbe9901](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/cbe990118381d30458f64f9bb0f6e93551191173))
* follow-redirects 1.16.1 (GHSA-q3jh-wrc6-jgq8, GHSA-8r9p-f939-6h3c) ([8df0847](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8df0847b41253f4e8317cd99b11ad4832bb0bf85))
* **help:** keep words whole in the contact table; AA contrast for phone field labels ([7571236](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7571236d41a96d2cea46faf38449e36e5f3305d7))
* **house-join:** a hosted checkout moves the client only once Stripe reports it paid ([31944bd](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/31944bd79517ee2cdd4449fe5d0d05ee23941210))
* **house-join:** no free trials from the house — a house package with a free trial gets the cross-coach 404 at the list, the detail and every checkout path ([#166](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/166)-6) ([817c8a3](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/817c8a3f0bdd031d07fd9ecb818473824ecf4d3d))
* invite page buttons radius 12, card 16, code stays on one line in the sentence ([d4cac22](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d4cac22519ba6cb383e622c6d34e760357990ba5))
* keep the raw heart-rate stream out of both wearable insight prompts ([707a273](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/707a273d1205056715e6c009677cabe168bc35c9))
* memory-off Health-notes copies client-ai-v12 / v13 and coached P0 screens v17 / v18 (owner [#162](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/162)-6) ([a29fa4f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a29fa4f0a1f1d70cccd732617dfcba5391476002))
* name the Health-page notes in the first box-2 agreement ([d0790f3](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d0790f3267ae9f6296d83b47bf7bff4dbe9cd530))
* newest joins first so the 100 cap drops the oldest (ROMAN-EXTRAS-BE2) ([6af8d0a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/6af8d0aab8b914b393dfe84c3ac1b4ae41072bde))
* **packages:** the house-move clean-up warning prints no exception text (C-611-17 guard) ([2146ff9](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2146ff96b4452b1cbeb55dbb1f0043fd6a79a4c0))
* **public-pages:** small grey text [#8](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/8)A7F6E -&gt; [#6](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/6)F6658 for AA contrast (MUTED-TEXT, owner [#166](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/166)-9) ([ba48bf1](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ba48bf1160d51f3107eb80f21ace1cab3a91e82b))
* **public-pages:** small grey text on light grounds becomes [#2](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/2)C2C2C (FX-1136, owner [#168](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/168)-13) ([3868181](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3868181497c4cf33b7e1bfdd366f08740f760fd8))
* **public-web:** help pages fit phone screens; review nits (FIX-1126-R1) ([5abbef2](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5abbef2bda4fc28c389d320bac4e8ea1b7a85b36))
* re-check draft access on the draft transaction's own connection ([2c27475](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2c27475ab128a1ef7f67384151d176af9e4acd76))
* **renewal:** a revoked grant's unused expiry is not a plan end; only older ends are superseded (b[#1127](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/1127) round 2) ([3872c28](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3872c28ce153d65b4c07acf2c2e04e697816b873))
* Roman mark follows consent when Roman wrote the draft, not at send (#ROMANMARK-CONSENT-MARK op 1) ([87af5ac](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/87af5acdc1811f9e23822db05864d42c724e9a60))
* Roman mark only on server-written Roman drafts while the client allows AI help ([69ca9a0](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/69ca9a0c3d3798d95b02bf08f2cb9559611e436e))
* server-side wording sweep (owner rule C-6) ([69b5d41](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/69b5d41ea609104a2cceda8cc780b3bb9f6ace02))
* support email is support@thegrowthproject.site (#SUPPORT-ADDRESS) ([74bb4dd](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/74bb4dda86ba52888448ffa0fdd64f68edb7d489))
* **switch-tell:** honour Mute all notifications; Money keeps the moved date (FX-1132) ([afdbde3](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/afdbde32326e0e7563a647f2b23fc222b84efd81))
* wearable approve marks only Roman's stored suggestion text or an explicit edit of it ([2d23c9f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2d23c9f3b60a2c4e25f723156e550b3a1860a339))
* wearable approve sends Roman's stored suggestion or is refused; a sync expires it ([b7a9e44](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b7a9e4463784cf604c4dace503541341adae2a1e))


### Performance

* [165] CHURN-BE — the last coach message per client is one GROUP BY row, not every message since the end ([cd3c69f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/cd3c69f8f5320b0ce48825dfc0ad31373e9b6c77))


### Documentation

* [152] FIX1063 — add Zoom kill line to runbook ([31ad212](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/31ad2129730e6ca2ab5e0ba78f96ce2004780fc8))
* [152] GUARD2 — roman-safety-copy names the current prompt version (roman-client-v5) ([cb572ec](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/cb572ec1805135a960b998ac2b664364fd7a2f3d))
* [152] MSGRT — read-receipt comments name both people ([382b673](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/382b673edb1333469f09342ca88b52cdddd81f1d))
* [159] WORDS-backend part 2 - neutral words and example emails in docs ([0b4aaa6](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0b4aaa6c6dd614c2355b8968cc9ae009f23b9812))
* [160] COACH-GONE-DELIVERY — manifest comments say delivered content stays on any purchase ([50bc023](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/50bc0238201051fc02d57bac7646282840247462))
* coach-message materialiser comment names the Roman mark gate ([0259479](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/025947922e5dd71b41b702d439dd97a2a00009c9))


### Refactors

* [164] RENEWAL-BE — export endedPlanWhere and assertOn for CHURN-BE (the sweep's candidate rule, one copy) ([db593fd](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/db593fd7eed034c9a94dd382bd5040c5a1fc4dd9))
* **coach:** Home day rings in typed helpers; check-in ring on CheckIn(user_id, date) ([4331161](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/433116102eb817a2836cd604221761de84a24f59))

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
