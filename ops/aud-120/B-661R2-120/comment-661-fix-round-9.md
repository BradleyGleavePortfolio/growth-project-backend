FIX ROUND 9 (B-661R2-120, agent 120) — growth-project-backend#661 @ e0cc97e150384d049823327b274ac47511ee952e

One commit, [e0cc97e1](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/e0cc97e150384d049823327b274ac47511ee952e), on `bc399edd` (fast-forward push, no rebase, no force). main `ee55f814` is unchanged; no merge needed. Size: 2,942 changed lines (+2,813 / -129, 17 files), under 3,000. Per the operator ruling, the source change is here and the tests are in #702 (head `b96611de95d7d5f31fd623a2a7a6b0f7d8a03db8`, RESTACK + FIX ROUND 2 comment there).

## Finding -> change -> commit -> test

| Finding | Change | Commit | Test (#702) |
|---|---|---|---|
| B-661-14 (Sol 5998892091) / B-661-15 (Opus 5999168270), one defect: the native first grant kept the spent first-invoice PaymentIntent or trial SetupIntent client secret and the ephemeral key at rest | `checkout-webhook-handler.service.ts:1654` (`applySubscriptionUpdated`) and `:2293` (`applyInvoicePaid`): `...(entitled ? CLEARED_PAYMENT_SECRETS : {})` in the existing grant update, under the package lock and the purchase row lock. The erase commits or rolls back with the state change. An attempt that grants nothing keeps both credentials: an unpaid first invoice (`incomplete`), a declined first attempt (`payment_failed`), and a trial without its own saved card (no default, or a default with the create-time end still set). | e0cc97e1 | `test/checkout-grant-credentials.spec.ts` G1, G2, G3, G3b, G5 (failed before); controls G4 x2, G6; live block `#661 credentials at rest on real PostgreSQL`: paid grant x2 events and carded-trial grant x2 events (failed before), unsaved-trial controls x2 |
| C-661-2 (operator ruling: the backfill covers subscription rows that already hold credentials; production ClientPurchase has 0 rows, so a no-op today) | `scripts/clear-spent-payment-credentials.ts` (new, 89 lines). Dry run by default; `--apply` erases in batches (default 500, max 5,000) and re-checks the predicate in each write; idempotent; logs counts only. It keeps every still-payable attempt: one-time (no subscription id) in `pending` / `payment_failed`, and a subscription attempt in `pending` / `incomplete` / `payment_failed` / `trialing` that is not entitled and never started a trial. Not a migration (migrations apply on deploy); the operator runs it. | e0cc97e1 | live `C-661-2 backfill`: 13 spent, 6 payable, 1 credential-free row; dry run `{13, 0, false}` and nothing changes; apply with batch size 4 `{13, 13, true}`, only the two credential columns of the 13 rows change; second apply `{0, 0, true}` |
| C-661-15 (Opus): no test pins the resolved end | Test only | - | H1a (paid plan deleted), H1d (carded trial deleted before a grant event) |
| C-661-13 (Opus, body stale) | PR body: status, owners, T4 scan, evidence, Not in this PR, Fix round 8 / refresh / Fix round 9 sections | - | - |

Why `entitled` gates the erase: it is the same `subscriptionGrantsAccess` result the write already stores in `entitlement_active`. The client never needs the sheet credentials after a grant: a replay answers `alreadyActive` before any credential read, `readCheckoutState` returns early for an entitled row, and `attachNativeTrialCard` returns ok for an entitled row. `lifecycleRevision` does not include the credential columns, so the compare-and-set and redelivery fences are unchanged. Known and accepted: the no-write paths (`invoice.paid` when nothing changed, `subscription_unchanged`) do not touch rows written before this fix; the backfill covers them.

## Evidence

| Check | Head | Result |
|---|---|---|
| Local unit spec (heavy.sh, one spec) | tests on `bc399edd` + script, fix absent | 5 failed (only `stripe_client_secret` / `stripe_ephemeral_key`) / 5 passed |
| Local unit spec | #702 `b96611de` | 10 / 10; ESLint clean on the handler; `check-r75.js` OK (range #661..#702 and main..#702) |
| Failing-before lane | tests on `bc399edd` + script, fix absent | [run 37348121187](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37348121187): `tsc --noEmit` green; 9 failed / 20 passed: exactly the 9 "(failed before)" cases, each only on the two credential fields; controls, backfill and all 12 existing live tests pass |
| After + both lenses' probes | #702 `b96611de` + probe commit `51f427cc` | [run 37348700674](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37348700674): `tsc --noEmit` green; 44 suites / 609 tests, 0 failed, 0 skipped |
| PR CI | #661 `e0cc97e1` | 11 / 11 required success (build-and-test 773 suites / 13,255 passed; mwb-3, rls, community live, CodeQL, R75, SBOM, danger, schema parity, npm audit); `deploy-readiness-gate` skipped |
| PR CI | #702 `b96611de` | 7 / 7 available required success (stacked base: CodeQL / R75 / SBOM / danger run only on main-based PRs); build-and-test 775 / 13,274; mwb-3 8 suites / 81 tests (the new live block's 7 included) |

## Probe replay (both lenses)

| Lens | Probe | Before (this round) | At `b96611de` |
|---|---|---|---|
| Sol 120 | `aud-sol-661d-120-composition.live.spec.ts`, byte-identical, SHA-256 `5beb8cae...` (four credential assertions + controls) | 4 failed ([37341623338](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37341623338)) | pass |
| Sol 120 | run 2 controls: composition + `partial-refund-decision.service` + `first-payment-webhook.integration` ([37342234566](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37342234566)) | pass | pass |
| Sol 120 | `aud-sol-661r5-postgres`, `aud-sol-661r6-selection.live`, `aud-sol-118-owner-boundaries.live` (byte-identical) | pass | pass |
| Sol 120 | run 1 regression list (35 retained specs incl. every `b-recur*` R1-R7 spec, handler, checkout, fanout, settlement) | pass | pass |
| Opus 120 | `aud-opus-661d-120-hunks.spec.ts` H1a-e, H2a-c, H3a-d, G1-G4 | G1-G3 failed ([37343688493](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37343688493)) | pass (H3d still records C-661-16, a C under freeze) |
| Opus 118 | `aud-opus-661-118.live.spec.ts` | pass | pass |
| Sol 116 / 117 | R3 `provider-snapshot`, R4 `settlement-acceptance` (minimal doubles; Sol 120 marked them superseded) | 4 failed at `9ddda117` ([control 37349960492](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37349960492)) | same 4 fail, same errors ([37349395486](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37349395486)): their doubles predate the round 4/5 purchase-version witness, so the prefetch returns no status and the decline is a fail-closed 503 `PAYMENT_FAILURE_RETRY`. Their cases are covered by `checkout-settlement-round5` and the live settlement spec, which pass |
| Opus 116 | `zz-aud661ci-hosted-probe` (DEFECT form) | 3 failed at `9ddda117` (same control) | same 3 fail, same error (`db.clientPurchase.findMany is not a function`; its double predates rounds 6 and 7). Its inverted form, `checkout-hosted-activation-once.spec.ts`, passes |

Round 9 changes only the two recurring grant writes; the legacy failures are identical before and after and are not counted as passing.

## Money list

- Webhook order / redelivery: whichever of `invoice.paid` / `customer.subscription.updated` grants first erases; the later one writes null again or nothing; neither restores the credentials or fans out twice (G2, live x2 events); a rolled-back event rolls back its erase.
- Concurrency / lock order: the erase is a field of the existing update under the package lock then the purchase row lock; no new lock, query or Stripe call. The backfill takes row locks only (one table), excludes every attempt the sheet can still write to, and re-checks its predicate in each write.
- Terminal states: refunded / disputed / chargeback_lost / canceled / expired rows: the end paths already erase (H1a, H1d); historic rows are in the backfill set. Deleted account: no change to that path.
- Pagination / fail-closed completeness: no Stripe list in this round. The backfill pages by id with a bounded batch and stops on a short page; a crash leaves a rerunnable, idempotent state.
- Currency / minor units: no amount, currency or fee is read or written.
- Copy truth: no copy or reply code changes. C-661-13 (Sol) / C-661-14 (Opus 118) copy items stay follow-ups.

## Follow-ups (C), not fixed under the freeze

- C-661-13 (Sol): `src/checkout/checkout.service.ts:87-96,128-144` completed-payment copy promises access without proving entitlement. Rule: entitlement-neutral copy, or check access first.
- C-661-14 (Opus 118): `checkout.service.ts:89` puts `trialing` / `past_due` in `PAID_STATUSES` ("already complete" for a free trial). Rule: resolve with C-661-13.
- C-661-16 (Opus): `checkout-webhook-handler.service.ts:1096-1124` `prefetchFailedPaymentIntentStatus` reads Stripe for a settled native row. Rule: return `{}` when `billing_type === 'recurring' && stripe_subscription_id`.
- C-661-17 (Opus): `:1885-1888` settlement bump also bumps active native rows. Rule: add `billing_type: { notIn: ['recurring'] }, stripe_subscription_id: null`.
- C-661-18 (Opus): `checkout.service.ts:544` recurring guard precedes the `pi-` replay at `:567-577`. Rule: classify a finished `pi-` row before the guard.
- C-661-10 (carried): PaymentIntent association release and `stripe_payment_intent_id` index (migration). C-656-1: trials release prerequisite, unchanged.

## Operator decisions (recommended default first)

- D1: run `npx ts-node scripts/clear-spent-payment-credentials.ts` (dry run), then with `--apply`, in the deploy window after #661 + #702 land. Default: yes, approval-only; it is a no-op today (0 rows).
- D2: land #661 and #702 together (rule 11) after both lenses approve both exact heads. Default: yes.

READY FOR AUDIT
