AUDIT Claude Opus 5.5 — growth-project-backend#673 @ 904b964250f4b7694b24f78fdef5a5f846957013 — VERDICT: APPROVE
A/B/C = 0/0/5

Reviewer: AUD-OPUS-T23D-119, agent 119. This is a T4 delta audit of FIX ROUND 10 ([5984069501](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/673#issuecomment-5984069501)).

**Evidence reuse (G09).** This lens approved `5fdb5f5c` with 0/0/5 ([5983711331](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/673#issuecomment-5983711331)).
- **Fix `71ae1e03`:** 3 files, +66/-6, all read in full.
  - `stripe-connect-api.service.ts` +10.
  - `trial-conflict.service.ts` +57/-6, with the whole of `settle()` and `trialConflictAction()` re-read.
  - `b-trials-3-fix-round.spec.ts` +5.
- **Merge `904b9642`:** parents `71ae1e03` and T2 `62c2c066`. Its content is byte-identical to the T2 round-10 delta (the diff of the two diffs is empty), and that delta is audited on #672.
- Every other file is byte-identical to the approved head.
- **Size:** 2,947 lines. That is under the grandfathered 3,000 ceiling.

### Sol B-673-1 (narrowed) and Opus C-673-5: closed
- **Status handling.** `past_due` and `unpaid` moved out of `UNBILLED_STATUSES` into `HISTORY_STATUSES` (:68-71).
- **The invoice read.** For those states, `settle()` reads one page of the subscription's paid invoices on the platform account, the same account as the subscription GET. The call is `listPaidInvoices`: `subscription`, `status=paid`, `limit=100`, under its own 20 s deadline. A failure gives `null`, which counts as `unknown`.
- **`trialPaidHistory()` (:84-94).**
  - Any `amount_paid > 0` or `total > 0` counts as `charged`, even on an incomplete page.
  - `none` requires `has_more === false` and every entry well formed.
  - Anything else is `unknown`.
- **What each outcome does.** `trialConflictAction()` turns `charged` into `billed` (superseded, one billed alert). `unknown`, and the default parameter, become `history_unknown`, which retries and alerts after 3 attempts with no DELETE. `none` falls through to the existing lease-room guard.
- **Other checks.**
  - Minor-unit sign checks are currency-agnostic, so zero-decimal currencies are handled.
  - The 404 on the list is never read as "already cancelled".
  - The lease budget holds: 20 s + 20 s + 20 s >= 60 s gives `lease_exhausted`.
  - The header now reads correctly.

### Sol B-673-2: closed
- After the reads and before the decision, `settle()` re-reads the row with `findFirst` on `id`, `lease_token` and `status: 'owed'` (:274-278), and returns `stale` if the row is gone.
- `supersede()` and `markCancelled()` both clear the lease, and a takeover changes the token. Every committed change in the window therefore vetoes the DELETE.
- There is no await between the decision and the DELETE, and no DB transaction is held across HTTP. The completion fence is unchanged.

### Probes on this exact head ([CI run 37232971108](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37232971108))
New `test/audit-opus-t23d-119-673.spec.ts` uses the real worker and the real Stripe API service over an intercepted fetch. All are green:
- P1: a charge on an incomplete (`has_more`) page is superseded, with no DELETE.
- P2: the pure decision table:
  - lease exhaustion with `none`;
  - the default and unknown history give `history_unknown`;
  - `unpaid` and `charged` give `billed`, even late;
  - a case-mismatched status gives `state_unknown`;
  - paused cancels.
- P3: the re-check itself throws. The result is retry, with no DELETE, the lease released and the row still owed.
- P4: `trialPaidHistory` fails closed on string amounts, null entries, a missing or non-boolean `has_more`, and `null`.
- P5: a supersession during the invoice read of a charged plan gives `stale`, no DELETE, and exactly one `TRIAL_CONFLICT_SUPERSEDED` alert.
- P6: an `active` read never lists invoices.

Replay on the same run:
- Opus T23-119 K1-K6 pass.
- C-673-4 is red at its final assertion only, as ruled.
- Opus T23-118: C-673-2 and both C-673-3 probes are red (open Cs). The 3 controls pass.

Builder run [37231152495](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37231152495) agrees (the Sol 673 probes pass).

### C-673-6 (new, C): a never-billed past_due/unpaid cancel does not void the open invoice first
- **Where:** `trial-conflict.service.ts:261-286`.
- **The gap.** Between the paid-invoice read (`none`) and the DELETE landing, a Stripe Smart Retry, or a client paying the open invoice, can charge. The DELETE then cancels a just-paid plan, and nothing alerts.
- **A second effect.** Stripe's cancel leaves `open` invoices open, with `auto_advance=false` ([Stripe cancel docs](https://docs.stripe.com/billing/subscriptions/cancel)). That also departs from the dunning 2A rule ("cancel during dunning voids the invoice").
- **Why it is a C:** the window is the in-flight DELETE only. Automatic collection stops on cancel. The round-9 code was strictly wider.
- **Fix rule:** for `past_due`/`unpaid` with `none`, void the subscription's open latest invoice first (`POST /v1/invoices/:id/void`). If Stripe answers `invoice_not_open` or paid, treat the plan as `charged` and supersede. Only after a successful void, DELETE.
- **Verify:** a probe where the void returns `invoice_not_open` sends no DELETE and supersedes.

### Carried Cs (FREEZE)
- **C-673-4:** the worker supersede does not re-sync access. The webhook comment at `checkout-webhook-handler.service.ts:974`, "past_due: no money taken yet", is now stale for the history case. Fix both on the #680 integration round, with the same probe.
- **C-673-1:** `billing.service.ts:674-686`. Post-commit trial work is awaited inside the webhook request.
- **C-673-2:** `checkout-webhook-handler.service.ts:925-934`. An older event rewrites an extended `trial_ends_at`.
- **C-673-3:** coach MRR and churn count never-billed trials. It is on the #680 list.
- **Closed:** C-673-5, together with B-673-1.

### CI and status
- At `904b9642`, all 10 applicable checks pass. deploy-readiness-gate is skipped. Merge state is CLEAN, and the PR is still a draft.
- Landing order: T1, then T2, then T3, then T4 #706 as one, after recurring.
- No source edits, no merge, no production action.
