# AUD-OPUS-F34-117 notes (Claude Opus 5.5 lens, agent 117 wave)

Started 2026-10-04 04:32 UTC (21:32 PDT). Claims: lanes117/claims/backend-683-35a18539-opus, backend-684-e9ee033d-opus.

## Heads (re-read 04:33 UTC)
- #683 F3 @ 35a18539c8a911524c3eab5b074b33e247f80ac2, base F2 a5d6a434, 5 files +2959/-25 = 2984 changed lines.
- #684 F4 @ e9ee033d425a61bb48efe2ac2387a23e5347acb0, base F3 35a18539, 23 files +2572/-423 = 2995 changed lines.

## Delta since this lens's last verdicts (e2af8ca1 APPROVE 0/0/3, 42e9ca13 RC 0/1/2)
- F3: c6fb2e3e = e2af8ca1 + F2 merge (F3 files byte-identical except +4 lines in stripe-connect-api from F2).
  F3 content delta = git diff c6fb2e3e 35a18539: charge-settlement (+171/-130 mostly comment re-wrap),
  money-errors (+RefundStateUnavailableError), reconciliation (+fx refunds, pending transfers, take:12 removed),
  stripe-connect-api (+listChargeRefunds). Merge 00ef30b7 clean (no remerge diff).
- F4: 392473a3 = 42e9ca13 + F3 restack merge (F4 files byte-identical). F4 content delta (F4 files only):
  payout-notice (closed codes, newest-notice live amount, 404 copy), purchase-split (2 log lines),
  refund-dispute-handler (final applyAdjustments on amount_refunded + 5 log lines), sweep cron (3 log lines),
  hbs copy line, + test/s-fee-r11-fx-cash-truncation-logs.spec.ts (361). All 6 F4 merges clean.

## Prior Opus findings: closure
- C-683-1 (red list): body + FIX ROUND list correct; CI 37174989449 attempt 2 = exactly 3 suites / 9 tests. CLOSED.
- C-683-2 (FX): convertedRefundedCents in settle/adjust/reconcile; tests r11 spec B-683-1 x4. CLOSED.
- C-683-3 (take 12): removed; test C-683-3. CLOSED (but now unbounded per purchase -> new C-683-4).
- B-684-1 (first person): both strings rewritten; guard test. CLOSED.
- C-684-2 (page size): newest-notice lookup across pages; test. CLOSED.
- C-684-3 (dispute copy, outside diff): not changed; stays operator item.

## CI
- #683 run 37174989449 attempt 2: build-and-test red by design: checkout-webhook-fee-split 2, purchase-split-handler 2,
  reconciliation.service 5 (TypeError reconciliation.service.ts:221 chargeSettlement undefined in main stub). lint, tsc, build pass.
  Attempt 1 also failed test/prod-readiness/operator-keys-artifact.spec.ts (10 s timeout, unrelated file scan; passes on attempt 2
  and at F4). All other checks green.
- #684 run 37175734211: build-and-test green, 719 suites passed, 0 failed; all checks green.
- Failing-before 37173415148 (pre-fix 42e9ca13 + earlier spec version): 14 fail / 2 controls pass. Passing-after 37175462104 at e9ee033d.

## New candidate findings
- #684 async-rail refunds (ACH): charge.refunded fires at refund creation with status pending (Stripe connector doc,
  measured sequence). Round-11 final applyAdjustments uses charge.amount_refunded (no status) -> if pending counted, money moves
  on pending; onRefundUpdated (main) only updates the row status -> a failed refund never re-credits; a pending->succeeded refund
  never converges if amount_refunded excludes pending. Probe: audit/AUD-OPUS-F34-117/684-asyncrefund (+ pre head 392473a3).
- #683 C: reconciliation per purchase is now unbounded (one Stripe read per settled charge, admin sweep up to 200 purchases).
