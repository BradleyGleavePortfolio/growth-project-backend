AUDIT Claude Opus 5.5 — growth-project-backend#654 @ 02c48de710f9f69bfc985336eb14249663bbb638 — VERDICT: APPROVE

**A0 / B0 / C3** (C-654-8, C-654-9, C-654-10). This is a full T4 audit of the PR's own scope on top of #627 `cd332bfa`. My last verdict was REQUEST CHANGES at `16cf4ca9` ([5964353243](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/654#issuecomment-5964353243), addendum [5964371107](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/654#issuecomment-5964371107)).

I read the whole own delta `16cf4ca9..02c48de7`:
- `48616468` (filter allowlist, R1-9/R1-10) and `d43633aa` (B-654-1, C-654-2, C-654-3);
- `76f6f1c3` + `317301b5` (round 2: B-654-1 narrowed, B-654-5/6/7, checkout_state);
- `c90c0d75` + `02c48de7` (caught errors logged by code only).

Inside those commits I read `subscription-checkout.service.ts` (mint, finishBound, replayAttempt, claimUnbound, tryReuse, retireAttempt, readCheckoutState), `subscription-terms.ts`, `trial-card.ts`, the webhook handler and connect-api diffs, `error-details.ts`, and migration `20270311000000`. The two #627 merges carry no PR-owned edits.

### Prior findings (this lens)
- **B-654-1: closed.**
  - The `setup_intent.succeeded` webhook finds the row by the SetupIntent id (`seti_<id>_secret_` prefix). It sets the subscription default idempotently (`tgp-trial-card-<sub>-<pm>`).
  - Reads now use the SetupIntent itself, not `pending_setup_intent` (`trial-card.ts` readTrialSetup). Retire and reuse never cancel a trial whose card was saved.
  - The narrowed case from GPT-6.1 Sol is fixed: a failed lookup returns `{purchaseId:null, ok:false}`, so `handle()` throws, the outer transaction rolls back, and Stripe redelivers (`checkout-webhook-handler.service.ts:541, 587-592`).
  - Failing-before test: `test/b-recur-3-fix-round-2.spec.ts:175`.
- **C-654-2: closed.** Reuse requires `trialUnchanged` plus the pinned `termsStillOffered`.
- **C-654-3: closed.** A same-key replay goes through `replaySecretState`: settled returns ALREADY_ACTIVE, dead returns ATTEMPT_EXPIRED, and a spent secret is never returned.
- **C-654-4: closed.** `pickErrorDetails` is applied in `http-exception.filter.ts:65` using a shape-checked allowlist. The new `SUBSCRIPTION_ATTEMPT_EXPIRED.reason` is limited to `timed_out | terms_changed`.

### Sol's round-2 items (my independent read; Sol closes them)
- **B-654-5.** The terms are pinned before the create, and every retry resends the same request under `tgp-sub-<client>-<key>`. Binding happens before the ephemeral key. A key mismatch is resolved through `metadata.tgp_purchase_id` (`listSubscriptionsForCustomer`; `has_more` counts as unreadable). The tests at `b-recur-3-fix-round-2.spec.ts:202-333` hold.
- **B-654-6.** `classifyWithoutSheet` keeps an active, paid or processing first invoice and returns `mode:'none'` instead of canceling.
- **B-654-7.** A replay answers with the pinned terms. Changed terms retire the attempt: an unpaid one is canceled, and a paid or carded one returns ALREADY_ACTIVE.

### Checks
- The migration is additive (nullable JSONB) and in lane block `20270311*`, with `down.sql`. It stores no user id, so nothing is owed to the #608 manifest.
- Copy has no "we/us/our" and no "!".
- Logs now carry error codes only (`errorLabel`).

### C-654-8: a pinned resend after Stripe's 24 h key window creates a second subscription for one attempt
- **Where.** `replayAttempt` → `claimUnbound` → `mintSubscription` resends a retry-marked attempt with no age bound (`subscription-checkout.service.ts:1041` replayAttempt, `:1106` claimUnbound; only the new-key reuse path is capped at 23 h by `OPEN_ATTEMPT_MAX_AGE_MS`, `:71`).
- **Counterexample.**
  1. The create times out after Stripe made `sub_1`, and the row is retry-marked.
  2. The same client key is retried after Stripe pruned the key (24 h, per the operator ruling). The mobile key lives in a screen ref, so a long-lived screen can resend it.
  3. Stripe runs it as a new request: `sub_2` is bound and `sub_1` is orphaned with the same `tgp_purchase_id`. For a trial, `sub_1` stays `trialing` until trial end.
- **Probe.** `audit/AUD-OPUS-MONEY/654-c8-key-expiry`, spec `test/audit-opus-654-c8-key-expiry.spec.ts`. It is red at `317301b5` ([run 37142324612](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37142324612)): `count: 2` and `["sub_1:trialing"]`. It is red again at `02c48de7` ([run 37143117139](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37143117139)), with the same 2 of 2 failing.
- **Why C.** Nothing is charged today. An orphaned incomplete subscription expires at 23 h. An orphaned trial has no card, and `missing_payment_method=cancel` ends it. Reaching this needs an uncertain create plus the same key more than 24 h later.
- **Fix rule.** Before resending a pinned request whose reservation is 23 h or older, look up `metadata.tgp_purchase_id` first and bind or cancel what is found. Or end retry-marked attempts older than 23 h with ATTEMPT_EXPIRED after that lookup. Test: the probe above turns green.

### C-654-9 (outside this diff, cross-lane): mobile #334 at `0629d50` rejects the new `mode:'none'`
- **Where.** `src/lib/packagePayment.ts:171-183` accepts only `payment|setup` with non-empty secrets and throws `PaymentIntentShapeError`. So a zero-due or processing first invoice (B-654-6) shows a support-case error for a plan that is live.
- **Gate.** #334 must accept `mode:'none'` and `checkout_state` before both ship (lane B-RECUR-MOB).

### C-654-10: `errorLabel` falls back to an unfiltered `Error.name`
- **Where.** `subscription-checkout.service.ts:144-152`. The code and type fields must match `^[A-Za-z0-9_.-]{1,64}$`, but the fallback returns `err.name` as is. A thrown error whose `name` was set from data would carry free text into the four new log lines.
- **Why C.** Every error that reaches these catches today gets its `name` from a class definition (Prisma, Stripe client, TypeError), not from request data. GPT-6.1 Sol rated the same pattern in #656 B (B-656-7).
- **Fix rule.** Run the same pattern test on `name`, or use a fixed fallback such as `error`. Add a canary test where an error's `name` carries an address-like string.

**Status at posting.**
- Posted under the operator's 11:25 PDT pause instruction.
- The builder's FIX ROUND 2 comment at this head ([5971989117](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/654#issuecomment-5971989117)) has no READY FOR AUDIT line.
- The 7 required checks that run on this stacked base are green. A grep of the added lines in `cd332bfa..02c48de7` finds no banned cast token.

**Merge gates (not findings).**
- The ruling stands: whichever of #654 and #628 merges second unifies the never-entitled helper.
- The C-656-1 composition gate with #656 still applies: capability registration, reserve/release wiring, and one entitlement rule.
- The required checks that are absent on a stacked base (Danger, CodeQL, banned-cast, SBOM) must pass after the PR is retargeted to main.

