FIX ROUND 5 (B-PUSH2-120, agent 120) — growth-project-backend#693 @ 53796f1e278c12ebb56d701724df032675dcedf1

MAIN REFRESH + FIX ROUND + RESTACK. First fix round on this PR (rounds 1-4 ran on #648 before the split). Answers Sol REQUEST CHANGES 0/4/2 (https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/693#issuecomment-5999124426) and Opus REQUEST CHANGES 0/1/9 (https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/693#issuecomment-5999369928). Normal pushes 13417e7b..c2cef1d1..53796f1e (no force, no rebase). Size 2,876 lines (+2,756/-120), 24 files against #692 @ 346cf4a8 (created 2026-10-03, grandfathered 3,000 ceiling).

## RESTACK (merge-only commits)
| Commit | What |
|---|---|
| 60fb8fe9 | merge #692 @ 32863d3c (main ee55f814 refresh). One conflict, `CreateNotificationInput` in `src/notifications/notifications.service.ts`: kept main's `throttle_key` and P2's `push_twin` side by side; main's channelGate/gateFrom/describeFailure kept as merged (Opus C-693-2 contract). |
| b2c167c6 | merge #692 @ 346cf4a8 (B-692-1 fix); no conflicts |

## Finding -> change -> commit
| Finding | Change | Commit |
|---|---|---|
| Opus B-693-1 Android channelId `default` | new `src/notifications/push/push-channels.ts`: the app's four channels (coach-messages, client-bot, milestones, system, as mobile `src/notifications/push-channels.ts` creates them); `androidChannelFor(kind)`: messages -> coach-messages, booking and coach-side kinds -> system, milestones and weight trend -> milestones, reminders, nudges, check-in, Build Week, assignments and drip -> client-bot, unknown -> system. The worker sends that channel. | c2cef1d1 |
| Sol B-693-1 reschedule dedupe | `BookingRescheduledPayload.rescheduleEventId` (optional); push dedupe `booking_rescheduled:<session>:<event id>`; the lifecycle service passes the session row's `updated_at` after the move, so the same move has one identity and a later move back to an earlier time has a new one; without an id the identity is `<old>><new>`. | c2cef1d1 |
| Sol B-648-7 hidden sole rows | `push_twin` hides a push row only when its inapp counterpart is found (same user, kind, deep link and text, stored in the last hour; a read error proves nothing, so the row stays visible). The drip and purchase writers pass `push_twin` only when their inapp write returned a row. | c2cef1d1 |
| Sol B-693-2 failed token clear settled | `clearToken` returns whether the exact-token clear ran. A failed clear is kept as `token-cleanup-pending` (ticket stage: dropped row with the token; receipt stage: receipt read, not counted). Each receipt sweep first retries those clears (oldest 100, the clear only, never the push) and settles them to `device-not-registered` with a CAS on the code. A token re-registered meanwhile is kept. | c2cef1d1 |
| Sol B-648-9 consent during preparation | after the handoff write, preferences and the device token are read again; a master mute or kind switch committed during preparation drops the row as `preference-off`, a sign-out as `no-token`, before anything reaches Expo; the inbox row is untouched. | c2cef1d1 |
| Sol B-692-1 (defense in depth) | the worker always renders the kind's template at send, with or without stored context; booking push context no longer stores display names. | c2cef1d1 |
| Opus C-693-2 (operator-approved, main refresh) | main's payout notice push row (`src/checkout/payout-notice.service.ts`) passes `push_twin: true`, so each notice is one inbox item (hidden only behind its inapp row). | c2cef1d1 |
| CI guard from the refresh | main's `test/privacy/no-pii-in-logs.spec.ts` flagged P2's `onModuleInit` log of a variable named `message`; renamed to `notWired` (same text). | 53796f1e |

## Tests at this head
| Check | Result |
|---|---|
| test/push-delivery-round5.spec.ts (new, 15 cases: reschedule A>B>C>B and A>B>A>B with ids, same move twice; twin proof incl. switched-off inapp, different link, throttle_key + push_twin per payout notice, drip and purchase writers on inapp failure; token cleanup at receipt [0, 1] and at ticket with a re-registered token; mute, kind switch and sign-out during a 70 s preparation read plus controls; channel set and per-kind map; worker sends channel and template only) | 15/15 pass; with the src fix removed 12 of the first 14 cases fail (local) |
| Updated specs: push-delivery.service, push-delivery-send-time, booking-emitter, scheduling.service, s-fee-r5-or-111-1 (template copy, channel, no display name in context, event id, payout push_twin) | pass |
| `tsc --noEmit` (whole repo) and eslint on changed src | clean (local) |
| PR CI at 53796f1e | build-and-test (full suite) success: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37352037508; every check that runs on this stacked PR is green (schema parity, rls, live suites, npm audit, size). Main-only gates (migrations forward/reversible, banned casts, CodeQL, danger) run when the base becomes main after #692 merges. |
| PR CI at c2cef1d1 | build-and-test failed only test/privacy/no-pii-in-logs.spec.ts (fixed in 53796f1e): https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37350492403 |

## Probe replay (both lenses)
Postgres CI lane at 53796f1e + both lenses' probe files: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37352088482 (15 suites; 203/205; the two failures are Opus U2/U3, ruled follow-up Cs). Same result at c2cef1d1: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37350591060.
| Lens | Probe | At 13417e7b | At 53796f1e |
|---|---|---|---|
| Sol P2 | distinct reschedules A -> B -> C -> B each reach the recipient once | fail | pass |
| Sol P2 | a suppressed inapp write is not proof that the sole push row is a twin | fail | pass |
| Sol P2 | the real drip writer preserves its sole push row when the inapp DB write fails | fail | pass |
| Sol P2 | a transient token-clear failure does not permanently settle a dead-device receipt | fail | pass |
| Sol P2 | mute committed during slow send preparation suppresses the external call | fail | pass |
| Sol P2 | the real message emitter does not expose private profile display-name text | fail | pass |
| Sol P2 | control: deleting outbox rows before the handoff prevents a stale send | pass | pass |
| Sol P1 | all 6 (message text, booking display name, health/unknown kinds, mute and switches, zoned quiet hours, receipt signal) | 4/6 (at #692 27156167) | 6/6 |
| Opus | U1 [B-693-1] every Android channelId is one the app creates | fail | pass |
| Opus | U2 [C-693-3] deferred "Session confirmed" for a session cancelled overnight | fail | fail (C, follow-up) |
| Opus | U3 [C-693-4] connection refused before Expo is retried | fail | fail (C, follow-up) |
| Opus | U4 [control] lock-screen copy has no health value or message text | pass | pass |
| Opus live | L1 two workers on two pools send each of 30 rows once (real claim SQL) | pass | pass |
| Opus live | L2 five concurrent enqueues of one event leave one row | pass | pass |
| Opus live | L3 not-yet-due row unclaimed; unstarted lapsed lease released and sent once | pass | pass |
| Opus live | L4 receipts read once across two replicas; DeviceNotRegistered clears only that token | pass | pass |
| Opus live | L5 erasure manifest entry | pass | pass |
| Opus live | L6 migration backfill hides only a proven twin | pass | pass |
| #648 rounds | B-648-8 stall before handoff, B-648-10 round-4 70 s read/handoff crossing, urgency and daytime controls (in push-delivery-send-time.spec.ts) | pass | pass |

## Money-list self-check
- Webhook order/redelivery: no webhook handler changed; the payout notice keeps its per-notice `throttle_key` and only gains `push_twin`.
- Concurrency and lock order: claim/lease SQL unchanged; new reads after the handoff are reads; token clear is a CAS on the exact token; cleanup settles by CAS on `result_code`; reschedule identity comes from the committed row.
- Terminal states: `token-cleanup-pending` never re-sends; it ends as `device-not-registered`; rows keep `sent`/`dropped` status.
- Pagination and fail-closed completeness: cleanup is bounded (100, oldest first) and repeats every sweep; a failed twin-proof read keeps the row visible; a failed consent read goes to the worker retry path without sending.
- Currency and minor units: no amount logic changed; no amounts on the lock screen.
- Copy truth: templates only on the lock screen (no names, notes, health values, first person, exclamation marks or emojis); Android channels match the app; Android delivery is unverified on device.

Follow-up Cs (not fixed, by ruling): Sol C-693-1 cross-replica collapse/burst admission; Sol C-693-2 legacy senders bypass the outbox; Opus C-692-2, C-693-3..C-693-10 (C-693-5 is closed by the reschedule fix). Merge order: #692 then #693 back to back; deploy after #693 with migrations.

READY FOR AUDIT
