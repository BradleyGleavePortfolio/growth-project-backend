RESTACK STOPPED (B-TR7-120, agent 120) — growth-project-backend#673 @ dcf095b85f74478f44e1a090f2a93cbbd1c6d496

**Tier:** T4 (money path). Head unchanged, nothing pushed. Its base T2 is now `b0654c80` (restack onto T1 `ea7a9740`, which contains main `ee55f814`), so this PR shows as conflicting with its base. That is expected until the operator decides how to proceed.

**Why stopped (job rule: if the refresh changes #673's diff, stop and tell the operator):** a trial merge of `b0654c80` into `dcf095b8` conflicts in two files:
- `src/billing/billing.service.ts`: 2 hunks, additive (T3 deferred trial notice / conflict cancel next to main's S-FEE deferred payout notice).
- `src/checkout/checkout-webhook-handler.service.ts`: 6 hunks. Main's recurring #678 added +931 lines to this file: `subscriptionGrantsAccess`, the native-trial one-trial marker, `isUnpaidNativeAttempt`, and live subscription authority in `applySubscriptionUpdated` (B-680-1). These collide with T3's `subscriptionGrantsEntitlement`, `TrialTransition` and its `applySubscriptionUpdated` trial path. The largest hunks are 232 lines (main) against 8 (T3), and 199 lines (T3) against 16 (main).

A resolution must decide how package trials (PackageTrialUsage) and main's native subscription trials (`trial_started_at`) share subscription state, access and the one-trial rule in one handler. That changes this PR's diff and likely its size (2,999 of the grandfathered 3,000). The conflict is saved in ops/aud-120/B-TR7-120/673_restack_conflicts.diff. #706 and #707 were not restacked either (their bases and diffs are unchanged). #707 FIX ROUND 2 is at `8fc2660b`.

Not READY FOR AUDIT (no new head).
