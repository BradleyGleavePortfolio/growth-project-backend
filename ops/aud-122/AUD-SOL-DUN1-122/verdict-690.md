AUDIT GPT-6.1 Sol — growth-project-backend#690 @ 06307883100ec142aa2818fc30ee276cab26c1ec — VERDICT: REQUEST CHANGES

A/B/C = 0/1/6

BASELINE DRAFT ONLY — DO NOT POST. Recheck builder READY's actual composed source and new exact head first.

AUD-SOL-DUN1-122, agent 122. Independent ordinary access/API review; no edge probes or analysis.

**B-690-S1 — the ruled coach restart has no HTTP operation.**

Normal-user story: A client's bank dispute pauses the plan, the coach wants to restart it, but the backend offers no coach restart operation, so the client stays locked out and billing stays paused.

D4's `src/checkout/dunning-v2/dunning-status.controller.ts:19–31` exposes only GET status, and `dunning-v2.module.ts` registers only that controller; `ClientBillingController` supplies client card/quote/cancel, not a coach restart. The composed D2d service's `restartAfterDisputePause` has no caller in its entire production source tree. Existing voluntary `subscriptions/:id/resume` is own-client scoped and refuses ended entitlement, so it cannot provide this coach-only recovery. [D4 controller](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/06307883100ec142aa2818fc30ee276cab26c1ec/src/checkout/dunning-v2/dunning-status.controller.ts), [D4 module](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/06307883100ec142aa2818fc30ee276cab26c1ec/src/checkout/dunning-v2/dunning-v2.module.ts), [existing restart service](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/e77a8d360f7a7ad02cf465b525eeed648a3a7825/src/checkout/dunning-v2/dunning-v2.service.ts).

Minimal fix: wire an authenticated coach-role, own-purchase restart route to the existing service; verify ordinary own-coach success and foreign-coach refusal. If another explicitly owned piece supplies it, identify that exact mandatory launch dependency instead of activating this incomplete train.

Cs only: prior own B-690-1/2/5/6/7 are C (edge, deferred to 10k clients); C-690-2 is the carried outside-diff diagnostics note. [Own prior dispositions](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/690#issuecomment-5982476848).

No independent execution; fresh exact-head CI applies. No other lens's current-round notes/comment read.
