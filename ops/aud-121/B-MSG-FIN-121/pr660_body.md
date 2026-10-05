Builder: TGP annex lane A3-MSG-CORE

## Tier header
- **Tier:** T4
- **Why:** New tenant-scoped table with RLS (CoachThreadState), message content erasure (PII), cross-tenant read surface (unified inbox), and a CI gate file change (`.github/workflows/ci.yml` community-live-tests file list).
- **T4 trigger scan:** RLS/tenancy: YES (new table + policies, inbox query bound to coach scope). PII: YES (delete erases body/voice; audit carries lengths and ids only). CI gate files: YES (`.github/workflows/ci.yml`: one line adds the live RLS spec to community-live-tests). Auth/payments/production: no.
- **T3 trigger scan:** Schema migration: YES (20270303000000). New public routes: YES (all behind `MessagingCoreV2Guard`, 503 when OFF). Realtime payload: new event `thread-updated` (ID-only payload) on the existing `messages:<userId>` channel.
- **Bounded T1:** README, launch-flags runbook row, fly-env desired-state entry.
- **Builder-owner:** TGP annex lane A3-MSG-CORE.
- **Acceptance evidence:** see "Tests" below. Live RLS spec runs in community-live-tests (CI).
- **Promotion triggers:** flipping `FEATURE_MESSAGING_CORE_V2=true` in any environment needs mobile slice 3 merged and an operator call on "delete erases content" (below).

## Inventory (what existed, what this extends)
- Canonical 1:1 = `CoachMessage` in `src/messaging` (coach + client controllers, `read_at` per message, unread-count routes, voice notes, block filtering via `MessagesSafetyService`, sub-coach scope via `SubCoachScopeService`, realtime ping `new-message` on `messages:<id>`, push via `MessageReceivedEmitter`). Existing RLS `coach_message_participant_access`.
- Community cohort messages, member DMs, the cohort coach-inbox triage queue and community search are separate and unchanged. Nothing here duplicates notifications delivery (#647/#648), the S-ERRORS mapper, report/block UI (#314) or account deletion (#608).
- There was no idempotency key on `CoachMessage` (audit HK_6a_R1 noted it); this adds one.

## What changes
| Surface | Coach | Client |
|---|---|---|
| Unified inbox (pinned first, newest activity, unread = badge computation, block hides preview, keyset cursor, `filter=unread`) | `GET /coach/messages/inbox` | `GET /messages/inbox` |
| Edit (author, 48 h, body only, `edited_at`) | `PATCH /coach/clients/:client_id/messages/:id` | `PATCH /messages/:id` |
| Delete for everyone (author, 48 h, idempotent tombstone, content erased, unpinned, voice object queued in the voice erasure ledger) | `DELETE .../messages/:id` | `DELETE /messages/:id` |
| Thread pins (max 10, advisory-locked) | `POST/DELETE .../messages/:id/pin`, `GET .../messages/pins` | `POST/DELETE /messages/:id/pin`, `GET /messages/pins` |
| Mute per thread (1h/8h/1d/7d/forever/off; suppresses push, keeps realtime ping) | `PUT .../messages/mute` | `PUT /messages/mute` |
| Inbox pin (max 5 per user) | `PUT .../messages/inbox-pin` | `PUT /messages/inbox-pin` |
| Read up to a message + live read-receipt ping | `POST .../messages/read { up_to_message_id }` | `POST /messages/read { up_to_message_id }` |
| Send: `client_message_id` or `Idempotency-Key` (replay returns the original row, no side effects); `reply_to_id` (v2) | existing send routes | existing send routes |

Blocking parity: edit/pin refused when either side blocked (403 `messaging.blocked`); messages from someone you blocked can't be addressed (404); pins bar and reply quotes hide blocked authors; delete is always allowed. Deleted messages never count as unread (flag ON).

Errors: every failure is `{ statusCode, code, error, message }` with a stable `messaging.*` code (`feature_disabled`, `message_not_found`, `not_author`, `message_deleted`, `edit_window_closed`, `delete_window_closed`, `not_editable`, `edit_empty`, `blocked`, `reply_target_unavailable`, `pin_limit_reached`, `inbox_pin_limit_reached`, `idempotency_key_reused`, `idempotency_key_invalid`, `idempotency_key_mismatch`). Each message says what happened and what to do next. No "we/us", no exclamation marks.

## Flags (default OFF)
- `FEATURE_MESSAGING_CORE_V2` (in ENV_RULES; `.github/fly-env-desired-state.json` "unset"; launch-flags runbook row; `GET /me/feature-flags` key `messaging_core_v2`). OFF: new routes answer 503 `messaging.feature_disabled`; thread read, send, read and unread queries match the legacy behaviour (asserted in tests). Exception: send idempotency is always on, because it only adds a dedupe on a key the old clients never send.

## Env names
- `FEATURE_MESSAGING_CORE_V2` (new).

## Migration
- Prefix `20270303000000_messaging_core_actions` (A3 reserved). Adds `CoachMessage.client_message_id`, `reply_to_id` (self FK, ON DELETE SET NULL), `edited_at`, `deleted_at`, `deleted_by_id`, `pinned_at`, `pinned_by_id`, UNIQUE (sender_id, client_message_id), index (coach_id, client_id, pinned_at); new table `CoachThreadState` (ENABLE + FORCE RLS; `coach_thread_state_self_access` USING user_id = current user, WITH CHECK also requires the caller to be on the thread; `coach_thread_state_owner_all`). `schema.prisma` matches (Schema parity gate). `down.sql` included. All additive, nullable columns, so no backfill and no lock-heavy rewrite.

## Dependencies / cross-lane notes
- **#608 account deletion manifest** needs one entry: `CoachThreadState` rows where `user_id` = deleted user → delete (FK cascade covers hard delete; the tombstone path must delete them explicitly). The new `CoachMessage` columns hold no PII beyond ids; the existing body-clearing covers content.
- Mobile slices (thread polish, offline queue) consume these routes. They follow once #314 merges (lane constraint).

## Tests
- New `test/messaging/messaging-core-v2.spec.ts`: 37 cases (flag guard, idempotent replay / reuse / P2002 race, reply validation and quote serialization, edit/delete rules, tombstone + voice erasure, pins cap/blocks, mute push suppression and fail-open, inbox order / unread / blocks / tenancy / cursor, read-up-to, tombstones excluded from unread). PASS.
- New live RLS `test/messaging/rls/coach-thread-state-rls.live.spec.ts` (10 cases, runs in community-live-tests): self-only reads, teammate/other tenant/other coach see nothing, owner reads all, no writes for others or foreign threads, no cross-row update/delete, new CoachMessage columns participant-only, UNIQUE key enforced, reply FK SET NULL.
- Existing, re-run locally (`--runInBand`, targeted): messaging.service, messaging-voice, messaging.dto, coach-messaging-roles, ai-coach-message-materialiser, feature-flags service + controller, env-validation, fly-env-manifest, fly-env-workflows, env-discovery, env-registration, fly-env-classifier, deploy-readiness. All PASS.
- No banned cast tokens added (test doubles use the prototype-object pattern).

## Operator decision needed
- **Delete erases content.** Delete for everyone clears body and voice right away and keeps no hidden copy. If a message is under an open report, the reviewer loses the content. Options: (a) keep as is (privacy-first; reports would then need a body snapshot when filed); (b) block delete while a report is pending; (c) keep a sealed copy for N days. This PR does (a). It needs an operator call before the flag goes on.

## Size note
About 3k lines, a bit under a third of which is tests. One migration and one route contract, so splitting it would leave half-wired routes behind the flag.

## CI note
Pushed for CI to check; locally I ran only the targeted specs, no full tsc. CI gate change: one added line in the community-live-tests jest file list.

