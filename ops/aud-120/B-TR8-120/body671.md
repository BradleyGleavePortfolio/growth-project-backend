**Tier:** T4 (money path). **Why:** free trials with a card up front: the one-trial ledger decides who gets a trial and the trial-ending notice states what the card will be charged. **T4 trigger scan:** money (Stripe trial subscriptions, charge copy), privacy (notice and ledger logs carry ids and closed codes only). **T3 trigger scan:** schema + migrations (T1), cron worker and outbound push/email (T2), Stripe webhooks (T3). **Bounded T1:** none. **Canonical builder:** agent 115 (split of #656); fix round 6 by B-T12-116 (agent 116); fix round 7 by B-TR-117 (agent 117); main refresh by B-TR7-120 (agent 120). **Parent owner:** #656. **Acceptance evidence:** Fix round table below (failing-before and passing-after CI lane runs). **Promotion triggers:** none (already T4).

**Fix round table**

| Round | Piece head | Findings closed | Failing-before | Passing-after |
|---|---|---|---|---|
| 6 (B-T12-116) | `1efac91e` | B-671-1 (Sol + Opus), C-671-1, C-671-2, C-671-3, C-672-5 schema/copy | [run 37174151877](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174151877) | [run 37174355443](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174355443) |
| 7 (merge-only, B-TR-117) | `c75002c9` | none open; main `b644198b` merged (#611, #675, #694, #695), every T1 file byte-identical | — | PR CI at `c75002c9` (11/11) |
| main refresh (B-TR7-120) | `ea7a9740` | none open; main `ee55f814` merged (#678 recurring + fees). Conflict `prisma/schema.prisma` ClientPurchase resolved additively (shared `trial_days` declared once); every other T1 file byte-identical; 2,289 lines | — | PR CI at `ea7a9740` (20/20, incl. Schema parity) |

Split of #656 (free trials, backend) under the owner's PR size rule: over 3,000 changed lines is an automatic fail (MODEL_ROUTING.md 8.2, tgp-agent-context). #656 was 5,611 lines at `86223987` (FIX ROUND 5). Stack: T1 -> T2 -> T3, merged back to back; deploy only after T3, together with mobile #338. Owner adds the Stripe webhook event `customer.subscription.trial_will_end` before that deploy. The tree at T3 equalled #656 @ 86223987 (checked with git diff) until fix round 6, which adds the T1/T2 fixes. Prior verdicts on #656 (Sol RC 0/4/1 at b9939d02; no full Opus audit) do not carry; each piece needs fresh Opus 5.5 and Sol audits at its exact head (T4, money path). `tsc --noEmit` passes at every piece.

**T1 (this PR, base main, 2,291 lines after fix round 6):** schema + migrations 20270228000000_package_free_trials and 20270313000000_package_trial_truth (with down.sql), trial rules, checkout capability, usage ledger service, diagnostics, copy and view, deletion-manifest entries, test fakes, and the one-trial-rule spec (20/20 pass locally). One assertion of that spec (PackagesModule provides and exports TrialCheckoutCapability) and its import are held back to T2, where the module wiring lands; the final file is unchanged. Inert: nothing is registered in a module. The migrations do apply on deploy (additive).




