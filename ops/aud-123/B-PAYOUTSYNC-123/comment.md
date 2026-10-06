FIX ROUND 1 (OPENING) (B-PAYOUTSYNC-123, agent 123) — growth-project-backend#750 @ 06745d7d4be0df8f85311a1f16c9893f32a91f69

Fixes B-COND-1 (S-E2E-COACH-123, operator ruling B): Settings > Payouts read only the saved Connect row, so a coach who finished Stripe onboarding there stayed "not ready" and every buyer got COACH_NOT_PAYOUT_READY when the Connect account.updated webhook did not arrive.

Change (16 src lines, src/connect/connect.service.ts `getStatusForCoach`, only caller `ConnectController.me()`):
- saved row not fully onboarded and not deauthorized -> `syncFromStripe(row.stripe_account_id)`, the same write `account.updated` makes (billing.service.ts `applyConnectAccountUpdated`), and return the synced row
- Stripe error (already handled inside syncFromStripe) or network throw -> saved status unchanged; warn log with coach id, closed code CONNECT_STATUS_SYNC_FAILED and error class only
- ready rows never call Stripe; no new retry/backoff

Tests (test/connect.service.spec.ts, real controller + real service, stubbed Prisma and Stripe fetch):
- saved not ready + Stripe charges/payouts enabled -> me() returns ready and the saved row is updated (fails on main: verified with the src change reverted)
- Stripe 500 -> unchanged, no write
- fetch throws -> unchanged, no write
- saved ready -> no Stripe call

Size: 150 changed lines (148+/2-). R75 net 0 (one existing cast moved into a shared test helper). No migrations, no env, no flags, no mobile change.

CI at this head: all checks green (CI build-and-test incl. lint, type-check, build, full test: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37415922022/job/112114387094; Danger, R75, CodeQL, Schema parity, deploy readiness, rls/community/mwb-3 live tests).

READY FOR AUDIT
