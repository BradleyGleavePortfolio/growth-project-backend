# Agent 117 wave — common rules (operator agent 117). Read FULLY, then /home/user/workspace/ops/lanes116/_COMMON_116.md (still binding
# except where this file differs), then ONLY your entry in /home/user/workspace/ops/lanes117/JOBS117.md.

Owner (Bradley), 10-03 21:20 PDT: resume the fleet; up to 15 agents in parallel; "one job = one agent = one or two PRs, then it ends".
Recurring packages are "LITERALLY MOST CRITICAL OF ALL"; never one-time-only. Hyperscaler quality or it is a day-1 blocker; wall clock
is resource #1; more functionality, not less. Never name the clinic partner anywhere. Spend no money. Copy: no first person, no emojis,
no exclamation marks, no generic errors.

## Differences from _COMMON_116.md
1. Operator is agent 117. Commit identity: `git -c user.name="TGP Agent 117" -c user.email="agent@tgp.invalid" commit ...`
   (identity is not a gate). Comment first lines say "agent 117" and your 117 job id.
2. Locks/claims/notify live under /home/user/workspace/ops/lanes117/{locks,claims,notify}. Stack locks: fees, recur, coach, dunning,
   trials, wear. Lens notes: /home/user/workspace/ops/aud-117/<JOB>/. Reports: /home/user/workspace/ops/reports/<JOB>.md (end with
   "## HANDOFF").
3. Facts verified by the operator 21:21-21:30 PDT 10-03: production = backend main a5b605d1aa86f3afcece6061dc0502f20b83f27e (deployed,
   /health ok, /readyz db up); _prisma_migrations 189 rows, latest 20270301000000_community_win_coach_matcher finished; mobile main
   367e6c48dac676151400d4d4b9959c4cc3c7586a. 116-era drafts and probes: /home/user/workspace/ops/aud-116/<116 JOB>/ and
   /home/user/workspace/ops/reports/<116 JOB>.md (the 116 report named in your entry is your evidence trail; it ends with ## PAUSE STATE).
4. Known infra failures (rerun the failed job ONCE, then investigate): jest worker out of memory (fixed by #694, not merged yet);
   SBOM gate SIGPIPE race in test/ci/delivery-artifact.spec.ts ("required runtime package ... missing", fixed by #695, not merged yet).
   Never relabel a regression a flake.
5. Rule 12 (owner 21:15): a pure main merge where every PR file stays byte-identical needs no new lens verdict (operator MERGE-ONLY
   TREE CHECK). Restacks of split pieces, fix rounds and conflict resolutions are NOT covered: lenses post a short merge-only delta.
6. Deps: /home/user/workspace/deps/<backend|mobile>/READY may still be installing at launch; read code first. Sandbox is shared by 15
   agents (2 CPU, 7.9 GB): heavy.sh for everything heavy, targeted jest only, never full tsc/jest locally; lenses run NO heavy local work
   (use the CI lane: /home/user/workspace/ops/ci-lane/ci_lane.sh). Delete your own ci/* and audit/* branches when your job ends.
7. Final answer under 250 words: PR(s), exact head, verdict or round, A/B/C, comment URL, CI state, operator decisions (with default).
