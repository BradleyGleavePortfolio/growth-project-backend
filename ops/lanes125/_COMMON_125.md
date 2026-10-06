# _COMMON_125 — common brief for every agent 125 worker (read fully, then ONLY your entry in /home/user/workspace/ops/lanes125/JOBS125.md)

Operator: agent 125, 2026-10-06 from 13:47 PDT. Agent 125 runs ALONE over both repos (growth-project-backend, growth-project-mobile).
Owner order 13:50 10-06 (verbatim): "start one agent to audit every single one of these areas, seperately, in depth." Then "EXECUTE".
Owner 12:33 (to agent 124): "We are nearing IOS launch and need final QA passes and fixes!" Owner 12:01: "TOP PRIOTY for the food and
workout logging to be kick ass, and for the flow of money to be BULLETPROOF".

The one document is TGP_SOURCE_OF_TRUTH.md on tgp-agent-context main (clone: /home/user/workspace/tgp-agent-context). It is 900+ KB:
read ONLY A1 (owner standing rules), the two OWNER OVERRIDES at the top of A2 (EDGE-CASE FREEZE items 1-6, RUTHLESS SCOPE items 7-11),
and A6 (decisions in force). Do not read the rest unless your entry tells you to.

## The product and the launch
- TGP: a 1:1 personal-training platform. Coaches sell packages (recurring packages are the most critical item of all), schedule
  sessions, message clients, build programs and meal plans, get paid through Stripe Connect. Clients train, log food and workouts, log
  health data (Apple Health, Health Connect), chat with Roman (the AI coach persona, a butler and friend), join the community and pay.
  Backend: NestJS + Prisma + Postgres (Supabase) on Fly. Mobile: React Native / Expo, iOS and Android.
- The store build is Wed 10-07 from mobile main: BOTH iOS and Android build from eas.json profile "clinic" (it extends "production" and
  adds Health Connect, the client tutorial, coach brief and consultation onboarding). CORRECTED 14:20: an earlier version of this line
  said iOS uses "production"; that was wrong. EXPO_PUBLIC_FF_* values are fixed at build time (read eas.json for what is on).
- Production backend flags = backend .github/fly-env-desired-state.json on main ("true" = on; "unset" = off unless the code default is on).
  ON today: community core (API/POSTS/MESSAGES/PUSH/REALTIME), FEATURE_MESSAGING_CORE_V2, FEATURE_ROMAN_CHAT_ENABLED,
  FEATURE_ROMAN_ADJUST_ENABLED, booking reminders, programs (MWB templates/autosave, named regimes), wearables ingest, AI consent ledger,
  FEATURE_COACH_CODE_TOOLS, FEATURE_COACH_BROADCASTS, FEATURE_COACHLESS_HOME. OFF: FEATURE_DUNNING_V2 (turns on after an owner Stripe
  step; b#762), DMs, voice notes, importer, Google Calendar/Meet. Verify in the file; it wins over this list.
- Production = backend ec12a4b3 (deploy 14). Backend main 1ce430b9 = production + b#771 (flag-off Roman playbook schema). Mobile main
  a1904f2f. Open PRs from agent 124's last wave (NOT yours; do not push to them; do not duplicate their fixes): backend b#762, b#776-b#785;
  mobile m#402, m#404-m#415. Run `gh pr list --repo BradleyGleavePortfolio/growth-project-<repo> --state open` and read the titles and
  diffs of any that touch your area BEFORE you fix anything. If an open PR already fixes your finding, write "covered by <PR>" and move on.
  If your fix must touch the same file as an open PR, keep your change minimal and name the overlap in your PR body.
- Owner = Bradley Gleave. He IS the featured coach (code GP-BRADLEY). Never name the clinic partner anywhere (all repos are PUBLIC).
  Never print secret values (names only). Spend no money.

## What you hunt (binding: SoT A2 overrides 1-11, plus the owner's hyperscaler bar)
- B (must fix before launch): a normal user, on a normal day (ordinary taps, ordinary network, one person at a time, launch-size traffic),
  hits: money wrong/lost/given away; private, health or payment data shown to the wrong person; a safety or crisis routing miss; data
  loss or corruption; a security hole an ordinary user or outsider can reach; an App Store / Play / legal failure; a false
  customer-facing claim; a core flow (sign up, sign in, pay, book, message, train, log food, coach payouts) that breaks or dead-ends.
  Every B states in ONE plain sentence how an ordinary user hits it and what goes wrong for them. If you cannot say it that way, it is
  not a B.
- U (fix if small and safe): a defect a normal user notices on the happy path that makes the app feel less than Apple-level: a dead or
  mislabelled button, a screen with no loading/empty/error state, a generic error ("Something went wrong") instead of a specific one, a
  wrong or misleading number, a spinner that never ends, copy that contradicts what the app does, a broken navigation target, an
  obviously confusing flow. Product copy rules: no first person, no emojis, no exclamation marks, no generic errors.
- C: everything else. Weird edge cases (time zones, DST, midnight, clock skew, two-device or same-instant races, retries, webhooks twice
  or out of order, lease/timer windows, crash-mid-write, cache sizes, extreme volume, odd inputs, old app builds, extra defence on
  guarded paths, missing tests for working code) get ZERO time: no search, no probes, no analysis. If noticed: one line,
  "C (edge, deferred to 10k clients)".
- Read the paths that move money, private data, access and safety first. Trace the area as a real user would on the 10-07 build: every
  screen, button, empty state, error state and the backend route behind it (controller -> service -> Prisma), with flags as they will be.

## How you work
1. gh and git need bash with api_credentials=["github"]. GitHub GraphQL can 502: prefer REST (`gh api repos/BradleyGleavePortfolio/...`).
   Use `gh api repos/<o>/<r>/actions/runs/<id>/jobs` and `gh pr view N --json statusCheckRollup`, NOT `gh run view`, `gh run watch` or
   `gh pr checks` (those hit an unauthenticated 60/hour IP limit). Poll CI no faster than every 60 s.
   If gh/git returns 401 "Bad credentials", do not retry in a loop: keep work committed locally, write it in your report, tell the operator.
2. Read code in the READ-ONLY checkouts: /home/user/workspace/wt/RO-backend (backend main 1ce430b9) and /home/user/workspace/wt/RO-mobile
   (mobile main a1904f2f). Never edit, check out or build in them, or in the main clones /home/user/workspace/growth-project-*.
3. To fix: create your own worktree with an ABSOLUTE path from origin/main:
   `git -C /home/user/workspace/growth-project-<repo> fetch -q origin main && git -C /home/user/workspace/growth-project-<repo> worktree add -b agent125/<job-lower>-<short> /home/user/workspace/wt/<JOB>-<repo> origin/main`
   Commit identity: `git -c user.name="Bradley Gleave" -c user.email="bradley@bradleytgpcoaching.com" commit ...`, no AI co-author trailer.
4. Sandbox: 2 CPU / 7.9 GB shared with ~20 agents. Shared deps: /home/user/workspace/deps/backend and /home/user/workspace/deps/mobile
   (a READY file appears when the install finishes; until then read code and use CI). Link with
   `/home/user/workspace/ops/link_deps.sh <backend|mobile> <worktree>`; backend then `/home/user/workspace/ops/heavy.sh npx prisma generate`
   inside the worktree. Run local work ONLY through /home/user/workspace/ops/heavy.sh, ONE targeted jest file at a time. NEVER a full
   suite, NEVER full-project tsc or eslint locally (out of memory). Full suites and tsc run in the PR's own CI. Extra targeted runs:
   `/home/user/workspace/ops/ci-lane/ci_lane.sh <backend|mobile> <worktree> ci/<JOB>-<n> <spec...>` (new branch name each run; at most
   one lane run in flight; delete your ci/* branches at the end).
5. PRs: at most TWO (one backend, one mobile), each on main, each UNDER 800 changed lines (hard fail above 1,500: additions + deletions,
   tests count, lockfiles/generated/snapshots excluded). Check size before every push. Conventional Commits title (Danger). R75: no new
   `as any` / `as unknown as` / `as never`, no empty `.catch(() => undefined)`. Tests that fail on main where behaviour changes. No
   lockfile edits, no new dependencies, no migrations unless truly required (then additive only, timestamp newer than 20270402000000).
   Mobile changes must work against the CURRENT production backend (capability check or graceful fallback), because the mobile build
   may ship before the backend deploys. No new feature flags that would leave a fix off at launch.
   PR body starts with the tier header (SoT A3 section 8.1): Tier, Why, T4 trigger scan, T3 trigger scan, Bounded T1, Canonical builder,
   Acceptance evidence. Then the B/U list it fixes, each with its one-sentence user story.
   Push once, wait for PR CI green, then post ONE comment whose first line is exactly:
   `FIX ROUND 1 (OPENING) (<JOB>, agent 125) — growth-project-<repo>#<n> @ <full head sha> — READY FOR AUDIT`
   If CI is red from your change, fix and push again (say so in the comment). If red from main or infra, say which check and why.
6. Promotion (SoT A3 section 9): if you are GPT-6.1 Sol and a fix needs a T4 change (auth, RLS/tenancy, PII, money, credentials,
   destructive data), do NOT build it: write the finding, the exact file:line and the smallest fix in your report for the operator to
   route to a Claude Opus 5.5 builder. Claude Opus 5.5 workers may build T4 fixes.
7. Never: merge; deploy; run fly-deploy.yml, fly-secrets-set.yml or fly-env-sync; change branch protection, settings, environments or
   production flags; touch production, Fly, Supabase, Stripe, Expo or EAS; start a build; spend money; close PRs; push to PRs you did not
   open; comment on PRs you did not open; use a time you did not get from `TZ=America/Los_Angeles date`.
8. Report: /home/user/workspace/ops/reports/<JOB>.md, kept current as you go. Sections: Scope traced (screens + routes), B list, U list,
   C one-liners, "Covered by open PRs", PRs opened (number, head, lines, CI), "Not fixed (needs operator)" with file:line + smallest fix,
   and a final "## HANDOFF" so a fresh agent can continue if you die. When done write one line to
   /home/user/workspace/ops/lanes125/notify/<JOB>.txt: `done | PRs: <list or none> | B=<n> U=<n> | needs operator: <n>`.
9. Time box: 80 minutes total from your start (audit about 35, fix about 45). Mobile fixes must reach READY FOR AUDIT early so they can be
   reviewed and merged before the 10-07 build. At the time box, or when the operator sends "WRAP UP": within 10 minutes push complete
   work, post READY or STATUS comments, finish the report, remove your worktrees (check for unsaved work first), release locks.
10. Final answer to the operator, under 200 words: PR(s) + exact heads + line counts + CI state, B/U/C counts, the top 3 findings in one
    line each, anything that needs an operator or owner decision (each with your recommended default).
