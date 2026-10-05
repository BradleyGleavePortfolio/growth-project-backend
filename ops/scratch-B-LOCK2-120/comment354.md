FIX ROUND 2 (restack, merge-only) (B-LOCK2-120, agent 120) — growth-project-mobile#354 @ 68c7f080c1e7e7708e7c3b213ae9278b57ba3649

Merge-only: #353's new head `9d47045b` merged into this branch (merge commit `68c7f080`, clean, no conflict, no other change). PR diff vs #353 is unchanged: `nativeCardUpdate.test.tsx` only, +1119 / -0 = 1,119 changed lines.

| Finding | Change | Commit | Test |
|---|---|---|---|
| none on #354 | merge of the fixed L2 (FIX ROUND 2 on #352 `c89f719c` and #353 `9d47045b`) | 68c7f080 | `nativeCardUpdate.test.tsx` 41/41 at this head (local targeted run) and in PR CI |

Probe replay: this PR carries no probes of its own; both lenses' #352 and #353 probes were replayed at `9d47045b` (the tree under this merge plus this test file): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37344434190 (145/146; the 1 is Sol 119 Boundaries probe 1, an old "does not settle" anchor superseded by Opus B-352-7, see #352).

Money list:
- Webhook order and redelivery: unchanged (tests only).
- Concurrency and lock order: unchanged; the suite's initStripe / initPaymentSheet order checks still pass with the new shared-sheet owner in #352.
- Terminal states: unchanged; payment end-plan body still "Your access ends now".
- Pagination and fail-closed completeness: unchanged.
- Currency and minor units: unchanged.
- Copy truth: unchanged in this PR; dispute copy changed in #352 / #353 only.

Checks at `68c7f080`: Typecheck, lint, test pass (https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37344796375) (the required check on a stacked base).

READY FOR AUDIT
