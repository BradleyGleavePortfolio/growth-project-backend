AUDIT GPT-6.1 Sol — growth-project-backend#673 @ 91d0adcbb3b1c5eef10266006a6a6a8c6b33f6a5 — VERDICT: REQUEST CHANGES

A/B/C = 0/1/1

Reviewer: AUD-SOL-TR10-122, agent 122. Independent delta against [the last Sol dependency-qualified approval](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/673#issuecomment-5985426913); no current Opus notes or comments read.

### B-673-3 — enabled free-trial offer contradicts ordinary checkout eligibility

**Normal-user story:** A client opens package A's free-trial card sheet, dismisses it without saving a card, then selects package B from the same coach; B still promises an available free trial, but checkout removes that trial and asks for immediate payment. [Customer offer response](https://raw.githubusercontent.com/BradleyGleavePortfolio/growth-project-backend/91d0adcbb3b1c5eef10266006a6a6a8c6b33f6a5/src/packages/packages.controller.ts), [Native checkout](https://raw.githubusercontent.com/BradleyGleavePortfolio/growth-project-backend/91d0adcbb3b1c5eef10266006a6a6a8c6b33f6a5/src/checkout/subscription-checkout.service.ts).

**File:line:** changed `src/checkout/subscription-checkout.service.ts:152-157` registers the capability; `TrialUsageService.offersForClient():123-136` reads only started ledger rows and `offerFor():373-382` returns B `available=true/reason=offered`, whereas native `decide():555-575` treats unstarted A's open attempt as a hold and sets B's trial to zero. `ClientPackagesController:258-262,288-289` exposes the false offer. [Offer predicate](https://raw.githubusercontent.com/BradleyGleavePortfolio/growth-project-backend/91d0adcbb3b1c5eef10266006a6a6a8c6b33f6a5/src/packages/trials/trial-usage.service.ts), [Checkout predicate](https://raw.githubusercontent.com/BradleyGleavePortfolio/growth-project-backend/91d0adcbb3b1c5eef10266006a6a6a8c6b33f6a5/src/checkout/subscription-checkout.service.ts).

**Minimal fix:** align advertised eligibility with native started/open-attempt truth, preserving same-package resume; for a different held package, return an accurate unavailable/in-progress offer with a working next action rather than promising a trial the checkout removes.

**Verification requested:** sequential `buy(A) -> offers -> buy(B)` must give matching advertised/actual trial truth; same-package A resume and already-started-trial controls remain correct. A 12-line proposed case is preserved in `ops/aud-122/AUD-SOL-TR10-122/B-673-3-normal-offer-mismatch.diff`; patch validation passed, execution is not claimed (GitHub CLI returned 401). This requires no races, unusual retries, webhook order or date boundary.

The shared webhook claim, winner-only marker and loser denial/cancellation are otherwise coherent; the three refresh conflict resolutions preserve the T3 added/removed lines exactly. Prior B-673-1 closure stays qualified on #707 landing with the train. [FIX ROUND 12](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/673#issuecomment-6000663552), [Restack](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/673#issuecomment-6002326865).

C-673-8: C (edge, deferred to 10k clients); carried void/event reconciliation, no fix requested.

CI reread at 15:22 PDT: all 10 latest applicable checks are green, including build-and-test, schema parity, audit and all four live/floor checks; deploy-readiness is skipped and main-only landing checks remain owed on the combined landing tree. [Exact-head checks](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/673/checks).

Recommended default: hold the train for this ordinary false-claim fix; respect #673's 2,996/3,000 cap by placing the small integration correction in the top slice or a new bounded piece. No new policy ruling or edge hardening requested.
