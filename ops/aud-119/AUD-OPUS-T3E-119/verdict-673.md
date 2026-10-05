AUDIT Claude Opus 5.5 — growth-project-backend#673 @ dcf095b85f74478f44e1a090f2a93cbbd1c6d496 — VERDICT: APPROVE

A/B/C = 0/0/7

Agent 119 · AUD-OPUS-T3E-119 · T4 delta audit (money path) of FIX ROUND 11 against this lens's APPROVE at `904b9642`.

**Evidence reuse (G09).** The approval at `904b9642` stands for everything outside fix commit `dcf095b8`. Parent is `904b9642`, and that one commit is the whole delta: 3 files, +67/-15. `stripe-connect-api.service.ts` gains `listOpenInvoices` and `voidInvoice`. `trial-conflict.service.ts` changes `settle()` and adds `readOrNull` and `voidOpen`, and `trialPaidHistory` gets the C-673-7 change. `b-trials-3-fix-round.spec.ts` gains a 2-line stub. All of it was read in full, together with its callers and with the webhook handler's owed-conflict branch (`checkout-webhook-handler.service.ts:958-976`). Size is 2,999 (+2,991/-8), under the grandfathered 3,000 ceiling with no headroom left.

**Prior findings decided**
- **Opus C-673-6 (void before cancel): CLOSED.** For a never-billed past_due/unpaid plan, `settle()` reads the open list, then the paid list, then checks ownership. Only a complete, non-empty page with string ids is accepted, and (n+1)x20 s must fit before the lease ends (`voidOpen`, `trial-conflict.service.ts:449-464`). Each invoice must come back with `status: 'void'`. Ownership is checked again before the DELETE (`:288`). The failing-before run is 37236196278 (36 assertion failures, no type errors); the after run is 37237173197.
- **Sol B-673-1 (narrowed, paid-conversion race): this lens agrees it is closed.**
  - A payment before the open read shows up in the paid list, which is read later, so the plan is superseded.
  - A payment between the two reads shows up in both lists, so the plan is superseded.
  - A payment after the paid read makes its void fail (`invoice_not_voided`), so the plan is retried and the next read supersedes it.
  - After a confirmed void, the invoice cannot be paid.
  - Sol's exact probe is in #706 `b-trials-5` and is green.
- **Sol C-673-7: CLOSED.** `trialPaidHistory` returns `none` only when `amount_paid === 0` and `total === 0` on a complete page. Negative, NaN, string, null or missing amounts give `unknown` (`:94-95`).

**Money list**
- **Replay:** a settled row returns `not_owed` and makes zero Stripe calls (Q6). A void that timed out locally but landed at Stripe leads to a retry, then to a supersede (C-673-8).
- **Concurrency:** a second worker during the void gets `busy`; there is one void and one DELETE (Q9). A supersede, a deleted webhook or a lease takeover during any added await vetoes the DELETE (b-trials-5).
- **Bounded:** every Stripe call goes through `withDeadline` (20 s), and the lease budget is checked against the real elapsed time. With 25 s of reads and one invoice, the result is `lease_exhausted` with no void (Q2). With 15 s of reads, the void and the DELETE go ahead (Q2b).
- **Fails closed** in each of these cases, with no void and no DELETE:
  - `has_more`, an empty page, a malformed page, a non-string id or a null entry (Q3);
  - a failed list;
  - a failed paid list while the open list is fine (`history_unknown`, Q4);
  - any void reply other than `status: 'void'`, including a 404, which is never read as already cancelled.
- **Logs and Sentry:** fixed codes only (`invoices_unknown`, `lease_exhausted`, `invoice_not_voided`). A Stripe message never reaches the tags (Q10).
- **Currency:** amounts are compared only as `> 0` or `=== 0`, which holds for minor units and zero-decimal currencies.

**Probes (CI lane, exact head + probe specs only):** run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37238544583
- New `audit-opus-t3e-119-673.spec.ts`: Q1-Q10 plus Q2b, 11/11 green.
- Replays:
  - T23D-119 P1-P6: green.
  - T23-119 K1-K6: green; C-673-4 is red, as ruled.
  - T23-118: C-673-2 and C-673-3 (x2) are red, as ruled.
  - `b-trials-3`: green.
- Totals: 78 pass and 4 fail; all 4 are the ruled C reds.

**Follow-ups (C), not blocking**
- **C-673-8 (builder, rated C, agreed):** `trial-conflict.service.ts:285-296` and `checkout-webhook-handler.service.ts:966-972`.
  - Voiding the last open invoice moves the plan to active. If the DELETE then fails, Q1 pins the result: the next read gives `billed`, the plan is superseded, and a false "offer a refund" alert goes out. If the void-driven active webhook commits during the DELETE, the outcome is benign: the plan is cancelled anyway and the alert is false.
  - No client money is taken. The cost is at most one unpaid period, and only in the DELETE-failure case.
  - Fix rule: persist void intent on the row under the lease before the first void. The webhook and the next settle then treat active + intent + a complete $0 paid history as never billed. Do this in the #680 round with C-673-4.
- **C-673-9 (builder, rated C, agreed):** `voidOpen` `:457-458`.
  - With two or more open invoices the result is always `lease_exhausted`. Uncollectible invoices are neither listed nor voided (Q7 pins this). Both cases fail closed: retry, then the cancel-failing alert after 3 attempts.
  - Fix rule: renew the lease by CAS before each void; list `status=uncollectible` too.
- **C-673-10 (new, outside this diff):** `trial-conflict.service.ts:71,119-123`. `incomplete` is treated as unbilled, so it is cancelled with no void. That is unreachable for a trial subscription today, because Stripe creates trials as `trialing`.
  - Fix rule: move `incomplete` to `HISTORY_STATUSES`, or void its open first invoice the same way.
- **Carried unchanged:** C-673-1 (#680 integration), C-673-2 (`checkout-webhook-handler.service.ts:925-934`), C-673-3 (#680 list), and C-673-4 (worker supersede without an access re-sync; the comment at `:974` is stale).

**CI at this head:** 10 applicable checks pass and deploy-readiness-gate is skipped. Merge state CLEAN, draft.
