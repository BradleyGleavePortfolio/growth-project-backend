# B-PAYOUTSYNC-123 — F7 coach payout status sync (B-COND-1)

Builder: Claude Opus 5.5, agent 123. Start 21:50 PDT 10-05 (time box 30 min, ends 22:20).
PR: growth-project-backend#750 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/750
Branch: fix/connect-me-payout-sync. Base main 5230306c. Head 06745d7d4be0df8f85311a1f16c9893f32a91f69.
Title: `fix(connect): re-read Stripe when the payout status is not ready`.

## Change
- src/connect/connect.service.ts `getStatusForCoach` (only caller ConnectController.me(), GET /v1/connect/accounts/me): when the
  saved row is not fully onboarded and not deauthorized, call `syncFromStripe(row.stripe_account_id)` (the same write
  account.updated uses via billing.service.ts applyConnectAccountUpdated) and return the synced row. Stripe error or network
  throw -> saved status unchanged (warn log, closed code CONNECT_STATUS_SYNC_FAILED, class only). No retry/backoff. Ready rows
  never call Stripe.
- test/connect.service.spec.ts: block "GET /v1/connect/accounts/me payout status sync" — real controller + real service:
  not-ready + Stripe enabled -> ready + row updated (fails on main); Stripe 500 -> unchanged; fetch throws -> unchanged; ready row ->
  no Stripe call. Shared `makeService` helper keeps R75 net 0.
- Size: 148 additions + 2 deletions = 150 changed lines (16 src).

## Local evidence
- heavy.sh jest test/connect.service.spec.ts test/connect-env-gate.spec.ts: 20/20 pass. With the src change reverted the first
  new case fails (1 failed, 16 passed).
- check-r75 staged: net 0. ESLint on both files: clean.

## CI
All checks green at 06745d7d (22:00 PDT): CI build-and-test (lint, type-check, build, full test)
https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37415922022/job/112114387094 ; Danger, R75, CodeQL,
Schema parity, H4 deploy readiness, SBOM, npm audit, rls/community/mwb-3 live tests.

## Comment
FIX ROUND 1 (OPENING) ... READY FOR AUDIT:
https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/750#issuecomment-6009668232 (22:00 PDT)

## Cs (no fix)
- C (follow-up, not in scope) Settings > Payouts copy is generic in places (S-E2E-COACH-123 C-1); untouched.
- O-1 owner check (live Connect webhook endpoint) still useful but no longer blocks: this fix removes the dependency for the
  Settings screen and the Buy gate after the coach opens Settings > Payouts.

## HANDOFF
State: DONE. PR #750 open at head 06745d7d4be0df8f85311a1f16c9893f32a91f69, CI green, opening comment posted, READY FOR AUDIT.
Worktree /home/user/workspace/wt/B-PAYOUTSYNC-123 removed; local branch deleted (remote branch fix/connect-me-payout-sync is the
PR head, keep it). No locks, claims or ci-lane runs. Nothing merged or deployed; no Stripe calls.
Next: two lenses (Opus + Sol) review #750 at 06745d7d; one fix round if a B comes back (recreate a worktree from
origin/fix/connect-me-payout-sync). Merge is operator-only with --match-head-commit after dual APPROVE.
