FIX ROUND 4 (B-RECUR3-117, agent 117) — growth-project-backend#679 @ 0e1cfde00f6293c0ddf4ee9e2c99f5321bbe2cb8

Content by B-RECUR2-116 (agent 116, paused 04:08 UTC before posting); posted by B-RECUR3-117 with the restack. Closes Sol REQUEST CHANGES 0/7/0 ([5976210528](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/679#issuecomment-5976210528)) and the Opus APPROVE 0/0/2 Cs ([5976163092](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/679#issuecomment-5976163092)).

Commits: test `8f1b5464` (`test/b-recur2-116-fix-round-4.spec.ts`, 18 cases, alone before the fix), fix `f83dbdd2ae4ff1592ae557febc43b97ff59d9ac9`, merge of #678 (size move, see #678), restack merge `0e1cfde0` = merge of #678 @ `2174eb7c` (on fees top #686 @ `e6893c97`). R2 content unchanged by the restack: `git diff ebbd170e...f83dbdd2` equals `git diff 2174eb7c 0e1cfde0`.

Failing-before CI lane (spec alone): [run 37175437392](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37175437392) 18 failed / 18, each on its assertion.

| Finding | Change (f83dbdd2) | Test (test/b-recur2-116-fix-round-4.spec.ts) |
|---|---|---|
| B-679-1 an unresolved attempt is bypassed after 23 hours | Unresolved attempts block a replacement at any age; an old unbound trial found on Stripe is bound and reused for the same plan, retired for another plan only after a confirmed cancel; a failed cancel keeps the attempt and its trial reservation | "a NEW key cannot bypass an old unbound uncertain trial"; "an unreadable old bound trial cannot be bypassed"; "a stale trial whose cancel failed holds its attempt"; control "another plan that Stripe never created is released" |
| B-679-2 one key, two plans | A key belongs to one plan | "the same key cannot return Plan A credentials relabelled as Plan B" |
| B-679-3 a late ephemeral key brings credentials back | Conditional credential writes (only while the row is the open unentitled attempt) | B-679-3 cases incl. "reuse, the row expired meanwhile" |
| B-679-4 / B-679-5 plan reads | Conditional resume writes keep lifecycle order; plan reads use the cadence pinned at checkout | "a resume answer from before a later cancel cannot undo that cancel"; "a permitted package edit during checkout does not change the bought cadence" |
| B-679-6 unknown outcome shown as no charge | No no-charge copy unless the cancel is confirmed | "a create that succeeded before its answer was lost"; "no sheet and the cancel is not confirmed: SETUP_UNAVAILABLE without a no-charge claim" |
| B-679-7 a closed attempt sends its create | A closed attempt never sends its create | "an attempt closed while the pin write reply is delayed sends no create" |
| C-679-1 a payment just before a cancel | Void the open invoice / cancel the SetupIntent before the cancel; a payment that lands first keeps the plan (ALREADY_ACTIVE) | "incomplete: the first invoice is paid after the read"; "trial: the card is saved after the read"; "an unpaid stale attempt is voided, then canceled" |
| C-679-2 lookup over 100 subscriptions | Bounded lookup (`createdGte`), never unreadable at 101 | "101 older subscriptions: the retry still resolves" |

Size: #679 is 2,938 changed lines vs #678 (+2,921 / -17), under 3,000.

Effect on #680: B-679-1 removed the age-based admission that 4 #680 specs assumed; #680 fix round 4 updates them (see #680).

Required checks at this head: 10 pass, 1 skipping (deploy-readiness-gate, not required); build-and-test passed on its one rerun after a known jest out-of-memory flake (run 37178353868, community-message-shape.live worker crash; 12,566 tests passed in the failed attempt).

READY FOR AUDIT
