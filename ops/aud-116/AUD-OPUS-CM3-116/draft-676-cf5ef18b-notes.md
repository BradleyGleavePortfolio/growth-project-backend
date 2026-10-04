# DRAFT (not posted): AUD Claude Opus 5.5 notes on backend#676 @ cf5ef18b6d6f892ce6d7b975539f4ea31730286e

This is a draft only. No READY FOR AUDIT comment was posted yet at 04:01 UTC: the PR is a draft, with checks at pass=7, pending=3, skipping=1. These notes come from reading code only. None of them has been checked with a CI-lane probe yet.

## Closed by reading the code (needs a probe to confirm)
- **B-676-1:** the per-event SplitLedgerReversal postings look correct.
  - The writer (#674 split-ledger.service.ts applyReversal) posts the actual CAS increment. It does this in the same transaction and once per (entry, kind, source).
  - Refunds post at ChargeRefund.posted_at. Disputes post at closed_at.
  - The reader (#676 coach-money.service.ts:423-473 allocateReversal) uses postings as they are. It splits only the legacy unposted cents, and only across events that have no posting.
  - The candidate filter includes reversal_postings.some.posted_at (:992).
  - RLS is deny-all, but Prisma connects as the BYPASSRLS service_role, so the reader can read the rows.
- **B-676-2:** refreshStatus at coach-connect.service.ts:251-257 now logs a closed code and the error class only.
  - The other err.message lines (:362 listPayouts, :573 refreshReadiness) are in main code, outside the diff. They are C at most.
- **C-676-2:** payoutReason at :138-180 uses a closed copy map with the regex ^[a-z_]{1,64}$ and a hasOwnProperty guard.
- **MRR ruling:** MRR_SUBSCRIPTION_STATUSES = active, past_due (:665).
  - Trialing subscriptions are counted after the currency filter and go into trial_clients / trial_mrr_cents. paying_clients excludes trialing.
  - Trial rows carry amount_cents = renewalCents (#680 subscription-checkout.service.ts:742), so they pass the amount_cents > 0 filter.
  - new_clients_30d uses PAID_WHERE, so it excludes trialing.

## Candidate new findings (NOT yet probed)
- **Candidate B-676-3 (regression from the B-676-1 fix): the tax CSV can double-count client_refunded.**
  - #674 transfer-orchestrator.service.ts:298 posts the head_coach_split slice at `new Date()` when the reversal is recorded, after the Stripe call. It does not use the event time.
  - buildMoneyCsv (:866-876) keys each reversal row on p.at. So a refund on a sale with a head-coach split produces two "refund" rows in the seller's CSV: one for destination/fee and one for head_coach_share. Each row sets client_refunded to the full refund amount.
  - At 564f33bf, every slice was allocated to the event's time, which gave one row.
  - The builder's #677 test runs with frozen fake time, so it cannot catch this.
  - **Probe to run:** in the reverseTransfer mock, advance the system time by 1 s. Then assert that the seller's CSV has exactly one refund row per event and that the sum of client_refunded equals the event amount.
  - **Fix rule:** pass the event's own time in ledger_source.at for head-coach postings (#674). Alternatively, key reversal CSV rows by (kind, source_id) and set client_refunded once per event (#676).
  - **Severity:** B if the probe confirms it. Head-coach transfers are not live in production (0 Connect accounts).
- **Candidate C (churn after the trial ruling):**
  - churned_30d counts a cancelled trial that never billed as churn.
  - Since payingIds now excludes trialing, it also counts a client who cancelled plan A but is still trialing plan B (recurring() :1244-1346).
  - **Fix rule:** count a cancellation as churn only if the purchase billed at least once and the client holds no other entitled purchase, including a trial.
- **Candidate C (legacy split):**
  - Legacy unposted cents are re-split when a later event posts 0 cents on that slice, because the floor portion is 0. This can shift an earlier window, but only for rows created before #674.
  - This is very unlikely in production (0 Connect accounts).
- **Note:** the docstring at :411-422 still describes only the proportional split. This is cosmetic.

## Evidence to gather on resume (CI lane, commit probe first)
1. /home/user/workspace/ops/aud-116/AUD-OPUS-CM1-116/audit-cm1-676-window-cents.spec.ts, unchanged, at the head.
2. A new probe: 3 windows and 4 events (333, 1, 777 cents, then a lost dispute and a redelivery).
   - Earlier windows and their CSVs never change.
   - Lifetime equals the sum of the windows equals reversed_cents.
   - The sum of postings equals reversed_cents.
3. Legacy mix: a refund with no posting, then a posted refund. W1 stays unchanged.
4. Head-coach CSV with +1 s Stripe latency (candidate B-676-3).
5. MRR/trial/churn matrix: active, trialing usd, past_due, trialing gbp, cancelled plus trialing, cancelled trial, and one-time.
   - Expected: mrr 5900, paying 3, trial_clients 2, trial_mrr 5800. Record the churn value (expected 2, which documents the C).
