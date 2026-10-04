AUDIT Claude Opus 5.5 — growth-project-backend#676 @ ccd60bbcb6b724534cfc69547c89a68c9af32901 — VERDICT: REQUEST CHANGES

A/B/C = 0/1/1 (C-676-1 / C-641-2 is carried on top and not counted)

Lens AUD-OPUS-CM-118 (agent 118), T4 (coach-visible money, tax CSV, recurring metrics). Piece M3 of #641. This verdict is independent of the builder and of the Sol lens.
- This lens's probe found the MRR defect below before Sol's verdict at this head ([5982716659](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/676#issuecomment-5982716659)) was read. It was first drafted as a C because no trial can be sold on main plus this stack.
- It is raised to B to stay consistent with this lens's own B-676-4 (the 117 round). That finding was the same ruling and the same never-billed-trial case, for churn, and was equally reachable only once trials exist.
- The finding uses Sol's id, B-676-5, so that one defect has one id. The evidence is this lens's own run.

**Evidence base (G09)**
- This lens's earlier work on this piece:
  - #641 APPROVE at fb29fb9e. The M3 code is largely byte-identical to it: guards, tenancy, currency scoping, lifetime totals and the landing pages.
  - A full audit at 564f33bf (116, RC 0/2/1).
  - A delta audit to cf5ef18b (117, RC 0/2/0, [5976743259](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/676#issuecomment-5976743259)).
- Read in this round: every M3 line of cf5ef18b..ccd60bbc.
  - `coach-money.service.ts` +213/-27: `BILLED_WHERE`, `ReversalPortion.source_id`/`event_at`, `MoneyOccurrence` and `loadOccurrences`, the `buildMoneyCsv` event keys, `exportTooLarge`, churn.
  - Tests: `coach-money-event-rows.spec.ts`, `coach-money-occurrence-rows.spec.ts` and the read double.
  - `coach-money-production-writes.spec.ts` moved byte-identically to #677.
- The M1 part is the #674 head f9e21a87, audited in this lens's #674 verdict at that head. It is not counted again here.
- The restack is merge-only: the ccd60bbc tree (e1919ab4) equals `git merge-tree --write-tree fbd6402c f9e21a87`. The base is the #674 branch at f9e21a87, and the merge is CLEAN.
- Probes ran in the CI lane on audit/AUD-OPUS-CM-118/676-probes, probe commit 914603c3 on this head (probe specs only): [run 37221623024](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37221623024). Result: 16 pass, 2 red, both as predicted. One is the composed C-674-12 case, which is counted on #674. The other is B-676-5.

**Prior findings from this lens, decided at this head**
- **B-676-3: CLOSED.**
  - Writer, in #674: every inline posting of one event carries the event's elected time (refund `posted_at`, dispute `closed_at`).
  - Reader: one row per event id and time (`eventKey`/`reversalKey`, coach-money.service.ts:931-936), with `client_refunded` only on the row at the event's own time (:948-950).
  - Every succeeded refund and lost chargeback of the coach's own sales seeds its row from the event itself (`loadOccurrences` :1284-1354; :937-943). A zero-portion refund therefore keeps its row.
  - `loadOccurrences` is scoped to `purchase.coach_user_id` = the authenticated coach and `source: null`. It filters by currency in the query and again after it, matching the seller slice scope. It is bounded at limit+1 per kind and fails closed with `MONEY_EXPORT_TOO_LARGE`.
  - The occurrence time expressions equal the writer's and `toTimed`'s (`posted_at ?? created_at`, `closed_at ?? updated_at`), so legacy proportional portions merge into the same row.
  - This lens's probe `audit-opcm1-117-676.spec.ts` passes unchanged (3a, 3b, 3c and the control) in run 37221623024.
  - The builder's failing-before runs: [37180008258](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37180008258) and [37187188812](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37187188812).
- **B-676-4: CLOSED.**
  - The churn query requires `BILLED_WHERE`: a paid status, or a posted or reversed destination slice (:1434-1435). Its top-level `OR` does not collide with any other key in that where.
  - A client holding any entitled purchase today, a trial included, is not churned (`heldIds` :1497-1500).
  - Status `trialing` rows (what the trials stack writes, checked on #673 df76889f) are not billed.
  - The churn case in this lens's probe passes unchanged, and so do the builder's plan-A-cancelled / plan-B-trialing cases.
- **B-676-1, B-676-2, C-676-2:** closed at cf5ef18b, with code unchanged. The 116 probe `audit-cm1-676-window-cents.spec.ts` passes unchanged in the same run.

**Composed checks at this head (writer + reader)**
- Two overlapping succeeded deliveries of one refund at the month's last millisecond, where the delivery without the ledger claim wins the head-coach record 1 ms later (see C-674-12 on #674). Control green in run 37221623024:
  - one Stripe reversal and transfer 98;
  - exactly one refund row with `client_refunded`, which sums to 9.80 across the March and April files;
  - `head_coach_share` sums to -0.98 and `net_to_you` to -8.62 across both files, exactly the ledger.
- Totals (`foldWindowTotals`) still come only from postings and slices. Occurrences add rows and `client_refunded` only, never a ledger cent.
- Copy: `MONEY_EXPORT_TOO_LARGE` text unchanged (no first person). The new code adds no log sink.
- Checks: 10/10 applicable checks green at this head. CodeQL, danger, banned casts and SBOM do not run on a stacked base; they run when the composed train targets main. deploy-readiness-gate skips by design.
- Size: +2,963/-18 = 2,981 against #674, and the operator SIZE ASSESSMENT is KEEP.

### B — must fix

#### B-676-5 (= this lens's C-676-4 candidate; id shared with Sol): MRR and `paying_clients` count a trial that never billed once its first invoice fails
- **Where:** `src/coach-money/coach-money.service.ts`.
  - The `active` query (:1404-1410) has no billed evidence.
  - The fold admits `past_due` (:1468, `MRR_SUBSCRIPTION_STATUSES` at :710), and `payingIds` takes every row that is not trialing (:1472-1474).
- **Ruling 10-03 (binding on this piece):** MRR and churned_30d exclude never-billed trials. A trial whose first charge failed is still never billed. During dunning it stays entitled with status `past_due`, which is what `invoice.payment_failed` writes.
- **Counterexample:** run 37221623024, `test/audit-opus-cm-118-676.spec.ts`. There is one billed subscriber (4,900, with a posted destination slice) and one post-trial `past_due` purchase that is entitled and has no paid status and no slice. Result: **MRR 9,800 and paying 2**, where the right answer is 4,900 and 1.
- **Minimal fix rule:**
  - Count a recurring row in MRR and `paying_clients` only with `BILLED_WHERE` evidence: a paid or active status, or a posted or reversed destination slice.
  - A never-billed `past_due` row counts neither. It may be shown next to trials.
  - A billed `past_due` renewal still counts.
  - Export `BILLED_WHERE` (:247; today it is private, and the exported `PAID_WHERE` is a different predicate), so that the C-673-3 integration imports the same rule rather than copying it.
- **Verify:** the probe case passes unchanged. Add a billed `past_due` renewal (it counts), a trial converted by its first paid invoice (it counts), and the existing churn cases unchanged.

### C (optional; to the operator's follow-up list under the freeze)
- **C-676-6 (the builder's C-676-x note, confirmed): a lost dispute with `closed_at` null is dated at `updated_at`** (:1187 and :1352).
  - `updated_at` moves on later writes, so a row lost by `charge.dispute.updated` and seen before its close can change month between exports.
  - Fix rule: date a lost dispute at its first lost status change (a stamped column), or backfill `closed_at` in a migration.
- **C-676-1 / C-641-2 (carried, not counted):** integrated fee, per-renewal, recovery and dunning-v2 acceptance when the train is composed. This is a release condition.
- **#674's B-674-13 and B-674-14** sit in the lower piece and are not counted here. The fix there changes this PR's base, so #676 needs a restack and a new verdict in any case.

**Next head:** approval needs B-676-5 closed with a test that failed before, the restack on the fixed #674, and the applicable checks green. Everything else decided above stays closed if its code is unchanged. No push, merge or dispatch to the PR branch by this lens.
