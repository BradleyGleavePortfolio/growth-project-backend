# _COMMON_122 — common brief for every agent 122 worker (read fully, then ONLY your entry in JOBS122.md)

Operator: agent 122, 2026-10-05 from 15:06 PDT. OWNER CHANGE 15:15: agent 122 runs ALONE over both repos (growth-project-backend
and growth-project-mobile); agent 123 starts only after 122 ends. Push only to the repo and PRs your entry names. The one document is TGP_SOURCE_OF_TRUTH.md on tgp-agent-context main (local clone
/home/user/workspace/tgp-agent-context; `git -C /home/user/workspace/tgp-agent-context pull -q` first). Read its A1 (owner standing
rules), the two OWNER OVERRIDES at the top of A2 (EDGE-CASE FREEZE items 1-6, RUTHLESS SCOPE items 7-11), and A5 rules 11 and 12.
Older briefs: /home/user/workspace/ops/lanes121/_COMMON_121.md (this file replaces it for you), ops/lanes116/_COMMON_116.md (section 8 =
lens comment format).

Owner goal 14:50 PDT: launch path 4/7 by end of day "truly, without cutting corners". Owner rules that matter most: recurring packages
are the most critical item of all; hyperscaler quality; wall clock is resource number one. Never name the clinic partner anywhere (all
repos are PUBLIC). Spend no money. Product copy: no first person, no emojis, no exclamation marks, no generic errors.

1. gh and git need bash with api_credentials=["github"]. Commit identity:
   `git -c user.name="Bradley Gleave" -c user.email="bradley@bradleytgpcoaching.com" commit ...`, no AI co-author trailer (identity is
   never a gate). Comment first lines name your job and "agent 122", e.g.
   `FIX ROUND 1 (B-DUNR3-122, agent 122) — growth-project-backend#689 @ <full sha>`,
   `RESTACK (B-DUNR3-122, agent 122) — growth-project-backend#688 @ <full sha>`,
   `AUDIT Claude Opus 5.5 — growth-project-backend#687 @ <full sha> — VERDICT: APPROVE` /
   `AUDIT GPT-6.1 Sol — growth-project-backend#690 @ <full sha> — VERDICT: REQUEST CHANGES`
   (then A/B/C counts, findings with ids like B-<pr>-<n>, file:line, the one-sentence normal-user story for every B, probe/run links).
2. Paths: locks/claims/notify in /home/user/workspace/ops/lanes122/{locks,claims,notify}; lens notes and probes in
   /home/user/workspace/ops/aud-122/<JOB>/; your report /home/user/workspace/ops/reports/<JOB>.md (keep it current; end with
   "## HANDOFF" so a fresh agent can continue if you die). Prior reports: /home/user/workspace/ops/reports/*-121.md, *-120.md and older.
3. Sandbox: 2 CPU / 7.9 GB shared with up to 8 agents + the operator. Shared backend deps: /home/user/workspace/deps/backend (a READY
   file appears when the install is done; until then read code and use CI lanes). Link with
   `/home/user/workspace/ops/link_deps.sh backend <worktree>` then `/home/user/workspace/ops/heavy.sh npx prisma generate` inside it.
   Main clone /home/user/workspace/growth-project-backend: never change its checkout; use
   `git -C /home/user/workspace/growth-project-backend worktree add /home/user/workspace/wt/<JOB>-<n> <ref>`. Remove your worktrees
   (check for unsaved work first) and delete your own ci/* and audit/* branches when done.
4. CI lanes first: lenses run NO local npm/jest/tsc/eslint/builds except the single-spec fallback in item 11; probes go through
   `/home/user/workspace/ops/ci-lane/ci_lane.sh backend <worktree> <ci/<JOB>-<n> or audit/<JOB>/<n>> <spec...>`. Builders run local
   work only via /home/user/workspace/ops/heavy.sh, one targeted jest file at a time; NEVER a full suite and NEVER full-project tsc
   locally (it runs out of memory): full tsc and full suites run in the PR's own CI or in a lane (`.ci-lane-tsc` in the lane spec list
   if the workflow supports it; see ops/ci-lane/backend-ci-lane.yml). Poll CI no faster than every 60 s. Prefer REST
   (`gh api repos/BradleyGleavePortfolio/growth-project-backend/...`) when GraphQL returns 502.
5. Size (SoT A1.2): a PR opened after 12:33:16 PDT 10-04 fails above 1,500 changed lines (tests count; lockfiles, generated files,
   snapshots excluded). Older PRs never go over 3,000. Check size before every push. Dunning headroom: #687 2,674, #688 2,784,
   #689 2,913, #690 2,913, #691 2,742 (all grandfathered 3,000); #724 1,133 and #725 117 (1,500 rule).
6. FREEZE + RUTHLESS SCOPE (SoT A2 items 1-11, binding): a finding is a B only if it happens in normal use (ordinary taps, ordinary
   network, one person acting at a time, launch-size traffic) AND the result is money wrong/lost/given away, private/health/payment data
   to the wrong person, a safety or crisis routing miss, data loss or corruption, a security hole an ordinary user or outsider can reach,
   an App Store/Play/legal failure, a false customer-facing claim, or a core flow (sign up, sign in, pay, book, message, train, coach
   payouts) that breaks or dead-ends for a normal user. Spend zero time on time zones, DST, midnight/date boundaries, clock skew,
   same-instant or two-device races, webhooks arriving twice or out of order, lease/timer windows, crash-mid-write recovery, cache sizes,
   extreme volume, odd input combinations, old app builds, extra defence on guarded paths, missing tests for working code: no search, no
   probes, no analysis; if noticed, one line "C (edge, deferred to 10k clients)". Every B states in one plain sentence how an ordinary
   user hits it on a normal day and what goes wrong. Re-reviews check only prior Bs and the changed lines. One fix round is the target.
   Builders fix item-list problems only: no edge hardening, probes or tests unless a lens B asks.
7. Time boxes: delta re-review 20 min, full review of one PR 30 min, a whole train 45 min. Read the code paths that move money, data,
   access and safety first; skim the rest. Verdicts short: Bs first, Cs as a one-line list.
8. Lenses: independent. Never read the other lens's notes, report or comment for this round before posting your own verdict. One
   verdict per PR per exact head; verify the head right before posting; if it moved, review the delta and post at the new head, or stop
   and tell the operator. Claim before auditing: `touch /home/user/workspace/ops/lanes122/claims/backend-<n>-<head8>-<opus|sol>`.
9. Never: merge; deploy; change branch protection, settings, environments or production flags; run fly-deploy.yml, fly-secrets-set.yml or
   fly-env-sync; touch production, Fly, Supabase, Stripe, Expo or EAS; start a build; spend money; edit lockfiles unless your entry says so;
   close PRs; touch PRs outside your entry; push to a repo your entry does not name; use a time you did not get from
   `TZ=America/Los_Angeles date`.
10. Final answer under 250 words: PR(s), exact head(s), verdict or round, A/B/C counts, comment URL(s), CI state, follow-up Cs, operator
    decisions needed (each with your recommended default).
11. CI queue discipline: at most one ci-lane run in flight per agent (all probes for a round in one push); never push a PR head only to
    re-trigger CI; one push per PR per round; cancel your own lane runs you no longer need. If a lane has not started 20 minutes after
    you pushed it, a lens may run that single spec through heavy.sh (never a full suite) and say so in the verdict.
12. Stop order: when the operator sends "WRAP UP" (or your time box ends), within 10 minutes push complete work, post status comments,
    finish your report with ## HANDOFF, remove worktrees, release locks, and give your final answer.
