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

## [0.1.1](https://github.com/BradleyGleavePortfolio/growth-project-backend/compare/v0.1.0...v0.1.1) (2026-10-31)


### Features

* [167] SC-BE1 — text replies and sender names in the space chat ([a4caf62](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a4caf62c845cdae49137d9a847975d2a68f5bf4f))
* [167] VOICE-INBOX-BE — client voice notes in the coach inbox ([a8d393b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a8d393b485cef77f24d65afefcdf437930958c9e))
* [168] SC-BE2 — space chat read line, unread counts and per-space notification settings ([7d8d502](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7d8d5022b1f03c0962c9bc618af5351c2850231c))
* [168] SC-BE3 — photos in the space chat: upload URL, image messages and erasure ([31d5c73](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/31d5c73122a9aa058b0def78efa2ede4b78341d0))
* [168] SC-PUSH — space chat push: one collapsing unread notification, reply and High alert priority ([6509de9](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/6509de9b974250f562f8010ad4e6109454ab4166))
* [169] BLOCK-TELL-BE — the blocked person is told in one-to-one chats ([0facb61](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0facb618f779ec3bcd1b4be356806dc25bd898ad))
* [170] GUEST-ELIGIBILITY 2 — the web purchase page: code step, Welcome Back summary, and the new buyer's confirm and download page ([8103e9d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8103e9d7863165169c8a7f71d10aa58381382ee7))
* [171] FR-1141 — coach inbox names the clients in a block (closed_client_ids, ids only) ([68a7fa8](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/68a7fa8b904dfb01ba3cd5cdcd680c69e14c8d5f))
* [171] PHOTO-CHECK-BE - space chat photos pass an automatic safety check before they post ([8f6fa3d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8f6fa3df09661542dab9cb4ecc3568c0308077e7))
* [171] PHOTO-CHECK-BE — the automatic photo check: OpenAI moderation before a space chat photo posts, fail closed ([c4e8e56](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/c4e8e56a223ba5f2cfdaf96ff08308540eee7c48))
* [171] PHOTO-CHECK-BE — the notated ghost value ([#171](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/171)-2) and one boot warning when photos are on without a real key; flagged caption, ghost key and timeout cases ([bb4fab6](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/bb4fab64b5d799401e3b69effb86fae9ac1d9bbe))
* [172] GC-2 — the web payment return page ([eb6cb1f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/eb6cb1fe5fbe6e0f14bdc4d29b718ad37fc47739))
* [172] GC-2 — the web payment return page (/p/:token/done reads the payment from Stripe) ([267ac01](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/267ac01386b67f450557c792a4aa265e1d9379ec))
* [172] PHOTO-CHECK-BE - community_photo_safety coach alert type ([#172](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/172)-5 op 2) ([fbc35c1](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fbc35c15c61bcd99b435adb7f6f6c5e5dc44435e))
* [172] WEB-BUYER-FLOW — email first, and the password on the web ([946d1cb](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/946d1cb0f27a45ca327d3f5ea21faf57a36d7687))
* [172] WEB-BUYER-FLOW — email first, and the password on the web ([82714a3](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/82714a35b536fe6098a4b4f438becc850c1f01c6))
* [176] LEAVE-MUTE-BE — leave or mute a space or a thread ([305a2df](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/305a2dfafcb7375a7995e9e1f4e4b0169f40193f))
* [176] LEAVE-MUTE-BE — leave or mute a space or a thread ([80a8191](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/80a81910e759037d354c41bb4f06344d1d14dcc9))
* [176] NEEDS-YOU-BE — how long each client has been waiting ([b1fb137](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b1fb1371c1735420417c3ae40f6bce60c0e6ca26))
* [176] NEEDS-YOU-BE — how long each client has been waiting ([b95ad2a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b95ad2a4457e5aac2f47cd0a420b3c5f13929316))
* [177] FR-1165R3 — a coach's removal of a post or a reply shows Removed by Coach ([019b5d2](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/019b5d2f71cbe5b72a6e3db1d371ac3bd17d476f))
* [177] SPACE-OWNER-ALERTS — public-space rows reach the space owner's side and the poster's own coach ([f2ae589](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f2ae589f563f85fc02d306c9cb4b0712d1d1b5e8))
* [180] SC-PURPOSE-BE - a space's purpose reaches its members ([7acfd4f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7acfd4fe9ee9e6f9f8dffa85f05c437362facb40))
* [180] SC-PURPOSE-BE - space reads carry description (string or null) ([a330e64](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a330e646778fba7688745d601ae61bc773fc42dd))
* [185] STORE-E4 — one consent box: consult-consent-v19 / v18-coach-free and plan offers yes ([1f88b35](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/1f88b354f7ce1cab15771b4fc99aff01d3f0a78b))
* [185] STORE-E4 — one-box consent versions v19 / v18-coach-free record the plan renewal offers yes ([dc3ccdb](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/dc3ccdb486ac41caeb7b95b7d5ea9ecbe5be656d))
* **community:** a coach's removal of a post or a reply stays as "Removed by Coach" (FR-1165R3) ([8f52ead](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8f52ead115b35c0482f2c88bf99ccee9e0fb3146))
* **community:** a coach's removal stays visible as a placeholder (REMOVED-BY-BE) ([cdb66d4](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/cdb66d482d4dde4fcedb6606b12e5c0f6120e794))
* **community:** a post keeps who removed it (FR-1165R3) ([8740659](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8740659f775dc0ba1cf99099fc95536e13506da8))
* **community:** a post keeps who removed it (FR-1165R3) ([0989346](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/09893469d41012a16f815c8ce7c951496e626b3b))
* **community:** removed_by_user_id on space voice notes and chat messages (REMOVED-BY-BE) ([903e871](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/903e8711e3836438e9c070c133df066a5b1dbacb))
* **community:** space and thread push obey leave and mute (LEAVE-MUTE-PUSH) ([97f4213](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/97f42137717c940133d125c60eef7500e89d873e))
* GC-3 web page trials (card saved, nothing charged that day, one trial per coach) ([16ecf85](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/16ecf857325e8ce5f56c538dabfcd1d76f649409))
* LEAVE-MUTE-PUSH [177] — space and thread push obey leave and mute ([c59ef59](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/c59ef5936023b1088b0cf5d3d10d388d853ce145))
* **messaging:** coach inbox and unread count name the roster clients in a block (closed_client_ids, ids only) (FR-1141, LO-872 B1 server half) ([f4695ca](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f4695ca3898d5d8a87e7c13b8f9f63083028aa1d))
* **PF-7-BE:** a renewal failing on a coach Stripe account that can't take payments waits, tells the coach, and is paid once fixed ([df78a93](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/df78a930adbff1e280f28ab13aeba5aa6b0a1b71))
* **policy:** name OpenAI in Consumer Health sharing, Community photos in What we collect, and the photo-safety alert (FR-1187, wording needs owner) ([44b7340](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/44b7340872ce30561b34705d8be225f86748b893))
* rule D routes public-space rows to the space owner's side and the poster's own coach ([ff3327e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ff3327e30a984461c848e25919cb66490ee7644e))
* SC-PURPOSE-BE fill description on both space reads; the field is required ([fe9a381](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fe9a381417f9a3a811b0dabb904a671c84228fc9))


### Bug Fixes

* [168] BLOCK-ALL-BE — a block closes every conversation both ways; a space ban hides the banned person's words in that space ([309b2e5](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/309b2e599d0f1b35cad21a59b9a3ee672be1b3a6))
* [168] SC-PUSH — community_message_received has no setting column (README row none, kind walk runs it) ([2489b50](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2489b50e42b0404681dddc0cedabf0a8f0b43a22))
* [168] SC-PUSH — the send step asks rowsByAuthorsWhoStay for the source message, and drops what waited once the space switch is off (Sol B1, C2) ([ece8abf](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ece8abf27034db2230f625f3fc1e54400950e527))
* [169] FX-1139 — reported photos reach the coach ([3c3f4bd](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3c3f4bdb69294dfc45eb6c32358e4966da978216))
* [169] FX-IDEM — a retried send posts once ([4eca770](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/4eca77039edde8302fa1a705d0cf7b340f881b7e))
* [170] GUEST-ELIGIBILITY 1 — existing TGP emails prove the email with a code; other-coach buyers are refused before payment ([8cd6383](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8cd638304886af934eef92ed5e94cea45090b5a2))
* [170] GUEST-OUTER-TX — web purchases stop holding the payment save open across Stripe and account setup ([53dc5e5](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/53dc5e5cf298547e1b8797fe2b5011ecc616cd75))
* [171] DUNNING-KIND-FIX — payment blocker, meal plan and community rows no longer fall to the off-by-default digest setting ([5b966e5](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5b966e564fa8b5f220d5872f973bd880e8090481))
* [171] FR-1154R3 — Mute all keeps the broadcast in-app row and stops the churn and import pushes ([39727bd](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/39727bdd59accf88d18a36a89ba4abda945f4ba7))
* [171] FR-1154R3 — the churn push-skip log carries no exception text (privacy log guard) ([4dd529a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/4dd529a28379b868ce61b9cb218e668f13914821))
* [171] PHOTO-CHECK-BE — key PHOTO_CHECK_OPENAI_API_KEY (outside the OPENAI_* family), listed under excluded like the other provider keys; it.each rows ([84ec803](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/84ec803fa817aa0f4fb07593afc6db1889ec68ac))
* [172] BLOCK-ALL-BE round 4 — coach brief kept through a block, wearable card closed across a block ([f3cd5b7](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f3cd5b7f8fc3975d51697be348ef4c9c38bc9aa3))
* [172] FR-1138 — Opus C-6: High alert does nothing and the preview route answers 404 while the space switch is off ([3856455](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3856455afe2164da27ff8b856e01559b40168ee9))
* [172] FR-1138 — Sol B-2: plan a space push again at send time (block, ban, deleted message, Mute all since enqueue drop it) ([c9c127c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/c9c127c90e4547fdc20ec59ea1b896f4119d07e0))
* [172] FR-1139 — moved client's photos leave, photos keep plan tags, quotes carry the photo ([5c0bcdf](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5c0bcdf33d65e442a0e2da63b55221a84ab16845))
* [172] FR-1139 — photo rows are service-only; the chat signs only a message's own photo (Sol B2) ([ba50a13](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ba50a130553d4fc025d7aaf22747825928e742e7))
* [172] FR-1139 — space photos: moved client's photos leave, plan tags kept, quoted photo shown ([d9f322c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d9f322c0d3d7e9399a373863818af0d9930090f9))
* [172] FR-1139 — the coach queue signs only a reported message's own photo (Sol B2) ([793a2fd](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/793a2fd03622d9d05053be1fa4607ba0b39396b9))
* [172] FR-1149 — reuse the approved PP-21 closed-link line on the code step ([e3e17a5](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e3e17a5249731bdb408d742f07f7404d1de78bde))
* [172] PHOTO-CHECK-BE - refusal table, caption edits checked, caption-only refusal keeps the upload, self-harm refusal alerts the coach ([5c26307](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5c26307735c8edc7c1e08785cdb16a3e6c075f0c))
* [172] PHOTO-CHECK-BE - the 5-second moderation deadline covers the answer body (Sol B2) ([ce7ced3](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ce7ced33a071aef51dc20acb434130aacd768f5d))
* [173] FR-1155 — the return page after a refund or dispute, expired links, a fresh key for Try again ([df548e8](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/df548e8684944909cc2f7f77d1d8e64eca40f8cb))
* [173] FX-1156-R75 — photo writer stores the plan tag with no cast (LS-1139D B1) ([a1a2743](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a1a27439c4eab4ddf2c252f8a32c8ce1b647dd08))
* [174] COLOR-FOLLOWUPS — help and policy body text [#2](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/2)C2C2C ([99e8aa4](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/99e8aa43da97aed2ea537a89f1d1595083d07e0d))
* [174] COLOR-FOLLOWUPS — help and policy body text [#2](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/2)C2C2C ([95d3904](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/95d3904140ee9e49d39071c7b9f21b47e78ce06e))
* [174] FR-1155R3 done page reads the money state from this payment's charge and its dispute row ([fba8192](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fba8192cc8ef46764666dfc603a5026cf2bb55a9))
* [174] FR-1155R3 R75 net 0: typed test doubles, a failed charge read is the 503 page ([bfc1282](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/bfc1282a4fe22d227fd1a6d2dec6b3d8986df3d0))
* [174] PHOTO-GPS — a space photo that carries a location is refused ([34455fc](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/34455fc7ae281b58e0655d840ecedbea051a4989))
* [174] SPACE-404-CLASS — a space you cannot read answers 404, the same as no space ([6fa0812](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/6fa08123aca121f9c9af7e3e232cac6cb79b7bc3))
* [174] VOICE-IDEM-BE — a voice note sent again after a lost reply posts once ([decbc89](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/decbc89b504f4e9e82f0d92bc3eb56d58bcbcfb1))
* [175] FR-1164R — refuse a space photo with ExtendedXMP, whose chunks can split a GPS name (LS-1164 B1) ([0ee8042](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0ee8042eb016cfe1cb3c9ec98be50b88c993f91b))
* [175] FR-1164R2 — refuse XMP location names in any letter case, from every documented family (LS-1164R B1) ([37b5b26](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/37b5b260bf8a95fe4047b54d14981f8bb1d5e6c2))
* [175] REMOVED-BY-BE — a coach's removal stays visible as a placeholder ([d0bf7cc](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d0bf7ccc40dc2bcc8d7a87d14bc03897bad9fd41))
* [175] RENUMBER-1137 — space reads migration sorts after main's 9200 ([0b7bed4](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0b7bed43cb2141df4916412c75f351f2070f2b2a))
* [176] CHURN-PUSH-COPY — churn nudge push uses the lock-screen copy, not the coach's text ([e7c8184](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e7c8184d4bb8a883f4642b2d8ea29e809f032218))
* [176] CHURN-PUSH-COPY — churn nudge push uses the lock-screen copy, not the coach's text ([03b56d9](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/03b56d9d14601d2b56ad3c24de547cfbb81bc5c0))
* [176] COLOR-FIX-2 — landing page text colour ([fc7c63e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fc7c63e3831965f4d2b045943b864561858855e3))
* [176] COMMUNITY-ROW-ALWAYS — write the community inbox row with or without a push token ([2d9c351](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2d9c3519b7c2da0772d98c735d2fcd390f031f06))
* [176] COMMUNITY-ROW-ALWAYS — write the community inbox row with or without a push token ([6948181](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/6948181f77ae4a6509724c91687f936e93fc9743))
* [176] FIRST-PAYMENT-PUSH — send the first-payment push to the coach ([140de2a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/140de2a67f3eb2d4f8c8660900965ebd169fa539))
* [176] FIRST-PAYMENT-PUSH — send the first-payment push to the coach ([35fa73f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/35fa73fca6515a8fb702d22eb0862048f962691b))
* [177] ACK-VISIBILITY-GUARD — ack writes pass the read visibility gate ([0f3bd9f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0f3bd9fc4a0c2feb4242da52974bd1effc9fb808))
* [177] ACK-VISIBILITY-GUARD — ack writes pass the read visibility gate ([8db2896](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8db2896971392066c30b6b730260838481aa67b0))
* [177] FR-WEB5 — one wrap rule for every paragraph on the buyer pages ([fcd5f55](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fcd5f55905b68470cc67e8c9ca8bf0a48f8a16e8))
* [177] FR-WEB5 — wrap a long email on the pay and confirm pages ([d9f4adc](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d9f4adc12021b59c79df525f02679ec9e38ebd9b))
* [177] INBOX-PHOTO — photo rows in the coach inbox say Photo ([7be9132](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7be913284ad7025a3c385a91512973d77476cee0))
* [177] INBOX-PHOTO — photo rows in the coach inbox say Photo ([c7d4aa2](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/c7d4aa2ff2d84fe4b8b7f12f4035d972735f7ef8))
* [180] BPF-1 - a space member can send a voice note in that space ([1a27523](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/1a2752390909f32bbd39ac39326ff018cf262071))
* [180] BPF-1 - a space member can send a voice note in that space ([1bf4d01](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/1bf4d01d8bbed7d3887bb0432dfc1abe38611c95))
* [184] STORE-1TO1 - a package publishes and sells only while its coach can coach the buyer one to one ([fe74d91](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fe74d91c0fd37ca21cd2ea7ac74afae102a384d6))
* [184] STORE-1TO1 - every package includes its coach's 1:1 coaching (publish and checkout refuse one that cannot) ([436cf4b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/436cf4bc5b7e0f1e8fa88ae6f957b6edcdba20d1))
* [184] STORE-B2 - plan renewal offers need the person's yes in the app ([8d63e48](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8d63e481d674609f052aa4f24eec4869df94be0a))
* [184] STORE-B3 - a vendor without its deletion keys stays pending and is retried, never dropped ([af574cd](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/af574cd037155af692f270bc32f60391e260045e))
* [184] STORE-B3 - a vendor without its deletion keys stays pending and is retried, never dropped ([a0a9579](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a0a957910288f75950b79c941ec3b828b4489d2d))
* [184] STORE-B3 - keep pending vendor erasure held when keys go missing (LS-1182 B1) ([b50d14b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b50d14b9406cfb3e8d97a612a4e63d5d4b637832))
* [184] STORE-B3 - read the vendor settings by literal name (env discovery) ([e3c578a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e3c578ad2ece570c5bda2affa2fa353820100475))
* [185] FR-1TO1 - web reads, pay page and every grant obey the one 1:1 coaching seller rule ([6c3bb44](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/6c3bb44ffe0769eaa31a6f23f959912ddb6f6f14))
* [185] FR-1TO1R2 - the join writer reads its coach through the coaching rule before it picks or publishes a package ([8867d7c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8867d7cebb765c8e58ae4c6f13f6cd5dc431a932))
* [185] FR-E4B — Roman's memory and notes lines name both places the Roman permission is asked (POL-7, POL-8); privacy uses list names plan renewal offers (RENEW-1); needs owner ([163b27d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/163b27def31710987b8896bafb529ccbf062e535))
* [185] PERM-W5 — Privacy Policy names OpenAI for the photo check ([28e4967](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/28e4967856464ec5e78266fded28d6be7ddafeaf))
* [185] PERM-W5 — Privacy Policy names OpenAI for the photo check ([b615d6b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b615d6be3963714c65d5474f5bfe6213be4c6158))
* [185] STORE-E4C — policy lines say 'in some versions of the app' (true before and after the phone update) ([00bd4ea](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/00bd4ea9e7a2194cb3e78aeefefb1eab669c984c))
* [185] STORE-E4C — privacy policy lines describe the one box and the separate Roman AI choice (POL-1 to POL-6, needs owner) ([d3af0f6](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d3af0f634f5613717c6f5b33ef63762aa3a39620))
* [186] FR-1187R2 — the photo check comment says no photo is sent, not nothing (LO-1187R2 N1) ([69d906e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/69d906e20be932bc86293ed4c2c1fde0d23a6f20))
* [186] FR-E4B — approved phrase B in POL-1, POL-5, POL-7, POL-8 ("when you first open Roman"; 185-W4) and their pins ([c4104e3](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/c4104e39e17a3412b5622526401c63af72b8cd3a))
* [186] PF-2-BE — a plan under its own Day-10 lock is never entitled (also after a Stripe resync); table tests for both shared rules ([ab4d768](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ab4d768a096f6ea575f7dbcd6b9c0c6c6da470f1))
* [186] PF-2-BE — one live grace rule for every paid-access read; no new paid drops after the Day-10 lock (LS-PAYFAIL B2, B3) ([956081d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/956081da2cba395e67898ab54bfc893222c9bae3))
* [187] FR-1190 — another plan in live grace waives a locked plan (LS-1190 B3, LO-1190 C1) ([2ae7432](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2ae743217237177001e13d4871828eb5d4f40752))
* [187] FR-1190 — drip dispatcher picks and delivers only on the full live rule (LS-1190 B5) ([e2664fe](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e2664fe79d7f4aa28cac99f55130f736469915a5))
* [187] FR-1190 — package community space follows the live rule (grace counts, own lock does not) (LS-1190 B1, LO-1190 B1) ([7455479](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7455479d52a76c4c460fbb0274e9aff0e7d85658))
* [187] FR-1190 — package push delivers inline only to a live purchase; others stay pending (LS-1190 B2, LO-1190 C2) ([6d6861f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/6d6861ff5badfbc0327071a431bcf5ebcea53b40))
* [187] FR-1190 — purchase fanout delivers inline only on a live purchase (LS-1190 B4) ([367e32d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/367e32d63277e9d91ea9f9d0fbcef866ca4318be))
* [188] AUDIT-1030 — follow-redirects 1.16.2 for a high advisory (GHSA-mrwp-f3q8-3g9p) ([a7a7c16](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a7a7c1618189c73f2a497795ad8de74063cefa31))
* [189] COUNT-DELETED-BE — every count a coach sees leaves out removed messages and blocked, banned or departed members ([b8c7ebd](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b8c7ebd66625426abd62c3940c5cb4c54a9b0728))
* a renewal failure with no fresh answer from Stripe gets main's ten days, never a guessed hold ([f998c12](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f998c12773006679e8550a2f3571097650b98c25))
* a space you cannot read answers 404, the same as no space (SPACE-404-CLASS) ([978d389](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/978d3892bf90c8518ed7b983b0f9c90f03a42f3d))
* **ai-approval:** a send a block refused answers its 403, not a 500 (FR-1141R4, Opus C-2) ([596c753](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/596c75376c4d29cc05bfff8b806100fb701a8ccb))
* B1 public-space photo safety alerts reach the space owner and team ([01ca76b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/01ca76b53e9e75d11de0ecb54328d31ee080675c))
* brief payment lines do not use up the AI sentence budget (FR-1191 F5) ([50d470f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/50d470fc011adbb12f61622b180e2c9571d359fd))
* **churn-nudge:** a block either way hides the nudge, the AI notice and the chat's message notices from the inbox; the lock screen reads as a new message (B-LONOTIFY3-1, B-LSNOTIFY3-3, CPC-W2) ([8fbf96d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8fbf96d08c4a42b8fc7f72b56c11e37342858db7))
* **churn-nudge:** a block with their coach hides the coach's message notices from the client's inbox and badge (B-LONOTIFY3-1 class) ([0df7bee](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0df7bee1b19f62f2b37693f33d3aa5b63f9fcc47))
* **churn:** store the nudge in the client inbox and give its push a tap target ([aea66c5](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/aea66c592686d3fa03bec54b0acd6774b10ee1d9))
* coach client payments keep unpaid plans live with a failed payment (FR-1191 F1) ([ebf2f04](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ebf2f04f82876bcb9dad39a682be0bcd8e808803))
* **coach-brief,coach-money:** PF-5-BE tell three dunning states apart, no false card retry, unpaid counted as failed ([2942ab3](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2942ab3836cddbca0a9c5bcda1ff25008894118f))
* **coach-brief:** block-safe Today brief maps its typed live parts, no cast (FX-1141-R75) ([5ad8263](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5ad82633cb7a59050fd2047440880927d5fadee0))
* **coach-brief:** count payment lines apart in the repair prompt; refuse retry promises in other words (LO-1191R2B C1, C2) ([b713130](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b7131305649f958cddadf5bef8c99a83dafc91a8))
* **coach-brief:** keep the saved brief through a block, answer Today block-safe (FR-1141R4, Sol B1) ([fb395ab](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fb395ab1881e171e58e05bf65d98cd0bd79481c0))
* **coach-brief:** write today's brief again when a renewal entered or left the hold (LS-1195R2 B3, ruling R10) ([58e70b6](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/58e70b64d6f68cbe305a7664815f396fb91292f7))
* **coach-money,dunning-v2:** show no bank try count the server does not record (LS-1191R2B B1) ([6fe6281](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/6fe6281757a4f427771c9f75415e081977ec3c25))
* **coach-money:** leave held renewals out of the attention query before its limit (LS-1195R2 B2) ([b79027c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b79027cd590e348af592494a0b989a342f5b489c))
* **community:** a coach's removal takes the post's search copy with it (LS-1165R4 B1) ([4c4a6f2](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/4c4a6f26402dff5dbf578c8f9cc68177ed68c24f))
* **community:** a failed post removal ping is logged, not swallowed (FR-1165R3, R75) ([8fd3d1d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8fd3d1d9b988cec5fe631603e793f0686ed98a91))
* **community:** a row is a coach removal only when it carries a remover id (REMOVED-BY-BE) ([537989a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/537989a0702a21926e985d81c12e6d4bfe8c47a5))
* **community:** a voice note sent again after a lost reply posts once ([0846d04](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/0846d04c08a4f71ba37a7aba0312758de5654428))
* **community:** ack writes pass the full read rule of the row's kind ([63fb540](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/63fb540328d4a0d26ba15609759f82f4a9c1d5a5))
* **community:** an EXIF APP1 cut inside its header at the end of the bytes reads as located, never throws (FR-1187R2) ([6704065](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/670406592911728da2da3c1ca72df66da3b91c1b))
* **community:** bulk replied stamps touch only rows the coach can read ([3780722](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3780722080aca4f70f5172842ad6f43f5ce697d1))
* **community:** foreign moderation item, photo upload space and reindex target answer like missing (SPACE-404-CLASS) ([b5b5d61](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b5b5d611b2d284346dbedbf24862b89e3c4661f9))
* **community:** FR-1144B - an unkeyed photo write names no id; a photo replay is compared without its fresh link expiry ([ef85887](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ef85887b5e3e807e11a5f277aa711359e2968bc2))
* **community:** FR-1144B B1, B2 - photos and the third High alert follow the one send-once rule ([cb49a43](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/cb49a4326ae156dc8d5b0f2ca85e69c6419cfaba))
* **community:** FR-1168 fix round 1 for leave and mute (LO-1168 B1, LS-1168 B1-B4) ([69f9803](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/69f9803930c0390e591a9191319c6e196abf8c50))
* **community:** FR-1168R2 B1 on b[#1175](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/1175) a muted thread still hears the coach's High alert ([dc984fe](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/dc984fecf16c76b8f97a97da1bbc40564550df6d))
* **community:** FR-1168R2 B1 the member list leaves out a person who left the space ([9f73fee](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/9f73feeb3edd799373683cdf1e4fdd3e17b659e9))
* **community:** FR-1168R2 B2 a leave or join pings the space at once, ids only ([532d504](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/532d5046bfc77f242db6975b790f06145e8f1a85))
* **community:** FR-1168R2 C1 on b[#1175](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/1175) a High alert reply's reach is its thread's ([2c36d45](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2c36d45fa0998cf770197e4f865aa0542cb04f54))
* **community:** FR-1168R2 C1 on b[#1175](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/1175) the coach's High alert preview takes reply_to, so a reply's reach is its thread's ([536b9d2](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/536b9d26d003366089501e538fe45258621c44f9))
* **community:** read an EXIF thumbnail and every other APPn as bytes for location (FR-1187R3, LS-1187R3 B1, LO-1187R3 C1 N2) ([c51df40](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/c51df404cc30c7d027374ad7f31a7ec2a65823d1))
* **community:** space push skips only muted or left threads, not followed again (FR-1168) ([a5ac284](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a5ac284c8015051fd401cb56c1cd15f35f6bee96))
* **community:** the location check reads the whole photo: every APP1, a JFXX thumbnail, an EXIF thumbnail and everything after EOI (FR-1187R2: LS-1187R2 B2) ([84833e3](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/84833e305cfce5f48038818082f796ff108de763))
* **community:** the photo sent to OpenAI keeps only picture segments, a JFIF header with no thumbnail and an Adobe header's fixed part (FR-1187R2: LS-1187R2 B1, LO-1187R2 C2, N1) ([2846f60](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2846f608236275aeee929f4c6c8ab56cac158212))
* **community:** the queue's Hide keeps who removed it, and Hall removals ping (FR-1165R) ([fe13830](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fe138301482b7a68a5a771a13a7fd3b76b3fc55a))
* **COUNT-DELETED-BE:** one count rule for every coach and member count and preview ([d19ec67](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d19ec67e1f53e6f2b6427364acdd90f6dbb35753))
* **deps:** [171] zod 4.4.3 -&gt; 4.6.6 (GHSA-mrhx-c7xc-m3w5, high) ([967c671](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/967c67120c85912cab617c59116e99262310ad67))
* **deps:** [172] AUDIT-1024 multer 2.5.0, body-parser 2.4.0, undici 7.30.1 (three high advisories) ([b23fa9f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b23fa9f1b31253218fa794fde7d8814d8aec770a))
* **deps:** [172] AUDIT-1024 multer 2.5.0, body-parser 2.4.0, undici 7.30.1 (three high advisories) ([6057ca3](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/6057ca31ca3c87b7d3b2f047411e055bc559892a))
* **deps:** [188] AUDIT-1030 follow-redirects 1.16.2 (GHSA-mrwp-f3q8-3g9p, high) ([5ca14af](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5ca14af546835b0084fe185347a9c06cd97e57cc))
* **FIN-1173:** B4 - ask the own-coach ban through app.community_author_unbanned, not a bans relation filter ([15ecf62](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/15ecf62d85a4b126382b729b4ed37557f0f88eb3))
* **first-payment:** a failed notice rolls back to its savepoint, never the purchase (B-LSNOTIFY3-1) ([f125149](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f125149898b56fc3a069a852a6aa8ee784aedc0e))
* **first-payment:** ledger insert ON CONFLICT DO NOTHING so a coach's second purchase commits ([680623e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/680623ee5dc326c6e3f48a6db9038d01a4a5f502))
* FLIR-GPS-BE bound EXIF reads, read Parrot, Photoshop 1058, GoPro, UTF-16 XMP, JUMBF and MP4 locations, FLIR no-fix sentinel (LO-1189 B1 B2 C1) ([01f73e6](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/01f73e6a5868298f05760cb1bcd258c2b5ff4e3c))
* FLIR-GPS-BE judges JUMBF boxes only joined, so a location-free EXIF cut over two APP11 segments posts (LS-1189R2 B1 class) ([5a99224](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5a99224630ec2bef7641cf54ef47132f1e60355e))
* FLIR-GPS-BE read UTF-16 XMP names by decoding both alignments, not by removing NULs (bounded on 10 MB) ([4e2db77](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/4e2db7793cfd1585361cb86ba9531da546dd1d2a))
* FLIR-GPS-BE reads every TIFF directory, UTF-32 XMP, Photoshop resources once joined, one segment budget (LO-1189R2 B1 C1, LS-1189R2 B1 B2) ([3b70a66](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3b70a66f37856cfa5b5ce6e83dc7673d66ab3d7b))
* FLIR-GPS-BE reads Photoshop 1059 as EXIF only when it is a TIFF, as exiftool keeps it binary (LO-1189R2 N1) ([f2fac36](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f2fac3606747ac50e5716578f42546ed69285791))
* **FR-1173:** B1 - a public-space row's report reaches the owner's team and the poster's own coach (LS-INBOX2 B1) ([a4db948](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a4db948f1899435dc8f7b5d60048adc7d372ac5e))
* **FR-1173:** B2 - whoever the inbox lists a row to can open and acknowledge it (LS-INBOX2 B2) ([3968e75](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3968e75b2e5098324f4f15226b9ea502707333ae))
* **FR-1173:** B3 - one coach's Acknowledge clears the row for every coach and the AI triage (LS-INBOX2 B3) ([a881f36](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a881f3640381cb8daac313fcdbecb5999bb93f58))
* **FR-1173:** B4 - a ban on the reading coach drops the own-coach arm, in the inbox and the row rule (LS-INBOX2 B4) ([1426e78](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/1426e78a89af8ec8d3c237c306604b06253cf0ec))
* **FR-1173R2:** B1 - the flagged route serves only reports the coach can act on; read-only reports with read_only=1 (LO-1173R2 B1) ([d42db03](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d42db038f5cfa34ba051e4d4439132d0db219795))
* **FR-1173R2:** B2 - the poster's own coach opens the message and voice note their inbox lists, that row only (LS-1173R2 B2) ([943c7fa](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/943c7fa6e92d74ba4ecf5582ee134f497f3f4206))
* **FR-1173R2:** B5 - a banned author's reports leave every rule D reader, the same ban rule as the row read (LS-1173R2 B5) ([72418c6](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/72418c6719fbbf263532147c5bf5717892ee94f6))
* FR-1189R3 match UTF-16 and UTF-32 names in the bytes, with no decoded copy (LS-1189R3 B1), and charge skipped Photoshop 1059 resources (LO-1189R3 C1) ([5dd659e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5dd659e0b1a033795af18eed313fe02301f5dcb6))
* FR-1195R3 F1 the history read shows today's brief by the same hold gate as today's read (LS-1195R3 B1, ruling R10) ([bf47166](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/bf471664c0f5a038855ff204ca9ef1d6763cf36a))
* FR-1195R3 F2 PF-W9 counts only renewals held on the coach's own Stripe account (head brief and its hold check) ([f50cfef](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f50cfef91511547feb619021885d50df9278c94d))
* FR-1195R3 F2 the brief SQL text without an owner stays as on main (no extra space before the waiting FILTER close) ([be6a0de](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/be6a0de2d417e78bf1da4f902949909bdc858291))
* head coach brief counts only the team's own sales (FR-1191 F4) ([c2c6aa8](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/c2c6aa8434231e544fec235af4545b20a0a5b62b))
* landing page text colour [#2](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/2)C2C2C (owner [#168](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/168)-13, D5 - A) ([44556db](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/44556db74167e04d9d14a9cce028f19e2c3e5b19))
* **LO-1193 B1, LS-1193 B1:** web-trial return page follows the conversion, not the saved card ([abf5093](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/abf5093c70cdd71a5ba1c21413cbad8b6b3a41dd))
* LO-1197 B1 v1 console chat list skips deleted messages and blocked authors ([d08e4c9](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d08e4c9fbb86b0ef9a64a1daa6d6f8ec4910a60c))
* **LS-1193 B2:** a converted web trial is stored as trialing, like an app trial ([dbf59e3](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/dbf59e3e337c6a51ce4deeab498718c3ccc97314))
* LS-1197 B1 the count rule asks each message's author; LO-1197 C2 C3 count-rule names its readers, contactRings takes the counted roster ([50487b7](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/50487b789ba78c334f6da4cb995706bfeea44b6d))
* LS-1197 B2 Today pinned post takes the Hall author rule and keeps the next pin ([fcbdaca](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fcbdacabd2617ed407628f9f7213ea554653244d))
* Money Paid list leaves out sales whose renewal is failing now (FR-1191 F3) ([9e33fb8](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/9e33fb8bc7e27ce8bd2c4432999a85c5c269c80e))
* Money Try n of m counts the current invoice's bank tries (FR-1191 F2) ([42d4b04](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/42d4b04f589698d8a4c81985470c687756427efe))
* **notifications:** FR-1154 Mute all — safety and money pushes pass at every check; in-app rows always land ([cc95bc7](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/cc95bc72eefd4f89bdd7ba5e4ff6b5874eaf7d59))
* **notifications:** Mute all never stops an in-app row or a money notice (MUTE-PAY, owner [#171](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/171)-3) ([1f509da](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/1f509da913035dab011784271db7c853abb66123))
* **notify:** register the coach account hold notice as a coach Money alert sender (LO-1195R2 B1) ([c97296f](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/c97296fd564ac81d5f9eb89457e8de3ea5ef2cda))
* **pf-7:** held renewal reads active to the client; durable per-channel coach notice; every held invoice paid once (LO-1195 B1, LS-1195 B1, B2) ([d8a0f22](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d8a0f221586b5d09f50f0a3916be025b24bee912))
* **photo-check:** send OpenAI the photo with no metadata (FR-1187, LS-1187 B1) ([4d5f3c3](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/4d5f3c391982407e6ed1f633455659222207f0a4))
* PHOTO-GPS refuse a space photo that carries a location ([ecebd93](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ecebd9300fa2655f8e1920abc31660d069b672b0))
* refuse a Community photo whose FLIR record holds a GPS position (FLIR-GPS-BE) ([dadf8d2](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/dadf8d2f14e7ef0427405f620510f4308da5bb6b))
* register FEATURE_COACH_ACCOUNT_HOLD as an open name (no closed set), so the Fly manifest needs no entry ([2efbc10](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2efbc10fd143ebf4719aeb24caf2324eab066f5d))
* register FEATURE_COACH_ACCOUNT_HOLD in ENV_RULES; read v2's switch directly in the hold sweep ([2c1209b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2c1209b3c3ff8e13f6effb8a683d6562e7f535a6))
* **store-1to1:** [185] FR-1TO1R2 - joinCoachFor keeps a plain id in its unique where (tsc) ([e48344d](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e48344df81c3604d31eeea0d5f2be6bc55fdef23))
* **store-1to1:** [185] FR-1TO1R2 - joinCoachFor nests the coaching rule under AND (unique where typing) ([bc7fc3c](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/bc7fc3c763e66554f17117db55130fc0ca27b7f5))
* STORE-B2 plan renewal offers (Day 1, Day 7) need the person's yes in the app; Mute all stops them ([d2806af](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d2806af8b17cbbae4435f7678faa75730cbdefa3))
* **storefront:** GC-2 return page buttons wrap with side padding at 360 px and 130% text; escape test checks the injected tag, not the tick ([4c43c4b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/4c43c4bcb7f53de89c4b511ab184fc0f7cd31f2f))
* **wearables:** no coach card draft and no approve or edit across a block (FR-1141R4, Opus B-1) ([f2579d4](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f2579d4314b430be1d356f79d24c929ad96319d3))
* **WK-1-BE:** one workout per resend key; exercise video links follow the assignment the client sees ([8d86c17](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8d86c1715a3dbb19f1d74a4cfd218f8125b9e296))


### Reverts

* keep b[#1165](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/1165) at its size; the post column moves to the stacked PR (FR-1165R3) ([f5273af](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f5273afdc5cbabb13b330aa3de9265a7d12f3de3))


### Documentation

* [171] FR-1154R3 — trial notice comments match the Mute all rule (money push passes; rows never muted) ([6fda73b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/6fda73bb01f47f813dcab4e23dc211c60b98aff4))
* [171] PHOTO-CHECK-BE — the owner to-do line ([#171](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/171)-2) in .env.example, the manifest reason and launch-flags ([9ccea27](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/9ccea27d4d4bbca592b8be118c1056ec119f81d3))
* [172] PHOTO-CHECK-BE - caption edits checked; device pass for the refusal table and the coach alert ([9f27bc8](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/9f27bc8f684ab24a4ceb6c01ae0ca488895e3fc0))
* [175] FR-1164R2 — image-location header: a StandardXMP packet cut over two APP1 segments is not covered (LO-1164R C) ([ab14d00](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ab14d00a9f216877eacd22b3141f6429129f5ced))
* [177] owner rule A1.11 (verbatim) at the top of this repo's agent rule files ([f4e7b39](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f4e7b39a3e7afbd5d545bc71ad8b697f165d363f))
* [177] owner rule A1.11 (verbatim) in this repo's agent rule files ([03d5175](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/03d5175842d8959c07f202e9eaf13d83a80ee964))
* [180] DOCS-V1 — push switches and notifications README accuracy ([b5c0d06](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b5c0d061999aeda2d291396bc4f197bb38007d23))
* [184] STORE-B3 - account-deletion README test row names the LS-1182 B1 cases ([da3ff4e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/da3ff4e8a30c0d1f667d4505d9c861bcb12fed0e))
* [186] FR-1187R2 — vendor row lists the allowlist strip and the approved Consumer Health words ([cd95e6e](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/cd95e6e1624520d1fa9b12859833f9b3550a124d))
* [186] PF-2-BE — doc comment sits on dunningGraceWhere ([dabf6bf](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/dabf6bf344fdafede8fcf4f0a1a9e767dae107e3))
* distinguish legacy community and space push switches ([5b01932](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5b01932f73fe2ed6e2c7f590736a9ab00be51e59))
* **notifications:** [181] FIN-BE3 on b[#1180](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/1180) line 67 word for word as b[#1175](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/1175) (903c8a00), switch list below the table ([4b763b1](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/4b763b1cf3bca8ecd64cfd5ab08f7661b1cca1d0))
* **notifications:** FR-1168R2 LO-1168R1 N5 on b[#1175](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/1175) the space chat push is gated by FEATURE_COMMUNITY_SPACE_PUSH only ([903c8a0](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/903c8a00a3598b60fbdaaafd5c004957043f0158))
* **notifications:** README note 2 says Mute all never stops those senders' in-app rows, not that they always write one (LO-1180R2 B1 class) ([03dcd67](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/03dcd679a768d80561c0423d6d725cd328a7fa4e))
* **notifications:** README recipients match the live senders: message_received reaches the coach, nudges reach any eligible user, five emitter-only kinds have no sender on main, two off-table kinds named (LS-1180R3 B1, LO-1180R3 C1 C2) ([d7e1d3a](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d7e1d3ad879ee6ce4199bed8bcb706b9493191f2))
* **notifications:** README says what backend main does (B1, B2, C1, class-first) ([8c4120b](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8c4120b6c44c150443ba8a9b8c9e703624d5d50d))
* **notifications:** README switch families, channels and senders match the code family by family (LO-1180R2 B1, C1, N2, N3, N5, Sol C-R2-2) ([3522c50](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3522c506144a82086f1deeed9d81e5aeaa2f659b))
* STORE-B2 comments say plan_renewal_push governs only the Day 0 notice ([d729231](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d72923139339636008a09be3d6595455cfc56c1a))
* the AI triage reads rule D's two arms ([d97b7c4](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d97b7c47d30303f8b47f05e9903a3994b923c5b8))


### Refactors

* [184] STORE-B3 - plain record types for the vendor key lists ([cd394af](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/cd394afe507d9a210f30bf20907a605996a3a292))

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
