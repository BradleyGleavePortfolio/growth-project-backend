FIX ROUND 5 (B-PUSH2-120, agent 120) — growth-project-backend#692 @ 346cf4a8ee462c8f241de65df6ffda95988257f3

First fix round on this PR (rounds 1-4 ran on #648 before the split). Answers Sol REQUEST CHANGES 0/1/0 (https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/692#issuecomment-5999124539) and Opus APPROVE 0/0/2 (https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/692#issuecomment-5999369595). Includes the main refresh. Normal push 27156167..346cf4a8 (no force, no rebase). Size 910 lines, 10 files (created 2026-10-03, grandfathered 3,000 ceiling). Base main ee55f814.

## Finding -> change -> commit
| Finding | Change | Commit |
|---|---|---|
| Main refresh | merged main ee55f814; no conflicts | 32863d3c |
| Sol B-692-1 lock-screen PII | `src/notifications/push/lock-screen-copy.ts` renders only fixed per-kind templates. The inbox body is ignored for every kind; display names are accepted for compatibility and never rendered. Message: "New message" / "You have a new message. Open the app to read it." Booking kinds carry no name, note or reason; the two reminders keep the start time, rendered in the recipient zone at send. Milestone, progress, check-in, coach alert, Build Week and assignment kinds use fixed quiet lines; unknown kinds use the generic line. | 346cf4a8 |
| Opus C-692-1 tier header | PR body now opens with the tier header (T4) and a fix-round table | body edit |
| Support for #693 B-693-2 | `@@index([result_code])` and `CREATE INDEX IF NOT EXISTS "PushOutbox_result_code_idx"` in migration 20270307000000 (not applied in production; additive per operator ruling) so the token-cleanup retry reads by code | 346cf4a8 |

Opus C-692-2 (counterpart display names in stored rows for 30 days) stays a follow-up; #693 stops writing the booking display name into push context.

## Tests at this head
| Check | Result |
|---|---|
| test/push-lock-screen-copy.spec.ts (new, 6 cases: no inbox body or display name for any kind; message says only that a message arrived; fixed booking templates; reminders keep the zoned time; unknown kinds generic; no exclamation marks, emojis or first person) | 6/6 pass |
| PR CI run 37350476563 (build-and-test, full suite) | success: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37350476563 |
| All required checks (migrations forward and reversible, schema parity, banned casts, CodeQL, danger, npm audit, rls, live suites) | green at 346cf4a8 |

## Probe replay (both lenses)
CI lane at 346cf4a8 + Sol's probe file: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37351622402 (12/12).
| Lens | Probe | At 27156167 | At 346cf4a8 |
|---|---|---|---|
| Sol | does not forward arbitrary message-kind text onto a lock screen | fail | pass |
| Sol | does not expose private text embedded in a booking display name | fail | pass |
| Sol | health kinds and unknown kinds replace rather than trust the inbox body | pass | pass |
| Sol | master mute and individual switches override delivery | pass | pass |
| Sol | quiet hours use the supplied client zone, including DST | pass | pass |
| Sol | the receipt transport forwards the cancellable signal and returns receipts | pass | pass |
| Opus | U4 lock-screen copy carries no health value and no message text (runs with #693's worker) | pass | pass at #693 c2cef1d1 (lane 37350591060) |
| Opus | L5 erasure manifest entry on Postgres | pass | pass at #693 c2cef1d1 (lane 37350591060) |
| Opus | L6 migration backfill hides only a proven twin, on Postgres | pass | pass at #693 c2cef1d1 (lane 37350591060) |

## Money-list self-check
- Webhook order/redelivery: no webhook handler changed in this PR.
- Concurrency and lock order: no claim, lease or lock code changed; copy is a pure function.
- Terminal states: no state machine changed; the new index only serves reads.
- Pagination and fail-closed completeness: not applicable to copy; unknown kinds fall back to generic copy (fail closed).
- Currency and minor units: no amounts on any lock-screen template.
- Copy truth: templates carry no first person, no exclamation marks, no emojis, no names; Android delivery stays unverified on device.

Merge order (operator ruling): #692 then #693 back to back; deploy after #693 with migrations.

READY FOR AUDIT
