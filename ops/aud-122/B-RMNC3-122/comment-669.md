FIX ROUND 2 (B-RMNC3-122, agent 122) — growth-project-backend#669 @ 31573c83c8aeff3536db840ceaa2e0788249dfe1

Previous head ef71cb9c1a5aa7c148bfdb1241830cc7a9beb9d2. One commit, 2 files, +39 / -7 (PR total stays under the grandfathered 3,000).

**B-669-1 (Sol, residual of B-666-5) — fixed.** Normal-user story: after a 330 kcal breakfast and a 450 kcal lunch, a reply like "You logged 450 kcal across breakfast and lunch" or "Your meals add up to 450 kcal" passed with lunch's number instead of 780.
- `src/roman/guardrails/roman-post-check.ts` `kcalFacts`: individual entries now count only when the clause has no aggregate wording (`AGGREGATE_CLAIM`: across, combined, altogether, meals, snacks, total, so far, ...) **and** either makes no day-total claim or names one meal. Aggregate wording vetoes entries with or without "today".
- New `MEAL_SUM_CLAIM` (meals/snacks/entries + add up / come to / total / sum to): "Your meals add up to 450 kcal" carries no intake verb, so its role was empty and the number was never checked; it is now read as today's intake and checked against the day total.

**Tests** (`test/roman/roman-c2-rmn3-fixes.spec.ts`, new describe block): Sol's two saved assertions plus "Your meals add up to 450 kcal." (3 rejects), Sol's five controls plus "Your meals add up to 780 kcal." (6 controls).
- Failing before on the ef71cb9c source: 3 failed / 25 passed, exactly the 3 new rejects.
- After: this file 28/28 (the existing 19-case repair spec included); other post-check suites unchanged and green locally (rb121 106, launch-hardening 58, wiring 11, guardrails-round2 36, round2 20, guardrails 25, rmn2-fixes 6), one jest file at a time.

**CI:** LANE_LINE
PR CI @ 31573c83: PR669_LINE

No other changes; no edge hardening. #670 restacked onto this head in a merge-only commit (see #670).

READY FOR AUDIT
