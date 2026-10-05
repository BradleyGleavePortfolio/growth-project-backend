Builder: TGP annex lane A4-MSG-BROADCAST

**Tier:** T4. Never lowered.
**Why:** Fans coach-authored content out to client devices (tenancy, member privacy), new tables with RLS, a scheduler that must never double-send, quiet-hours rule OR-113-5, and a T4 CI gate edit (one spec added to the `community-live-tests` job list).
**T4 trigger scan:**
- Tenancy / authorization: every A4 query keys on `req.user.id` → `BroadcastScopeService` (reuses `SubCoachScopeService.getAuthorizedClientIds` + head-coach resolution, the same rule as the command center and 1:1 messaging). Segments are evaluated only inside that roster; package/program refs are checked against the tenant first (`broadcast.segment_ref_not_found`, no count oracle); card refs are resolved server-side against tenant/author (`card.ref_not_found`); a client-specific meal plan can never go to a group. Sub-coaches see only broadcasts they wrote.
- Member privacy: a broadcast becomes one `CoachMessage` per recipient in that recipient's own 1:1 thread. No client-facing route reads `coach_broadcasts`/`coach_broadcast_deliveries`; the realtime ping carries no body; the push says only "New message from <coach>". Live test asserts a copy names no other recipient.
- RLS: six new tables, all server-only — RLS enabled + FORCED, `service_role` all, RESTRICTIVE deny for `anon` and `authenticated`. Proven live (`test/broadcasts/broadcasts-dispatch.live.spec.ts`, reads 0 rows / writes refused for both roles on every table).
- Idempotency / races: occurrence claim is a compare-and-set on `next_run_at` + unique `(broadcast_id, run_key)`; fan-out uses a CronLease-style conditional-UPDATE lease and `createMany(skipDuplicates)` over unique `(run_id, recipient_id)`; each delivery is leased and the message insert + card insert + delivered state commit in ONE transaction fenced on `lease_holder` (`message_id` unique). Create honours `Idempotency-Key` (unique `(coach_id, idempotency_key)`; different body under the same key → `broadcast.idempotency_conflict`).
- Quiet hours (OR-113-5): non-urgent deliveries in 21:00–08:00 recipient local (NotificationPreferences.timezone) are deferred to 08:00 local via the existing `QuietHoursPolicy` (one definition of the window). `urgent: true` bypasses. Mute (global mute or message_push off) delivers silently; blocks in either direction skip; roster departure skips (re-checked at send time).
- CI gate edit (T4 per operator 14:58): `.github/workflows/ci.yml` adds exactly one spec path to the `community-live-tests` jest list. Nothing else in any workflow changes.
**T3 trigger scan:** new coach UX endpoints, a per-minute cron (flag-gated), launch-flag manifest + runbook table entry.
**Bounded T1:** none.
**Builder-owner:** TGP annex lane A4 (Claude Opus 5.5 builder). Builders never audit their own change.
**Acceptance evidence:** see Tests below; required checks at the head.
**Promotion triggers:** n/a (already T4).

## Inventory (before building)
| Area | On main | A4 action |
|---|---|---|
| Broadcasts / segments / scheduler | None (`broadcastNewMessage` is only the realtime refresh ping) | New `src/broadcasts/*` |
| Single-runner lease | `CronLease` table lives in unmerged #627 (not mine) | Same conditional-UPDATE pattern, as row leases on the run/delivery rows (no dependency on #627) |
| Quiet hours | `notifications/nudges/quiet-hours.policy.ts` (21–8) | Reused as-is |
| Mute | `NotificationPreferences.muted`, `message_push` | Honoured; optional `BROADCAST_THREAD_MUTE_PROBE` token for lane A3's per-thread mute |
| Blocks | `UserBlock`, `MessagesSafetyService` | Both directions excluded at fan-out and re-checked at send |
| 1:1 thread | `CoachMessage` (canonical, owner verdict) | Broadcast copies are CoachMessages; thread list now includes `card` |
| Tenancy | `SubCoachScopeService` | Reused |
| Risk | `PtmPrediction` + `bucketize` | Reused for the `risk` segment |
| Last active | `ActivityEvent(client_id, created_at)` | Reused |
| Packages / programs | `ClientPurchase.entitlement_active`, `ClientWorkoutAssignment → WorkoutPlan.program_id` | Reused |
| Client tags | None | New `coach_client_tags` (coach-private) |
| Saved replies | None | New `coach_saved_replies` |
| Rich cards | None | New `coach_message_cards` (server snapshot) |
| Polls | None | Not built (proposed in the lane report as a follow-up slice) |

## What ships
- `POST /coach/broadcasts/preview` → `{ recipient_count, excluded_blocked_count, roster_size, sample[≤5] }`
- `GET /coach/broadcasts/segment-options` → packages, programs, tags with counts, risk buckets
- `POST /coach/broadcasts` (Idempotency-Key) · `GET /coach/broadcasts` · `GET /coach/broadcasts/:id` (stats + last 20 runs with per-run stats incl. read) · `PATCH /coach/broadcasts/:id` · `POST …/:id/pause|resume|cancel`
- `POST /coach/cards/validate` → server-resolved card snapshot for composer preview
- Saved replies: `GET/POST /coach/saved-replies`, `PATCH/DELETE /coach/saved-replies/:id`, `POST …/:id/use` (most-used first)
- Client tags: `GET /coach/client-tags`, `GET/PUT /coach/clients/:client_id/tags`
- Recurrence: daily / weekly (by weekday) / monthly (by month day, clamps to month end), every N, `local_time` in the broadcast time zone (DST-safe), `until`, `count`. Missed recurring occurrences older than 12 h are recorded as `missed_window` instead of sent late; backlog never floods.
- `{first_name}` personalization per recipient.
- Every error is `{ code, message }` with a specific next step (`src/broadcasts/broadcast-errors.ts`, 21 codes); mobile maps codes to copy.

## Flags / env / migration
- Flag: `FEATURE_COACH_BROADCASTS` (values true/false, unset → off). Registered in `ENV_RULES`, `.github/fly-env-desired-state.json` (`unset` + gate text) and the generated kill-switch table in `docs/runbooks/launch-flags.md`. Off: every A4 route answers 503 `broadcasts.disabled`; the dispatcher does nothing (in-flight deliveries park; delivered rows are never re-sent).
- Migration: `20270304000000_a4_broadcasts_cards_saved_replies` (A4's reserved prefix). Additive only (six tables). SQL generated by `prisma migrate diff` from the schema (parity) + RLS block; `down.sql` drops the six tables.
- One shared-file touch outside `src/broadcasts`: `MessagingService.listThread` includes `card` (read-only include; null for plain messages).

## Dependencies
- Lane A3 (renderer slot, per-thread mute): mobile cards render through A3's slot once merged; backend exposes `BROADCAST_THREAD_MUTE_PROBE` for A3 to bind. Not blocking.
- #608 deletion manifest (agent 113): needed entries — `coach_broadcast_deliveries` (recipient_id, cascade on user delete), `coach_client_tags` (client_id/coach_id, cascade), `coach_saved_replies` (owner_user_id, cascade), `coach_broadcasts` (coach_id cascade; author_user_id SET NULL). Broadcast copies are ordinary `CoachMessage` rows already covered by the existing messaging erasure; `coach_message_cards` cascade with their message.

## Tests
Local (heavy.sh, `--runInBand`): `npx jest test/broadcasts test/ci/fly-env-manifest.spec.ts test/prod-readiness/env-registration.spec.ts test/prod-readiness/env-discovery.spec.ts` → all pass (live suite skips locally without a DB).
- `recurrence.spec.ts` — parse errors per field; DST spring-forward keeps 07:00 wall time; bi-weekly Mon/Thu skips the off week; monthly 31st → Feb 28; `until`; Tokyo vs UTC.
- `segment.spec.ts` — every field; injection-shaped ids rejected; unknown fields (e.g. `coach_id`) rejected; all/any bounded by roster.
- `cards.spec.ts` — foreign ref → `card.ref_not_found` with a tenant-bounded query; snapshot from the server row; client-specific meal plan blocked for groups/other clients.
- `dispatcher-delivery.spec.ts` — quiet hours across time zones (same instant: New York deferred to 08:00 NY, Tokyo delivered; Tokyo 06:59 deferred to 08:00 same day), urgent bypass, mute silent, block skip, roster departure, lost lease rolls back with no push, canceled skip.
- `broadcasts.service.spec.ts` — no recipients refused; sub-coach writes under head tenant as author; recurring anchor + first occurrence in the broadcast zone; past send time / bad zone codes; sub-coach author scoping; sent broadcast not editable/cancelable.
- `broadcasts-dispatch.live.spec.ts` (CI `community-live-tests`, real migration chain) — three concurrent dispatcher instances on separate Prisma clients + two restarts → exactly one run, one delivery row and one CoachMessage per recipient, one push per message; dead-instance lease respected then sent once; fan-out re-run adds nobody; quiet hours NY deferred to 08:00 local while Tokyo/LA deliver; preview count == recipients; blocked and other-tenant clients never messaged; member privacy; RLS anon/authenticated read 0 / write refused on all six tables.

## Fix round
| Finding | Change | Commit | Test |
|---|---|---|---|
| — | — | — | — |

