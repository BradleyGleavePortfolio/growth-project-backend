# Agent 116 wave — common rules for every job (15 agents in flight). Read FULLY before working. This file wins over older lane files.

Operator: agent 116 (Perplexity Computer session 9dcf27cd), single writer for operator state since 2026-10-03 19:15 PDT.
Owner (Bradley), 2026-10-03 19:20 PDT, verbatim: "start with 15 paralized agents on the biggest jobs".
Owner, 2026-10-03 19:25 PDT, verbatim: "dont use agents on multiple PR's - it takes away from the depth of scrutiny if they just did
one or two PR's per turn".
So every agent has ONE job of one or two PRs: /home/user/workspace/ops/lanes116/JOBS.md, the entry named in your launch message.
Read it right after this file. Never work on any PR outside your job (reading a neighbouring piece for context is fine). Depth over
breadth: you have time to read every line of your PR(s), trace every call site, and prove findings. When your job is done, END; the
operator launches a fresh agent for the next head or the next PR.

## 0. What governs you (in this order)
1. LAW: /home/user/workspace/repos/tgp-agent-context/AGENT_RULES.md (G01-G22). Above everything.
2. PROCESS: MODEL_ROUTING.md (T0-T4; section 8.2 PR size gate) in the same repo.
3. Owner standing orders: OPERATOR_STANDING_ORDERS.md and MERGE_DEPENDENCY_GUIDE.md (rule 11 = split stacks land as one).
4. Current truth: handoffs/op-115/HANDOFF_AGENT_116.md sections 0.1 (launch path), 3.2 (binding rulings), 12 (split pieces),
   and the lane report of the agent 115 lane that last owned your PRs: handoffs/op-115/reports/<LANE>-115.md (each ends with HANDOFF).
5. Older product decisions: handoffs/op-114/LEDGER-72H.md (binding; newest wins). Verbatim owner quotes: DECISION_LOG.md.
GitHub (PR heads, FIX ROUND and AUDIT comments) is the truth over any file. tgp-agent-context is PUBLIC and read-only for you.

## 1. Owner bar (binding)
"ANYTHING LESS THAN HYPERSCALER QUALITY IS A DAY 1 BLOCKER / WALL CLOCK TIME IS KEY #1 RESOURCE / DO IT RIGHT, DO IT SMOOTH -
SMOOTH IS FAST / I WANT MORE, NOT LESS FUNCTIONALITY". Pristine Apple-level UX. Recurring packages are "LITERALLY MOST CRITICAL OF
ALL"; never one-time-only. No generic errors (every failure says what happened and a working next action; unknown = short reference
+ support path + Sentry without PII). Copy: no emojis, no exclamation marks, no first person ("we", "our", "write to us").
Never name the clinic partner anywhere (say "the clinic partner"). Never commit the coach welcome text. Spend no money.

## 2. Facts verified 19:15-19:17 PDT 10-03 (re-verify before acting)
- Production backend = backend main = d23fa31773f2e7f14781d243db35067d949f421a (deployed 11:57 PDT; /health ok, /readyz db up).
  Mobile main = 367e6c48dac676151400d4d4b9959c4cc3c7586a. Required checks green on both mains (release-please red: ignore).
- Production _prisma_migrations: 188 rows, 0 unfinished, latest 20270301000000. 20270307000000 (push) NOT applied.
  Production has 1 app user (the system coach) and 0 Connect accounts.
- Backend required checks (11, strict up to date): build-and-test, rls-floor-guard, rls-live-tests, mwb-3-live-tests, npm audit
  (high+critical, whole graph), CodeQL JS/TS, Banned cast tokens, build-sbom, danger, Schema parity, community-live-tests. CodeQL,
  danger, banned casts and build-sbom run only on PRs based on main. Mobile required (3): Typecheck, lint, test; Analyze
  (javascript-typescript); Analyze (actions).
- Known flakes (rerun the failed job ONCE with `gh run rerun <id> --failed`, then investigate; never relabel a regression a flake):
  jest worker out of memory (community-message-shape.live.spec.ts and others); provider-wiring symlink spec (C-664-1);
  test/ci/release-evidence-gate.spec.ts:367. Schema parity "base commit ... is not in the checkout" = stale base: tell the operator.
- GitHub account: personal, Free plan, 20 concurrent Actions jobs shared by everyone. CI minutes are the shared bottleneck.

## 3. Workspace, git, identity
- Full clones: /home/user/workspace/repos/{growth-project-backend,growth-project-mobile,tgp-agent-context}. `git fetch` first.
  gh and git need bash api_credentials=["github"]. Owner: BradleyGleavePortfolio. Prefer `gh api` with explicit paths if a gh
  subcommand falls back to unauthenticated calls.
- Your worktrees only: /home/user/workspace/wt/<JOB>-<n>. Never touch the main clones' checkouts or another job's worktree.
  Remove your worktrees when done (unlink node_modules first, then `git worktree remove --force`).
- Commit identity: `git -c user.name="TGP Agent 116" -c user.email="agent@tgp.invalid" commit ...` (identity is not a gate;
  owner ruling 2026-09-28; never stop or comment about identity).
- Merge with merge commits. Never force-push a PR branch, never rebase a pushed branch, never push to main.
- Shared deps: wait for /home/user/workspace/deps/<backend|mobile>/READY (installing at launch; read code first), then
  `/home/user/workspace/ops/link_deps.sh <backend|mobile> <worktree>`; backend then `/home/user/workspace/ops/heavy.sh npx prisma generate`.
  If your branch changes package.json or the lockfile, do not install: report to the operator.

## 4. Sandbox limits (a sandbox crash is a tier-1 incident)
2 CPUs, 7.9 GB RAM, 20 GB disk (about half used at launch), shared by 15 agents.
- EVERY heavy command through /home/user/workspace/ops/heavy.sh (never wrap it in a short timeout). Targeted jest only
  (`heavy.sh npx jest --runInBand --ci <files>`), eslint/prettier on changed files only. NEVER run full tsc or the full jest suite
  locally. GitHub CI runs them.
- `df -h /` at the start of each work block; above 85 percent: stop heavy work and write it in your report.
- Lenses do NO heavy local work at all (read code, run probes in CI).

## 5. GitHub CI lanes (owner 2026-10-03: "use github CI lanes for speed")
- Proofs and probes run in the one-job CI lane, not locally and not as full ci.yml dispatches:
  `/home/user/workspace/ops/ci-lane/ci_lane.sh <backend|mobile> <your worktree> <ci/<JOB>-<pr>-<what> | audit/<JOB>/<pr>-<what>> <spec> [spec...]`
  Commit what you want tested first (e.g. PR head + new failing test, without the fix). The script pushes a throwaway branch with a
  one-job workflow and prints the run id/URL. Watch: `gh run watch <id> -R BradleyGleavePortfolio/<repo> --exit-status`.
- Full `gh workflow run ci.yml --ref <branch>` only for live-DB suites (rls-live, community-live, mwb-3). Never dispatch fly-*,
  release-please, h4-readiness or anything that deploys or sets secrets. Cancel your own superseded runs. Delete your ci/* and
  audit/* branches when your job ends.

## 6. Polling and credits (owner watches a daily credit budget)
- PR state: `/home/user/workspace/ops/prstate.sh <backend|mobile> <n>` (90 s shared cache). Sleep 150-300 s between polls; never
  tighter. Only wait when your job says so (e.g. "stay for the refreshed head"); otherwise finish and end.
- No redundant re-reads of large diffs; keep notes in your report as you go.

## 7. Builder contract (jobs named B-*; Claude Opus 5.5; T4 unless your job says otherwise)
1. You are the sole writer of the PR branch(es) in your job. Content changes go only into your job's PRs (max two). A mechanical
   restack (merging your fixed piece branch upward into later pieces of the same stack, no content edits beyond honest conflict
   resolution) is allowed and posted as `FIX ROUND <k> (restack, merge-only)`. Take the stack lock first:
   `mkdir /home/user/workspace/ops/lanes116/locks/<stack>` (stacks: fees, trials, recur, coach, dunning, wear, programs, lockout,
   wizard, cmoney, sheet), remove it when the restack is pushed. If the lock exists, wait (poll every 3 min).
2. Before coding, read every AUDIT and FIX ROUND comment on your PRs (and on the original PR a piece was split from); list each open
   finding (A/B/C) from BOTH lenses at their latest verdict heads.
3. Close every A and B (and every cheap C) with code plus a test that FAILS before and PASSES after (failing-before run in the CI lane;
   cite its URL). Get it right once: the next verdict from both lenses must be APPROVE. More functionality, never less.
4. Pre-push checklist: (a) no free-form text, emails, tokens or message bodies reach logs/Sentry/analytics (ids and codes only);
   (b) every await followed by a state write re-checks account/session identity; (c) cancellation and unmount races covered by a test;
   (d) copy rules (section 1); (e) failing-before test per finding; (f) your diff stays under the size limits (section 9).
5. One comment per PR per round, first line exactly: `FIX ROUND <k> (<JOB>, agent 116) — <repo>#<n> @ <full 40-char sha>`, then a
   finding -> change -> commit -> test table. Update the PR body tier header and Fix round table. End the comment with the line
   `READY FOR AUDIT` ONLY when every required check is green at that exact head (red-by-design pieces: say which check is red by
   design and which later piece turns it green). Merge-only rounds: `FIX ROUND <k> (merge-only) ...`.
6. SPLIT STACKS (pieces of an original PR): fix each finding in the piece where the code lives (if it lives in a piece outside your
   job, write it in your report for the operator instead), first merge any newer lower piece into yours, then restack upward (rule 1).
   Never retarget or merge a piece into main: the operator lands stacks (rule 11).
7. New PRs: tier header in the body (Tier / Why / T4 trigger scan / T3 trigger scan / Bounded T1 / Canonical builder / Parent owner /
   Acceptance evidence / Promotion triggers), Conventional Commits title (danger is required), base main unless your job says
   otherwise, and post READY FOR AUDIT when green.
8. Strict branch protection: the OPERATOR merges and runs mechanical update-branch. If your own PR is DIRTY, you resolve it with a
   merge commit and post a merge-only FIX ROUND.
9. Push progress at least every 20 minutes (green -> PR branch; otherwise wip/<JOB>-<topic>) and keep your report current.
10. You END when READY FOR AUDIT is posted on your job's PR(s) at green heads (or you are blocked and your report says why). Do not
   wait for verdicts, merges or deploys: a fresh builder takes the next round with your report as its handoff.

## 8. Lens contract (jobs named AUD-*; Claude Opus 5.5 or GPT-6.1 Sol as named; independent of every builder)
- Verdict comment, first line exactly:
  `AUDIT <Claude Opus 5.5 | GPT-6.1 Sol> — <repo>#<n> @ <full 40-char sha> — VERDICT: APPROVE | REQUEST CHANGES | BLOCK`
  then `A/B/C = x/y/z` and findings with IDs `<A|B|C>-<pr>-<k>` (A blocker, B must fix before merge, C optional), each with
  file:line, a concrete counterexample or probe (CI-lane run URL when you proved it), and the minimal fix rule. APPROVE only with
  zero A and zero B. Re-read the head right before posting; if it moved, audit the new head. One verdict per PR per head.
- Audit your job's PR(s) at their current heads even if the other lens already posted REQUEST CHANGES there (the builder waits for
  both verdicts). CLAIM before you start a head: `mkdir /home/user/workspace/ops/lanes116/claims/<backend|mobile>-<n>-<head8>-<opus|sol>`. If mkdir
  fails, another lens of your model owns that head: skip it.
- First decide your lens's prior findings on that PR and on the original it was split from (closed with code + failing-before test,
  or not). Then audit at the tier in the PR body, raised by the max-tier rule (money, auth, privacy, tenancy, health data, deletion,
  CI gate files = T4).
- EVIDENCE REUSE (G09, your decision, recorded in the verdict): a split piece's code that is byte-identical to code your MODEL's lens
  already approved on the original PR (verify with git diff against that approved head) may rest on that evidence; you must still
  (1) read the full piece diff for piece-boundary safety (compiles alone, inert or flag-gated until wired, its tests come with it,
  nothing imports a later piece, migrations additive and correctly ordered), (2) audit deeply every line changed since your lens's
  last APPROVE on the original (fix rounds, main merges, split edits), and (3) audit fully any code your lens never approved. Never
  copy the other lens's verdict. State in the verdict which evidence you reused and why it applies.
- RED BY DESIGN pieces (backend #682, #683; mobile #349, #350; named in JOBS.md): do not wait for green. Verify the red checks fail only for the stated reason (which spec,
  why, which later piece carries its update) and say so in the verdict. Everything else at that head must be green.
- Merge-only and restack heads: short delta check. Confirm `git diff <your last verdict head> <new head>` adds nothing beyond main's
  merged commits (or the lower piece's merged fix) plus any conflict resolution (read every conflict hunk), then post a verdict at the
  new head. Fast but real.
- Findings outside the diff: C "outside this diff" unless they make the PR unsafe. A finding that belongs to another PR goes in your
  report for the operator; it never blocks the PR under review (guide rule 9).
- Probes: branch from the exact PR head to audit/<JOB>/<pr>-<probe>, add the probe spec only, run via ci_lane.sh, cite the run URL.
  Notes under /home/user/workspace/ops/aud-116/<JOB>/. Never push to a PR branch.
- END after your verdict(s) are posted, unless your job says to stay for a named next head. A fresh lens of your model audits later
  fix rounds using your report and verdict as its evidence trail, so make both complete (every finding: file:line, counterexample,
  fix rule, how to verify the fix).

## 9. PR size (owner, MODEL_ROUTING 8.2)
Additions + deletions; lockfiles, generated files and snapshots excluded; tests count. A NEW PR over 3,000 lines fails automatically
(lenses post REQUEST CHANGES "SIZE FAIL (over 3,000 lines)" without review). 1,500-3,000: the operator posts a SIZE ASSESSMENT.
New PRs target under ~800 lines of non-test source. Existing split pieces are within the limit; a fix round must not push one over 3,000.

## 10. Binding rulings (newest wins; full list LEDGER-72H.md, HANDOFF_AGENT_116.md 3.2)
- Fee = price - actual Stripe fee - 2%; $19.99 floor or free. Native PaymentSheet subscriptions (default_incomplete, first-invoice
  PI); never one-time-only. Real free trials: coach sets 0-30 days, card up front, one per client per coach, trial-ending notice.
  Apple Pay / Google Pay in the sheet off by config until the merchant id exists.
- Refund/chargeback (OR-111-1): coach alert with exact amounts; reverse that charge's own transfer; forward-only netting from the next
  transfers; no payout delay, no negative-balance debits.
- Dunning: retries Days 1/3/7; Day-10 lockout; 1A card update during dunning auto-charges the open invoice and unlocks on success;
  2A cancel during dunning voids the invoice and ends access now; voluntary cancel keeps access to period end; free/code grants never
  enter dunning.
- Shared code: #654/#628 never-entitled check -> the second to merge unifies into one helper. #322/#334 ClientPackagesScreen.tsx -> the
  second keeps the native card-update screen. #675 (coach M2) and #672 (trials T2) both change packages.service/controller -> the
  second to merge refreshes. C-661-3 and C-656-1: whichever of the pair merges second carries the combined behaviour.
- OR-115-1 neutral roman.safety_route action + restricted reason code; OR-115-2 crisis templates without box-2 consent.
- #611 owner answers O-611-1..6 (HANDOFF 3.2): deletion paragraph approved, deletion startable in-app or by email; no Anthropic
  zero-retention (30-day sentence); Mux listed; backups plan-agnostic; Stripe redaction, Sentry 90 days, Resend 30 days, PostHog
  analytics on and session recording off; de-identified aggregate retention with a public no-re-identification commitment.
- Health Connect ships in the clinic binary on day 1 (owner 10-03 18:42). AI chats kept until the client deletes them or the account.
- Migrations: additive only; new migrations in this wave take a timestamp newer than 20270316000000 and ask the operator in the report
  if unsure; anything holding a user id goes into the deletion manifest.

## 11. Never
Merge; change branch protection, required checks, repo settings or production flags; touch production, Fly, Supabase, Stripe, Expo or
EAS; start any build; spend money; dispatch any workflow outside section 5; edit lockfiles unless your job says so; touch importer,
Dependabot, annex (#655, #657-#660) or Roman PRs unless your job says so; use timestamps you did not get from `date`.

## 12. Reports and final answer
Report: /home/user/workspace/ops/reports/<JOB>-116.md (your job id, e.g. AUD-OPUS-F12-116.md). Append as you finish each PR (head, verdict or round, comment URL, CI run
URLs, open items). End with "## HANDOFF" (exact state + next step of each PR in your job). Nothing private in reports.
Final answer (under 300 words): your PR(s), exact head, verdict/round, A/B/C counts, comment URL, CI state, and anything the operator
must decide (with your recommended default).
