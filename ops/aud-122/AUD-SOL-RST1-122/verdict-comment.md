AUDIT GPT-6.1 Sol — growth-project-mobile#380 @ b49d714777b6eaf2df12b200abbf2fc3eb78a1d5 — VERDICT: APPROVE

AUD-SOL-RST1-122, agent 122 — independent first review, T4 money.

A/B/C = 0/0/1. Bs: none.

- Visibility matches the backend contract: this client's recurring, access-off, non-ended purchases are read through coach-scoped routes, and the button requires an active `charge_disputed` dunning row with `entered_at` ([coachDisputeRestart.ts:65–115](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/b49d714777b6eaf2df12b200abbf2fc3eb78a1d5/src%2Fentitlements%2Fdunning%2FcoachDisputeRestart.ts)).
- Confirmation precedes the POST; an acknowledged restart changes the displayed state to “Plan restarted” and removes the button, while each known refusal has specific copy and the no-response path does not claim success ([DisputePausedPlansCard.tsx:52–114](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/b49d714777b6eaf2df12b200abbf2fc3eb78a1d5/src%2Fcomponents%2Fcoach%2FDisputePausedPlansCard.tsx), [coachDisputeRestart.ts:121–195](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/b49d714777b6eaf2df12b200abbf2fc3eb78a1d5/src%2Fentitlements%2Fdunning%2FcoachDisputeRestart.ts)).
- Backend reference `2f11f14bb8c361d72dc0f5db8e0725801a83b821`: `DunningRestartController` requires authenticated coach/owner access and derives the caller from `req.user.id`; `restartCandidate` refuses a purchase belonging to another coach before billing changes ([backend #687](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687)).

C-380-1 — C (edge, deferred to 10k clients): roster discovery stops after 500 purchases per coach; no fix now ([coachDisputeRestart.ts:27–28,89–98](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/b49d714777b6eaf2df12b200abbf2fc3eb78a1d5/src%2Fentitlements%2Fdunning%2FcoachDisputeRestart.ts)).

Evidence: [PR Typecheck, lint, test — success](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37392943563/job/112042068552); [builder CI lane — success](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37392952996). The lane differs from the reviewed head only by its three CI harness files. No prior lens evidence reused; no local test/build, probe, or push.

Operator gates: this is stacked on m#354, so approval remains subject to required main-only checks after retargeting; keep the backend restart route available before enabling dispute-paused plans ([mobile #380](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/380), [backend #687](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687)).
