AUDIT Claude Opus 5.5 — growth-project-backend#676 @ cf5ef18b6d6f892ce6d7b975539f4ea31730286e — VERDICT: REQUEST CHANGES

A/B/C = 0/2/0 (C-641-2 is carried on top and not counted)

Lens AUD-OPUS-CM1-117 (agent 117), T4 (money). Piece M3 of #641. This verdict is independent of the builder and of the Sol lens: Sol's verdicts at this head were not read before writing it.

**Evidence base (G09)**
- `git diff 564f33bf cf5ef18b` was split into two parts:
  - The M1 part (src/checkout, src/connect/fees, prisma, ci.yml, runbook) is byte-identical to the #674 delta `9a512028..d9327546`. It is audited in this lens's #674 verdict at d9327546 and not counted again here.
  - The M3 part is 7 files, +196/-35. Every line of it was read.
- The rest of the M3 code is unchanged since 564f33bf. This lens audited it line by line at that head (AUD-OPUS-CM1-116, RC 0/2/1), and that audit is reused for the unchanged lines only.
- The base is the #674 branch at d9327546, and merge with it is clean.
- Probes ran in the CI lane on audit/AUD-OPUS-CM1-117/676-probes: [run 37178111398](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37178111398). The probe commit is 7c160d08 on top of this head, and only probe specs were added. The first run was [37177837844](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37177837844), with the same results before the probes were made fix-agnostic.

**Prior findings from this lens, decided at this head**
- **B-676-1: CLOSED.**
  - `allocateReversal` (coach-money.service.ts:423-472) now reads the per-event `reversal_postings` and splits only legacy unposted cents.
  - The reversed-slice candidate query also matches a posting in the window (:992).
  - This lens's 116 probe `audit-cm1-676-window-cents.spec.ts` passes unchanged in run 37178111398. After a later refund, the first window and its CSV stay exactly as posted, and the second window reports exactly what was posted for it.
- **B-676-2: CLOSED.**
  - `refreshStatus` logs `code=CONNECT_REFRESH_FAILED class=stripe|other`.
  - `syncFromStripe` logs `code=CONNECT_ACCOUNT_RETRIEVE_FAILED status=<n>` (connect.service.ts).
  - The new spec asserts that a canary string is absent from the logs. No `.message` sink was added in the M3 diff. The two remaining ones (coach-connect.service.ts:362, :573) are main code.
- **C-676-2: CLOSED.**
  - `payoutReason` maps `failure_code` to app copy that includes the coach's next step.
  - Its 18 codes are exactly Stripe's documented [payout failure codes](https://docs.stripe.com/api/payouts/failures).
  - An unknown code gets a generic line with the code as a reference. Prototype keys are refused. Stripe's free text is never shown.
- **MRR ruling, MRR half: CLOSED.**
  - MRR counts `active` and `past_due` only (:665).
  - A trial is counted apart (`trial_clients`, `trial_mrr_cents`) and never in `paying_clients`.

### B-676-3 — one refund or lost chargeback on a head-coach-split sale becomes two rows in the seller's tax CSV, and `client_refunded` is counted twice
**Where**
- `buildMoneyCsv` keys a reversal row by `kind|purchase|charge|posting time` (coach-money.service.ts:869) and writes the event's full amount into each row (:871).
- The postings of one event carry different times:
  - destination and application_fee use the refund's `posted_at` (refund-dispute-handler.service.ts:542), or the dispute's `closed_at` (:1192);
  - the head-coach slice uses the time the Stripe reversal is recorded, `at: new Date()` (transfer-orchestrator.service.ts:298, in #674).
- The builder's #677 spec freezes the clock, so all postings share one instant and the defect does not show.

**Counterexample** (red in [run 37178111398](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37178111398), `test/audit-opcm1-117-676.spec.ts`)
- The setup is the real handler, ledger, orchestrator and CoachMoneyService on one store: a 4,900-cent sale with slices destination 4,312, TGP fee 98 and head-coach split 490, and a 490-cent head-coach transfer.
- **3a.** A 980-cent refund, with Stripe's reversal call taking 1 s.
  - Expected: 1 refund row, `client_refunded` 9.80.
  - Got: **2 refund rows, 19.60**.
- **3b.** The reversal times out and the 15-minute sweep records it 2 h later, across a window edge.
  - Expected: one refund row carrying `client_refunded`, and 9.80 across both files.
  - Got: **2 rows and 19.60**.
- **3c.** A lost 4,900-cent chargeback, with 1 s latency.
  - Expected: 1 row, 49.00.
  - Got: **2 rows, 98.00**.
- **Control:** the same refund with a frozen clock gives one row. Lifetime head-coach income is 392.

A seller's accountant who sums `client_refunded` reports refunds the client never received.

**Fix rule:** every slice reversal of one event lands on that event's one CSV row, and `client_refunded` is counted once per event. Either option works:
- **Writer, in #674 (recommended).** The head-coach posting takes the event's own time (refund `posted_at`, dispute `closed_at`), passed in `ledger_source.at`. All postings of one event then share one time. This also keeps the seller's `head_coach_split` window total in the refund's window.
- **Reader, here.** Key reversal rows by `(kind, source_id)`, and set `client_refunded` only on the event's row.

**Verify:** 3a, 3b and 3c pass unchanged, and the control stays green.

### B-676-4 — `churned_30d` still counts a free trial cancelled before it ever billed (operator ruling of 10-03: MRR and churned_30d exclude never-billed trials)
**Where:** the churn query (coach-money.service.ts:1270-1279) takes every purchase with `canceled_at` in the last 30 days, `amount_cents > 0` and `source: null`. Nothing requires that the purchase billed. A trial row carries the renewal price as `amount_cents`.

**Counterexample** (same run):
- client-1 pays 49.00 a month.
- client-2 cancelled a free trial 10 days ago and never billed (no ledger slice).
- client-3 is trialing now.
- Result: MRR 4,900, paying 1 and trial 1 are right. But `churned_30d` is **1**, where it should be 0.

There is a related regression in this round. `payingIds` now excludes trialing rows (:1313-1315). A client who cancelled a billed plan A and is now trialing plan B therefore newly counts as churned. Before this round, that client was not counted.

**Fix rule:** a cancelled purchase counts as churn only if it billed at least once. Use the evidence `PAID_WHERE` uses: a paid status, or a counted destination slice. A client who still holds an entitled purchase with this coach, a trial included, is not churned.

**Verify:** the probe's churn case passes unchanged. Add the plan-A-cancelled, plan-B-trialing case.

### C (optional)
- **C-641-2 (carried):** exact-candidate integration with #627/#628.

**Notes** (not findings):
- The `allocateReversal` docstring (:411-422) still describes only the proportional split.
- A legacy slice with unposted cents can be re-split when a later event posts. This affects legacy rows only, and production holds no Connect ledger rows today.
- Trial counting depends on the trials stack writing `amount_cents > 0` on trial rows. Confirm this when the stacks are combined.

Approval at the next head requires B-676-3 and B-676-4 closed with failing-before tests and every required check green. If the B-676-3 fix lands in #674, both pieces get new heads and new verdicts. No push, merge or dispatch to the PR branch by this lens.

