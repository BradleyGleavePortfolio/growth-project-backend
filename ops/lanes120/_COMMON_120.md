# Agent 120 wave — common rules (operator agent 120). Read FULLY, then /home/user/workspace/ops/lanes119/_COMMON_119.md (still
# binding except where this file differs; it in turn points to _COMMON_118/_COMMON_116), then ONLY your entry in
# /home/user/workspace/ops/lanes120/JOBS120.md.

Owner (Bradley), 10-05 to agent 120: take over 119's in-flight work; push every PR through the audit cycle; merge only when both lenses
are clean at the exact head; up to 15 agents in parallel; "one job = one agent = one or two PRs, then it ends". Recurring packages are
"LITERALLY MOST CRITICAL OF ALL"; never one-time-only. Use GitHub CI lanes for parallel work; the sandbox is shared. Never name the
clinic partner anywhere. Spend no money. Copy: no first person, no emojis, no exclamation marks, no generic errors.

## Differences from _COMMON_119.md
1. Operator is agent 120. Commit identity (AGENT_RULES G05):
   `git -c user.name="Bradley Gleave" -c user.email="bradley@bradleytgpcoaching.com" commit ...`, no AI co-author trailer (identity is
   not a gate: never stop or comment about it). Comment first lines say "agent 120" and your job id, e.g.
   `FIX ROUND 2 (B-TR7-120, agent 120) — growth-project-backend#707 @ <full sha>` or
   `AUDIT Claude Opus 5.5 — growth-project-backend#661 @ <full sha> — VERDICT: APPROVE` /
   `AUDIT GPT-6.1 Sol — growth-project-mobile#369 @ <full sha> — VERDICT: REQUEST CHANGES` (lens format: _COMMON_116 section 8).
2. Locks/claims/notify: /home/user/workspace/ops/lanes120/{locks,claims,notify}. Stack locks: secrets (#661/#702), coach, dunning,
   trials, hc, lockout, wizard, programs. Lens notes: /home/user/workspace/ops/aud-120/<JOB>/. Reports:
   /home/user/workspace/ops/reports/<JOB>.md (end with "## HANDOFF"; keep it current: if you die, a fresh agent continues from it).
3. Facts verified by the operator 09:13-09:27 PDT 10-05 (GitHub, Fly health, Supabase read-only):
   - Production = backend f48267f9 (fly-deploy run 37240806383, 15:43 PDT 10-04; fees landed). /health ok, /readyz db up.
   - Backend main ee55f814 (recurring #678 merged 16:32 PDT 10-04 with #679/#680/#696/#701; CI green). NOT deployed yet. Its two
     migrations (20270225000000_native_subscription_trials, 20270311000000_subscription_checkout_terms) are not applied.
   - _prisma_migrations: 190 rows (2 April baseline rows rolled back), 0 pending, latest applied
     20270301000000_notification_zone_provenance_reminder_generation. StripeProcessedEvent 0 rows. Supabase plan Free.
   - Mobile main cc4ceeed. CI queue empty in both repos at 09:20.
4. Agent 119 died at about 16:42 PDT 10-04 without a handoff for its last hour. Its last builders pushed and DIED BEFORE COMMENTING:
   B-661R-119 (#661 bc399edd, #702 9ddda117), B-CM6-119 (#674 9e8a3a6b, #676 296067fb, #677 921299fe, #703 b16021ab) and the dunning
   main refresh (#687 f3c7fd37, #688 5003e7e6, #704 32d886bb). A push with no FIX ROUND / RESTACK comment is unfinished work: treat the
   code as unverified until you have checked it yourself. Their claims and locks do not apply. Reports *-119.md, lens notes and probes
   in ops/aud-119/ and every PR comment are evidence you must read.
5. FREEZE (unchanged): builders fix only A and B findings (plus a C on the same lines as a B fix). Every other C goes into your report
   under "## Follow-ups (C)" with file:line and fix rule.
6. Builders before READY: replay every prior probe from BOTH lenses on your PRs (pass/fail per probe in the comment) and self-check the
   money list (webhook order/redelivery; concurrency and lock order; terminal states; pagination and fail-closed completeness;
   currency and minor units; copy truth). Get it right once.
7. Size (owner 12:33 PDT 10-04): PRs opened after 12:33:16 PDT 10-04 fail automatically above 1,500 changed lines (lockfiles,
   generated files and snapshots excluded; tests count). Grandfathered PRs keep their 3,000 ceiling: never push one over 3,000. Check
   before every push. #673 is at 2,999 and #362 at 2,983: new tests go to the PR your entry names.
8. CI LANES FIRST (owner 10-05). The sandbox is 2 CPU / 7.9 GB shared by up to 15 agents plus the operator.
   - Lenses: NO local npm, jest, tsc, eslint or builds. Read code locally; run every probe in a GitHub CI lane:
     /home/user/workspace/ops/ci-lane/ci_lane.sh <backend|mobile> <worktree> <branch> <spec...>
   - Builders: local work only through /home/user/workspace/ops/heavy.sh, one targeted jest file or one tsc project at a time; full
     suites run in the PR's own CI or a lane, never locally.
   - Lane branches: a NEW unique name per run (ci/<JOB>-<n> or audit/<JOB>/<n>); never reuse a name, never force-push a PR branch.
   - Wait for CI with `gh run watch <id> --exit-status` or a sleep loop of at least 60 s between polls; never poll faster.
   - Deps: /home/user/workspace/deps/backend (READY) and /home/user/workspace/deps/mobile (installing; READY file appears when done).
   - Worktrees only: /home/user/workspace/wt/<JOB>-<n>; never change a main clone's checkout. Remove your worktrees and delete your
     own ci/* and audit/* branches when your job ends.
9. gh: GraphQL often returns 502; prefer REST (`gh api repos/BradleyGleavePortfolio/<repo>/...`). `gh pr view --json` works most of
   the time; on 502 retry once, then use REST.
10. R-DISPUTE-PAUSE (owner 12:01 PDT 10-04) is binding: a dispute on any charge of a recurring plan immediately pauses all billing for
    that plan and ends the client's access; no automatic restore when it closes; the coach restarts access separately. One-time
    purchases unchanged. OR-111-1 still applies. Dispute copy on recurring plans says exactly that.
11. Never: merge; deploy; change branch protection, settings or production flags; touch production, Fly, Supabase, Stripe, Expo or
    EAS; start a build; spend money; edit lockfiles unless your entry says so; touch PRs outside your entry; use a time you did not get
    from `date` (America/Los_Angeles).
12. Final answer under 250 words: PR(s), exact head(s), verdict or round, A/B/C counts, comment URL(s), CI state, follow-up Cs,
    operator decisions (with your recommended default).
