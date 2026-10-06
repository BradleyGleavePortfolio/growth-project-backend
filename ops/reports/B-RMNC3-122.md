# B-RMNC3-122 — #669 fix B-669-1 + restack #670 (agent 122, builder Opus)

Started 17:45:46 PDT (TZ=America/Los_Angeles date). Time box 25 min.

## Job
B-669-1 (Sol RC 6006755911 on #669 ef71cb9c, residual of B-666-5): `src/roman/guardrails/roman-post-check.ts` let
individual meal entries validate a summing claim whenever the clause lacked day-total wording ("You logged 450 kcal
across breakfast and lunch" passed with lunch's 450 instead of 780). Then restack #670 (merge #669 only).

## Fix (#669 new head 31573c83c8aeff3536db840ceaa2e0788249dfe1, parent ef71cb9c)
- `kcalFacts`: entry values count only when the clause has NO aggregate wording (AGGREGATE_CLAIM: across, combined,
  altogether, meals, snacks, total, so far, ...) AND (no day-total claim OR one named meal). Aggregate wording therefore
  vetoes entries with or without "today".
- New `MEAL_SUM_CLAIM` (meals/snacks/entries + add up / come to / total / sum to): "Your meals add up to 450 kcal" has no
  intake verb, so its role was empty and it was never checked; now it is read as today's intake and checked against the
  day total.
- Diff: 2 files, +39 / -7. #669 total ~1,650 changed lines (grandfathered 3,000).

## Tests (heavy.sh, one jest file at a time)
- New describe block in `test/roman/roman-c2-rmn3-fixes.spec.ts`: Sol's 2 saved assertions + "Your meals add up to
  450 kcal." (3 rejects) and Sol's 5 controls + "Your meals add up to 780 kcal." (6 controls).
- Failing-before on ef71cb9c source: 3 failed / 25 passed (exactly the 3 new rejects) —
  ops/aud-122/B-RMNC3-122/before-ef71cb9c.log.
- After fix: roman-c2-rmn3-fixes 28/28 (incl. existing 19-case repair spec), roman-guardrails-rb121 106/106,
  roman-launch-hardening 58/58, roman-guardrails-wiring 11/11, roman-guardrails-round2 36/36, roman-round2 20/20,
  roman-guardrails 25/25, roman-rmn2-fixes 6/6 — logs in ops/aud-122/B-RMNC3-122/after-*.log.

## Restack (#670 new head 30f097477f1ab7ba54dec43fe048bab57972e715)
Merge-only: parents dc159eaf (old #670 head) + 31573c83 (new #669 head); `git diff dc159eaf 30f09747` equals the #669
fix delta (same 2 files, +39 / -7). No C3 file changed.

Disclosure: the #670 push went out at 17:51:23, 38 s after the #669 push at 17:50:45, not the requested 2+ minutes.
One push per PR held.

## CI
- Lane ci/B-RMNC3-122-1 (lane commit 20088519, sole parent #670 head 30f09747; specs test/roman, test/ai-consent, 2
  dunning lockout specs, + full tsc): run 37396178179 — PENDING.
- #669 PR CI @ 31573c83: PENDING. #670 PR CI @ 30f09747: PENDING.

## Comments
- #669 FIX ROUND 2: pending
- #670 RESTACK: pending

## HANDOFF
State: both pushes done; lane + PR CI pending; comments not yet posted. Next: poll
`gh api repos/BradleyGleavePortfolio/growth-project-backend/actions/runs/37396178179/jobs` and
`gh pr view 669/670 --json statusCheckRollup` (not gh run view/pr checks), post FIX ROUND 2 on #669 and RESTACK on #670
ending READY FOR AUDIT, delete branch ci/B-RMNC3-122-1 after the lane completes, remove worktrees
wt/B-RMNC3-122-669 and wt/B-RMNC3-122-670, release lock ops/lanes122/locks/backend-669-670-B-RMNC3-122.lock.
