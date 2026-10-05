AUDIT Claude Opus 5.5 — growth-project-backend#676 @ 0ee4933d0f227991bde5e41c0a770b4887ec1957 — VERDICT: APPROVE
Job AUD-OPUS-CM8-120 (agent 120), FIX ROUND 5, exact-head review (restack on #674 e35c37a1 + B-676-5 fix).

A/B/C = 0/0/2

Scope:
- 0ee4933d is a clean merge. Its tree equals `git merge-tree --write-tree 296067fb e35c37a1` (5677317536f1).
- This piece's own diff is e35c37a1..0ee4933d (+2965/-19; 2,984 lines, under the 3,000 ceiling). It was compared file by file with its diff at the last Opus verdict (f9e21a87..ccd60bbc, RC 0/1/1, B-676-5). 19 of 21 files have byte-identical +/- content.
- The only changes since that verdict:
  - coach-money.service.ts:247 exports `BILLED_WHERE`, and :1410-1411 adds `OR: [{ status: 'trialing' }, BILLED_WHERE]` to the recurring `active` query (04b76b4d);
  - test/privacy/no-pii-in-logs.spec.ts drops the connect.service.ts legacy count (ratchet down only).
- CI at this head: all checks green (CI 37343097282).

## B-676-5 (this lens's 118 finding): closed
- coach-money.service.ts:1404-1412 now requires billed evidence for every non-trial entitled purchase in MRR and paying clients. Billed evidence is a paid status (PAID_PURCHASE_STATUSES 'paid', 'active'), or a posted or reversed destination slice. Trials stay apart (:1463-1467).
- `MRR_SUBSCRIPTION_STATUSES` is ['active', 'past_due'] (:710), so 'unpaid' is excluded. This matches main's access rule: subscriptionGrantsAccess, checkout-webhook-handler.service.ts:56, grants access for active, trialing and past_due only.
- A trial whose first invoice failed (past_due, no paid status, no slice) is out. A billed past_due renewal is in.
- Proof, lane B: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37350491962 (audit/AUD-OPUS-CM8-120/703-probes-1, b4182bf7 on 88940c3f):
  - the adapted replay of this lens's 118 probe is green, including its C-676-4/B-676-5 case and the composed C-674-12 month-edge case;
  - test/coach-money-billed-mrr.spec.ts is green (5 cases + the BILLED_WHERE export pin).
- The adaptation was diffed against the original probe. The only changed lines are marked store/double additions (TransferReversalOp table; transfer kind, settlement_id, reversal_seq; a Stripe list of the reversals it made). The assertions are unchanged. The original files time out only because their private store has no operation table.

## Dependency on #674
B-674-15 (#674, owner reconcile can drop a refund's head-coach posting) makes the Money reversal cents from this piece wrong on that path. The defect and its fix are in #674's handler; nothing in this piece's diff changes. The stack lands as one, so this APPROVE does not release #676 alone.

## C (follow-ups; carried, not blocking)
- C-676-6 coach-money.service.ts:1187, :1325 and :1352. A lost dispute with a null closed_at is dated at updated_at. Fix: stamp the first lost status, or backfill closed_at.
- C-641-2 / C-676-1 (release condition): integrated fee, per-renewal, recovery and dunning-v2 acceptance before the stack lands.

Head re-read immediately before posting: 0ee4933d0f227991bde5e41c0a770b4887ec1957.
