# AUD-OPUS-F12-116 (Claude Opus 5.5 lens, operator agent 116 wave) — fees F1 #681, F2 #682

Started 2026-10-03 19:28 PDT. Claims: ops/lanes116/claims/backend-681-5a19178d-opus, backend-682-007d3dcb-opus.
Notes: /home/user/workspace/ops/aud-116/AUD-OPUS-F12-116/. Worktree: /home/user/workspace/wt/AUD-OPUS-F12-116-682 (detached at 007d3dcb).

## Setup facts
- #681 head 5a19178de2d6017ba0b9be73ff6ea2c365a20d55, base main d23fa317; 27 files +1847/-656; 18/18 checks green (run 37151667174 etc.).
- #682 head 007d3dcbb69ebb1b31f406602ab3b7db65889896, base agent115/fee-split-1-ledger-foundation (= 5a19178d); 6 files +2413/-116.
- Refreshed #627 tree = merge-tree(66162285, d23fa317) = 09de2bff. Every F1 and F2 file is byte-identical to that tree
  (the deleted fee-rounding spec is absent in both).
- Changes on piece files since my lens's APPROVE @ 3a5338d7: round 10 (orchestrator parkFailureKind, 27 lines), the
  notifications.service merge resolution in 66162285, main 0d33c4d4 / d23fa317 hunks (schema, env, prod-switches, notifications).

## #681 (fees F1) — APPROVE 0/0/4
- Head 5a19178de2d6017ba0b9be73ff6ea2c365a20d55 (unchanged at posting). Verdict:
  https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/681#issuecomment-5975947638
- CI: all 17 run contexts pass (11 required; deploy-readiness-gate skipped). build-and-test
  https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37151667174/job/111286651550
- Evidence reuse: Opus APPROVE #627 @ 3a5338d7 (5972040127); every F1 file byte-identical to refreshed #627 tree 09de2bff;
  deep audit of 66162285 notifications merge resolution + main hunks; full read of migration, fee math, checkout, refunds, charge lock.
- C-681-3 legacy ledger write findFirst+create, nullable 4-col unique (split-ledger.service.ts:338-356, migration:43-48). Sol rates
  B-681-2. This lens: C (only pre-S-FEE destination charges; prod 0 Connect accounts). Becomes B if any legacy destination charge exists.
- C-681-4 charge-lock.ts:230-232 logs Error.message on release failure (Sol B-681-1). C: internal ids only.
- C-681-5 split-ledger.service.ts:198 undoReversal dead and relative; delete.
- C-681-6 (operator) migration 20270210000000 older than main latest 20270301000000 (guide rule 7, handoff 9.4; OR-113-4 says deploy
  applies it). No references to the name; recurring 20270225/20270311 do not touch S-FEE objects. Default: rename newer than
  20270316000000 in the final fold, verified in the merge-only delta.

## #682 (fees F2) — REQUEST CHANGES 0/2/1
- Head 007d3dcbb69ebb1b31f406602ab3b7db65889896 (unchanged at posting). Verdict:
  https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/682#issuecomment-5975947733
- Probe (exact head + test/audit-opus-682-probe.spec.ts; copy kept in notes dir):
  https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172209834 (7 failed acceptance, 3 controls pass).
- B-682-1 transfer-orchestrator.service.ts:1136-1153 reversal drive(): no post-await re-proof or HTTP-boundary start budget; a paused
  sender re-reverses after takeover + key expiry (Stripe 800 vs books 400). Same boundary Sol filed as B-682-1; independent probe.
  Fix: mirror the transfer send protocol (claim CAS, re-fence + re-read after await, beforeSend start budget, duplicate alert).
- B-682-3 payout-notice-copy.ts:67,79,93,101 first person ("We took", "We will hold", "We paid", "We released"); 6/8 cases fail
  the voice probe. Sol filed C-682-1; this lens B (owner copy bar; B-325-4 precedent). Fix: impersonal copy + all-event voice guard.
- C-682-4 free-text Stripe/Prisma messages in logs and last_error (lines 562-609, 803-807, 896, 951-955, 1156-1167, 1204-1208,
  1256-1261). Sol B-682-2; this lens C (inputs are ids/amounts/fixed strings).
- Red by design verified: attempt 2 of run 37153346304 (job 111344582169) fails exactly 4 tests in purchase-split-handler.service.spec
  and checkout-webhook-fee-split.spec ("connectTransfer.updateMany is not a function" in main's fakes); F4 #684 carries both.
  Attempt-1 Jest OOM flake gone. checkout.service.spec passes (PR body overstates). Everything else green; main-only checks
  (CodeQL, danger, banned casts, SBOM) run only at the composed landing candidate.

## Findings for other PRs (operator; never block)
- #684 (F4) src/email/templates/coach-payout-adjustment.hbs:20 "We take it out of your next payout" — same first-person rule.
- F3/F4 charge-settlement.service.ts resolveStuckReversals logs (err as Error).message — same class as C-682-4.

## HANDOFF
- #681 @ 5a19178d: Opus APPROVE 0/0/4 posted; Sol RC 0/2/0 (B-681-1, B-681-2). Next: F1 builder closes Sol's Bs (cheap: closed
  log code; legacy identity), operator decides C-681-6 rename timing; a fresh Opus lens audits the new head as a delta from 5a19178d.
- #682 @ 007d3dcb: Opus RC 0/2/1 posted (B-682-1 reversal send protocol, B-682-3 copy voice); Sol RC 0/2/1. Next: F2 builder fixes
  both Bs with failing-before evidence (this probe spec is a ready acceptance test), then restacks F3-F6; fresh dual audit at new head.
- Land-as-one unchanged: no piece merges alone; deploy with mobile #321.
- Cleanup done: worktree removed, audit/AUD-OPUS-F12-116/682-probe deleted (local and remote). Claims left in place.
