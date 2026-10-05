**Tier:** T4 (money path). **Why:** closes Sol B-673-1 as narrowed at #673 `dcf095b8` ([Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/673#issuecomment-5985038558)): a never-billed past_due/unpaid trial-conflict cancel voided only `status=open` invoices; an `uncollectible` invoice is still payable (Stripe allows uncollectible -> paid), so it could pay 4,900 minor units during paid-history preparation while the open one was voided, and the worker DELETEd a paid plan (paid access lost). **T4 trigger scan:** money (Stripe invoice void, subscription cancellation, lease fencing). No schema, migration, dependency, config or copy change. **T3 trigger scan:** none beyond T4. **Bounded T1:** none. **Canonical builder:** B-TR6-119 (agent 119). **Parent owner:** #656 via T3 #673; base `agent119/trials-split-4-tests` (T4 #706 `3d95f96e`). **Acceptance evidence:** failing-before and passing-after CI lane runs below; every prior trials probe replayed. **Promotion triggers:** none (already T4).

Split piece **T5** of the trials stack (T1 #671 -> T2 #672 -> T3 #673 -> T4 #706 -> T5 this PR). Opened after 12:33 PDT 10-04, so the 1,500-line ceiling applies: ****739 changed lines** (+711/-28; 6 files: 2 source +95/-21, 4 test +616/-7)**. The runtime fix lives here because #673 is at 2,999 of its grandfathered 3,000. #671-#706 are unchanged. Lands with #671-#706 as one (MERGE_DEPENDENCY_GUIDE rule 11); never retargeted or merged alone.

### Change
- `StripeConnectApiService.listUncollectibleInvoices` (`subscription`, `status=uncollectible`, `limit=100`), same shape as `listOpenInvoices`.
- `TrialConflictService.settle()` for `past_due`/`unpaid`: `readPayable()` reads the complete open page and then the complete uncollectible page, both **before** the paid list. `payableInvoiceIds()` accepts only `has_more: false` pages of non-empty string ids (deduplicated, open first); anything else is unknown.
- `voidPayable()` (replaces `voidOpen`): empty or unknown domain -> `invoices_unknown`; more than `TRIAL_CONFLICT_MAX_VOIDS` (10) -> `invoices_too_many`. Before each void and before the DELETE the lease is renewed by compare-and-set (`id` + `lease_token` + `owed`): a supersession, deletion webhook or takeover in between -> `stale` (no further void, no DELETE); a renewal whose round trip leaves no room for the next 20 s call -> `lease_exhausted`. Each void must answer `status: 'void'`, else `invoice_not_voided`. Every non-ok result sends no DELETE (retried; the next read supersedes a plan that paid).
- The fixed `(n+1) x 20 s` budget is replaced by the per-call renewal (same lines; this also closes the lease half of C-673-9: two or more payable invoices now settle).
- Trialing/incomplete/paused paths are unchanged (no invoice reads).

### Tests
`test/b-trials-6-payable-domain.spec.ts` (32 tests; real TrialConflictService + real StripeConnectApiService over an intercepted fetch, real CheckoutWebhookHandlerService for Sol's probe):
- Sol AUD-SOL-T3E-119 probe with its exact inputs (past_due/unpaid x open/uncollectible payer): no DELETE, `retry`, row `owed`, the delayed active webhook keeps paid access.
- Never billed (both statuses): open, uncollectible and paid lists, both voids, one DELETE, in that order; only-uncollectible domain settles; payment on the uncollectible invoice between its read and the paid read -> superseded, no void, one billed alert.
- 8 unknown uncollectible lists (500, 404, `has_more`, missing `has_more`, non-list data, null entry, numeric id, empty id) and 4 unconfirmed uncollectible voids (payment won, 200 paid, 200 uncollectible, 500): no DELETE.
- More than 10 payable invoices; renewal: three invoices after 35 s of reads settle and a second worker mid-sequence is `busy`; a slow renewal round trip -> `lease_exhausted`; supersession, deletion and takeover during the uncollectible read and during the uncollectible void -> `stale`, no DELETE.
- Controls (green before and after): an id on both pages is voided once; payment wins the open void; trialing control.
- `b-trials-5`: its world answers the uncollectible list (default complete empty page), the call-order control includes it, and the round-11 lease-budget test now asserts the renewal (two open invoices settle). `b-trials-4` conflictWorld and the `b-trials-3` stub answer the uncollectible list with an empty page.

| Round | Head | Failing-before | Passing-after |
|---|---|---|---|
| opening (B-TR6-119) | `ffed434e` | [run 37240926785](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37240926785): T5 tests + Sol's probe verbatim on the #706 `3d95f96e` source: 32 assertion failures, 65 green (0 TypeError/TS) | [run 37241269037](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37241269037): `tsc --noEmit` clean, every b-trials spec + Sol's probe verbatim 276/276; probes [run 37240966988](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37240966988) (see OPENING) |

Follow-ups (C) and the probe replay are in the OPENING comment.

