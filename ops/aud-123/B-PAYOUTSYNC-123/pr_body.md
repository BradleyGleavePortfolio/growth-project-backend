## Summary
Settings > Payouts (`GET /v1/connect/accounts/me`) read only the saved `ConnectAccount` row. That row changes only on the `account.updated` webhook or `POST /coach/connect/status/refresh`, so a coach who finished Stripe onboarding from Settings stayed "not ready", and the checkout payout gate (`COACH_NOT_PAYOUT_READY`, checkout.service.ts:604, subscription-checkout.service.ts:272) refused every buyer whenever the live Connect webhook did not reach the backend (B-COND-1, operator ruling: B).

`ConnectService.getStatusForCoach` (only caller: `ConnectController.me()`) now calls `syncFromStripe` — the same code path `account.updated` uses (billing.service.ts `applyConnectAccountUpdated`) — while the saved row is not fully onboarded and not deauthorized, and returns the synced row. A Stripe read failure (Stripe error or network error) keeps the saved status. No new retry or backoff. A ready row never calls Stripe.

Backend only; ships without a new app build.

## Linked plan / brief
Agent 123 JOBS123 wave 3 fix queue F7 B-PAYOUTSYNC-123; evidence S-E2E-COACH-123 B-COND-1.

## Test plan
`test/connect.service.spec.ts` new block "GET /v1/connect/accounts/me payout status sync" (real `ConnectController` + real `ConnectService`, Prisma stub, Stripe fetch stub):
- saved not ready + Stripe says charges/payouts enabled -> `me()` returns ready and the saved row is updated (fails on main)
- Stripe 500 -> saved status unchanged, no write
- Stripe unreachable (fetch throws) -> saved status unchanged, no write
- saved status already ready -> no Stripe call

Local: `jest test/connect.service.spec.ts test/connect-env-gate.spec.ts` 20/20 pass; the first case fails with the src change reverted. `scripts/check-r75.js --mode=staged` net 0. ESLint clean on both files. Full suites and tsc run in this PR's CI.

## Rollback plan
Revert this commit; `me()` goes back to reading the saved row only.

## Audit pack pointer
Report: ops/reports/B-PAYOUTSYNC-123.md (agent 123 workspace).

---

## R-rule self-check
- [x] **R23 LOC cap:** 148 additions, 2 deletions (16 src, 132 test)
- [x] **R18 lane scope:** connect service + its spec only
- [x] **R100 prod-readiness:** N/A, no config or env change
- [x] **R100 deploy-readiness board:** PR CI
- [x] **R75 banned cast tokens:** net 0 (one existing cast moved into a shared test helper)
- [x] **R74 test:src ratio:** 132/16
- [x] **R92 RLS impact:** none
- [x] **R98 PII statement:** does not touch PII; the new log line has coach id, closed code and error class only
- [x] **R82 + R106 migration safety:** no migrations
- [x] **R83 feature flag:** N/A, read-path sync through existing code
- [x] **R86 SLO:** one Stripe GET only while the coach is not ready
- [x] **R90 idempotency:** GET route; the sync write is idempotent
- [x] **R3 commit identity:** Bradley Gleave, no AI co-author
- [x] **R6 push cadence:** single commit
- [ ] **R14 audit cycle:** pending lenses

## Dependencies
None. Base: main 5230306c.

## Notes for auditor
Trigger is `!is_fully_onboarded && !deauthorized_at`. `syncFromStripe` already returns the unchanged row on `StripeConnectApiError`; the new try/catch covers non-Stripe throws (network). Mobile CoachConnectScreen calls `me()` after the onboarding sheet closes and on pull-to-refresh, so no app change is needed.
