FIX ROUND 2 (B-TR7-120, agent 120) — growth-project-backend#707 @ 8fc2660b9942b2c6f315186351716a31b6ec9bc5

**Tier:** T4 (money path). Fixes B-707-1 from both lenses ([Sol RC](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/707#issuecomment-5985426719), [Opus RC](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/707#issuecomment-5985519108)), both read in full. FREEZE: only B-707-1; C-707-2/3/4 are follow-ups (not folded; Opus P1, which pins C-707-3's latest-first void order, is still green). Fast-forward `ffed434e..8fc2660b`, base `agent119/trials-split-4-tests` (#706 `3d95f96e`, unchanged). **Size: 1,246 changed lines** (+1,217/-29, 7 files; source +175/-22, tests +1,042/-7), under the 1,500 rule. No schema, migration, dependency, config or copy change.

**Restack:** not done in this round. The #671 main refresh (`ea7a9740`) and the #672 restack (`b0654c80`) are pushed; the #673 restack stopped because main's recurring #678 conflicts with #673 in `src/checkout/checkout-webhook-handler.service.ts` (6 hunks) and `src/billing/billing.service.ts` (2), which changes #673's diff (job rule: stop and tell the operator). #673, #706 and this PR keep their bases and diffs.

### Deviation from the Opus fix rule (operator-visible)
Opus rule step 2 says DELETE each draft (`deleted: true`). Stripe forbids that for a subscription's invoices: "once an invoice has been finalized or if an invoice is for a subscription, it must be voided" ([Delete a draft invoice](https://docs.stripe.com/api/invoices/delete)). A DELETE of a renewal draft always fails, so that rule would retry forever. The fence is therefore finalize with `auto_advance=false` ([Finalize an invoice](https://docs.stripe.com/api/invoices/finalize): no automatic collection while false), confirmed same id and `status: 'open'`, then void ([Void an invoice](https://docs.stripe.com/api/invoices/void)), confirmed `void`. It has the same property as the rule's failed delete: any failure means retry with no DELETE, and a draft that finalized meanwhile is read as open or paid next time. It also meets Sol's rule: draft coverage is complete before the paid list, and nothing can still finalize or charge when the DELETE goes out.

### Finding -> change -> commit -> test
| Finding | Change | Commit | Test |
|---|---|---|---|
| B-707-1: a renewal invoice still `draft` is in neither page (`trial-conflict.service.ts:281-307, 521-524` at `ffed434e`) | `readPayable()` reads a complete `status=draft` page **first** (new `StripeConnectApiService.listDraftInvoices`, same page rule: `has_more: false`, array, non-empty string ids), then the open, uncollectible and paid pages. Unknown -> `invoices_unknown`, no finalize, no void, no DELETE | `8fc2660b` | `b-trials-7` "draft page unknown" x8; lenses' race x4 |
| same (fence) | `voidPayable()`: each draft not also on the open/uncollectible pages is finalized (`finalizeInvoice`, `auto_advance=false`; confirmed same id + `open`, else `draft_not_fenced`) and voided (confirmed `void`, else `invoice_not_voided`) **before** the other voids. Every Stripe call runs on a CAS renewal (`id` + `lease_token` + `owed`). Drafts count toward `TRIAL_CONFLICT_MAX_VOIDS` (10) | `8fc2660b` | happy path x2 (call order), finalize not confirmed x5 (500, already finalized 400, 200 still draft, 200 another id, 200 paid), payment wins the finalized draft before its void, 10 drafts + 1 open -> `invoices_too_many` |
| same (window after the voids) | Recheck before the DELETE: the draft, open and uncollectible pages again (an id not fenced -> `invoices_changed`; unknown/incomplete -> `invoices_unknown`; an id fenced here is void and final, so tolerated), then the paid page (`charged` -> `billed`, settled as `superseded` with `billing_started` and the billed alert; unknown -> `history_unknown`) | `8fc2660b` | recheck x7 + 1 control; Opus D1 shape (draft absent from the first page, paid during the open void) -> superseded, billed alert, no DELETE |
| same (ownership) | Ownership on every added await | `8fc2660b` | supersession, deletion webhook and lease takeover during the draft read, the finalize, the draft void and the recheck -> `stale`, no DELETE (12 cases) |
| Existing suites | `b-trials-3..6` worlds answer the draft list; the call-order assertions include the draft read and the recheck | `5394908a` | b-trials-3/4/5/6 green |

`test/b-trials-7-draft-fence.spec.ts`: 44 tests with a real TrialConflictService and a real StripeConnectApiService over an intercepted fetch, plus the real CheckoutWebhookHandlerService for the lens races. 40 are red before and green after; 4 controls are green both times.

### Runs
- **Failing before:** [lane 37342832376](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37342832376) runs the round-2 tests and both lenses' draft probes against the `ffed434e` source. Result: **48 assertion failures, 145 green** (0 TypeError, 0 TS): b-trials-7 40/44 red, the b-trials-5 call order 3 red, the b-trials-6 call order 2 red, Sol draft race 2/2 red, Opus D1 red (D2 green).
- **Passing after:** [lane 37342940525](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37342940525) runs `8fc2660b`, all 13 b-trials suites, 15 lens probes verbatim and 6 one-line adapted copies, plus `tsc --noEmit`. tsc is clean. 435 pass, 43 red, and every red is classified below.
- **PR CI at this head:** all 10 required checks are green, and deploy-readiness-gate is skipped. That includes [build-and-test](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37344223473/job/111878640221), [Schema parity](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37344223419/job/111878642758), the rls/community/mwb-3 live tests, rls-floor-guard, npm audit and size-label.

### Probe replay (both lenses, at this head, lane 37342940525)
Adapted copy = the lens file plus one line that answers the new `status=draft` list with a complete empty page. Lens fixtures do not route that list, so verbatim files fail closed (`retry`, no DELETE). That is a fixture mismatch, not a behaviour regression.

| Lens | Probe | Verbatim | Adapted |
|---|---|---|---|
| Sol | AUD-SOL-T5-119 draft race (`707-draft-race`) | **pass 2/2** (red 2/2 before) | n/a |
| Sol | AUD-SOL-T5-119 T3E replay | 4 red (fixture: the open GET never happens because the draft read fails closed; paid access kept) | **pass, all** |
| Sol | AUD-SOL-T3E-119 payable race | 4 red (same fixture) | **pass, all** |
| Sol | AUD-SOL-T23D-119 payment race, T23D replay, T23-119 probe | **pass** | n/a |
| Sol | AUD-SOL-T23-118 conflict probe | 1 red, ruled (late-row lease), unchanged | n/a |
| Opus | AUD-OPUS-T5-119 draft D1/D2 | D1 red (fixture: fails closed before the race fires), D2 red | **D1 pass**; D2 red by design (pins the old `cancelled` result; Opus asked for it to be rewritten, and the new behaviour is the b-trials-7 D1-shape test) |
| Opus | AUD-OPUS-T5-119 P1-P10 | 7 red (fixture) | **pass except P8**, which pins "drafts are outside the read domain" (B-707-1 itself). P1 (C-707-3 pin) green |
| Opus | AUD-OPUS-T5-119 T3E replay | 5 red (fixture) | **pass, all** |
| Opus | AUD-OPUS-T3E-119 original / B-TR6 adaptation | 6 / 6 red (fixture) | Q2, Q7 red: retired by Opus in its T5 verdict, the same 2 as at `ffed434e` |
| Opus | AUD-OPUS-T23D-119 | **pass** | n/a |
| Opus | AUD-OPUS-T23-119 / T23-118 | 1 / 3 red, ruled (C-673-4; C-673-2, C-673-3 x2), unchanged | n/a |

### Money-list self-check
- **Webhook order/redelivery:** no handler change. `invoice.finalized`/`invoice.voided` are not handled on this branch or on main. A delayed active event after a fenced draft paid finds the row superseded through the paid recheck, with the billed alert. Deletion redelivery is unchanged.
- **Concurrency and lock order:** every finalize, void, recheck read and the DELETE runs on a CAS-renewed lease (`id` + `lease_token` + `owed`). No new DB lock, and lock order is unchanged. Supersession, deletion or takeover at every added await gives `stale` with no DELETE (12 tests).
- **Terminal states:** a void is final. An invoice that was finalized but not voided stays `open` with `auto_advance=false` (no automatic collection), and the next attempt voids it from the open page. The outcomes are cancelled, superseded (`billing_started`), retry (`draft_not_fenced`, `invoice_not_voided`, `invoices_changed`, `invoices_unknown`, `history_unknown`, `invoices_too_many`, `lease_exhausted`) and stale.
- **Pagination/fail-closed completeness:** the draft, open, uncollectible and paid pages must each be complete (`has_more: false`, array, non-empty string ids, limit 100). Anything else sends no DELETE. More than 10 fenced invoices -> `invoices_too_many`. Empty open+uncollectible -> `invoices_unknown` (B-TR6 rule, unchanged).
- **Currency/minor units:** no amounts are computed. Paid history is unchanged (`amount_paid > 0` = charged). A finalize that returns `paid` ($0 or credit-funded draft) -> `draft_not_fenced`, retry, and the next read classifies it. This system never creates customer balance credits.
- **Copy truth:** no user-facing copy change. The billed alert text is unchanged, and the new codes are server log codes only.

### Follow-ups (C), not folded
- C-707-2 (`trial-conflict.service.ts:439-448`, void loop in `voidPayable`): a partial void loses one period's billing. Fix rule: persist void intent and ids under the lease and include them in the billed alert, together with C-673-8.
- C-707-3 (void order `:439-448`, read order `readPayable` `:572-585`): the latest invoice is voided first and can supersede early. Fix rule: void older invoices first and `latest_invoice` last, immediately before the final renewal and the DELETE.
- C-707-4 (`payableInvoiceIds` `:560`, `trialPaidHistory` `:103`): a partly paid invoice cannot be voided, so the worker retries forever. Fix rule: carry `amount_paid`, and treat > 0 as charged.

READY FOR AUDIT
