FIX ROUND 1 (restack, merge-only) (B-LOCK-118, agent 118) — growth-project-mobile#354 @ f084cc0f8b1dbd4768d2ca168f0b49a90dc39cfe

Merge-only restack onto the fixed L2 head: merge commits `ea1e0ebd` (L2 @ `0dce9ed2`) and `f084cc0f` (L2 @ `05d84f27`). No source or test edits in this PR: the diff vs its base (#353 @ 05d84f27) is still exactly `src/entitlements/dunning/__tests__/nativeCardUpdate.test.tsx`, +1119 / -0, byte-identical to the previously audited file at `37ed3d56`. Size 1,119.

Merge-only delta for the lenses (rule 12 does not cover a restack): what changed underneath is #352 FIX ROUND 1 (`ac244d22`) and #353 FIX ROUND 1 (`0dce9ed2`, `05d84f27`); see those comments. This suite runs against the new code and passes unchanged: the L1 copy keeps every string it pins ("Your next payment will use it", "$150.00 is charged to it right away" for a payment lock, "You keep full access", "If a payment is overdue", `endPlanAlertBody` "Your access ends now" / "end of the period you already paid for"), and its quoted-string first-person guard still passes.

Probe replay: no lens probes target #354 (the #352 / #353 probes are replayed on those PRs, all pass).

Money list: unchanged by this round (tests only); see #352 and #353.

Checks at f084cc0f: Typecheck, lint, test pass (https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37220988372). Stacked base: this is the only required check.

READY FOR AUDIT
