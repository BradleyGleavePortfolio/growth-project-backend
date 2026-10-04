**Tier:** T4 (money path). **Why:** free trials with a card up front: the one-trial ledger decides who gets a trial and the trial-ending notice states what the card will be charged. **T4 trigger scan:** money (Stripe trial subscriptions, charge copy), privacy (notice and ledger logs carry ids and closed codes only). **T3 trigger scan:** schema + migrations (T1), cron worker and outbound push/email (T2), Stripe webhooks (T3). **Bounded T1:** none. **Canonical builder:** agent 115 (split of #656); fix round 6 by B-T12-116 (agent 116). **Parent owner:** #656. **Acceptance evidence:** Fix round table below (failing-before and passing-after CI lane runs). **Promotion triggers:** none (already T4).

**Fix round table**

| Round | Piece head | Findings closed | Failing-before | Passing-after |
|---|---|---|---|---|
| 6 (B-T12-116) | `4fa2fe4a` | Sol B-672-1, B-672-2; Opus B-672-1, C-672-1..5, C-672-6 (comment); merges T1 `1efac91e` | [run 37174499909](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174499909) | [run 37174803961](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174803961) |

Split of #656 (free trials, backend) under the owner's PR size rule: over 3,000 changed lines is an automatic fail (MODEL_ROUTING.md 8.2, tgp-agent-context). #656 was 5,611 lines at `86223987` (FIX ROUND 5). Stack: T1 -> T2 -> T3, merged back to back; deploy only after T3, together with mobile #338. Owner adds the Stripe webhook event `customer.subscription.trial_will_end` before that deploy. The tree at T3 equalled #656 @ 86223987 (checked with git diff) until fix round 6, which adds the T1/T2 fixes. Prior verdicts on #656 (Sol RC 0/4/1 at b9939d02; no full Opus audit) do not carry; each piece needs fresh Opus 5.5 and Sol audits at its exact head (T4, money path). `tsc --noEmit` passes at every piece.

**T2 (base T1, 1,954 lines after fix round 6):** package create/update accept trial_days under the trial rules; client package list and detail carry trial_offer for that client; TrialUsageService, TrialNoticeService and TrialCheckoutCapability registered and exported by PackagesModule; trial-ending email template and notification kind; package-rules spec and the restored one-trial-rule assertion (43/43 pass locally across the two specs). Not deployable alone: checkout does not honour a trial until T3.

