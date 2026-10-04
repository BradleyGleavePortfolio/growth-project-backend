# AUD-OPUS-D12-116 (lens: Claude Opus 5.5) — backend #687 (D1) and #688 (D2)

Started 2026-10-04 02:28 UTC (2026-10-03 19:28 PDT). Claims: backend-687-c2a901a8-opus, backend-688-6627044c-opus.
Heads at start: #687 c2a901a8f2552a166edc81b97454c9b7cd55df1c (11/11 pass), #688 6627044cce3c7a210099b77b72e53f782cba2801 (12 pass, 1 skipping).
Original #628 @ dc47e0efe2270e21a00ab8d038a9e7dbb415efe9 (FIX ROUND 8; no verdicts there).

## Notes
- Tree at #691 70bcaa43 == #628 dc47e0ef (tree f406769b). Every file in D1+D2 is byte-identical to #628 @ dc47e0ef (no split edits).
- Prior lens state (Opus on #628): APPROVE 0/0/0 @ 739e9a54; RC 0/1/2 @ 33e0696a (B-628-13, C-628-14, C-628-15). FIX ROUND 8 @ dc47e0ef claims all.
  C-628-14/15 live in client-billing.service.ts = D3 #689 (outside this job). B-628-13 spans D2 (dunning.service recordFailure,
  dunning-v2.service isDisputeCycleOpen/keepAsDisputeCycle/hasOpenDisputeObligation/applyImmediateClear), D3 (isDisputeCycle) and D4 (resolveDunningOnPaid).
- Files in D1/D2 unchanged since 739e9a54 (evidence reuse candidates): client-billing.money.ts, dunning-effective-access.ts, cadence.ts,
  email.service/types + both templates, fixtures, test/dunning-v2-service.spec.ts, test/dunning-v2-cadence.spec.ts.
  Changed since 739e9a54 (audited deeply): migration (+DunningDisputeObligation), schema, jest.config, prod-switches, .env.example,
  dispatcher (C-628-12 doc), dunning-v2.service (R4-R9), dunning.service (R9), stripe-connect-api (R9 replayed header), both fakes.
- CI: #687 11/11 required green (build-and-test run 37152165227). #688 build-and-test run 37152162539: tsc + 713 suites passed
  (incl. dunning.service, dunning-v2-service, dunning-v2-cadence). CodeQL/danger/banned casts/sbom do not run on #688 (base is D1, not main).
- Probe 1 (#688): lost dispute during a payment cycle. Branch audit/AUD-OPUS-D12-116/688-lost-dispute (6627044c + probe spec only),
  run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171961725
  Result: controls 3/3 pass, probes 2/2 fail as predicted (after `lost`, isDisputeCycleOpen false; applyImmediateClear liftedLockout true).
  Probe spec copy: /home/user/workspace/ops/aud-116/AUD-OPUS-D12-116/aud-opus-d12-688-lost-dispute.probe.spec.ts

## Verdicts (posted 2026-10-04 ~02:55 UTC; heads re-read immediately before posting, unchanged)
| PR | Head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| backend#687 (D1) | c2a901a8f2552a166edc81b97454c9b7cd55df1c | REQUEST CHANGES | 0/1/3 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-5975919378 |
| backend#688 (D2) | 6627044cce3c7a210099b77b72e53f782cba2801 | REQUEST CHANGES | 0/1/4 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5975919515 |

Verdict bodies: /home/user/workspace/ops/aud-116/AUD-OPUS-D12-116/verdict_687.md, verdict_688.md.

### #687 findings
- B-687-1 src/email/templates/dunning-v2-client.hbs:13 "a person on our team will help" (first person in client email copy; standing order "no first person in product copy"). Missed by this lens's own APPROVE @ 739e9a54 (file unchanged since). Fix: reword without first person + template voice test.
- C-687-2 client-billing.money.ts:37 comment "first-seen currency order" vs alphabetical sort at :52.
- C-687-3 jest.config.js:149 workerIdleMemoryLimit '2GB' (CI-gate config; coordinate with B-CI-116).
- C-687-4 migration 20270215000000 ordering (operator already ruled it stays).

### #688 findings
- B-688-1 dunning-v2.service.ts:1187-1200 / :1223-1234: dispute recorded during a payment cycle, closed lost before the renewal is paid -> renewal payment lifts the lock (B-628-13 order 2, lost variant). Proved by CI run 37171961725. Fix: onDisputeClosed not-won branch converts an active non-dispute cycle with keepAsDisputeCycle under the row lock (or count lost/charge_refunded obligations closed at/after entered_at).
- C-688-2 dunning.service.ts:1207 v1 email link default now /billing/update-card (live, not flag-gated; page arrives in D4; PR body "deploy only after D5" covers it); env-validation.ts:1028 default doc stale.
- C-688-3 dunning.service.ts:188-244 recordFailure read-then-write without row lock can overwrite a concurrently set dispute marker.
- C-688-4 dunning-v2.service.ts:779-780 sweep head-of-queue starvation by rows tryLock always skips (pre-existing at 739e9a54).
- C-688-5 dunning-v2.service.ts:1643 formatMoney wrong for zero-decimal currencies (pre-existing; USD only today).

## Operator items (not blocking these PRs)
1. D3 #689 (client-billing.service.ts @ dc47e0ef): same order-2 gap on the 1A card-update path. dispute_open is marker-only (isDisputeCycle :315, used :581/:830); with an open obligation and a decline marker, restoreAfterPayment (:1069) turns entitlement on, applyImmediateClear refuses correctly, then v1 recordResolution (:1115, no dispute guard) resolves the cycle; the later invoice.paid lifts the lock. Not probed by this lens (outside job). Recommended default: hand to the #689 lenses; fix with the obligation-aware isDisputeCycleOpen in D3 (or a dispute guard in v1 recordResolution), plus a D5 e2e "dispute during payment cycle -> card update".
2. C-628-14, C-628-15, B-628-11 (replayed pay) verification belongs to the #689 lenses.
3. jest.config.js workerIdleMemoryLimit overlaps the B-CI-116 job: confirm no conflict.
4. Recommended default for the stack: one FIX ROUND on the dunning stack fixing B-687-1 (D1) and B-688-1 (D2) (+ D3 item 1 if the #689 lenses agree), then restack D2-D5 and re-audit at the new heads. Merge order unchanged; deploy only after D5.

## Cleanup
- audit/AUD-OPUS-D12-116/688-lost-dispute deleted from origin (0 audit/AUD-OPUS-D12-116/* branches remain).
- Worktree /home/user/workspace/wt/AUD-OPUS-D12-116-1 removed (no node_modules link), `git worktree prune` run.
- Disk: 68% used at end.

## HANDOFF
| PR | Exact head | State | Opus verdict | Next step |
|---|---|---|---|---|
| backend#687 (D1) | c2a901a8f2552a166edc81b97454c9b7cd55df1c | OPEN draft, 11/11 checks pass, Sol RC | REQUEST CHANGES 0/1/3 (comment 5975919378) | Builder fixes B-687-1 (template copy + voice test); restack D2-D5; Opus re-audit at new head (can reuse this verdict's evidence for unchanged files). |
| backend#688 (D2) | 6627044cce3c7a210099b77b72e53f782cba2801 | OPEN draft, build-and-test pass (CodeQL/danger/banned/sbom not run: non-main base), Sol RC | REQUEST CHANGES 0/1/4 (comment 5975919515) | Builder fixes B-688-1; probe spec above must pass (2 probes) with controls still passing; add D5 e2e for lost-before-paid (webhook and card update); Opus re-audit at new head. |
No audit branches or worktrees left by this job. Claims backend-687-c2a901a8-opus and backend-688-6627044c-opus are done (verdicts posted).
