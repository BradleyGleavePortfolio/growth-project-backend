## What

Coach "Restart plan" for a client plan paused by a payment dispute or inquiry (R-DISPUTE-PAUSE, T4 money). Stacked on the lockout train (m#352 -> #353 -> #354) so it lands right after it.

Normal-user story: a coach whose client's plan was paused after a payment dispute (resolved in the coach's favour or settled) opens that client (the screen the coach's dispute alert opens), taps "Restart plan", confirms, and billing resumes; each refusal shows one plain sentence.

## How

- `src/entitlements/dunning/coachDisputeRestart.ts`
  - Reads the coach's roster purchases (`GET /v1/coach/purchases`), keeps this client's recurring plans with access off that are not ended, and reads each one's drill-down (`GET /v1/coach/payments/purchases/:id`). A plan counts as dispute-paused only when the backend's dunning row says so: status `active`, `last_failure_reason` `charge_disputed`, `entered_at` set (the same test as the backend restart pre-check, `restartCandidate`).
  - `POST /v1/coach/purchases/:id/dispute-restart` (backend b#690 @ 5d41f767, `DunningRestartController`). 200 `{ restarted: true }`; every coded refusal maps to its own sentence: 404 `PURCHASE_NOT_FOUND`; 409 `PLAN_NOT_DISPUTE_PAUSED`, `PLAN_ENDED`, `OTHER_LIVE_PLAN`, `NEW_DISPUTE`, `BILLING_BUSY`; 503 `BILLING_UNAVAILABLE`. No answer from the server says the result is not known yet and points to pull-to-refresh.
- `src/components/coach/DisputePausedPlansCard.tsx`: card at the top of the coach's client detail screen, rendered only while a plan is dispute-paused. Confirm dialog before restarting. Refusals that rule out a restart (not found, not paused, ended, other live plan) hide the button; temporary ones (new dispute, billing busy, billing unavailable) keep it.
- `ClientDetailScreen.tsx`: mounts the card; pull-to-refresh re-reads it.

## Tests

`src/entitlements/dunning/__tests__/coachDisputeRestart.test.tsx` (20): success after confirm; Cancel changes nothing; each of the 7 refusal codes maps to its sentence; button hidden for a card decline, a resolved cycle, no dunning row, another client's plan, a one-time plan, a plan with access, a failed read; final vs temporary refusals; impersonal copy.

## Notes

- Backend dependency: b#690 (dunning D4) must be deployed for the route; before that the read finds no dispute-paused plan (no `charge_disputed` dunning rows exist with dunning v2 off), so the card never shows.
- Copy: impersonal voice, no exclamation marks, no generic errors.
