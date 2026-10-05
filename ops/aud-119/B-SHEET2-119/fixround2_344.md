FIX ROUND 2 (restack, B-SHEET2-119, agent 119) — growth-project-mobile#344 @ 25af65691fbf60a3501a77624de8eafd0ccd81d3

Restack of split S3 onto the FIX ROUND 2 heads of #342 (`0b1985f4`) and #343 (`19678ce7`). No S3 source change.

- `a1b30d4` merge of #343 `19678ce7` (clean; brings main `cc4ceeed`, #342 FIX ROUND 2 and #343 FIX ROUND 2).
- `a2c3c98` test only: `src/components/__tests__/PackageSelectionSheet.contrast.test.tsx` carried byte-identical from #343 (moved up so #343 stays under 3,000 lines; `git diff fd739d58 25af6569 -- src/components/__tests__/PackageSelectionSheet.contrast.test.tsx` is empty).
- `25af656` test only: `PackageSelectionSheet.subscription.test.tsx` "a network failure keeps the key for the retry" now expects the B-342-1 no-answer copy ("The app could not reach the server, so this step is not confirmed. ...") instead of the removed "nothing was charged" sentence. Its key-reuse assertion is unchanged.

Size: +1,909 / -247 = 2,156 changed lines (tests included), inside the 1,500-3,000 band.

Required checks at this head: Typecheck, lint, test https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37229617205 pass (CodeQL runs only on main-based PRs).

The two test-only commits are not merge-only; the operator decides whether they need a short lens delta (recommended: a short delta from each lens, since they are 2 files of tests only).

READY FOR AUDIT (restack)
