AUDIT GPT-6.1 Sol — growth-project-backend#690 @ c15f157cabca707bd0dfa9c1e8eb20ff0f78f9ae — VERDICT: REQUEST CHANGES

A/B/C = 0/1/6

AUD-SOL-DUN1-122, agent 122. Independent ordinary access/API review; no edge probes or analysis.

**B-690-S1 — the ruled coach restart has no HTTP operation.**

Normal-user story: A client's bank dispute pauses the plan, the coach wants to restart it, but the backend offers no coach restart operation, so the client stays locked out and billing stays paused.

D4's `src/checkout/dunning-v2/dunning-status.controller.ts:19–31` still exposes only GET status, and `dunning-v2.module.ts` registers only that controller; `ClientBillingController` supplies client card/quote/cancel, not a coach restart. The actual composed production tree at this new head contains no caller of `restartAfterDisputePause`; its only implementation is `dunning-v2.service.ts:1505`. Existing voluntary `subscriptions/:id/resume` is own-client scoped and does not invoke the dispute restart, so it cannot provide this coach-only recovery. [Reviewed D4 PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/690).

Read all 760 lines of the real main/D2d merge-resolution diff plus the subsequent narrow integration delta: preserves main's subscription-attempt/activation and terminal-state rules, v2 dispute pause, ordinary grace, billing providers, effective-lock waiver, recovery route and privacy footer; diagnostics remain restricted on changed D4 paths. This was a conflict-resolution audit, not a clean merge-only attestation. [Reviewed D4 PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/690).

The last D3 type-only fix is inherited by a clean merge: independent merge-tree(f97c46e2,0fbd18ca) exactly matches actual tree `485c1100060d6d756b0e7bc117bae6be556d5948`. [Current D4 commit](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b3ae2f295bba961d5c6532698281e91b5194559e).

The subsequent c15f157c delta only tightens the privacy-test legacy exception-text inventory to match D4's already-coded webhook/sweep logs; the actual remaining seven webhook sites and coded sweep were checked. No production change in that final delta. [Privacy test delta](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/c15f157cabca707bd0dfa9c1e8eb20ff0f78f9ae).

Minimal fix: wire an authenticated coach-role, own-purchase restart route to the existing service; verify ordinary own-coach success and foreign-coach refusal. If another explicitly owned piece supplies it, identify that exact mandatory launch dependency instead of activating this incomplete train.

Cs only: prior own B-690-1/2/5/6/7 are C (edge, deferred to 10k clients); C-690-2 is the carried outside-diff diagnostics note. [Own prior dispositions](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/690#issuecomment-5982476848).

CI snapshot: build-and-test running; audit, schema parity, RLS floor/live, MWB and community checks green. CodeQL JS/TS, banned casts, SBOM and danger are absent on this stacked base and must execute on the composed main-targeted tree. Builder lane passed tsc plus 67 suites/1,118 tests at b0b47959's CI-only child; final delta adds only the read privacy-test inventory adjustment. No independent execution or passing claim for running checks. No other lens's current-round notes/comment read. [Current build](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37386865394/job/112022152189), [verified builder lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37386724702/job/112021677637).
