AUDIT Claude Opus 5.5 — growth-project-backend#706 @ 3d95f96e555627d7dd5605a6004c0df633687208 — VERDICT: APPROVE

A/B/C = 0/0/2

Agent 119 · AUD-OPUS-T3E-119 · delta audit (tests only, T4 stack) of FIX ROUND 2 against this lens's APPROVE at `a3f01163`.

**Delta and restack check**
- The head is merge `3d95f96e`, with parents `1543ca71` (the new tests) and `dcf095b8` (#673 FIX ROUND 11).
- The source and T3-spec part of `git diff a3f01163 3d95f96e` is byte-identical to `git diff 904b9642 dcf095b8`; the diff of the two diffs is empty. So the restack carries exactly the #673 round-11 change, which is audited in that PR's verdict, and there are no conflict hunks.
- `git diff dcf095b8 3d95f96e` covers 2 test files: `b-trials-4-fix-round.spec.ts` (+426) and the new `b-trials-5-fix-round.spec.ts` (+514). That is 940 lines with no source, under the 1,500 rule (opened 13:20 PDT).

**b-trials-5 (read in full)** uses a real TrialConflictService and a real StripeConnectApiService over an intercepted fetch. Sol's exact probe also runs the real CheckoutWebhookHandlerService. The suite covers:
- **Ordering:** the call order (open list, then paid list, then void, then DELETE). A payment between the two reads leads to a supersede with no void.
- **Void failures:** a payment that wins the void (`invoice_not_open`) is retried and then superseded once, with one billed alert. Six kinds of unconfirmed void reply and six kinds of unknown open list each mean no DELETE.
- **Lease budget:** two invoices give `lease_exhausted`.
- **Alerts:** a single cancel-failing alert after three attempts.
- **Races:** a supersede, a deleted webhook or a lease takeover during the void or during the open read means no DELETE.
- **C-673-7:** five malformed-amount cases, plus controls.
- **Fixtures:** the round-11 routing edits to b-trials-4 (the open list and void, and the `status=paid` selector) are fixture-only.
- **Failing-before check:** run 37236196278, on the 904b9642 tree, has 36 assertion failures and no TypeError or TS errors.

**Probes and replays (CI lane, exact head + probe specs only):** run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37238555246
- b-trials-3, b-trials-4 and b-trials-5 are green.
- The new Opus `audit-opus-t3e-119-673.spec.ts` is 11/11 green.
- The T23D-119 and T23-119 replays are green except the ruled C-673-4. In the T23-118 replays, C-673-2 and C-673-3 (x2) are red, as ruled.
- Totals: 135 pass and 4 fail; all 4 are the ruled C reds.

**Follow-ups (C), not blocking**
- **C-706-1 (carried):** `b-trials-4-fix-round.spec.ts`. The fake `$transaction` is read-committed, so the race tests pin read order, not the snapshot. Fix rule: a snapshot-freezing fake, or a live-DB spec.
- **C-706-2 (new):** `b-trials-5-fix-round.spec.ts` lacks two regressions:
  - void confirmed, then the DELETE fails (the C-673-8 path: retry, then supersede);
  - lease budget measured against real elapsed read time, as opposed to the invoice count alone.

  Probes Q1, Q2 and Q2b in the run above prove the current behaviour. Fix rule: adopt them into b-trials-5 in the #680 round.

**CI at this head:** 10 applicable checks pass and deploy-readiness-gate is skipped. Merge state CLEAN, draft.
