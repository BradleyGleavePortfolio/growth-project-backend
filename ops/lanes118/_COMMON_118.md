# Agent 118 wave — common rules (operator agent 118). Read FULLY, then /home/user/workspace/ops/lanes116/_COMMON_116.md (still
# binding except where this file differs), then ONLY your entry in /home/user/workspace/ops/lanes118/JOBS118.md.

Owner (Bradley), 10-04 09:31 PDT: resume; up to 15 agents in parallel; "one job = one agent = one or two PRs, then it ends".
Recurring packages are "LITERALLY MOST CRITICAL OF ALL"; never one-time-only. Hyperscaler quality or it is a day-1 blocker; wall clock
is resource #1; more functionality, not less. Never name the clinic partner anywhere. Spend no money. Copy: no first person, no emojis,
no exclamation marks, no generic errors.

## Differences from _COMMON_116.md and _COMMON_117.md
1. Operator is agent 118. Commit identity per AGENT_RULES.md G05 (the LAW):
   `git -c user.name="Bradley Gleave" -c user.email="bradley@bradleytgpcoaching.com" commit ...` and no AI co-author trailer
   (identity is still not a gate: never stop or comment about it). Comment first lines say "agent 118" and your 118 job id, e.g.
   `FIX ROUND 15 (B-FEES15-118, agent 118) — growth-project-backend#682 @ <full sha>`.
2. Locks/claims/notify: /home/user/workspace/ops/lanes118/{locks,claims,notify}. Stack locks: fees, recur, coach, sheet, dunning,
   trials, wear. Lens notes: /home/user/workspace/ops/aud-118/<JOB>/. Reports: /home/user/workspace/ops/reports/<JOB>.md (end with
   "## HANDOFF"). Keep your report current as you go: if you die, a fresh agent continues from it.
3. Facts verified by the operator 09:33-09:45 PDT 10-04: production = backend 643817b3586e27ad95cc3c519733fc14d0aaafde (fly-deploy run
   37178577858; /health ok, /readyz db up); _prisma_migrations 189 rows, 0 unfinished, latest
   20270301000000_notification_zone_provenance_reminder_generation; backend main b644198b90bb9ab1dc62a78794e12cf09f8ace7c (CI-only
   changes since the deploy: #694 jest memory, #695 SBOM gate); mobile main 7fdb629a798d44e76475dbece1b14e68f360ab91. CI queue empty.
4. Agent 117 and every agent it ran are DEAD (last GitHub action 00:56 PDT 10-04). Their claims and locks do not apply. Their ci/*-117
   and audit/*-117 branches and their PR comments are evidence you must read. A dead lens's unposted probe is evidence for you (builders:
   replay it; lenses of the same model: reuse it after re-running), never a verdict.
5. FREEZE: every stack in this wave is under review. Builders fix only A and B findings (plus a C only when it is the same lines as a B
   fix). Every other C goes into your report under "## Follow-ups (C)" with file:line and fix rule; the operator tickets them.
6. Before READY FOR AUDIT a builder (a) replays every prior probe from BOTH lenses on its PRs, including the dead-lens probe branches named
   in its job entry, and states pass/fail per probe in the FIX ROUND comment; (b) self-checks the money list and writes one line per item
   in the FIX ROUND: webhook order and redelivery; concurrency (two workers, lock order); terminal states (refunded, disputed, canceled,
   deleted account); list pagination and completeness (fail closed on incomplete Stripe lists); currency (presentment vs settlement,
   minor units); copy truth (no claim before proof). Sol found new Bs in almost every money round: get it right once.
7. Size: over 3,000 changed lines (additions + deletions; lockfiles/generated/snapshots excluded; tests count) is an automatic fail with
   NO grandfathering (owner, v8 handoff). Check `gh pr view N --json additions,deletions` and your local diff before every push.
   1,500-3,000: say so in the FIX ROUND; the operator posts the SIZE ASSESSMENT.
8. Known infra failures are fixed on main (#694 jest OOM, #695 SBOM race). A stacked piece may still hit them: rerun the failed job
   ONCE, then investigate. Never relabel a regression a flake.
9. Rule 12 (owner 21:15 10-03): a pure main merge where every PR file stays byte-identical needs no new lens verdict (operator MERGE-ONLY
   TREE CHECK). Restacks of split pieces onto another PR branch, fix rounds and conflict resolutions are NOT covered: lenses post a
   short merge-only delta.
10. Deps: /home/user/workspace/deps/<backend|mobile>/READY (installing at launch; read code first). Sandbox shared by up to 15 agents
    (2 CPU, 7.9 GB): heavy.sh for everything heavy, targeted jest only, never full tsc/jest locally; lenses run NO heavy local work
    (CI lane: /home/user/workspace/ops/ci-lane/ci_lane.sh). Repos in /home/user/workspace/repos are shared: worktrees only
    (/home/user/workspace/wt/<JOB>-<n>), never change a main clone's checkout. Delete your own ci/* and audit/* branches when your job ends.
11. Notify files: when a builder finishes a stack piece that another job restacks onto, write ONE line to
    /home/user/workspace/ops/lanes118/notify/<stack>.txt: "<stack> top: #<n> @ <full sha> (<JOB>, <time from date>)".
12. Final answer under 250 words: PR(s), exact head(s), verdict or round, A/B/C, comment URL(s), CI state, follow-up Cs, operator
    decisions (with your recommended default).
