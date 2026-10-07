AUDIT Claude Opus 5.5 (LB-OPUS-126) — growth-project-backend#822 @ b4f48a76fb0e65ab26eab7c9d60a0b21e436812d — VERDICT: APPROVE

A=0 B=0 C=1. CI: green at this head (SKIPPED:1 SUCCESS:18); mergeable clean. Size 12 lines (9+/3-). This grades policy and behaviour; owner approval 19:23 (no coach software subscription for normal coaching).

**Checks**
- Every generic SubscriptionGuard denial becomes observe-only when the variable is unset.
  - The guard reads only `process.env.BILLING_ENFORCEMENT === 'enforce'` (`subscription.guard.ts:110`).
  - Every subscription or tier denial in `canActivate` goes through `denyOrObserve(…, enforce, …)`: missing row on a pro route, `tier_too_low`, past_due past the grace period, canceled, paused, and incomplete or unknown.
  - That function throws 403 only `if (enforce)`. Otherwise it logs `[observe]` plus analytics telemetry and returns true.
  - Unset or any other value therefore lets every `@RequiresTier` route through for coaches, for example `/coach/ai/*`, `/v1/coach/ai/draft/*` and `/workout-programs/*`.
  - What stays as-is: the OWNER bypass, and the non-coach role 403 (a role check, not a subscription check).
- Factual scope: Env Truth (run 37559943231) and the secrets list (run 37536038425) prove BILLING_ENFORCEMENT is PRESENT on Fly, not that its value is `enforce`.
  - So this PR guarantees the observe posture whatever the current value is.
  - It does not prove that coaches are being denied a 403 in production today.
- Client money untouched: no other src file reads BILLING_ENFORCEMENT. Package checkout, the Connect payout gate, dunning (`src/checkout/dunning.service.ts`, which reads BILLING_PORTAL_URL, a different name, and `src/checkout/dunning-v2/`), refunds and webhooks do not depend on it.
- White-label gate kept: `custom-domain.service.ts:235-243` has its own direct check (`coachSubscription.tier === 'free'` gives 402 `pro_tier_required`) and does not read this flag. This PR does not touch it, so the paid custom-domain (white-label) offering stays gated.
- Boot and one path:
  - The new `values: ['enforce','observe']` and `unsetIs: 'off'` are descriptive only (per the ENV_RULES field comment, never read at runtime and never boot-affecting).
  - `fly-secrets-set.yml` stops writing `BILLING_ENFORCEMENT=enforce` in both lists, so the audited manifest is the only writer.
  - Merging changes nothing on Fly until `fly-env-sync` apply runs.

**C (never block)**
- C-822-1: while the variable is unset, past_due or canceled coaches on pro-tier routes are observed, not denied. That is intended by the owner's 19:23 decision, and the gate text says to flip back to `enforce` once a pro path exists.
