# _COMMON_121 — common brief for every agent 121 worker (read fully, then ONLY your entry in JOBS121.md)

Operator: agent 121 (session 8a21c288). Owner EXECUTE 12:35 PDT 2026-10-05: 15 agents in parallel. The one document is
TGP_SOURCE_OF_TRUTH.md on tgp-agent-context main (local clone /home/user/workspace/tgp-agent-context; `git pull` first). Read its A1
(owner standing rules), A6 (decisions in force) and A9.1 (agent 120 common brief: binding except where this file differs). Older briefs
it points to: /home/user/workspace/ops/lanes116/_COMMON_116.md (section 8 = lens comment format), ops/lanes118, ops/lanes119, ops/lanes120.

Owner rules that matter most: recurring packages are "LITERALLY MOST CRITICAL OF ALL"; hyperscaler quality; wall clock is resource
number one; more functionality, not less. Never name the clinic partner anywhere. Spend no money. Product copy: no first person, no emojis,
no exclamation marks, no generic errors. One job = one agent = one or two PRs, then it ends.

## Differences from A9.1 (agent 120 brief)
1. Operator is agent 121. gh and git need bash with api_credentials=["github"]. Commit identity:
   `git -c user.name="Bradley Gleave" -c user.email="bradley@bradleytgpcoaching.com" commit ...`, no AI co-author trailer (identity is
   never a gate). Comment first lines name your job and "agent 121", e.g.
   `FIX ROUND 2 (B-MSG-FIN-121, agent 121) — growth-project-backend#708 @ <full sha>` or
   `AUDIT Claude Opus 5.5 — growth-project-backend#674 @ <full sha> — VERDICT: APPROVE` /
   `AUDIT GPT-6.1 Sol — growth-project-backend#693 @ <full sha> — VERDICT: REQUEST CHANGES` (findings A/B/C with ids, file:line, probe).
2. Paths: locks/claims/notify in /home/user/workspace/ops/lanes121/{locks,claims,notify}; lens notes and probes in
   /home/user/workspace/ops/aud-121/<JOB>/; your report /home/user/workspace/ops/reports/<JOB>.md (keep it current; end with
   "## HANDOFF" so a fresh agent can continue if you die). Prior reports: /home/user/workspace/ops/reports/*-120.md (and older).
3. Facts verified by the operator 12:04-12:10 PDT 10-05 (GitHub, Fly health, Supabase read-only):
   - Production = backend main 5da537d6 (#661 + #702, deployed 11:44). /health ok, /readyz db up. Mobile main b79ca594 (Health
     Connect H1-H8 merged 11:29).
   - _prisma_migrations: 190 applied, 0 pending, latest 20270311000000_subscription_checkout_terms. Production rows: User 1,
     ClientPurchase 0, StripeProcessedEvent 0, native trials 0, CoachingSession 0. CoachMessage RLS on + forced with policy
     coach_message_participant_access.
   - New conflicts with main: b#671 (ci.yml), m#342 (config/expected-env.json), b#657 (fly manifest, ci.yml, launch-flags.md), m#331
     (src/services/authActions.ts).
   - Agent 120's GitHub auth failed 11:58-12:3x: anything it wrote after 11:45 that is not on GitHub is lost (including the B-MSG2-120
     FIX ROUND 2 drafts). GitHub PR heads, commits and comments are the only evidence.
4. Sandbox: 2 CPU / 7.9 GB shared by 15 agents + the operator. Shared deps: /home/user/workspace/deps/{backend,mobile} (installing at
   12:40; a READY file appears when done; until then read code and use CI lanes). Link with /home/user/workspace/ops/link_deps.sh.
   Main clones /home/user/workspace/growth-project-{backend,mobile} (also /home/user/workspace/repos/...): never change their checkout;
   use `git -C <clone> worktree add /home/user/workspace/wt/<JOB>-<n> <ref>`. Remove your worktrees and delete your own ci/* and audit/*
   branches when done.
5. CI lanes first: lenses run NO local npm/jest/tsc/eslint/builds; probes go through
   /home/user/workspace/ops/ci-lane/ci_lane.sh <backend|mobile> <worktree> <branch ci/<JOB>-<n> or audit/<JOB>/<n>> <spec...>.
   Builders run local work only via /home/user/workspace/ops/heavy.sh, one targeted jest file or one tsc project at a time; full suites
   run in the PR's own CI. Poll CI no faster than every 60 s. Prefer REST (`gh api repos/BradleyGleavePortfolio/<repo>/...`) when GraphQL
   returns 502.
6. Size (TGP_SOURCE_OF_TRUTH A1.2): a PR opened after 12:33:16 PDT 10-04 fails above 1,500 changed lines (tests count; lockfiles,
   generated files, snapshots excluded). Older PRs never go over 3,000; a NOT-READY older PR over 3,000 is split into pieces of 1,500 or
   less. New split pieces: under 1,500 each, target under about 800 lines of non-test source. Check size before opening and before every
   push. Headroom: b#674 2,995/3,000, b#673 2,996/3,000, b#693 2,965/3,000: new tests go to the tests-only PR your entry names.
7. FREEZE: builders fix only A and B findings (plus a C on the same lines as a B fix). Other Cs go into your report under
   "## Follow-ups (C)" with file:line and fix rule. Builders replay every prior probe from both lenses and self-check the money list
   (webhook order/redelivery; concurrency and lock order; terminal states; pagination and fail-closed completeness; currency and minor
   units; copy truth) before READY FOR AUDIT. Get it right once.
8. Lenses: independent. Never read the other lens's notes or comment for this round before posting your own verdict. One verdict per PR
   per exact head; if the head moves while you work, stop that PR and tell the operator in your final answer. Claim before auditing:
   `touch /home/user/workspace/ops/lanes121/claims/<repo>-<n>-<head8>-<opus|sol>`.
9. Never: merge; deploy; change branch protection, settings or production flags; touch production, Fly, Supabase, Stripe, Expo or EAS;
   start a build; spend money; edit lockfiles unless your entry says so; close PRs; touch PRs outside your entry; use a time you did not
   get from `date` (TZ=America/Los_Angeles).
10. Final answer under 250 words: PR(s), exact head(s), verdict or round, A/B/C counts, comment URL(s), CI state, follow-up Cs, operator
    decisions needed (each with your recommended default).
