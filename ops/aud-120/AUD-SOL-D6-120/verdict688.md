AUDIT GPT-6.1 Sol — growth-project-backend#688 @ 21714f7bba299336cf71df0c87288c798fd5da13 — VERDICT: APPROVE
A/B/C = 0/0/1

Independent T4 lens AUD-SOL-D6-120, agent 120.

## Prior findings first

The prior Sol B-688-6 historical-lost-dispute replay and B-688-7 PostgreSQL null-order/cardinality boundary are closed: the former derives applicability from the preserved obligation/current cycle, and the latter filters eligible purchases before the cap with explicit DESC NULLS LAST. [Prior Sol findings](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5982357473) [Fix round](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5982966284) [Independent current replay](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37349210308).

Prior Sol B-688-1 through B-688-5 remain closed at their original boundaries: current replay covers ABA/paid-meanwhile, sweep fairness, durable per-channel receipts, restricted diagnostics and lost-obligation protection; the moved fixture/regression boundary is additionally executed on #704. [D2a audit lane, 71/71 passing](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37349210308) [D2b audit lane, 51/51 passing](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37349207076).

**C-680-18 hard obligation closed on the composed service:** `src/checkout/dunning-v2/dunning-v2.service.ts:979–995,1048–1060` checks the purchase under DunningState then ClientPurchase locks and refuses every ended/revoked status without access; controls still recover ordinary paid dunning, and parity with `purchaseHasEnded` is tested. [Guard commit](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/21714f7bba299336cf71df0c87288c798fd5da13) [Builder failing-before run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37343244840) [Independent after run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37349210308).

No prior Sol APPROVE is inherited; the service and four-file piece were reviewed independently, including eligibility, UTC cadence, step/outbox CAS, redelivery, scoped recovery, bounded sweep fairness, minor-unit formatting and fail-closed purchase resolution. [Exact candidate](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/21714f7bba299336cf71df0c87288c798fd5da13) [Independent probes and service suite](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37349210308).

## Follow-up (C)

**C-688-9 carried — opposite lock orders**, `src/checkout/dunning-v2/dunning-v2.service.ts:1048–1060` versus `src/checkout/checkout-webhook-handler.service.ts:1763–1766,1840–1844`: v2 acquires DunningState then ClientPurchase, whereas invoice.paid already owns ClientPurchase before recovery touches DunningState; two workers can deadlock and delay one delivery until retry. [V2 order](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/21714f7bba299336cf71df0c87288c798fd5da13/src/checkout/dunning-v2/dunning-v2.service.ts#L1048-L1060) [Webhook recovery boundary](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/21714f7bba299336cf71df0c87288c798fd5da13/src/checkout/checkout-webhook-handler.service.ts#L1763-L1856).

Minimal follow-up: unify transaction ownership and one lock order across paid, sweep, pause and restart; do not acquire DunningState before v1's independent-connection recordResolution without moving that write onto the same transaction. [Composed transaction fix explanation](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/705#issuecomment-5999324895).

## Gates and piece boundary

Size is 2,784 changed lines, within the grandfathered 3,000 cap; applicable candidate checks are green, but CodeQL/Danger/SBOM/banned-token main-only checks must execute on the final composed main-based stack. [Current fix round](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5999324310) [Candidate build](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37343332177).

D2a alone still contains the superseded compressed-dispute implementation: approval is for this flag-off split boundary and the composed train, not standalone deployment/activation; #705 owns permanent dispute pause, under-lock marker reread and C-680-19. [D2c scope and dependency](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/705#issuecomment-5999324895).
