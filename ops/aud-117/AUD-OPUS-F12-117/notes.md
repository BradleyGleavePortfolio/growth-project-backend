# AUD-OPUS-F12-117 notes (Claude Opus 5.5 lens, agent 117)

Heads: #681 9de3135c2f128289ab302dff43a04e12f32b74d1 (base main d23fa317, BEHIND main a5b605d1), #682 a5d6a434a9bd909699b158ac3791a09db25c241d (base #681 @ 9de3135c).
Claims: ops/lanes117/claims/backend-681-9de3135c-opus, backend-682-a5d6a434-opus.
Worktrees: wt/AUD-OPUS-F12-117-681 (probe commit 3c2cf1b9), wt/AUD-OPUS-F12-117-682 (probe commits 02c99d67, 08c8e5f7, +ids fix).

## Merge check
patch-id(007d3dcb..479873f4) == patch-id(5a19178d..9de3135c) == a070c096 -> F1 r11 merge into F2 is clean.
F1 files (split-ledger, money-diagnostics, charge-lock, stripe-connect-api, prisma) byte-identical between 9de3135c and a5d6a434.

## CI-lane runs (this lens)
- 681: run 37177782132 job 111363926028: 4 suites 36/36 pass (116 probe L1-L5, D1 x5, D2 x9; 117 extra X1-X2; builder r11 spec; split-ledger.service.spec). L4 prints destination rows=2 (C-681-7).
- 682: run 37177789957 job 111363949166: 5 suites 56/56 pass (116 probe W1-W6, C1-C3, D1-D3, L1-L4, P1-P2; 117 extra X1-X4; builder r11; transfer-orchestrator.service.spec; s-fee-r9-send-boundary). Live-DB suite failed to COMPILE (probe harness: `const seeded = []` never[]).
  D3: stripe=800 books=400 duplicate_alerts=0 (C-682-5). P1: 960 checked, 12 truncated (EUR >= 9,999.99 dispute_won), none USD.
  X3: send_abandoned cause text = "...still pending under another attempt; nothing sent by this worker" (C-682-7).
  X4: 24 truncations (eur/gbp/aud/cad >= 9,999.99, dispute_won, all-present shape), amount_cut=0; USD none up to $999,999.99.
- 682 live-DB #1: run 37177952371: DB-L0 control 30/30 dupes with old algorithm; DB-L1 pass; DB-L2 pass; DB-R1 pass (20 ops, 20 losers all ReversalUncertainError, 1 send per op); DB-R2 failed on probe-fake id collision (stripe_reversal_id unique; second fake restarted at trr_1). Harness fixed.
- 682 live-DB #2: run 37178103246 (see report).

## Red by design #682 (re-derived from GitHub)
build-and-test run 37173697501 attempt 2 job 111353837189 @ a5d6a434: Test Suites 2 failed / 714 passed; Tests 4 failed / 12,333 passed.
Failures: checkout-webhook-fee-split.spec.ts:313 and replay idempotent; purchase-split-handler.service.spec.ts:239 sub-coach and idempotent.
Cause in log: `this.prisma.connectTransfer.updateMany is not a function` (main's fakes). F4 e9ee033d rewrites both specs (settlement-fakes); F3 35a18539 does not touch them.
#681: 17 contexts pass at 9de3135c (build-and-test run 37173385908 attempt 2 job 111353805376).
