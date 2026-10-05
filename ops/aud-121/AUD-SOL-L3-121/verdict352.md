AUDIT GPT-6.1 Sol — growth-project-mobile#352 @ c89f719cd8f5863c4150af1da5b96e273df319d6 — VERDICT: REQUEST CHANGES
A/B/C = 0/2/2

Job AUD-SOL-L3-121, agent 121; independent T4 money/auth-state FIX ROUND 2 review.

### Prior Sol disposition first

**B-352-1 stays closed on its original stale-403/auth-reset scope; B-352-2 closes on its reported mixed-paid/disputed restoration and missing-pause-facts scope.** The re-pinned mixed receipt keeps `$150.00 went through`, scopes recovery to the paid plan, states access ended/billing paused/coach decides, and rejects both “settle” and universal restoration; all five updated Sol119 boundary probes, identity probes and current L1 contract tests passed in the exact-source prior Sol lane. ([Verified exact-source replay](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37355830979), [FIX ROUND 2](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-5999207160))

**B-352-3 is repaired at the originally reported `initStripe → initPaymentSheet` gap but remains open across native presentation ownership**, as below. ([Candidate helper](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352), [same-head negative evidence](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37355830979))

### B-352-3 — The newest-session latch does not protect an already-presenting native sheet or its continuation

`src/entitlements/dunning/updateCard.ts:189-229,241-249`: the newest session is checked before/after initialization, but starting B can initialize the shared SDK while A is still presented; after presentation A checks only `isCurrent`, not `ownsSheet`, and passes only `isCurrent` into money confirmation. ([Candidate helper](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352))

The pinned 0.64.0 iOS implementation assigns a singleton `self.paymentSheet` during non-custom initialization, then A's `.completed` presentation callback clears **the current singleton**, not an identity-qualified presenting instance. ([Native initialization](https://github.com/stripe/stripe-react-native/blob/v0.64.0/ios/StripeSdkImpl%2BPaymentSheet.swift), [native completion, lines 319-326](https://github.com/stripe/stripe-react-native/blob/v0.64.0/ios/StripeSdkImpl.swift))

**Concrete counterexamples:** (1) A is presenting, A retires, B initializes its customer, A completes and clears B's singleton, then B presents: B returns `error` instead of `done`; (2) A is superseded by B while still mounted, then A returns success: A still posts its old SetupIntent's `/payment-method/confirm`, returning `done` instead of `retired`. ([Two actual failed assertions; 45 controls/regressions passed, 2 failed](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37355830979))

These are SDK-state/continuation probes backed by the actual pinned native source, not a claim of a device charge, backend authorization bypass or canceled server request. ([Probe evidence](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37355830979), [pinned SDK](https://github.com/stripe/stripe-react-native/blob/v0.64.0/ios/StripeSdkImpl.swift))

**Minimal fix rule:** serialize native initialization/presentation through native completion/teardown, re-check the initiating screen/auth owner after acquiring that lease, and fence post-presentation confirmation/retries/bank continuations against the operation's session as well as its screen/auth lifetime; release the lease on success, cancellation, rejection and retirement without freeing it before in-flight native completion. Preserve 1A payment, existing approved invoices, lost-answer reconciliation and bank recovery; replay both interleavings plus live-owner/cancel/error controls. ([Affected flow and retained functionality](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352))

### B-352-9 — Inquiry pauses are reported as money already reversed

`src/entitlements/dunning/dunningErrorCopy.ts:485-494,628-631`; `dunningApi.ts:142-147,325-353`: accepted quote/confirm dispute metadata carries no inquiry/funds-withdrawn discriminator, but the helper unconditionally says “Your bank reversed a payment” and the cancel outcome says the bank “had reversed” it, including when amounts are unknown. ([Current L1 contract/copy](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352))

An accepted inquiry-only quote with `complete:true`, empty invoice/totals arrays and a dispute entry `{purchase_id:'p_inquiry',coach_name:'Avery',amount_cents:null,currency:null}` therefore produces that false reversal claim before and after a card save, while retaining the otherwise-correct coach-controlled pause facts. ([Candidate helper/normalizer](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352))

Stripe states that inquiries withdraw no funds unless elevated to disputes; owner decision 6 applies the same pause/access-ending policy to inquiries, not the same money-withdrawal fact. ([Stripe inquiry contract](https://docs.stripe.com/testing-use-cases?locale), [binding decision register](https://github.com/BradleyGleavePortfolio/tgp-agent-context/blob/main/TGP_SOURCE_OF_TRUTH.md))

**Minimal fix rule:** use neutral payment-dispute/inquiry copy whenever actual withdrawal is not proven, or retain a trusted subtype/funds-withdrawn discriminator and condition reversal claims on it; keep access ended, billing paused, coach decides, no automatic restart/card fix, and confirmed ordinary-plan payments/currency totals intact. Update tests that currently hard-code a reversal for the undifferentiated envelope, and cover inquiry-only quote/save, mixed paid/inquiry and legacy cancel copy. ([Affected helpers](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352))

The three narrow inquiry negatives plus an ordinary-save control are committed in the audit-only batch; they are **queued, not claimed executed or passing**. ([Queued consolidated probe lane](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37365609416))

### Follow-ups (C; freeze, unchanged)

- **C-352-1:** `dunningErrorCopy.ts:75-86`; `updateCard.ts:128-135,285-292`: unify short customer references/full searchable diagnostics with the existing correlation conventions; do not mix raw/fresh IDs and `request_id` extra with the standard support/Sentry reference fields. ([Candidate](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352), [prior Sol disposition](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-5983776115))
- **C-352-3:** `dunningErrorCopy.ts:247-253`: read/validate `Retry-After` and show the actual wait rather than always “Wait a minute”, with a safe fallback. ([Candidate](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352), [prior Sol disposition](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-5983776115))

### Evidence reuse, CI and operator default

No other lens's current-round report or verdict was read; this lens independently read FIX ROUND 2 runtime changes, native source, retained API/auth/store/native consumers and piece boundaries.

The `40706529` main merge reproduces automatic tree `dfb53858b24d56d918c9fa81dde5721db8b69cc6`; prior Sol run `37355830979` differs from the candidate only by audit specs/workflow, so its 45-pass/2-fail evidence applies to this exact runtime. ([Builder merge/fix record](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-5999207160), [verified GitHub run](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37355830979))

Candidate Typecheck/lint/test and both analyses are green; #352 remains behind newer main, and the 2,586 changed lines are within its grandfathered 3,000 cap. ([Candidate checks](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37344285154), [analyses](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37344285354), [candidate](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352))

The two initially submitted per-PR lanes were canceled immediately on operator 121's one-in-flight instruction, replaced by one complete-stack batch rooted at exact #354; L1 runtime files are byte-identical there, and new inquiry assertions are explicitly pending during the runner incident. ([Canceled L1 lane](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37365516729), [canceled L2 lane](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37365523330), [single retained batch](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37365609416))

**Recommended default:** hold L1 for these two Bs, make one focused fix round, replay both lenses' probes and restack; no copy decision is needed for the superseded “settle” anchor. Keep backend-first deployment, the complete #352→#354 train, main-target checks and native-device acceptance as separate landing/release gates. ([Binding launch/owner register](https://github.com/BradleyGleavePortfolio/tgp-agent-context/blob/main/TGP_SOURCE_OF_TRUTH.md), [prior landing contract](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-5983776115))
