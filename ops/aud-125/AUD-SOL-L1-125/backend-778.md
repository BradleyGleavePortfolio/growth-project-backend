AUDIT GPT-6.1 Sol — growth-project-backend#778 @ 52fbaaebea99673750e1226e90c89e9ebacadc58 — VERDICT: REQUEST CHANGES

A=0 B=1 C=0; U=0.

**B-778-1 — live refund/dispute contracts still lose their pricing lock.** A coach changes the price or cadence while a client's recurring plan is disputed or fully refunded, and the edit is accepted even though the live Stripe subscription will retain its old terms, so the restarted plan's app pricing/cadence no longer matches its billing. [Changed pricing guard, file:line 586–591](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/52fbaaebea99673750e1226e90c89e9ebacadc58/src/packages/packages.service.ts#L582-L605), [three-status allowlist](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/52fbaaebea99673750e1226e90c89e9ebacadc58/src/packages/packages.service.ts#L39-L51), [dispute status writer](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/52fbaaebea99673750e1226e90c89e9ebacadc58/src/checkout/refund-dispute-handler.service.ts#L2067-L2073).

The new `pricing_locked` read model repeats that same three-status predicate, so it also reports unlocked for `disputed`, `chargeback_lost`, `refunded`, and `unpaid` subscriptions rather than representing a live contract. [Read model, file:line 837](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/52fbaaebea99673750e1226e90c89e9ebacadc58/src/packages/packages.service.ts#L834-L838).

Smallest fix: use the same live-contract predicate for both edit enforcement and management views, excluding genuinely ended subscriptions rather than admitting only active/trialing/past_due; cover normal refund/dispute pause then cadence edit and restart. The current pause test uses only `past_due`. [Test](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/52fbaaebea99673750e1226e90c89e9ebacadc58/test/money-connect-package-views.spec.ts#L163-L176).

Ownership and subscriber field allowlisting were traced; required CI is green, including [build-and-test](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37522159470/job/112470031788).

No local test/build, code push, merge, deployment, or provider action.
