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

## [0.1.1](https://github.com/BradleyGleavePortfolio/growth-project-backend/compare/v0.1.0...v0.1.1) (2026-07-23)


### Features

* **account-deletion:** Phase 10 — GDPR right to erasure ([#164](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/164)) ([d691d37](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d691d377803ba32ca0fde0c46596e765bb210283))
* **admin-console:** console-friendly alias routes for search / coach overview / client unified / finance health ([#80](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/80)) ([b067f23](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b067f23f5b9171651d4a7f12cdc318b30cfb9f7b))
* **admin/reports:** OWNER-only report/export foundation under /admin/reports/* ([#84](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/84)) ([fcd3e48](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fcd3e48a42e78b55c923588e28441b917be8125b))
* **admin+entitlements:** first-class product-entitlement read model ([#85](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/85)) ([0254367](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/02543675381e6e1af1717fc97d19198cf8f31546))
* **admin+gdpr+billing:** hard-gate become-coach, GDPR scrub worker, broader audit, mobile coach billing/account aliases ([#81](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/81)) ([86fd0ab](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/86fd0ab3eeae7ac7d697d32c1361b80356c70a08))
* **admin:** cross-product federation for fitness + finance admin console ([#79](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/79)) ([a7a485f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a7a485feb02b75e7cc1424779432e2b4422c6aef))
* **ai-execution:** Stream 2 backend — coach AI draft-and-approve for messages, workouts, meals, notifications ([#309](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/309)) ([b023853](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b023853de3c89831e8801241162ddc2f840066f7))
* **ai:** approval-loop materialiser fixes PRODUCT-1 silent message non-send ([#293](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/293)) ([dec5916](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/dec5916cf55dd7993a70ee31c845164c31bbc53f))
* **ai:** Coach AI engine v1 — Claude Sonnet adapter, per-client workout/meal/insight, AIDraft approval flow ([#204](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/204)) ([a10913c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a10913c0783e77a151808b74e78ee1bd03fa8363))
* **ai:** MWB-5 live-create workout-plan gateway capabilities (FEATURE_MWB_AI_LIVE_CREATE off) ([#385](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/385)) ([c85d17f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/c85d17fc088d050b9692c9306d1533aaea30f278))
* **ai:** private AI gateway foundation — fail-closed, audit, approval ([#140](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/140)) ([acbec56](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/acbec56b545b1353c4acc9a8d5ddaf748dced927))
* **api:** publish OpenAPI 3.1 spec via @nestjs/swagger ([#94](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/94)) ([f676d7e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f676d7e30756b1b259880f00c8a291e4592da951))
* **audit:** Phase 10 — audit logging expansion (16 new actions, AuditController, kill switch, 4 service hooks) ([#170](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/170)) ([3e17008](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3e17008bb5cb291c9bb4e869a3d8f4eb5ca7ebb4))
* **auth:** Chrome extension OAuth exchange + refresh endpoints [LOC-EXEMPT: test-first pattern — 372 R74 test LOC + round-2 P2 gap tests] ([#496](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/496)) ([08b727d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/08b727dedee919095a87aad2693713bad542f573))
* **auth:** Phase 10 — role-gating hardening, RecentAuthGuard, Google ID token verification, CORS headers ([f2581a8](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f2581a8d3edf091d881d4f68269c7ce364a8008d))
* **auth:** POST /auth/apple Sign in with Apple exchange ([#98](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/98)) ([ab6c7c3](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ab6c7c3987849e18292e4a766b4b344f946b1938))
* **backend:** coach LTV metrics endpoint ([#223](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/223)) ([e0d1710](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e0d17102fceb41562d947570c586a738430ceeb0))
* **backend:** YMove + MuscleWiki exercise video providers ([#224](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/224)) ([3b4ffb1](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3b4ffb164542bbd578fc1c9624ea5d415fa23aa9))
* **billing:** B3 smart dunning v2 — 4-attempt cadence + day-10 lockout + late-reversal ([#373](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/373)) ([9322eeb](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/9322eeb3313eaef3d253d262ac97a833b43d7d6c))
* **billing:** one-time CoachSubscription backfill for grandfathered users ([#96](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/96)) ([3f01616](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3f0161674852161f5a36adbf285bc811f60bacb5))
* **billing:** static Customer Portal login-link fallback for portal-session ([#71](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/71)) ([e17c52e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e17c52eefff8acc554314c862bf2d1b12e1bdd78))
* **bloodwork:** client-entered bloodwork rails ([#141](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/141)) ([02e1541](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/02e1541e25d893c4ce2bb168adc7174457cfcb46))
* **client:** transformation timeline endpoint — 4-lane chronological feed ([#149](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/149)) ([3d695a3](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3d695a33f439bbd16aed8a6920eb171e1426e90d))
* **coach-alerts:** wire push delivery + 3 missing alert emitters ([f64e3ee](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f64e3ee2bf87eb709bccc769fa7c49f74194b5ed))
* **coach-brief:** module scaffold, services, controller, scheduler, tests ([4f31f6e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/4f31f6ec8a1f67991d24e02e9aa2a48c2181250a))
* **coach-brief:** prisma schema + migration with RLS ([130d4ab](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/130d4ab8d65b5ef956efe7336746e9448868d027))
* **coach:** add GET /coach/clients/risk-board endpoint (Phase 1E) ([#159](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/159)) ([2239c9d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2239c9d5e257da4094899733400df61d6e314711))
* **command-center:** churn prediction + fix 5 silent 404 endpoints ([e81681e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e81681ef604d3e4af747b844b47e9152a932be18))
* **community:** v1-6 coach admin endpoints — cohort write, members, coach inbox ([#377](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/377)) ([9cf48d0](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/9cf48d0c4d3665d28aad92a85ca838bc21e3c542))
* **community:** v2-1 prereq — add plan_context_payload Json? column to CommunityMessage (additive) ([db8633d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/db8633d8e45a106b3b578601946f9f1c2bec8162))
* **community:** v2-2 coach ack signals backend (FEATURE_COMMUNITY_ACKS off) ([#387](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/387)) ([3f271b3](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3f271b3952d3c9c81e1540227c3a768c6a838a93))
* **community:** v2-4 AI inbox triage (read-only generation) ([#391](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/391)) ([48f68ed](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/48f68ede4afed9225b252f89e8800c867c831778))
* **community:** v3-1 challenges pagination enforcement (B-PAG-1) ([#392](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/392)) ([78165b6](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/78165b631ed58167622be40dfe7313ca0162569d))
* **community:** v3-2 classroom posts backend — coach lessons, media tiles, release lock (FEATURE_COMMUNITY_CLASSROOM_POSTS off) ([#396](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/396)) ([b19fee8](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b19fee89f6a32b22bc7a5a202e8ee058a7c8679e))
* **community:** v3-3 voice notes (backend) — FEATURE_COMMUNITY_VOICE_NOTES off ([#397](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/397)) ([592fc39](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/592fc39ebb965c4fbfe995aecbc418433f88f1fe))
* **community:** v3-4 search + wearable prompts (backend) — FEATURE_COMMUNITY_SEARCH off, FEATURE_COMMUNITY_WEARABLE_PROMPTS off ([#399](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/399)) ([03ac677](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/03ac6773e81627f8274d84d24750ae0230cbe40e))
* **connect:** Phase 1 — Express account creation + onboarding links + webhook sync ([#202](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/202)) ([3bc3f1b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3bc3f1bbaec54b32db3db4810688ab638b034b61))
* **connect:** Phase 2-5 — packages + Checkout + 2%/5% fee split + dunning + payment-ops ([#215](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/215)) ([1eb075f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/1eb075f359b3b6bd85a93bacade3a496697254fd))
* **connect:** Phase 6-7 — payout readiness, reconciliation, refunds/disputes, enterprise rollups ([#219](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/219)) ([6cc019f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/6cc019fb34dfaceeba00e01c6c8a8490f1ad8c09))
* **connect:** Phase 8 — mobile coach SaaS contracts (team, sub-coaches, coach-connect, redeemers) ([#217](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/217)) ([b3989b6](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b3989b61b118261826df9a20810f8bec162ca13c))
* **consent:** consent layer v1 for client→coach data access ([#86](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/86)) ([3a00b88](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3a00b88a5f10117844513749ca153467c7758146))
* **contract:** freeze tgp-importer OpenAPI slice + truthful error envelope ([#504](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/504)) ([e6c3082](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e6c3082755c89e51c18db9562f84b7b8898ce102))
* **contracts:** B5 digital contracts + HelloSign Embedded (FEATURE_CONTRACTS_ENABLED off) ([#375](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/375)) ([b966088](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b966088f71338fcff0aa767c480488cfa86b939a))
* **data-export:** Phase 10 — GDPR Article 20 data portability ([#171](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/171)) ([38d6c87](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/38d6c87b505ac1cace00a73fa3bcda8aeb57e675))
* **dunning-v2:** enforce Day-10 lockout via global guard mount, scoped to /roman/* ([5076a07](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5076a07a1e54b14e3db84d3aa128fb0bb44542d7)), closes [#520](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/520)
* **email:** Resend pipeline + bulk invite end-to-end for fitness launch ([#213](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/213)) ([9d69fed](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/9d69fed5bca3c9303f6f52555b08e199457f0fa6))
* **extension:** pairing-code endpoints — init + status + redeem (FEATURE_EXTENSION_PAIRING off) [IMPORTER-D] [LOC-EXEMPT: 782 R74-mandated test LOC + reversible RLS migration + prisma schema; shipped src is 362 net prod LOC under the R100.A3 cap] ([#502](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/502)) ([e36e459](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e36e459beedf72ca9886cac15619bc44bb1c1ceb))
* **first-win:** Phase 7A — Day 1 Win Sequence ([#160](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/160)) ([55b4d65](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/55b4d658159033baf5de9bd22bf676fed5910b26))
* **gcal/B3:** channel tracking columns on CalendarConnection [behind flag] ([#244](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/244)) ([4cd380e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/4cd380ebdf244f40071aa64047aae69286d892b8))
* **gdpr:** TTL prune stale CoachBrief rows (BL-GDPR-BRIEF-2) ([8008563](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8008563d6cc0c3c22feb70ab4454e533b7d9d739))
* H4.A registry-loader for prod-switches.yml (R100) ([#458](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/458)) ([8680000](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/868000088fab1fc5929e02291bec4d4928e99aaf))
* H4.B env-discovery scanner (R100) [LOC-EXEMPT: all net lines are scanner+spec under test/** which R76 excludes from the prod cap; genuine prod LOC = 0; CI A3 pathspec counts test/** so the 400 floor trips on the tests-heavy readiness slice; same R74&lt;-&gt;R23 tension exempted in H4.A [#458](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/458), H1 [#455](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/455), H2 [#456](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/456)] ([#464](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/464)) ([1892622](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/189262201840d8c944c3eadf4cd08dd5b26dfe72))
* H4.C stub-scanner ([#463](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/463)) ([8467c6f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8467c6f568a51337a7acbfb14f72ac85b996d605))
* H4.D provider-wiring scanner (R100) [LOC-EXEMPT: test-only split — both files under test/**, genuine prod LOC = 0; CI A3 pathspec counts test/** so the floor trips on the spec sized for R74 ratio&gt;=2.0; same precedent as merged H4.A [#458](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/458) and sibling H4.B/C/E/G PRs] ([#465](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/465)) ([9bf6d66](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/9bf6d66fb832aa6b8c10ee47776c9796e26aaf4e))
* H4.E learning-ledger ([#460](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/460)) ([fb8768d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fb8768d3edb5ff354dbe0d67f92c11358768381c))
* H4.F auto-flipper for READINESS_AUTO_FLIP secrets (R100) [LOC-EXEMPT: all net lines are scanner + spec under test/** which R76 excludes from the prod cap; genuine prod LOC = 0; CI A3 pathspec counts test/** so the 400 floor trips on the spec sized for R74 ratio&gt;=2.0; same precedent as merged H4.A [#458](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/458) and sibling H4.B/C/D/E/G PRs] ([#466](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/466)) ([0281261](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/02812619023d79f09952ffcf768bf6496a61f737))
* H4.G1 reporter ([#461](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/461)) ([ff8a4e6](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ff8a4e68fcf55150e8edd1325cd4da8439a91025))
* H4.G2 operator-keys-generator ([#462](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/462)) ([210f4eb](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/210f4eb742aa8283c3ad79d632b0819c90b23323))
* **help:** public self-serve coach help surface at /help/* ([#103](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/103)) ([9013a1e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/9013a1e47a61e058ec3a8af79b942cc91a0a0da8))
* hybrid coach pricing (free default + $99 Pro tier) ([#234](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/234)) ([76ca154](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/76ca1545f41c593d2c16542c05d07230b81f0c1f))
* **kms:** kms helper + bloodwork + calendar refresh-token retrofit ([#195](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/195)) ([5b7d130](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5b7d1301462cc756d1b8f0b1ea606eb511129f2e))
* **landing-pages:** banned-payment-host blocklist + Zod section schemas ([e098e9c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e098e9cda731adff1d4a3acc027259b1c40800f6))
* **landing-pages:** controllers + module wiring + public routes ([5d505f9](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5d505f903d42f8e0c7a56651bb7e6472c1a06bf8))
* **landing-pages:** DTOs for coach CRUD and public routes ([627efff](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/627efff708f9dc010776b90cdb966ddd00271053))
* **landing-pages:** LandingPageService — coach CRUD ([afa8bf0](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/afa8bf0418b53dc78d7468154d2a511f5b0f80f4))
* **landing-pages:** Phase 1 schema + RLS + migration r46 ([b8d8223](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b8d8223d3788a6ba08f90e69278cd261bc45aa44))
* **landing-pages:** Phase 3 — CRM adapters + lead sync + analytics ([#272](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/272)) ([68d36a1](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/68d36a1c6e81a01c36ea45b811caae56114de33d))
* **landing-pages:** renderer v2 — SaaS-brand tokens + 7-section persuasion arc + audit fixes ([#274](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/274)) ([d77b5c4](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d77b5c49b193dcc42b460abec63d289779691897))
* **landing-pages:** SSR HTML renderer — premium landing page templates ([041ce44](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/041ce440769e0f0f7b39494990e6ae6d45a24b72))
* **leaderboard:** peer leaderboard with combined-score metric (opt-in) ([#161](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/161)) ([98678de](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/98678decafbef489a8a08d8f9eadc9f8e0d26b32))
* **me:** add GET /me/feature-flags server-evaluated flag endpoint (unblocks D5=B+γ for PR [#251](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/251) rebuild) ([fe6eb1d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fe6eb1deb3cb0975aa7b7a3ede9d01976e7320c3))
* **me:** GET /me/feature-flags — server-evaluated feature flag endpoint ([1e4b657](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/1e4b657e75c631f540c51322256a6e086915413f))
* **notifications:** Phase 9 — full notification matrix, digest cron, 7 emitters ([#168](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/168)) ([d15896c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d15896c435394b06eed03ee00b5de595a2ea3517))
* **observability:** H3 — prom-client /metrics, pg_stat_statements, Sentry release tagging [LOC-EXEMPT: R100.A1 mandatory &gt;=2.0 test:src density forces ~1059 net test lines against ~505 net src; PR is overwhelmingly tests, not feature bloat — same R74&lt;-&gt;R23 tension exempted in H1 ([#455](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/455)) and H2 ([#456](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/456))] ([#459](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/459)) ([2ad6ae9](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2ad6ae91c9fa1293d639824b5b4e969fae35f42e))
* **observability:** Phase 10 — structured logging, request tracing, Prometheus metrics, health/deep, profiling ([#173](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/173)) ([4ac7001](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/4ac700170b78c571308b6e9e00bbcb5852d696ca))
* onboarding billing v1 — payment intent idempotency, IDOR guard, EphemeralKey idempotency, sub-coach fee split ([5444113](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/54441130ad75abc3782363d0b32c43fed9fc8c77))
* **ops:** automated smoke for OWNER admin/federation routes ([#83](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/83)) ([0b66912](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0b669122b0b1caa14edee4282dd8f2fda1bbddcb))
* **owner-console:** implement real MRR/ARR, churn, payments, payouts ([7cb90e2](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7cb90e247a0626c08ad650e12036a91cbb30ebf4))
* **packages:** PR-3 drip-feed schema foundation (additive only) ([#314](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/314)) ([ac82e49](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ac82e496c7f36524e940f3ee9ba4452af937dcaf))
* **packages:** PR-4 PurchaseFanout seam wired into all 3 checkout paths (no-op body) ([#315](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/315)) ([72df321](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/72df32193b095ab3a7c08861a5c529a27edb98ac))
* **packages:** PR-6 backend reads + draft/publish + duration_periods + pricing combos ([#317](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/317)) ([b7fef8a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b7fef8a4d409d5c95e2827efacd5708366245b6f))
* **packages:** PR-8 coach package CONTENTS endpoints + zod-per-cadence validation ([#318](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/318)) ([ba764bd](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ba764bd282048e30190532619443433bdd952e28))
* **packages:** PR-9 real PurchaseFanout body — atomic entitlement+drops ([#319](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/319)) ([8843343](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8843343d5253050a7be0d2dd8fad434249bcf7a7))
* **payouts:** bank-account ACH payouts v2 (FEATURE_BANK_PAYOUTS_V2 off) ([#374](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/374)) ([f123ef1](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f123ef1d81dfb6b47af51c97bcebec75109d165f))
* **phase-11/push-categories:** notification category enum on Expo push payloads ([#184](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/184)) ([180ab98](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/180ab9898a46c609cdc89f5d2266298b67445667))
* **phase-11/sub-coach-mgmt:** roster + analytics + reassignment APIs ([61c74b8](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/61c74b821f5d1ef4b1fd4ccd2b14d35476747758))
* **phase-11/workout-builder:** exercise library + workout plan + assignment models ([97760da](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/97760daef03a04c55f53ef1c5b17d43e4e16453e))
* **profile:** dietary_pattern, dietary_restrictions, workout_days_per_week ([#97](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/97)) ([18ce278](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/18ce2782358428ad302623499c5a7857447696f9))
* **profile:** equipment_access TEXT[] for granular AI workout context ([#102](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/102)) ([46e5f33](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/46e5f33aa4d404afbcdc16953e0b1b31c1005f0f))
* **r43/storefront:** schema + migration for share links + guest checkout ([d33433d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d33433d61fe95e23b5184ec487c9a3704c144200))
* **r43/storefront:** ShareLink + Storefront modules + webhook routing ([8c54cb9](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8c54cb9418a66c689f36eac83be9fa9e07cd1570))
* **rate-limit:** Phase 10 — per-route, per-user, per-IP rate limiting ([#166](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/166)) ([6dc0af3](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/6dc0af3d77e8e47424980fd759557cde9cdbae7c))
* **regimes:** add coach-only RLS for PartialRefundDecision via additive migration (R81 F3) ([ce9348e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ce9348eacfb71085b077515ace6670e6bb6024c8))
* **regimes:** backend service + controllers + refund hook — FEATURE_NAMED_REGIMES off ([d01ed06](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d01ed06b12e95f368f22fd8f80e799e687d6b1de))
* **regimes:** schema — WorkoutProgram regime fields + PartialRefundDecision ([b5400ce](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b5400cedabed8ae2d5896a15cd0f019d752328b1))
* **reports:** pdf transformation scorecard + finance federation columns ([#146](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/146)) ([72e7ee6](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/72e7ee62927f88433175c5bca43c3d2c95c2faf6))
* **roman-p4:** CoachFirstPaymentNotification (backend) — gated FIRST_PAYMENT emit on Stripe webhook ([#395](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/395)) ([adc066b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/adc066bd3f597c99c29cc4636dc206e62ef49608))
* **roman:** ED.2 three-arc router daily counts endpoint (backend) — FEATURE_ROMAN_THREE_ARC_COUNTS off ([#400](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/400)) ([0d13bfb](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0d13bfb285b52e40ae94c67a3a65c1c37df93ec0))
* **roman:** Phase 1 chat MVP backend — sessions, messages, SSE streaming, RLS (FEATURE_ROMAN_CHAT_ENABLED off) ([#378](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/378)) ([2fa6b57](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2fa6b57e0494db4b560e14b63d3c6bafbf122b7f))
* **roman:** Phase 2 backend — in-app notification voice swap across 7 surfaces (dunning, lockout, paywall, billing-update, ED.3, empty states, onboarding) (FEATURE_ROMAN_COPY_V2 off) ([#380](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/380)) ([e273c2e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e273c2e4485aa6cdfb1370ea58b4564959236ebf))
* **safety:** report + block endpoints, fail-closed message delivery, RLS participation check, throttles, idempotent upserts ([#263](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/263)) ([58c4588](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/58c4588bc50ea39e6696b5fcb3038144dfa1ab14))
* **scheduling:** booking lifecycle notifications + 24h/1h reminders ([#194](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/194)) ([6708adb](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/6708adbfa9601d2feea4d44c33d9fadd8241bfee))
* **scheduling:** concierge phase 1 — tgp-exclusive open-slots + override crud + google flag ([#193](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/193)) ([8857c1d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8857c1d5fa7bde37b4d3461f87fc1f78051fd43b))
* **scheduling:** concierge scheduling v1 — private 1:1 coach&lt;-&gt;client booking with Google Calendar sync ([#142](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/142)) ([#142](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/142)) ([a692b20](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a692b203a3ed31ad5d15c426a8fd03ece16057a2))
* **scheduling:** real google calendar adapter with mocked-fetch tests ([#192](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/192)) ([022c640](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/022c64046ff85a7ddf6ae1295f816901537c621b))
* **scout:** add conformance_alpha adapter behind source-mapper seam (V5 PR-2a) ([15ae9b2](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/15ae9b25e7c1a778f579ce1823f3a24569484eef))
* **scout:** add IMPORTER-I reconstructed-entity review read API [LOC-EXEMPT: canonical read bridge + mandatory coach-scope/no-oracle/erasure + live-RLS security suite exceed 400 net LOC; density 2.66 passes natively] ([f92a689](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f92a689838a0ae948e53f4cf4fad50991d17ec00))
* **scout:** coach-scoped reconstructed invite-pending roster read (IMPORTER-G) ([77bb4a0](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/77bb4a04f6e087886e6f27c5129d17dc5162f356))
* **scout:** parameterize reconstruction over entity families [LOC-EXEMPT: canonical RLS table + mandatory security tests exceed 400 net LOC; density 2.12] ([f9b81cf](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f9b81cf73289bfe74087dfe6327e52e460fb44f6))
* **scout:** POST /api/scout/ingest — extension crawl envelope receiver (FEATURE_SCOUT_INGEST off) [IMPORTER-B] [LOC-EXEMPT: 846 net — 239 prod src under the 400 cap; overage is R74-mandated test LOC (541) + migration/schema SQL] ([#501](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/501)) ([3478b61](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3478b61dcbf1debc878fce1a3d68ba805e357dfa))
* **scout:** POST /api/scout/progress + /api/scout/ingest/complete — cross-device progress + completion (FEATURE_SCOUT_INGEST off) [IMPORTER-E] [LOC-EXEMPT: test coverage + RLS migration + prisma schema; shipped src is small] [TEST-EXEMPT: ratio 1.99 vs 2.00 — 873 test LOC incl. live-DB RLS + transaction coverage; 0.01 shortfall is rounding, not a coverage gap] ([#500](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/500)) ([9b55620](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/9b55620a7bed750444faaa2d864e4e4577e5c2d8))
* **scout:** reconstruct settled crawl clients into invite-pending roster (IMPORTER-F) ([#510](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/510)) ([1e6b3bf](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/1e6b3bf434cb58fbe65cea92a480755f0e414fb6))
* **scout:** tenant-scoped import-status read for mobile progress UI ([#508](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/508)) ([95e2c63](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/95e2c6378e0b1b734328a7fdf6b9a6e33465a663))
* **scout:** thin source_platform to mapper registry (V5 PR-1) ([8a86056](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8a860561d5b7f8273e761dc9353d938cd02061a2))
* **secrets:** Phase 10 Track 7 — Secrets rotation playbook + zero-downtime JWT rotation ([#165](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/165)) ([cf836a6](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/cf836a652dac7d32ee6253e69477dc4b24164e40))
* **security:** R-DARK-1 global feature-flag route middleware — uniform 404 before auth ([#503](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/503)) ([52aca5f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/52aca5f52bb9c38edb6ed9001bce8f9a609aef5e))
* **security:** SecurityGuardsModule + module-cycle guard test (prevents [#243](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/243)) ([#245](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/245)) ([a9c1956](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a9c1956f6a4ed12c9641c527c4af0fbacfaca1e6))
* **sentry:** upload sourcemaps to Sentry on every Fly deploy ([#95](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/95)) ([f2cb871](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f2cb8719e69b3cfdc8cb6a9064470e684f5fda86))
* **share-link:** throttle mint + expiry/revoke routes (P2-3 P2-4) ([660c849](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/660c849c10a2ae5b68a20f97fc1e3ab17016e95f))
* **soc2:** Phase 10 — SOC 2 prep stubs (policies, controls, evidence snapshot) ([#169](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/169)) ([c51828f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/c51828fd1c65213b318ff856ae2d0a3df450e584))
* **sprint-b/v2:** coach toolset (workout builder, macros, meal plans, holistic insights) — clean rebase onto Stage 3 ([#188](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/188)) ([984fb0c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/984fb0cdfdf90d075eee3966e7b363238b7284c2))
* **stage-3:** coach-facing cross-pillar federation surface ([1663867](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/16638670358155b24b0b268ec51846849d580db6))
* **talent-marketplace:** TM-1 schema + RLS foundation (JobListing/Applicant/Application/CoachOffer/idempotency ledger) ([#425](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/425)) ([544291a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/544291a254563d73fd627bb05a38ea892e871557))
* **talent-marketplace:** TM-7a admin listing moderation (owner-only) [LOC-EXEMPT: dual-lens P1/P2 fixes + audit-log + note persistence + lifecycle timestamps] [TEST-EXEMPT: extensive negative + replay + audit-log + concurrency coverage exceeds 2x ratio purpose] ([#452](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/452)) ([66135d7](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/66135d7f0c42c904828375a1011d8c61495b84f0))
* **talent-marketplace:** TM-7b admin applicant review (owner-only) [LOC-EXEMPT: matches TM-7a evolved contract — ParseApplicationStatusPipe + audit log + note/decided_by/decided_at + wire spec] [TEST-EXEMPT: 65 admin-applications tests covering pipe + audit + idempotency + replay + status-guard satisfy R100.A1 ≥2x intent] ([#470](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/470)) ([a6f6e0b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a6f6e0b23be882eecae7e771d2afb3894a14a6b8))
* **talent-marketplace:** TM-8 hirer applicant tracking + PII-stripped CandidateCard [LOC-EXEMPT: PII projection + stage machine + 8b route stubs + comprehensive specs] [TEST-EXEMPT: spec count covers PII boundary, state machine, scope, idempotency, opacity] ([#449](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/449)) ([b815e7d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b815e7dcc4bd1a2f77afeb8f8234292d0526dbd3))
* **team-mode:** foundation v1 — ADR §10 resolved (Pro paid seats, Enterprise included, many-to-2 sub-coaches) ([#118](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/118)) ([a3abcba](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a3abcbae21a08d49818ec336b1ee8708ba31a993))
* **throttle:** Redis-backed throttler with user-keyed tracker + per-surface limits ([#93](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/93)) ([cef7723](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/cef77232de2b321022c9a7271edfdc559c9e1bbf))
* **video:** exercise catalog v1 + Mux ingest, webhook, playback URLs ([#214](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/214)) ([bcbd7b0](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/bcbd7b0592e6dfdffbe83754544fe265fb2765d9))
* **wearables:** PR-HK-0 — foundation (schema+RLS+ingestion) ([#345](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/345)) ([9c67444](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/9c67444c2be6bb712509ef379e43f6f29a289570))
* **workout:** MWB-1 master workout builder data model + RLS + sub-coach scope + entitlement guard ([#376](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/376)) ([6c4f618](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/6c4f618c938e897ead81d1044aec42d826440c14))
* **workout:** MWB-2 templates + clone-to-client + sub-coach scope (FEATURE_MWB_TEMPLATES off) ([#381](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/381)) ([94f830a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/94f830abc1b2699e943763ab2125187f57dfda53))
* **workout:** MWB-3 autosave + real undo + revision prune (FEATURE_MWB_AUTOSAVE_UNDO off) ([#386](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/386)) ([25dbc79](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/25dbc790ce4562ed8a863a36a26bb5bf8e02c0f9))


### Bug Fixes

* Fix:  ([790f6a5](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/790f6a51c671e9cf89d6017cc196e30e68345e65))
* AASA prod-only + PII salt prod-required + scrub converted rows (P2-1 P2-2) ([ed2ecfa](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ed2ecfaed88fe644f7e56d51ee3daf43816164b3))
* **ai-credits:** Stream 1 backend — AI credits + metering + R1/R2 audit polish ([#298](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/298)) ([cd40665](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/cd4066523e0589e46ab3aeb023ff0460df240e0f))
* **audit:** address 2 critical + 3 high + 3 medium findings from 2026-05-19 ([#233](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/233)) ([fbf5eca](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fbf5eca1b6e7acada70d0c474484d41099695e4a))
* **auth:** require active CoachSubscription before become-coach ([#225](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/225)) ([16e041c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/16e041c96a1c7a0915d3ac6c815f998e474e89b7))
* **B3:** custom-domain apex routes outside /api global prefix ([#342](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/342)) ([a344ec4](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a344ec4d47b4a3503707253ccf93335807a6af2e))
* **backend:** pre-Connect P1 cleanup — throttler, redis, sentry, cache, cron, seeds, soc2 ([#200](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/200)) ([b6de53b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b6de53b7f3f5dc505a324f6f4572f45abca76d1a))
* **billing:** atomic webhook event + raw-body-only signature (P1-1 P1-2 P1-8) ([edb9509](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/edb95095b251daa3c19539f50f1c341db656aac6))
* **billing:** handle Stripe transfer.failed webhook (P0-c) ([#313](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/313)) ([42906c8](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/42906c8d83792241ffa92611ca4751ecef1f5aff))
* **billing:** mirror portal-session login-link fallback on mobile route + correct README guards ([#116](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/116)) ([38bf8bb](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/38bf8bb1952eec98116c72de7d527a38a8656f2a))
* **billing:** pre-TestFlight P0/P1 — dual webhook secret, cancel endpoint, admin stripe events, tier env smoke ([#199](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/199)) ([e2720d9](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e2720d90790ddc28bb76b591ed38bde9d296c42a))
* bug-r2 dedup legacy meal-plans routes to real-meal-plans canonical ([#371](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/371)) ([c48e79a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/c48e79a8f374b4db8446ae92223b422d6994bb82))
* bug-r3 block archive of package with active subscribers ([#372](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/372)) ([f9b3c05](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f9b3c050d678524d8f4bf139fe268df57af5d203))
* **c5:** close 4 P1s — invite spam, data-export race, recent-auth replay, cancel-deletion race (A1-C5-P1-{1..4}) ([f10659d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f10659dbdb9b2d7b9bd03798e955799f4ffdd9cd))
* **c6:** add ALTER TYPE migration for revenue_sharing_changed enum + correct audit-action comment (A1-C6-INF-1, A1-C6-P2-1) ([4b0136d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/4b0136d327843d314ea3dd2e57cac4a1b7e0928c))
* **c6:** audit-log revenue-sharing changes + hash sub-coach invite tokens at rest (A1-C6-P1-1, A1-C6-P1-2) ([2dbd038](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2dbd0384620d93c93c438367674933c0edca4416))
* **checkout:** scope coach purchase drill-down by coach_user_id to eliminate 403-vs-404 enumeration ([abdf4f4](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/abdf4f4d12791c7d9ccb94893d4aa6b6dc7e0da8))
* **checkout:** scope confirmSession by local purchase before Stripe retrieval ([6a4dc13](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/6a4dc13388abe1c2e6afc005db4204985e53f667))
* **ci:** add DIRECT_URL to simulated prod env gate ([#246](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/246)) ([542663e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/542663ed226123baeeef409e6ff0bf11e694c72c))
* **ci:** add Stream 1 prod-hardened env vars to simulated-prod env-validation step ([#310](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/310)) ([e093900](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e093900653726dbaca6ac4b5e4e5bc6d6c4bdf29))
* **ci:** re-run _supabase_bootstrap.sql on reversibility reset ([#498](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/498)) ([5a3a823](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5a3a823abac5cf1eead1c87bf532214c95971597))
* **ci:** strip ?schema= from DATABASE_URL before psql/pg_dump in reversibility gate ([#497](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/497)) ([23806be](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/23806be858f72fc06a332e70224cda58204ac72d))
* **ci:** strip pg_dump 16 ephemeral session tokens from reversibility diff ([#499](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/499)) ([c041da4](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/c041da41aa9ce14af6814c0d3946f8ac6285c2bf))
* **coach-brief:** atomic generation claim, push dedup, sub-coach scope, MRR normalization, timezone validation, push timeout, cron from ConfigService ([b8b0434](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b8b043472adfa4243951c323111f36ccd335c684))
* **coach-brief:** consolidate A5 P1/P2/P3 fixes + R50 preflight script [A5-P1-5 A5-P1-6 A5-P2-1 A5-P2-2 A5-P2-3 A5-P2-5 A5-P3-1 R50] ([dc24ffe](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/dc24ffe5e6cfca71ba92cd1390157e98665cbc20))
* **coach-brief:** default notification_time to 05:00 per operator [A5-P1-1] ([4525243](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/4525243c3d567cf237e6c25a0ff71022c5606db7))
* **coach-brief:** Fix Round 2 — P1-6 UTC timezone fallback, P2-1 new migration, P2-3/4 timer cleanup + accurate push logging, P2-5 claim-after-success ([660030d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/660030dae120501c7b26816cac78251577a455a4))
* **coach-brief:** Fix Round 3 — repair root-tier test wiring (ClientAIContextService DI), RolesEnforced, env-validation fullProdEnv fixture ([b7ae661](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b7ae661bdd1d6091644391f9b09c1e009893341e))
* **coach-brief:** generation lease + push-ledger + business-only head-coach ([ce825b8](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ce825b82555602dcb02b2b1e48fa34219423d527))
* **coach-brief:** P1-1 R45 README package default + CI grep gate ([40f0ff4](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/40f0ff4d355ceef7deb901ca0e370b83c46b354a))
* **coach-brief:** P1-2 master COACH_BRIEF_ENABLED kill switch ([3e2d2c8](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3e2d2c83b04d881918ce0ef04d0a15365ce90813))
* **coach-brief:** P1-3/4/5/6 + P3-1 typed push delivery + bounded retry ([fe8ab95](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fe8ab958e9923936e3414e0481c2b58e8c8bf5f1))
* **coach-brief:** P1-7/8/9/10 revenue leak, prompt sanitization, narrative cap, cleanup ([6a325cf](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/6a325cf440439b85b6cc4b54f99f4531fe5b0bbd))
* **coach-brief:** P2-1/2/3 concurrent index, real-calendar dates, tz format, claim ordering ([7ae3b6c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7ae3b6cd7febbee9cabad57ed76c75df497ddf8c))
* **coach-brief:** P2-4 resolve 6 high npm-audit vulns via overrides ([d1c69e8](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d1c69e8469a30e3313086e337b62eb5c99c0bbce))
* **coach-brief:** revert drive-by allowlist, fix toISOString().slice [A5-P1-2 A5-P1-3] ([1de04cb](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/1de04cbc6d0773bf22f3111b1051151a3aaf7903))
* **coach:** add cursor pagination to client list (audit-1-fix-2) ([#177](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/177)) ([cc93774](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/cc93774a4ceb2263bc4cbee3455eef9be4b3d9f2))
* **coach:** bound getAlerts weight-log scan to 30 days (audit-1-fix-3) ([#175](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/175)) ([7e13126](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7e1312653d5ba6c8829452378e993e3068ad739d))
* **coach:** paginate getClientTimeline slices with take:100 + cursor (audit-1-fix-7) ([#180](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/180)) ([6994492](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/6994492981bbe65767803141453d1aec2f95aa3e))
* **coach:** scale-readiness [#6](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/6) — SQL aggregate for dashboard food totals ([#179](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/179)) ([0a5f616](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0a5f616ae67e05c3c880fc90183ed9c2afff0b71))
* **connect:** idempotency key on Stripe account_links creation (P1-3) ([fc9146c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fc9146cd4e794d3892716bf685ae928ba924a0a4))
* **data-export:** include RUNNING in rate-limit dedup predicate (audit A1-C5-INF-2) ([d4d17e8](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d4d17e81e8b027556663c985f1ac0a5b07775cfd))
* **deploy:** add directUrl to Prisma schema + DIRECT_URL env var + 5m release timeout ([790f6a5](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/790f6a51c671e9cf89d6017cc196e30e68345e65))
* **deploy:** add Message model + reviewed_by_coach + 4 TS error fixes ([#230](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/230)) ([2a66f40](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2a66f40a0bc80fa54d369fa86234ff2008602fcb))
* **deploy:** invoke release.sh via bash; pin LF endings repo-wide ([#87](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/87)) ([977bf4e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/977bf4ed88577c76bc894dd2f91548d656d8fecd))
* **deps:** provide ws transport for supabase realtime client (node 20 compat) ([#197](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/197)) ([2fefa99](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2fefa9953336e3a5010220677516b5a98724edae))
* **deps:** sync package-lock.json with package.json ([#229](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/229)) ([4c8da0b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/4c8da0b8963b76410707b02327bf932b3b400e25))
* **docker:** skip lefthook hook install during image build ([cbcbe70](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/cbcbe705ee7554b7f3b0653d89ad7d558dbc0619))
* **docker:** strip prepare script in image build; LEFTHOOK=0 does not gate install ([370eb4a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/370eb4a6cf71f9786a6630cd4e3a8083e1c43855))
* **dto:** align Coach Brief timezone @MaxLength to DB CHECK (80) ([decd5d9](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/decd5d9b172393842a133c0f908e1b8282382319))
* **email:** copy .hbs templates into dist via nest-cli assets (boot crash) ([#220](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/220)) ([efd5159](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/efd5159220e216658d72f659539b35ac8ac66349))
* **entitlement:** guard /insights/holistic, /scheduling/*, /messages/voice-upload ([#259](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/259)) ([5c1893f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5c1893f96867b7d32b3ff6e019bff5a0d980a5b3))
* **env-validation:** register storefront prod-hardened vars + aggregate prod blockers [A5-P0-1 A5-P0-2 A5-P1-7 A5-P2-2] ([038c5e8](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/038c5e8781a503d4b1ebb2022e6de5d6bde06374))
* **env-validation:** remove duplicate video-provider entries from prodHardenedFeatureVars ([c158bab](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/c158babaae09d142a0054769b08c6a8c6b4d9ed0))
* **env:** add feature tier so prod boot doesn't require Stripe/Sentry/launch URLs ([#64](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/64)) ([cbb737f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/cbb737f1e631760d722f69036228eed225e0e450))
* **feature-flags:** add @Roles('student','coach','owner') to satisfy RolesEnforced gate ([61e6f27](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/61e6f278c39c667dd9c5146bcb7d9dac9691fb4f))
* **feature-flags:** enforce flag-key contract, drop banned test casts, count enabled flags ([3675307](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3675307f202c402639da463e6e3f5572f4a5ff11))
* **federation:** dual-secret support for FINANCE_SERVICE_TOKEN rotation ([#201](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/201)) ([f54cc47](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f54cc4760af29ef6fe26b1469089b61c8d362e8f))
* **fly-secrets:** tolerate "Partial" rows in fly secrets list parsing ([#115](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/115)) ([50fd2dc](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/50fd2dcf216df9f6dcd3d1644b7a657f22afb3bb))
* **food:** Trainerize-grade logger — NL parse, per-serving math, cup/tbsp conversions, USDA seed ([#203](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/203)) ([95a4a15](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/95a4a15224a8fd7aae0be5daf63bedd848da3ff9))
* **gdpr,ai:** scrub AIDraft rows on user deletion to close GDPR Art. 17 gap (A1-C3-P1-1) ([9dd150e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/9dd150ea80232ec79bee3d6feac30912d98a48aa))
* **gdpr:** scrub Coach Brief tables on soft-delete (PR [#266](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/266) P1-1) ([743f00c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/743f00cbf87127eda46ee12382fa9af9eb001f35))
* **google-calendar:** align webhook controller with RFC-142 + structured errors ([#241](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/241)) ([50efa6d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/50efa6d6d10cfbaf1205fd5cc9ddbe95cc01ec13))
* **infra:** install ca-certificates so Sentry sourcemap upload can reach sentry.io ([#99](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/99)) ([f2a119e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f2a119ef0365d8154700482820b9b6eabe63e8c7))
* **infra:** keep one machine warm and bump to 2cpu/2gb (audit-1-fix-1) ([#174](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/174)) ([29e23ea](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/29e23eab13e4bc0fa2cbd38eb1d0719cd1749bff))
* **insights:** point finance-insights client at /api/federation/insights path ([#191](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/191)) ([b26a086](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b26a08673023c3710dd6fd72a36f1aa0bb9633bd))
* **invite-landing:** AASA/assetlinks refuse stub responses in production (P1-11) ([5ab0aec](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5ab0aecb47ef7007b5883c101be577aa9db3ca1b))
* **invite:** make public preview fail closed on Prisma errors ([#100](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/100)) ([f961ec8](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f961ec82ec152f100f532221fd740ab161824a0f))
* **landing-pages:** escape &lt;/script&gt; + line separators in JSON-LD (P0 XSS) ([8f2c47f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8f2c47fbe8a8ce08aff422057dffa8365e1ddebb))
* **landing-pages:** move hero background-image to &lt;img&gt; element (P1 CSS injection) ([e3c6c73](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e3c6c73f6fadc0f13fa93c60a120413ceca18079))
* medium audit fixes (M1-M15) + MoR automatic_tax ([3deb873](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3deb873403881128891cdbb570ae003d32e9950f))
* **messaging,invite:** pre-TestFlight P0 — emitter wiring, AASA/assetlinks, FK SetNull, audit writes ([#198](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/198)) ([96630f4](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/96630f402db274b2379e03a15eed1281a397980c))
* **migrations:** narrow forward-deploy chain repair — unblocks H3 [#459](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/459) ([#487](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/487)) ([429554b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/429554b6df6f07c4bf7d65d85da0f80c92b00a8c))
* **migrations:** strip prisma CLI update banner from baseline migration ([#104](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/104)) ([0b8ae55](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0b8ae55b1fb7b0fda6fc8755560342ca3e186ca8))
* **notifications:** R81 rebuild of PR [#395](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/395)+[#402](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/402) — close N1 (push throttle pre-commit mutation). Refs [#407](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/407) ([f6eb5cd](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f6eb5cd7e375147cf4834b645cb885f6e2ce0d5e))
* **notifications:** restore original 20260614065425 migration; drop unnecessary recreate cycle ([be3e2fd](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/be3e2fd2b6d0ba2e84a1f4160e23407af14ff71b))
* **packages:** collapse requireOwnedPackage 404-vs-403 enumeration into single 404 (A1-C2-P1-1) ([cf2a36a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/cf2a36a74c49bbc483ab2dbea790902e91b68b5b))
* **packages:** R81 rebuild — push-to-existing-drops with audit findings closed (replaces [#326](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/326)) ([4c052a2](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/4c052a22b09fbcc2abe8b25f0025d098edd2516f))
* **packages:** R81 rebuild of PR [#326](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/326) — close F1 (dispatcher race), F2 (throttle), F3 (zod strict), F4 (audit) ([73161de](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/73161de99732bce504bb5a42c4a30e4a3afb4553))
* payout-failed webhook handling + Stripe-write throttles + start-subscription DTO ([#329](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/329)) ([934d837](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/934d837c1987ddcdb49276dc2c598ea290a3747f))
* post-audit critical + high fixes (C1-C11, H1-H3, H5, H10) ([60ba305](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/60ba30527eb7ec9986ff87adb88921c3bc84dbaa))
* **pr400:** R81 post-merge closeout — daily-rings F1-F8 ([#417](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/417)) ([0b7622e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0b7622ee23c0f72b2530a55a77029d3446217fb9))
* **pr401:** R81 cleanup — break DI cycle, tx-safe partial refund, RLS, throttle, take cap ([8d22a4f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8d22a4f68a727eaa42511e38ab426f01d0627e65))
* **preflight:** R45 self-violation in script doc-comment ([8241b1e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8241b1e3e86377950d4532692e612c9aabbdbcdf))
* **prisma:** scale-readiness [#4](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/4) — explicit connection pool sizing ([#176](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/176)) ([7f3440b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7f3440bffa5a128f45d7757e8add050cb17e697a))
* **prod-readiness:** correct branch-protection guidance for deploy-readiness checks ([4cb05ef](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/4cb05effb760d3f89a15f59d2983ab5a8e0d43d7))
* **prod-readiness:** make OPERATOR_KEYS_NEEDED.md deterministic and truthful ([07ff974](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/07ff974079eb1da02f1de4f5ecd18c1f223afeae))
* **ptm:** wire app_open + finance federation signal emitters ([7ab614e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7ab614e3822efad5ae4f1e1c5770604b33eee865))
* **qa:** P0 launch blockers — auth, workouts, food, voice, scheduling ([#222](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/222)) ([2498cf0](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2498cf006c0df18799be88ab264c4badde02881a))
* quality audit corrections — team guard coverage, revoke return type, webhook no-op, package DTO field alignment ([614c9ea](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/614c9eab22b2742a71754448ea742b1b3f7fc5f8))
* r1-r2 quality corrections — student role in food controller, entitlement response shape, pushToUser receipt polling, stripe verifier docs ([f2fe754](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f2fe754070cefa923a511c069a5a131d30b2681a))
* **r45:** purge banned hostname from README, tests, CI (P0-1) ([980c193](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/980c1937919fda55b3e5860b5ec5cf47b90eb2b2))
* r6 quality corrections — DI wiring, past_due recovery, throttler security, invite enforcement ([93d2012](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/93d20126c62dfec38060ab59797c60ed4a809a1e))
* r7 quality corrections — admin guard, nonce enforcement, MIME sync, AI sanitizer ([a23d35b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a23d35b263da83b3a3cc8ce47bd8b77b1b29e8e4))
* **regimes:** add @Throttle to regime + refund-decision write routes (R81 F4) ([5b6520c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5b6520ce540986d89da5733407d5ced962dfa534))
* **regimes:** add take cap to getRegimeRevisions findMany (R81 F5) ([f54042f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f54042f4555912b8226960c3fe8a2698ced288fd))
* **regimes:** break module import cycle via global guards, not AuthModule import ([4314710](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/43147109ac30bc383a6b7aa13aecdd82ba1413f1))
* **regimes:** break module require cycle + register regimes jest root ([a367d66](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a367d660afb0666d516601ccbdf4b42a49ed98b0))
* **regimes:** R81 [#401](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/401) converge — decide() zero-row race, updateRegime row-lock, typed Prisma double, column rename ([f9e8191](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f9e8191e844bdb3804397a7b743afda5e345f12f))
* **regimes:** tx-wrap onPartialRefund find+create with P2002 idempotent skip (R81 F2) ([7b5a08a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7b5a08a03e3d7a474037bdce1b26c9fbc343e055))
* **release-audit:** P0 — Mux authz + webhook state machine + sub-coach invite recovery + URL config + Stripe fee rounding ([#221](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/221)) ([27f1360](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/27f1360852e20f0417375e94f556e51126c11ebd))
* round 6 — subscription enforcement, invite security, GDPR deletion, RLS, rate limiting ([2aae6b7](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2aae6b72a01fba82599995f896528d43656aaba9))
* round 7 — Apple nonce, Stripe webhook binding, admin guard, AI injection, voice upload ([0b5cae9](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0b5cae9342fc3a546bcec57d6655c2220cfcf8be))
* round-3 audit fixes — checkout scope, sub-coach guards, team RLS, coach_direct pref, nullable video ([9a883f4](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/9a883f49534973df63f51658b536bbded641a8e3))
* round-4 audit fixes — sub-coach cross-tenant theft, guidelines auth, fasting race, PaymentIntent race, reschedule overlap, admin service token, webhook hardening ([f51edd5](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f51edd57e1e6706d931793429918d4ac389a9111))
* round-5 slop fixes — digest error swallow, package DTOs, invite transactions, hardcoded URLs, N+1 audit writes, past-session guard, dead code ([693cc2a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/693cc2a3407e44b5bf45311bd3cc124f544886f5))
* **scheduling-test:** pin clock with jest.useFakeTimers so hard-coded fixtures don't rot ([#359](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/359)) ([24015d1](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/24015d1da7c2633bf722a20f40a75b731161c3da))
* **schema:** rename duplicate sub_coach_assignment back-relations on User model ([d6a127d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d6a127d9759d9ddf1b9c13fbaac289298e7f5343))
* security hardening v1 — RLS, rate limiting, checkout atomicity, webhook reliability, Connect layer, service splits, owner console ([0eb1285](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0eb12857e6b19933c0ed296082d60bf82843ebf3))
* **ssrf-guard:** use namespace dns import so module loads under CJS wrapping ([c233372](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/c233372c323ec09dba103e06024f241d90a17bb5))
* **storefront,connect:** on_behalf_of on destination-charge PaymentIntents + strip PII from Stripe metadata (P1-10 P2-4) ([c960cb0](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/c960cb092a68b9e4b170683432037acab001a72f))
* **storefront:** 2% + Stripe pass-through fee, min/max guard (P1-4 P1-5) ([81710d4](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/81710d433af7040b0ead8b8eb4e6f186a5b16b23))
* **storefront:** canonical recurring guard, retryable conversion, processed-event split (P1-5 P1-6 P1-7) ([0cd736c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0cd736cb4b550a9d36463ca4e2cbdfde3c04af9d))
* **storefront:** clamp platform fee at charge amount + USD-only Phase 1 (P2-5 P2-6) ([19f37ae](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/19f37aed100e78eb4e218e9f8cdcf898b2cce2e5))
* **storefront:** drop raw email index + document CONCURRENTLY ops (P2-6 P2-7) ([78cf8fc](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/78cf8fc9cba70b6e7e4925a638144ef83bc7d9cc))
* **storefront:** Fix Round 1 — P1-1 platform key, P1-2 atomic share-link, P1-3 recurring guard, P1-4 durable conversion, P1-5 email pagination, all P2s ([395c964](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/395c964cca3a1577c9eab8b7605768cd99e150fb))
* **storefront:** full connected-account readiness gate (P1-8) ([04ad3ec](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/04ad3ec64ddf4e04092effb86fe0e40e941fff0f))
* **storefront:** gate public GET on coach deletion + filter USD/one-time (P1-7 P2-5) ([7691c0b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7691c0bb6497f646d10da00fdb12241de8cb9537))
* **storefront:** GuestCheckout PII retention + daily scrub job (P2-3) ([328d7c3](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/328d7c3754e513c8063dc4ce4d11c823d3c6f7e4))
* **storefront:** invite-link flow replaces temp-password email (P1-9, R45 cleanups) ([7a9ad47](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7a9ad47b60c8b3cb0ced5c05c3067d96082e047a))
* **storefront:** P1-5/6/8 P2-1/3/6 — throttle key, dest-account, escapeAttr, audit overrides, copy, RNG guard ([fc5e29e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fc5e29eb9c85b9abc7ab21ff86a6e73ca482ac48))
* **storefront:** retryable on dest account lookup failure + neutral email subject (P2-8 P3-1) ([e490cba](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e490cbad2a7e0e791d84ed630af459135f5a90a8))
* **storefront:** share-link hardening — 21-char tokens, @Roles, tenant-scoped read (P1-3 P1-4 P2-1 P2-2 P3-2) ([431a350](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/431a35006e34166f9f2a05f3b05623fc673c7a96))
* **storefront:** typed BootstrapValidationError + EnvValidationError (R44 P1-2, P2-8) ([7e073f8](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7e073f81f2592f0a4731abc244ef2e066582b1ff))
* **storefront:** typed PiiSaltMissingError replaces raw new Error [A5-P1-1] ([2bace27](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2bace27bcb4dcd06797469c990b8f822b37a9a4e))
* **supabase:** use named WebSocket import so ws transport survives compilation (node 20 boot crash) ([#218](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/218)) ([d64b575](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d64b5757864883b9abf938551516652d40209faa))
* targeted deep audit fixes — push tokens, RLS, Stripe webhooks, food queue ([b5ecf73](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b5ecf737f9602b3416fb7c37bd49a368dba18f42))
* **tests:** add coachSubscription mock to invite-codes test factories ([#240](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/240)) ([9dc210e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/9dc210eca8e389138a15468f1f3b8f4c5c941f73))
* **tests:** client-ai-context mock drift — repair 11 pre-existing failures ([#237](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/237)) ([dc3e1ba](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/dc3e1ba1b9ea4f155d7d90ace67e08cc95942177))
* **tests:** google-calendar webhook token gate — repair 5 pre-existing failures ([#235](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/235)) ([5ccc28a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5ccc28a25a4f1dfbc399332e484bce352e5a780b))
* **tests:** miscellaneous fixture drift (H1-H7) — repair 14 pre-existing failures ([#242](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/242)) ([b32c509](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b32c5092a2b84e0bfdb75a77165575b1130b2181))
* **tests:** sub-coaches — add PUBLIC_INVITE_BASE_URL env + count/createMany mocks (H1+H2) ([#238](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/238)) ([208a927](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/208a92725e798c0c40e130924ab0b68aeee1f3a4))
* **test:** sync migration-spec fixtures to post-repair chain [TEST-FIX] ([#490](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/490)) ([391e2c7](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/391e2c7a90bb13aab4d9fdc862f1f12fd914c3c1))
* **throttler:** scale-readiness [#5](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/5) — Redis provisioning runbook + log on success ([#178](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/178)) ([855c586](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/855c5863e96934e3a1b1da683e6697eea414e47a))
* top-5 risk audit fixes — RLS gaps, entitlement guard, AI fallback, workout adherence ([da8e44c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/da8e44c412f21cc0905f05e8434aacf232244706))


### Dependencies

* **landing-pages:** add zod for section payload validation ([f711f72](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f711f72e66f04ccb01ff3b02f0d1eb60cd48730a))


### Documentation

* add ENGINEERING_RULES.md — decacorn quality standards ([75dfb4b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/75dfb4b63b679f58bbf52ac1615ab81b51cf77de))
* **admin:** canonical admin console reconciliation — supersedes [#127](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/127), adopts [#128](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/128) ([fdf88bd](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fdf88bd5c9d916f42c99f9f9d78f31a0d903d8b5))
* **adr:** TM rebuild ADR — close [#183](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/183), two-sided job board, Connect reuse, in-house verify+anti-bot ([#423](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/423)) ([423a51b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/423a51bc288c7a0eb9d35c56a8af637df2c59ba9))
* **audits:** file AI Credit Marketplace spec (per-coach cap + paid credit packs) ([#291](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/291)) ([c654715](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/c6547150ed8e0ce66a11157fc685d91c5bdeccba))
* **audits:** file Batch 3 — 28-issue full architectural register verbatim ([#284](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/284)) ([c14182b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/c14182b900b08cbc7279230bb8bcda48a6d7420d))
* **audits:** file Batch 4 — coach data accuracy + sub-coach experience + architectural refactor priorities (verbatim) ([#288](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/288)) ([52ed315](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/52ed315815e158353ee8d329b5d2ee3fa5052e4a))
* **audits:** file Bug Register Round 3 (Open Hunt) verbatim ([#290](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/290)) ([4014d38](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/4014d38f9c4a53270507e066dc72a36ee1f8cfc2))
* **audits:** file canonical AI Usage Economics plan (locks budget, dormancy, PR sequencing) ([#294](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/294)) ([f23f345](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f23f3451310f26e9d9634df1f2542c54190f84c6))
* **audits:** revise credit-pack pricing to face-value ($25/$50/$99/custom, 80% margin) ([#292](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/292)) ([2c87b5d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2c87b5d4253435220fcad83c962635715dfd84b2))
* **checkout:** correct audit comment on confirmSession to describe actual ownership check ([17dc985](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/17dc98569789556a6a03a015670bab5a96f950ea))
* codify R71/R72/R73 — parallel discipline + mobile planner gate ([#393](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/393)) ([a9d29aa](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a9d29aaae87efffaaccaf5cf75ebf007b58c59f8))
* **data-export:** correct audit comment on requestExport rate-limit (audit A1-C5-P2-1) ([0986ca9](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0986ca97e2404379b51b442d380700270e8e4600))
* enterprise vars and structures in root README + docs index ([#77](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/77)) ([ea76c17](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ea76c170eaeed6e60c47cc0293f42abcc6b1dfeb))
* **help:** coach support content set + onboarding email sequence ([#101](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/101)) ([d0d0499](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d0d04995229cc5700e5bff3a878b49b0e5f0a1d9))
* **operator:** durable rules for today's mismatches + surface PR [#81](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/81) ([#82](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/82)) ([3576bea](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3576bead44dce4c9891d6984a3b0fbcb51ae922d))
* **operator:** operator fill-ins + open PR status map ([#196](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/196)) ([444afb5](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/444afb50b1aa27a87efc36f138f72b8cf4b538e8))
* persist operator state — PROJECT_STATE, Stillwater Standard, hygiene + UX audits ([#283](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/283)) ([184a1b6](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/184a1b6f14a8e3b97d5a40c23ed7221de8166e1f))
* R66-R70 build discipline rules + doctrine guards index + ADR 0001 ([#366](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/366)) ([6160fd8](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/6160fd8638dd99af1c8bd964338d379bba99d273))
* **readme:** add pre-TestFlight status line + placeholder env var table ([3ec015b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3ec015bdff8496e3e85d790be3fb6ad794ea038f))
* **readme:** describe Sprint B v2, AI Gateway, Team Mode, Bloodwork, Admin Console ([#190](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/190)) ([2f31118](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2f311188abf143e94743eb68616339eac708f798))
* **rules:** add R56–R61 — worktree discipline + sandbox preservation ([#273](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/273)) ([1df67cf](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/1df67cfc272c2c922baf73d69463e226abc079fa))
* **test:** document pre-existing red suites outside PR scope (P2-9) ([03b5af5](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/03b5af5f2794ed209e9d41355beabadfb3da3327))


### Refactors

* **doctrine:** remove streak/badge/reaction from data model ([#90](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/90)) ([c9dff4c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/c9dff4c78517b0859350fb6d4b8264f6ef6aa19c))
* **guards:** remove duplicate APP_GUARD JwtAuthGuard registration (A5-P2-1) ([1afda10](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/1afda107c265ae956f68f1a560d94307ef6ca86d))
* **packages:** extract computeFireAt to shared drip-fire-at module ([#326](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/326) finish) ([#394](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/394)) ([e9fba73](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e9fba7322a4bb3fe394cb2b774be0c84147e5431))

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
