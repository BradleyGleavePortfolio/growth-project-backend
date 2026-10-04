AUDIT GPT-6.1 Sol — growth-project-backend#676 @ ccd60bbcb6b724534cfc69547c89a68c9af32901 — VERDICT: REQUEST CHANGES

A/B/C = 0/1/1

Lens AUD-SOL-CM-118, agent 118. Independent T4 review of the complete M3 read/query/fold/CSV/recurring boundaries, source-event occurrence delta, self-only controllers/guards, Connect refresh/redaction/payout copy, fixed-target public landing, module wiring, changed tests and lower-piece restack. [Exact head and round 3](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/676#issuecomment-5982571192)

## Prior findings and evidence applicability

No original #641 Sol APPROVE is inherited wholesale; prior evidence is reused only on bounded unchanged inputs, with original same-model history/event/churn/privacy acceptance assertions freshly re-executed independently on this head. [Previous Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/676#issuecomment-5977398126) [Fresh independent lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37221311111)

- **B-676-3 closes on the reported CSV event-completeness boundary:** succeeded refunds/lost disputes are queried independently of positive ledger cents, scoped to the authenticated seller/charge/currency and bounded with limit+1; original zero-portion, same-millisecond ids, inline latency, later recovery and historical-cent controls pass, as do new foreign-coach/wrong-currency/won/source-grant and lost-dispute overflow controls. [Independent exact-source execution](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37221311111) [Attributable failing-before CSV assertions](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37187188812)
- **B-676-4 remains closed on the canceled-never-billed trial/churn and still-entitled-other-trial boundaries; B-676-1/2 and C-676-2 remain closed on historical postings, refresh/privacy and app-owned payout-reason boundaries.** [Current unchanged assertion controls](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37221311111)
- Lower-writer B-674-12 first-close/first-success fixes have exact-head live DB evidence, and the M3 restack's tree equals the automatic merge tree with no conflict edits; M3 imports no M4 code or additional migration. [Inherited exact-head live tests](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37219238715/job/111486006108) [Restack evidence](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/676#issuecomment-5982571192)

## B — must fix

### B-676-5 — a never-billed trial is reported as paying MRR when its first invoice fails

**Where:** `src/coach-money/coach-money.service.ts:1404–1426,1455–1474`: active selection requires entitlement/positive listed amount but carries no billed evidence; the fold includes every `past_due` subscription and every non-`trialing` client as paying. [Exact current recurring implementation](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/ccd60bbcb6b724534cfc69547c89a68c9af32901/src/coach-money/coach-money.service.ts)

**Executed actual writer→reader counterexample:** an entitled 4,900-cent trial has no paid destination/other money posting and initially reports MRR/paying **0/0**; the real current `CheckoutWebhookHandlerService.handle(invoice.payment_failed)` writes `past_due` while retaining its entitlement, then this Money reader reports MRR/paying **4,900/1**, although the client has never paid. [Composed exact-source assertion](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37221311111)

Adding a distinct genuinely previously billed past-due client yields **9,800/2**, rather than the correct **4,900/1**; canceled-trial churn controls still pass, so this is a distinct pre-churn never-billed membership gap, not reopening their closed assertion. [Executed billed-dunning control and 100 passing controls](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37221311111)

**Minimal fix rule:** require durable billed evidence for MRR/paying membership, not just an entitled positive-price/nontrial current status; keep active free trials separately counted and retain previously billed past-due renewals. Export/reuse the corrected billed predicate so the operator's C-673-3 integration can use the same rule.

`BILLED_WHERE` at `coach-money.service.ts:247–252` is currently private; exported `PAID_WHERE` is a stronger, different predicate, so the supplied shared-billed-predicate dependency is not available as stated. [Current predicate declarations](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/ccd60bbcb6b724534cfc69547c89a68c9af32901/src/coach-money/coach-money.service.ts)

**Verify:** retain `test/audit-sol-cm-118-occurrence-boundaries.spec.ts`'s actual first-invoice-failure assertion and billed-dunning control; cover zero-dollar trial invoice, first successful conversion, canceled-before-billing, mixed clients/another entitled trial, currencies/cadences and a composed C-673-3 consumer. [Builder-ready failed acceptance assertion](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37221311111)

## C — carried integration release condition

**C-676-1 (= C-641-2):** `coach-money.service.ts:314–359,542–611,1392–1399,1564–1812` requires exact combined fee/per-renewal/recovery/dunning-v2/card-update send-record acceptance when the train is composed; this remains a release condition, not a duplicate blocker for another PR's implementation. [Current read contracts](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/ccd60bbcb6b724534cfc69547c89a68c9af32901/src/coach-money/coach-money.service.ts) [Carried integration disposition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/676#issuecomment-5977398126)

## CI, scope and proof limits

Independent lane `37221311111`, execution SHA `00a7877d1ca9beed8cf6ae358dfd634532cb42c8`, executes **1 new failed acceptance assertion / 100 passing controls** over unchanged candidate implementation plus audit/test copies and the approved one-job workflow/manifest; the two new occurrence-query controls also passed separately before the billing probe was added. [Billing-boundary lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37221311111) [Occurrence-only lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37221204001)

Applicable candidate checks are green, but CodeQL/danger/banned-casts/SBOM are absent on the stacked non-main base and must execute on the final main-targeted composition; size is **2,981 changed lines**, under the hard cap and in the operator assessment band. [Exact candidate CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37219238715) [Size/stacked-gate evidence](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/676#issuecomment-5982571192)

New accounting/query proofs use real writer/read services over stateful database/synthetic provider doubles; M3 guard assurance is source tracing, not a live auth-provider/device or release acceptance claim. [Attributable accounting execution](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37221311111)

Lower-piece B-674-13/14 are not duplicated in this PR's counts; default is to fix M1 first, close B-676-5 in M3, restack the Money train, and obtain fresh dual verdicts plus all main-only gates before landing.
