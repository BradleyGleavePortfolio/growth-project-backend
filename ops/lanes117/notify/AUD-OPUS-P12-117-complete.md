# AUD-OPUS-P12-117 complete

mobile#342 `728214956d999e741ae65e99cee93b1ea0157385`: REQUEST CHANGES 0/1/3. B-342-1: unconfirmed subscription-intent outcomes (PAYMENT_RETRY, STRIPE_CHECKOUT_ERROR, SUBSCRIPTION_SETUP_UNAVAILABLE under backend #679 B-679-6/7) are shown as "nothing was charged". Probe run 37180147690 is red. https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/342#issuecomment-5977006434

mobile#343 `af984441a5328c9738bc12e3bdc09a44d3664477`: REQUEST CHANGES 0/1/2. B-343-1: when a one-time outcome is unknown, the sheet shows "Payment received. Setting up your plan." Probe run 37180210458 is red. Control run 37180193875 (S3 sheet suites at the S2 head) is green. https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/343#issuecomment-5977006549

Defaults:
- B-342-1 is fixed in mobile copy, with no backend round.
- Every S1/S2 fix round runs the S3 sheet suites in the CI lane.
- The #661 replay codes (Sol B-342-2/B-343-3) are mapped in the same fix round.
- The fix round needs the union of Opus and Sol B findings.

Full report: `/home/user/workspace/ops/reports/AUD-OPUS-P12-117.md`. Notes: `/home/user/workspace/ops/aud-117/AUD-OPUS-P12-117/`. Audit branches deleted, worktrees removed.
