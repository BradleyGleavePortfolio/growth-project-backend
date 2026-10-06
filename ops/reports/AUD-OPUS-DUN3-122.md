# AUD-OPUS-DUN3-122 — dunning b#687 main merge check (Opus lens, agent 122)

- Started 17:13:50 PDT, verdict posted 17:19:52 PDT (time box 12 min).
- PR: growth-project-backend#687 @ aa736434287c7ebcf2b68e87ee8a0b5dabf2b015 (head checked right before posting).
- Claim: ops/lanes122/claims/backend-687-aa736434-opus
- Verdict: **APPROVE (merge-only)**, A 0 / B 0 / C 1
- Comment: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-6006319846
- Notes and probe files: ops/aud-122/AUD-OPUS-DUN3-122/ (the base, dunning, main and merge copies of both files, the merge-file result, comment.md, banned-cast.log)

## Findings
- The merge commit's parents are exactly 0716a0f4 (tree d5d8d95c = audited #691 top) and a70533d5 (the main tip). No other non-main commit is in the range.
- For every file changed by only one side, the blob at the merge equals that side's blob. The only files changed by both sides are prisma/schema.prisma and src/common/env-validation.ts.
- For both files, a git merge-file 3-way merge is clean and byte-identical to aa736434, and the line sets are an exact union. No duplicate models, enums or env names were added. The 16 duplicate env names that exist were already present at the merge base.
- Migrations: dunning 20270215000000 sorts before main's 20270301000000 and 20270302000000, but they touch disjoint tables, so they are independent. The forward-apply, schema parity and reversible checks are green.
- CI: the required check "Banned cast tokens (R75 / R100.A2)" is RED (job 112041698871, empty-catch-undefined net +2). It comes from 4 `.catch(() => undefined)` sites in the dunning train (client-billing.service.ts:1955 and :1970, dunning-r3-money-truth-e2e.spec.ts:1086, dunning-v2-dispute-pause.spec.ts:345). The merge did not cause it: those files are byte-identical to 0716a0f4. At 17:19, build-and-test and CodeQL were still in progress and everything else was green.

## Operator decisions
- Making R75 green needs a code commit, so rule 12 cannot carry this merge over by itself. Recommended default: B-DUNFIX-122 replaces the 4 sites with logged or named handlers in one commit, then a delta lens review of only those lines.

## HANDOFF
The work is done. The verdict is posted at aa736434, and I created no worktrees or branches. Remaining items are outside this lens: the operator follows up on the red R75 check and on build-and-test and CodeQL finishing. If the head moves, a fresh lens reviews only the delta.
