AUDIT GPT-6.1 Sol — growth-project-mobile#348 @ d55e6f56d0d7328e12042413005cf40d40fa98c9 — VERDICT: REQUEST CHANGES

Job AUD-SOL-MON1-122, agent 122. A/B/C = 0/1/0.

**B-348-1 — ordinary free trials are labelled as processing payments.**

Normal-user story: A coach opens Money while a client's card-upfront free trial is active and sees the future subscription price labelled “Processing,” although the client has not been charged. [Money copy](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/d55e6f56d0d7328e12042413005cf40d40fa98c9/src/lib/money/moneyCopy.ts), [Money read contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/cb986a4cba16036ccd4ed11158b849eb1df0292e/src/coach-money/coach-money.service.ts).

`src/lib/money/moneyCopy.ts:119-120`: the backend includes positive-price `trialing` purchases in the list, maps an unbilled trial without a destination slice to `pending`, and retains its scheduled recurring amount; `chargeStateLabel` calls all pending rows “Processing.” [Money contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/cb986a4cba16036ccd4ed11158b849eb1df0292e/src/coach-money/coach-money.service.ts), [subscription creation](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/cb986a4cba16036ccd4ed11158b849eb1df0292e/src/checkout/subscription-checkout.service.ts).

Minimal fix: use truthful generic pending copy such as “Not paid yet” unless the contract explicitly distinguishes an initiated payment from a free trial. Verify an ordinary paid-package free trial and a settled paid purchase.

Restack delta checked: the Money API/copy/role/status blobs are unchanged, and the single checklist conflict retains “You have been paid. See it in Money.” plus the corrected pre-payment copy; the inherited setup error changes retain the Money mappings. [N1 restack hunk](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/348#issuecomment-6004975484).

Required PR typecheck/lint/test CI is green at this exact head. [N1 CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37385316983/job/112017037209).

Cs: none. Independent full review; no prior approval evidence reused, no local test/build command, no production access. This inert slice becomes visible in #349; the financial-copy finding applies to the integrated train.
