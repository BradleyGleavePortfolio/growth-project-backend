AUDIT Claude Opus 5.5 — growth-project-backend#678 @ b89c199d91a868e625b1c1bd861d540ac4c2a8ce — VERDICT: APPROVE

A/B/C = 0/0/0

This is a full T4 piece audit of R1 of the #654 split. The tier is T4 because the piece carries money code (the Stripe subscription create and cancel API, the trial card), migrations and the error envelope. Its base is fees F6 #686 (`agent115/fee-split-6-recovery-specs` @ `7be7d396`). The builder round is [FIX ROUND 3 (no change)](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/678#issuecomment-5976055756).

### Prior findings (this lens)
I approved #654 @ `02c48de7` at 0/0/3 ([5972187301](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/654#issuecomment-5972187301)). None of the three has code in this piece:
- **C-654-8** and **C-654-10** live in #679. I decide them in my #679 verdict; both are closed.
- **C-654-9** (mobile) is closed. Mobile #342 @ `72821495` accepts `mode: 'none'` (`src/lib/packagePayment.ts:189-202`).

### Evidence reuse (G09)
- **Patches match.** For every one of the 12 files, the piece's patch `7be7d396..b89c199d` equals #654's own patch `cd332bfa..02c48de7`. I compared them after normalizing hunk headers and index lines, then hashing.
- **Blobs.** 10 of the 12 blobs are byte-identical to `02c48de7`. The other two, `prisma/schema.prisma` and `src/connect/stripe-connect-api.service.ts`, differ only by the #627/main changes underneath (`cd332bfa..7be7d396`: transfer `beforeSend`, buyer drop statuses, unrelated models). None of those changes touches a symbol this piece adds or calls.
- **Conclusion.** My `02c48de7` APPROVE evidence applies to this code. Nothing was taken from the other lens.

### Piece boundary (whole diff read)
- **Compiles alone.** build-and-test is green at this head.
- **Inert until #679.**
  - Nothing calls the new Stripe methods or `src/checkout/trial-card.ts` yet. The new methods are `retrieveSubscriptionForCheckout`, `listSubscriptionsForCustomer`, `resumeSubscription`, `retrieveSetupIntent` and `setSubscriptionDefaultPaymentMethod`.
  - `createSubscription` gains an optional `trialPeriodDays`. The existing caller `src/storefront/guest-checkout.service.ts:724` never passes it, so its Stripe request is byte-for-byte unchanged.
- **Live in this piece: the error filter.**
  - `src/filters/http-exception.filter.ts` now spreads `pickErrorDetails`.
  - It adds fields only for a coded 4xx whose `code` is one of the five allow-listed codes. It never overrides an envelope key.
  - On this base, no route throws those codes as `code:`. `src/billing/owner-billing.controller.ts:145` sets `error: 'SUBSCRIPTION_ALREADY_ACTIVE'` only, so `code` is undefined there and nothing is added. The change is additive.
- **Tests.** This piece has no tests of its own. The filter, API and fake tests arrive with their callers in #679 and #680. I accept that only because rule 11 lands #678-#680 as one.
- **Imports.** Nothing imports a later piece.
- **Migrations.**
  - What they add:
    - `20270225000000` adds `trial_days` with ADD COLUMN IF NOT EXISTS, which is shared with #656, plus `trial_started_at` and a CHECK of 1..730.
    - `20270311000000` adds `checkout_terms` as JSONB.
  - Both are additive and nullable, and each has a `down.sql`. The trials `down.sql` keeps `trial_days` while #656's `PackageTrialUsage` exists.
  - Neither holds a user id, so nothing is owed to the deletion manifest.
  - Forward-apply, reversibility and Schema parity are green at this head.
  - Note (not a finding): `20270225000000` sorts before production's latest applied migration, `20270301000000`. That is still safe:
    - `prisma migrate deploy` (`scripts/release.sh`) applies pending migrations by name regardless of order, and the two migrations touch unrelated tables.
    - It is not a new wave migration; the `>20270316000000` rule applies to new ones.
    - Renaming it now would break the #656 coordination.

### Checks at this exact head
- **Green:** build-and-test ([job 111286673464](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37151674078/job/111286673464)), rls-floor-guard, rls-live-tests, mwb-3-live-tests, community-live-tests, npm audit, Schema parity, forward migrations and reversibility.
- **Not run on a stacked base:** CodeQL, danger, Banned cast tokens and build-sbom. They must pass after the retarget to main.
- **Banned casts.** Main's committed checker (`scripts/check-r75.js --mode=range`, base `7be7d396`, head `b89c199d`) prints "OK — no positive token change" (as any +2 -2, net 0).

### Merge gates (not findings)
- Lands only together with #679 and #680 (rule 11), after fees F1-F6. The stack then retargets to main.
- The owner adds the Stripe `setup_intent.succeeded` webhook event before deploy.
- Deploy goes with mobile #342-#344.
