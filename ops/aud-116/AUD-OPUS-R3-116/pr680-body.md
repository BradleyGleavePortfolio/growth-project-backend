**Tier:** T4
**Why:** money path: native Stripe subscriptions and trials (create, bind, retire and cancel unpaid attempts); client data in logs.
**T4 trigger scan:** money yes (Stripe subscription create/cancel, attempt lifecycle); auth/tenancy: client-scoped purchase rows, unchanged; privacy yes (log lines carry ids and allow-listed labels only); health data no; deletion no; migrations: none in this piece (R1 carries them); CI gate files no.
**T3 trigger scan:** n/a (T4).
**Bounded T1:** none.
**Canonical builder:** B-RECUR-116 (agent 116) for fix round 3; earlier B-RECUR-3 (agent 115), B-RECUR-BE (agent 114).
**Parent owner:** operator agent 116.
**Acceptance evidence:** failing-before CI lane [run 37172350469](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172350469) (19 failed / 1 passed); after: required checks green at the head; local 8 b-recur suites 153/153.
**Promotion triggers:** n/a (already T4).

Split of #654 (native recurring subscriptions with card-on-file trials, 6,090 lines at `02c48de7`) under the owner's PR size rule: over 3,000 changed lines is an automatic fail (MODEL_ROUTING.md 8.2, tgp-agent-context). #654 is stacked on #627 and was behind #627's head; it was merged with #627 @ `66162285` locally (clean) and cut from that tree. Stack: #627 -> R1 -> R2 -> R3; merge back to back after #627, deploy only after R3 together with mobile #334. Owner adds the Stripe webhook event `setup_intent.succeeded` before that deploy. The tree at R3 equaled the refreshed #654 at the split; since fix round 3 it is #654 plus that round (#654 is superseded). Prior verdicts on #654 (Opus APPROVE 0/0/3 at 02c48de7) do not carry. An unposted Sol draft REQUEST CHANGES 0/3/0 at 02c48de7 (resend after Stripe's 24-hour key window can create a second subscription; error label logging; a failed cancel marks a payable attempt expired) is recorded in tgp-agent-context handoffs/op-115/reports/AUD-SOL-MONEY-115.md and AUD-SOL-MONEY-2-115.md; those findings land in R2/R3; fix round 3 (B-RECUR-116) closes them in R2 (#679) and R3 (#680). Each piece needs fresh Opus 5.5 and Sol audits at its exact head (T4, money path). `tsc --noEmit` passes at every piece. When #627 merges, retarget R1 to main (CodeQL, danger, banned casts and build-sbom then run).

**R3 (base R2, 2,914 lines after fix round 3):** native subscription webhook handling (setup_intent.succeeded, trial card, invoice paths) and the webhook, fix-round 1 (+http, +trial card) and fix-round 2 specs. Local: all seven b-recur suites 133/133.

### Fix rounds
| Round | Head | Findings | Comment |
|---|---|---|---|
| 1-2 (agents 114/115, on #654) | 795110b7, 02c48de7 | B-654-1..7, C-654-2..4 | [#654 FIX ROUND 2](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/654#issuecomment-5971989117) |
| 3 (B-RECUR-116) | 2b10687c | restack of #679 958806d1; B-654-9 / C-654-10 handler log lines; tests test/b-recur-116-fix-round-3.spec.ts (20 cases) | [5976054570](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/680#issuecomment-5976054570) |

