# Agent 119 wave — common rules (operator agent 119). Read FULLY, then /home/user/workspace/ops/lanes116/_COMMON_116.md (still
# binding except where this file or _COMMON_118.md differs), then ONLY your entry in /home/user/workspace/ops/lanes119/JOBS119.md.

Owner (Bradley), 10-04 first prompt to agent 119: resume; up to 5 agents in parallel; "one job = one agent = one or two PRs, then it
ends". Recurring packages are "LITERALLY MOST CRITICAL OF ALL"; never one-time-only. Hyperscaler quality or it is a day-1 blocker; wall
clock is resource #1; more functionality, not less. Never name the clinic partner anywhere. Spend no money. Copy: no first person, no
emojis, no exclamation marks, no generic errors.

## Differences from _COMMON_116.md and _COMMON_118.md
1. Operator is agent 119. Commit identity per AGENT_RULES.md G05 (the LAW):
   `git -c user.name="Bradley Gleave" -c user.email="bradley@bradleytgpcoaching.com" commit ...` and no AI co-author trailer
   (identity is not a gate: never stop or comment about it). Comment first lines say "agent 119" and your 119 job id, e.g.
   `FIX ROUND 2 (B-SHEET2-119, agent 119) — growth-project-mobile#342 @ <full sha>` or
   `AUDIT Claude Opus 5.5 — growth-project-backend#683 @ <full sha> — VERDICT: APPROVE` (lens first line per _COMMON_116 section 8).
2. Locks/claims/notify: /home/user/workspace/ops/lanes119/{locks,claims,notify}. Stack locks: fees, recur, coach, sheet, dunning,
   trials, hc, lockout, wizard. Lens notes: /home/user/workspace/ops/aud-119/<JOB>/. Reports: /home/user/workspace/ops/reports/<JOB>.md
   (end with "## HANDOFF"). Keep your report current as you go: if you die, a fresh agent continues from it.
3. Facts verified by the operator 12:20-12:27 PDT 10-04: production = backend 3e9a9a75f8ec2071526555af068e7fad36cd09e6 (fly-deploy run
   37225983355; /health ok, /readyz db up); _prisma_migrations 189 rows (2 April baseline rows rolled back, 0 pending), latest
   20270301000000_notification_zone_provenance_reminder_generation; StripeProcessedEvent 0 rows; Supabase plan Free. Backend main
   3e9a9a75, mobile main cc4ceeed. All 54 open stack PR heads match handoffs/op-118/HANDOFF_AGENT_119.md section 3. CI queue empty.
4. Agent 118 stopped CLEANLY at 12:03 PDT 10-04 (no agents running, nothing half-pushed). Its claims and locks do not apply. Its
   reports (ops/reports/*-118.md), lens notes and probes (ops/aud-118/) and PR comments are evidence you must read. B-SHEET2-118 was
   cancelled before any push.
5. FREEZE: every stack is under review. Builders fix only A and B findings (plus a C only when it is the same lines as a B fix).
   Every other C goes into your report under "## Follow-ups (C)" with file:line and fix rule; the operator tickets them.
6. Before READY FOR AUDIT a builder (a) replays every prior probe from BOTH lenses on its PRs and states pass/fail per probe in the
   FIX ROUND comment; (b) self-checks the money list, one line per item in the FIX ROUND: webhook order and redelivery; concurrency
   (two workers, lock order); terminal states (refunded, disputed, canceled, deleted account); list pagination and completeness (fail
   closed on incomplete Stripe lists); currency (presentment vs settlement, minor units, zero-decimal currencies); copy truth (no claim
   before proof). Get it right once.
7. Size: over 3,000 changed lines (additions + deletions; lockfiles/generated/snapshots excluded; tests count) is an automatic fail
   with NO grandfathering. Check `gh pr view N --json additions,deletions` and your local diff before every push. 1,500-3,000: say so in
   the FIX ROUND; the operator posts the SIZE ASSESSMENT. PRs within 75 lines of 3,000 (#682, #688, #687, #683, #685, #672, #364, and
   mobile #343 at 2,813): your entry says where new tests go; never push one over.
8. Known infra failures are fixed on main (#694 jest OOM, #695 SBOM race). A stacked piece may still hit them: rerun the failed job
   ONCE, then investigate. Never relabel a regression a flake.
9. Rule 12: a pure main merge where every PR file stays byte-identical needs no new lens verdict (operator MERGE-ONLY TREE CHECK).
   Restacks of split pieces onto another PR branch, fix rounds and conflict resolutions are NOT covered: lenses post a short delta.
10. Deps: /home/user/workspace/deps/<backend|mobile>/READY (installing; read code first). Sandbox shared by up to 5 agents plus the
    operator (2 CPU, 7.9 GB): heavy.sh for everything heavy, targeted jest only, never full tsc/jest locally; lenses run NO heavy local
    work (CI lane: /home/user/workspace/ops/ci-lane/ci_lane.sh). Repos in /home/user/workspace/repos are shared: worktrees only
    (/home/user/workspace/wt/<JOB>-<n>), never change a main clone's checkout. Delete your own ci/* and audit/* branches when your job
    ends.
11. Notify files: when a builder finishes a stack piece that another job restacks onto, write ONE line to
    /home/user/workspace/ops/lanes119/notify/<stack>.txt: "<stack> top: #<n> @ <full sha> (<JOB>, <time from date>)".
12. Binding ruling R-DISPUTE-PAUSE (owner 12:01 PDT 10-04, DECISION_LOG.md): a dispute on any charge of a recurring plan (whether or
    not a renewal ever failed) immediately pauses all billing for that plan and ends the client's access; no automatic restore when
    the dispute closes; the coach restarts access separately. One-time purchases unchanged. OR-111-1 still applies. Any copy about
    disputes on recurring plans must say exactly that (access has ended, billing is paused, the coach decides on restarting).
13. Final answer under 250 words: PR(s), exact head(s), verdict or round, A/B/C, comment URL(s), CI state, follow-up Cs, operator
    decisions (with your recommended default).
