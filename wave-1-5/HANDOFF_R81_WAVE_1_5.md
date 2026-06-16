# HANDOFF — R81 Wave 1.5 / Phase 2 cleanup

> **Authored:** 2026-06-16 ~09:10 PDT by the outgoing Perplexity Computer operator.
> **For:** The next Perplexity Computer operator who picks up this session.
> **Audience:** Operator-to-operator. Assumes Computer-level tool fluency. No fluff.
> **Status of session at handoff:** Wave 1.5 CHAIN A — A1 ✅ merged, A2 🔄 fixer running, A3-A8 pending. Phase 2 — PR1 (#400 followup) 🔄 fixer running. User is **asleep**. Operate autonomously per the rules in §3.

---

## 0. TL;DR — what you do in your first 15 minutes

1. **Reload skills:** `load_skill("coding")` and `load_skill("task-scheduling")`. They will be re-copied to `/home/user/workspace/skills/`.
2. **Check the two in-flight subagents:** `phase_2_pr1_400_daily_rings_followup_mqgre0ct` and `w1_5_a2_fixer_1_p2_2_p3_closeout_mqgtvxnv`. If status is "in progress" past their expected horizon, run the **stuck-subagent rescue playbook** in §10 (NEVER assume they died — they often finish work + push but never report back).
3. **Read this doc end-to-end.** Don't skim. The user moves fast and references rule numbers (R0, R64, R74, R81, R82) as shorthand — you need the glossary in §4.
4. **Open the watchdog cron tracker:** `/home/user/workspace/cron_tracking/3b014359/`. The user has a `*/60 * * * *` "check" heartbeat firing hourly. When it fires, respond per §11.
5. **Never Sonnet for fixers.** Opus 4.8 only. Builder = Opus 4.8. Auditor = GPT-5.5. Fixer = Opus 4.8. Re-audit = GPT-5.5. See §6.
6. **Never `browser_task` on GitHub.** Always `bash` with `api_credentials=["github"]` and `gh` CLI. See §8.
7. **Operate as Chief of Product, not a junior dev.** Quote: *"execute as Chief of Product not a shitty junior dev"*. Luxury doctrine on every choice. Right not fast.
8. **Disk hygiene:** Sandbox disk filled to 100% during this session — cleaning stale `node_modules` in dormant worktrees recovers ~10GB. Don't touch active-subagent worktrees.

---

## 1. What the LAST operator (the one before me) screwed up

This is documented honestly so you don't repeat it. The corrections are baked into how this session has been operating since.

### 1.1 Shipped PRs that violated R81 strict zero
Multiple PRs were merged with open P3 findings ("we'll fix in a follow-up"). The 27-finding Phase 2 backlog (the `POST_MERGE_PR249/250/251/252/253/254/396/400_AUDIT_*.md` files in `/home/user/workspace/audit-work/outputs/`) is the bill for that shortcut. The user codified the correction: **R81 strict = true zero findings, P3 must close, loop until both auditors clean**.

### 1.2 Used Sonnet for a fixer "to save credits"
The user's rule (verbatim): *"NEVER Sonnet for fixers — Opus 4.8 ONLY"*. The previous operator did it anyway on a borderline PR. The result was a re-audit with new findings that Opus would have caught on the first pass. Net cost: 2× the credits and 1× a strong rebuke from the user.

### 1.3 Used `browser_task` on github.com PR pages
This is R79. The `gh` CLI is faster, more reliable, fully scriptable, and works inside `bash`. `browser_task` against github.com is slow, brittle, and burns minutes per call. Don't do it.

### 1.4 Shipped a 1,200-LOC "small refactor"
This is the precipitating incident for the hyperscaler-grade rewrite of the build order. Original Wave 1.5 plan was 25 PRs at ~560 LOC median. Per Google/Stripe/Graphite research, defect detection collapses past 200 LOC and craters past 800. The current plan (`/home/user/workspace/wave-1-5/HYPERSCALER_BUILD_ORDER.md`) is 37 PRs at 260 LOC median. **Do not widen any PR past 400 LOC.**

### 1.5 Used `$allOperations` Prisma extension for RLS context
This was the original A1 builder's attempt and it was architecturally wrong. Under Supabase pgbouncer **transaction-pool mode** (port 6543), `set_config(..., true)` and the query that needs the GUC **must share a single transaction** — otherwise the pooler routes them to different connections and the GUC vanishes. The pivot to a `withRlsContext(prisma, ctx, fn)` helper that opens a `$transaction` and stamps the GUC on the **tx handle** is the only correct shape. See §13 — this will come up again on A3/A5.

### 1.6 Tried to `message_subagent` a running coding subagent
Coding/codex_codebase/remotebox/phone_call subagents **cannot receive follow-up messages while running**. Only `cancel_subagent` works. If you need to redirect, cancel + spawn fresh with corrected objective. See §10.

### 1.7 Let a "stuck" subagent run for 90 min before checking the worktree
Coding subagents frequently finish their work, push to GitHub, write their deliverable, and then never call submit_result. The "stuck" state is illusory. **Always check the worktree first** — the work is almost always already done. See §10.

### 1.8 Did not push wave-1-5/ docs to GitHub
Sandbox can evict. Workspace files vanish. Everything important — build order, decisions, addenda, fixer briefs, audit reports — must be **pushed to GitHub or it doesn't exist**. R64. See §8.5 for the push pattern.

### 1.9 Let disk fill to 100%
By the end of this session there were ~25 dormant worktrees on disk and `node_modules` directories everywhere. The cumulative ~14GB exhausted the sandbox. **Aggressively delete dormant worktrees' `node_modules` directories** as soon as a PR merges — they re-create on next subagent spawn. Never delete a worktree with an active subagent, and never delete a worktree with uncommitted/unpushed work.

---

## 2. The HECTACORN standard — what we hold ourselves to

User's exact words across this session: **"HECTACORN QUALITY"**, **"decacorn quality / depth / enterprise grade / 99.99% uptime is the goal"**, **"100% RLS hectacorn quality"**, **"execute as Chief of Product not a shitty junior dev"**, **"luxury doctrine for all choices"**, **"right not fast"**.

Operational definition — what hectacorn quality means in practice for THIS session:

| Dimension | Hectacorn bar | Mid bar (rejected) |
|---|---|---|
| **PR size** | ≤400 LOC hard, ≤200 LOC ideal, median 260 | 500-1500 LOC "small refactors" |
| **Audit cycle** | Dual GPT-5.5 auditors per PR, R81 strict (true zero P0+P1+P2+P3) | Single auditor, ship with open P3 |
| **Fixer model** | Opus 4.8 only, inline verbatim prescriptions per finding | Sonnet "good enough" with vague briefs |
| **Tests** | R66 full suite green before push; R70 30-sec fail-fast lane runs first; R0 test-everything-you-change | "Tests added later"; targeted-only runs |
| **RLS** | App-user role NOBYPASSRLS, `set_config(..., true)` inside `$transaction`, live-DB isolation tests per table | App-user equal to admin, `set_config` outside tx ("works on my pooler") |
| **Commits** | R74 identity `Bradley Gleave <bradley@bradleytgpcoaching.com>` always | Generic `git config user.email` |
| **Push cadence** | R61 force-push every 2 min on every active worktree | "I'll push when done" |
| **Scope** | Brief enumerates owned files + forbidden files. Scope mismatch = HALT + write `SCOPE_MISMATCH.md`. R71. | "While I was there, I also fixed…" |
| **Schema** | RLS enabled in the same migration that creates the table; financial tables get write-scope policies, not just SELECT | RLS as a follow-up PR |
| **Errors** | 402 entitlement, 403 access, 404 hidden, 409 idempotency, 410 gone (with dead-code removal same session) | Generic 500s; raw axios strings to mobile |
| **Voice** | Quiet luxury — Cormorant Garamond / Inter, bone/forest palette (`#FAF8F5 #4A7C59 #1A1A1A`); no emoji, no gamification chrome | Stock material design |

Hectacorn ≠ slow. Hectacorn = **no kicked cans, ever** (R6).

---

## 3. The user's binding rules (verbatim, this session)

Quotes are from THIS session unless dated. Do not paraphrase. Do not negotiate.

1. *"NEVER Sonnet for fixers — Opus 4.8 ONLY"*
2. *"GPT-5.5 for ALL re-audits"* — and **DUAL auditors per PR** (parallel subagents, focus split correctness/security + tests/contracts)
3. *"Loop fixer until truly zero findings"* (R81 strict — P3 must close)
4. **Scope mismatch protocol** — fixer halts and writes `SCOPE_MISMATCH.md`, never silently expands
5. *"No credit ceiling"* (paired with "right not fast")
6. *"Auto-merge YES"* after CLEAN
7. **R74 commit identity** — `git -c user.name='Bradley Gleave' -c user.email='bradley@bradleytgpcoaching.com' commit -m "..."` (always)
8. **Never `browser_task` on GitHub URLs** — `gh` CLI via `bash` only
9. *"One PR per auditor (no pairing) — but DUAL auditors per PR via parallel subagents"*
10. *"Fixer briefs with inline prescriptions"* (verbatim per-finding, not "figure it out")
11. *"All product options in coach/client POV + metaphor"*
12. *"Phase 1 must close before Phase 2"* — but in this session user authorized Phase 2 to run in parallel as **"secondary"**, one fixer at a time, never two Phase 2 PRs concurrent
13. **Phase 2 cleanup is SERIAL**: #400→#396→#398→#397→#252→#250→#249→#254 (biggest debt first)
14. *"HECTACORN QUALITY"*
15. *"push everything to github - anything stuck in sandbox"* (R64, R61)
16. *"Right not fast"* — PLANNER stage uses Opus 4.8 for major plan changes
17. *"100% RLS hectacorn quality"*
18. *"execute as Chief of Product, not a shitty junior dev"*
19. *"luxury doctrine for all choices"*
20. *"ALWAYS FOLLOW R0, R82, R64"*
21. **Watchdog cadence:** user requested 15 → 30 min; platform minimum is 60 min. Use 60 min, do not retry to reduce it.
22. **Per-`check` response style:** terse, in-flight subagents, recent merges, no preamble. See §11.

---

## 4. R-rule decoder (the ones you'll hit)

Pulled verbatim from `growth-project-backend/AGENT_RULES.md` and `ENGINEERING_RULES.md` so you don't have to guess.

| Rule | What it means | When you'll hit it |
|---|---|---|
| **R0** | "Test everything you change." Run jest on every touched module before push. | Every commit. |
| **R6** | "Never kick the can. Fix at the root the moment it appears." | Every audit finding. |
| **R10** | RETIRED 2026-05-26. Don't cite. New bar = CI green + 0 P0/P1/P2 on main. | Old PRs may still reference it. |
| **R31** | Builder ≠ Auditor. Different fresh subagents per PR. Extended by R73 to Planner ≠ Builder ≠ Auditor ≠ Fixer (4 roles). | Every PR. |
| **R52** | Reflog-based recovery if a force-push goes wrong. | Rare; useful if you need to undo. |
| **R56** | One subagent per worktree. Always. | Every code-writing spawn. |
| **R57** | `backend-main` and `mobile` read-only for subagents. | Pre-flight worktree check. |
| **R58** | Worktree naming: `/home/user/workspace/tgp/{repo}-{slug}`. | Naming new worktrees. |
| **R59** | Pre-flight: check target path doesn't exist; reuse only if same branch + clean. | Before `git worktree add`. |
| **R60** | Audits get their own worktrees too. | Spawning audit subagents. |
| **R61** | Push to GitHub every 2 minutes on every active worktree. | Always. |
| **R64** | Push to GitHub immediately after commit. Don't leave work local. | Every commit. |
| **R65** | The 50 documented AI-coding failure patterns. Auditors apply the full checklist. | Audit prompts. |
| **R66** | Full-suite-before-PR — `npx jest --runInBand` to completion before any push. Log saved to workspace. | Every push. |
| **R67** | Dispatch-state-persisted — push a row to `handoffs/dispatch.json` in `tgp-agent-context` before waiting on subagents. | Every spawn. |
| **R68** | Doctrine-decision-of-record — every doctrine change lands in `docs/decisions/NNNN-<slug>.md` (ADR). | Any guard/banned-token/invariant change. |
| **R69** | Skipped-tests-are-red — `.skip` needs `// SKIP-BECAUSE: <reason> — owner: <name> — expires: <YYYY-MM-DD>` above it. | If you add a skip. |
| **R70** | Fail-fast pre-push lane — run doctrine guards (<30s) before the full suite. | Before R66. |
| **R71** | Parallel-PR file ownership: each brief enumerates OWNS / MUST-NOT-TOUCH / shared-append-only. Pre-dispatch overlap check. Cap 5 concurrent code-writing subagents. | Every parallel dispatch. |
| **R72** | Audits must be exhaustive — sweep the whole diff, never stop at first finding, rank P0→P3. | Every audit prompt. |
| **R73** | Mobile screen Planner gate — fresh GPT-5.5 Planner subagent before any new mobile screen / >100 LOC change / emotional-architecture change. Planner reads `MOBILE_APP_DESIGN_INTELLIGENCE.md` in full first. | Every mobile screen PR. |
| **R74** | Commit identity = `Bradley Gleave <bradley@bradleytgpcoaching.com>`. | Every commit. |
| **R78** | Telemetry events PII-free. | Any analytics-emitting code. |
| **R79** | Never `browser_task` GitHub. `gh` CLI only. | Every GitHub interaction. |
| **R81** | CLEAN audit = true zero findings (P0+P1+P2+P3). Loop until satisfied. | Every audit cycle. |
| **R82** | No `any`, no `@ts-ignore`, no `as unknown`. CI doctrine-cleanup guard enforces. | Every TypeScript change. |

Anything else the user cites: search `AGENT_RULES.md` in the backend repo first. ENGINEERING_RULES.md covers `req.user.id` not `req.user.sub`, RLS interceptor after JwtAuthGuard, 402/403/404/409/410 codes, role enum `{coach, student, owner}` (clients are `student`), quiet-luxury palette, sub-coach 5% only on explicit toggle.

---

## 5. The audit cycle (the heart of the operation)

The cycle that every PR — Wave 1.5 OR Phase 2 — flows through. Memorize this shape.

```
[Operator]
   |  drafts brief (Planner stage if R73 mobile)
   v
[Opus 4.8 Builder] (run_subagent codebase, fresh worktree per R56)
   |  - implements per brief, <=400 LOC net source
   |  - R66 full suite green before push
   |  - R74 commit identity
   |  - opens PR on integration branch (not main)
   v
[GPT-5.5 Auditor — correctness/security]   [GPT-5.5 Auditor — tests/contracts]
   |  (parallel, R72 exhaustive, R65 full checklist)
   v
[Operator synthesizes both audits]
   |  - Agreement: dual-confirmed findings (highest signal)
   |  - Unique: single-auditor findings
   |  - Verdict: CLEAN only if BOTH report true zero (R81)
   v findings exist                            v true zero
[Opus 4.8 Fixer]                          [Auto-merge to integration branch]
   |  - inline verbatim prescriptions
   |  - touches ONLY brief-scoped files
   |  - scope mismatch -> HALT + SCOPE_MISMATCH.md
   |  - R74 commit identity, R64 push
   v
[Loop back to Auditor stage with re-audit prompt]
   (keep looping until true zero — no credit ceiling)
```

Final integration→main merge is **one PR at the end** after staging soak + flag flip rehearsal. No individual PR goes to `main` during Wave 1.5. Same for Phase 2 — each lands on the relevant branch (`main` for backend in Phase 2's case, since #400 etc. were already merged and Phase 2 closes the post-merge audit findings on `main` directly).

---

## 6. Model routing matrix

| Role | Model | Why |
|---|---|---|
| **PLANNER** (R73 mobile, or major plan rewrite) | **Opus 4.8** | Highest reasoning, full doctrine read |
| **BUILDER** (codebase subagent) | **Opus 4.8** | Quality > cost. User explicitly rejected Sonnet. |
| **AUDITOR** (general_purpose subagent, adversarial) | **GPT-5.5** | Different reasoning trace from builder; R31 separation. |
| **FIXER** (codebase subagent, closing findings) | **Opus 4.8** | Same standard as builder. |
| **RE-AUDITOR** (after fixer) | **GPT-5.5** | Same adversarial stance, fresh context. |
| **Watchdog cron** (background) | (default — set by `schedule_cron`, not us) | Just echoes "check"; no reasoning needed. |
| **Main thread (you)** | (whatever spawned this session) | You orchestrate, don't code. |

**Never deviate.** If a subagent finishes and you're tempted to "just have Sonnet do this quick fix" — don't.

---

## 7. The "split PRs into small LOC chunks" doctrine

This is the single most-cited research thread in the session. It's why Wave 1.5 went from 25 PRs to 37 PRs without changing scope.

### 7.1 The research (cite these to the user if they ask)
- **Google code review playbook:** PRs under 200 LOC for fastest review + lowest defect rate ([DeployHQ](https://www.deployhq.com/blog/google-code-review-playbook-deployment-velocity))
- **Meta:** target <150 LOC per PR
- **Stripe Minions / Graphite stacked model:** median PR 47 LOC, ideal 50 LOC, defect detection collapses past 200 LOC ([Graphite research](https://graphite.com/research/median-pr_size), [Stripe Minions case study](https://systemdesigndoc.com/case-studies/stripe-minions-1300-prs/))
- **LinearB elite tier:** <=100 LOC ([Git AutoReview 2026 benchmark](https://gitautoreview.com/blog/pr-review-time-benchmark-2026))
- **Octopus AI study:** PRs >800 LOC have 87% lower review thoroughness, 28% more post-merge defects ([Octopus Review](https://octopus-review.ai/blog/ai-made-your-prs-bigger-reviews-got-worse))

### 7.2 The caps (binding for THIS session)
| Cap | Value | Notes |
|---|---|---|
| **Hard ceiling** | 400 LOC net source | If a PR projects over, split BEFORE the builder spawns |
| **Ideal** | <=200 LOC | Google sweet spot |
| **Existing-file delta** | <=150 LOC | Force-splits on god-files |
| **New file** | <=350 LOC | Co-located helpers if larger |
| **Migration SQL** | <=300 LOC, <=1 per PR | Counted separately |
| **Test files** | No cap | More tests = good |

### 7.3 The stacked-PR model
Every PR depends only on the previous one in its chain. Three parallel chains:
- **CHAIN A — Security/Infra spine** — serial, blocks all others
- **CHAIN B — Schema chunks** — parallel within tier after A4
- **CHAIN C — Feature surfaces** — serial sub-chains after A+B

All chains squash-merge to `wave-1-5` integration branch, never to `main`, until the end-of-wave cutover PR.

### 7.4 The hyperscaler self-test
Before approving any plan, ask: *"Is this what Apple / Google / Notion / Tesla / Stripe would do?"* The user invokes this verbatim. If the answer is no, the plan rewrites until yes.

---

## 8. Tool cookbook

### 8.1 `gh` CLI — the only way to touch GitHub
Always `bash` with `api_credentials=["github"]`. Examples:

```bash
# View PR + checks
gh pr view 418 --repo BradleyGleavePortfolio/growth-project-backend --json state,isDraft,mergeable,mergeStateStatus
gh pr checks 418 --repo BradleyGleavePortfolio/growth-project-backend

# Edit PR body from a file
gh pr edit 418 --repo BradleyGleavePortfolio/growth-project-backend --body-file /home/user/workspace/audit-work/briefs/PR418_BODY.md

# Merge (squash + auto)
gh pr merge 418 --repo BradleyGleavePortfolio/growth-project-backend --squash --auto

# Post an inline review (CRITICAL: event must be "COMMENT", never "APPROVE" or "REQUEST_CHANGES")
gh api repos/BradleyGleavePortfolio/growth-project-backend/pulls/418/reviews --input - <<'EOF'
{"body":"...","event":"COMMENT","comments":[{"path":"src/x.ts","line":42,"body":"..."}]}
EOF

# Check if a branch is pushed
gh api repos/BradleyGleavePortfolio/growth-project-backend/git/ref/heads/wave-1-5/a2-rls-prismaservice

# Search repos in the user's org
gh api user/orgs --jq '.[].login'
gh search repos "growth-project" --owner=BradleyGleavePortfolio --limit=5
```

**NEVER** `browser_task https://github.com/...`. R79. The user will be visibly annoyed.

### 8.2 Spawning a coding subagent (Opus 4.8)
```python
run_subagent(
  subagent_type="codebase",
  task_name="W1.5-A3 builder — RLS policies for User/Gym/GymMembership",
  model="claude_opus_4_8",
  metadata='{"repo_url": "https://github.com/BradleyGleavePortfolio/growth-project-backend"}',
  preload_skills=["coding"],
  objective="Repository setup: managed clone from https://github.com/BradleyGleavePortfolio/growth-project-backend. The repo is prepared by infrastructure as an isolated shallow sparse worktree; do not manually clone it.\n\n<full brief here, see §9>",
  user_description="A3 builder — RLS policies"
)
```

### 8.3 Spawning DUAL auditors (GPT-5.5, parallel)
Always in a **single tool-call batch** so they run truly concurrent. Each gets a different focus:

```python
# Batch in one assistant turn:
run_subagent(subagent_type="general_purpose", model="gpt_5_5",
  task_name="A3 audit — correctness/security",
  objective="...adversarial focus on RLS correctness, USING/WITH CHECK predicates, GUC name reconciliation with A1+A2, security boundary across pgbouncer tx-pool...")
run_subagent(subagent_type="general_purpose", model="gpt_5_5",
  task_name="A3 audit — tests/contracts",
  objective="...adversarial focus on live-DB test coverage, harness usage, contract compatibility with B-tier consumers, observability...")
```

### 8.4 Watching subagents without blocking
```python
wait_for_subagents(subagent_ids=["<id1>", "<id2>"], user_description="Waiting on A3 dual audit")
```
You'll be woken automatically when both complete OR when the user sends a message.

### 8.5 R64 / R61 push pattern (do this on every breakpoint)
```bash
cd /home/user/workspace/<worktree>
git add -A
git -c user.name='Bradley Gleave' -c user.email='bradley@bradleytgpcoaching.com' commit -m "wip-autopush: $(date -Iseconds)" --allow-empty
git push -u origin $(git branch --show-current)
```

### 8.6 The Phase 2 audit ledger (input for #396 → #254 fixers)
Each post-merge audit is at `/home/user/workspace/audit-work/outputs/POST_MERGE_PR<N>_AUDIT_2026-06-15.md` and (often) a `POST_MERGE_PR<N>_SOLO_AUDIT_2026-06-15.md` second opinion. The fixer brief for each Phase 2 PR pulls findings from BOTH and writes inline prescriptions per finding.

### 8.7 Disk hygiene
When disk pressure rises (`df -h /home/user/workspace`), the safe wins are:
```bash
# Identify dormant worktrees (no recent commits, no active subagent)
for d in /home/user/workspace/growth-project-*-*; do
  echo "=== $d ==="
  cd "$d" && git log -1 --format="%h %s [%ar]" && git status -s | head -3
done

# Clear node_modules in dormant worktrees (Opus subagents re-install on spawn)
# DO NOT touch worktrees in the ACTIVE SUBAGENTS list
rm -rf /home/user/workspace/growth-project-*-DORMANT_HASH/node_modules
```
Active subagent worktrees: find them via `git log -1 --format="%h %ar"` — anything with commits in the last 2 hours is likely active.

---

## 9. Brief templates (proven in this session)

### 9.1 Builder brief skeleton
```markdown
# <PR-ID> BUILDER BRIEF — Opus 4.8

**Branch (new):** wave-1-5/<slug>
**Base:** wave-1-5-planning (commit <sha>)
**Worktree path:** managed clone — do not manually clone

## Objective
<one-paragraph what + why, coach/client POV + metaphor where applicable>

## Scope (R71 OWNS list)
OWNS (exclusive write):
- src/path/one.ts
- src/path/__tests__/one.spec.ts

MUST NOT TOUCH:
- src/path/owned-by-sibling.ts
- prisma/schema.prisma  # B1b owns

Shared-append-only:
- src/app.module.ts (small additive change OK; second-merger rebases)

## LOC budget
- <=<N> LOC net source (excl tests)
- <=<M> LOC new test file
- 1 migration <=300 LOC if applicable

## Implementation requirements
1. <requirement 1>
2. <requirement 2>
...

## Tests required (R0)
- <unit test 1>
- <integration / live-DB test 2>
- Run: `npx jest <paths> --runInBand` to green before push

## Constraints
- R66 full suite green before push
- R70 fail-fast lane green first
- R74 commit identity
- R64 push immediately after green
- R82 no any/@ts-ignore/as unknown
- Scope mismatch -> HALT + write SCOPE_MISMATCH.md

## Deliverables
1. Branch wave-1-5/<slug> pushed
2. PR opened, base wave-1-5-planning, not draft
3. Write /home/user/workspace/audit-work/outputs/<PR-ID>_BUILDER_REPORT.md with diff stat, test output, claims-to-be-audited list
```

### 9.2 Auditor brief skeleton (GPT-5.5, adversarial)
```markdown
# <PR-ID> AUDIT — GPT-5.5 (adversarial) — FOCUS: <correctness/security | tests/contracts>

**PR:** <url>
**Branch:** <branch> · **Commit:** <sha>
**Base:** <base-branch> (merge-base <merge-base-sha>)

## Mandate (R72 exhaustive, R81 strict)
Sweep the ENTIRE changed-file diff. Do NOT stop at first finding. Rank all findings P0 (security/data-loss) -> P1 (correctness) -> P2 (significant) -> P3 (style/doc/observability). CLEAN = true zero findings.

## Adversarial checklist (R65 50-failures, applied to THIS PR)
- <expected trap 1, e.g. "Observable+ALS subscription timing leak — verify defer() vs synchronous return">
- <expected trap 2>
- <claims-vs-actual table — verify every builder claim against actual diff>
- <LOC verification — `git diff --numstat <base>..HEAD -- ':!**/*.spec.ts'`>
- <RLS predicate verification>
- <type-narrowness — grep for any/@ts-ignore/as unknown>
- <test substance — is the parallel test genuinely concurrent? are async chains real or shallow?>

## Deliverable
Write /home/user/workspace/audit-work/outputs/<PR-ID>_AUDIT_<FOCUS>_GPT55.md with:
1. VERDICT (CLEAN / NOT CLEAN)
2. Findings table P0->P3 with file:line + prescription per finding
3. Claim-vs-actual table
4. Coverage statement (what was read end-to-end, what was deferred)
5. One-sentence judgment
```

### 9.3 Fixer brief skeleton (Opus 4.8, INLINE PRESCRIPTIONS)
This is the format the user is most insistent about. **No "figure it out"** — paste the exact code snippet you want.

```markdown
# <PR-ID> FIXER BRIEF — Opus 4.8 — STRICT R81

**Branch to work on:** <existing branch> — `git fetch origin <branch> && git checkout <branch>`
**Audit inputs:** /home/user/workspace/audit-work/outputs/<PR-ID>_AUDIT_*.md

## Findings to close (verbatim inline prescriptions)

### P2-1 — <one-line summary>
**File:** src/path/x.ts:<line>
**Root cause:** <crisp explanation>
**Prescription (PICK EXACTLY THIS):**
\`\`\`ts
// at module scope:
let warnedX = false;

// in the function:
if (!warnedX) {
  warnedX = true;
  this.logger.warn(`...`);
}
\`\`\`
**Update JSDoc** at line X from "..." -> "...".
**Add a test** asserting <invariant>.
**DO NOT:**
- demote to debug
- remove the warn
- add a rate-limiter library

### P3-1 — <one-line>
**Location:** PR body / file:line
**Prescription:** <verbatim text or snippet>

## Scope
Touch ONLY:
- <file 1>
- <file 2>
- PR body via `gh pr edit`
DO NOT touch:
- A1 files
- <files owned by sibling>

## Constraints
- R74 commit identity
- R0 test what you change (`npx jest <path>`)
- R82 no any/@ts-ignore/as unknown
- R64 push immediately
- LOC cap remains <=400 net
- Scope mismatch -> HALT + SCOPE_MISMATCH.md

## Deliverables
1. Commit + push to <branch>
2. Updated PR body via gh pr edit (if applicable)
3. Write /home/user/workspace/audit-work/outputs/<PR-ID>_FIXER_REPORT.md with: diff summary, jest output, `gh pr checks <N>` output, confirmation each finding closed with file:line citations
4. Do NOT merge. Leave for GPT-5.5 final re-audit.
```

---

## 10. Stuck-subagent rescue playbook (USE THIS — it works)

Coding subagents frequently complete their work, push to GitHub, write deliverables, and then never call `submit_result`. They appear "stuck" but the work is done. This playbook recovered two subagents this session (A1 final re-audit, A1 closeout). Pattern:

### Step 1 — Check the worktree for recent activity
```bash
ls -la /home/user/workspace/growth-project-*-*
for d in /home/user/workspace/growth-project-*-*; do
  if [ -d "$d/.git" ] || [ -f "$d/.git" ]; then
    echo "=== $d ==="
    cd "$d" && git log -1 --format="%h %s [%ar]"
    git status -s | head -5
  fi
done
```
Look for recent commits (within last hour) on the relevant branch.

### Step 2 — Verify the commit is pushed to origin
```bash
cd /home/user/workspace/<the-worktree-with-recent-commit>
gh ls-remote origin $(git branch --show-current)
# Should show the same SHA as HEAD
```
If origin is in sync, the work is preserved. If not, push it yourself with R74 identity (see §8.5).

### Step 3 — Look for the deliverable file
The subagent may have written its report to `/home/user/workspace/audit-work/outputs/` or `/home/user/workspace/audit-work/briefs/` even if it didn't report back. `ls -la` those dirs sorted by mtime.

### Step 4 — Read the deliverable, then `cancel_subagent`
```python
cancel_subagent(subagent_id="<the-stuck-id>", user_description="Rescued — work already on disk + pushed")
```

### Step 5 — Continue from artifacts
You now have everything you need. Spawn the next step (re-audit, merge, next builder) as if the subagent had reported back normally.

### CRITICAL: when NOT to use this
- If the worktree has NO recent commits and the subagent has been running <=15 min, just wait. Subagents have ramp-up time.
- If the subagent is `codex_codebase` / `remotebox` / `phone_call`, you cannot `message_subagent` it anyway — only cancel. Same rescue pattern applies.
- If the worktree shows uncommitted changes (`git status` has dirty files), the subagent is NOT done. Don't cancel.

---

## 11. The `check` heartbeat ritual

User has an hourly cron firing the word "check" (cron `3b014359`, `*/60 * * * *` UTC). The user wanted 15 min, then 30 min — platform rejected both (minimum cadence is 60 min unless the cron uses a programmatic trigger).

### Response shape (TERSE — user expects no preamble)
```
[status as of HH:MM PDT]

In flight:
- <subagent task-name> (id: <short>) — <age> — <last commit hash + 1-line>
- <subagent task-name> (id: <short>) — <age> — status

Recent merges (last hour):
- PR #N <title> — squash-merged to <branch> at HH:MM PDT

Next on deck:
- <PR-ID>: <one-line plan>

Blockers: none.
```

**Do NOT** ask the user a question on a `check` response unless an operator-choice has truly come up (see §12). Do NOT narrate what you're about to do — just status.

### If a watchdog fires and you have NO active work
Still respond. Example:
```
[09:00 PDT] All clear. Last merge: PR #418 (W1.5-A2) -> wave-1-5-planning at 08:54 PDT. Next on deck: W1.5-A3 brief draft starting now.
```

---

## 12. "User is asleep" autonomy contract

User said *"im going to bed!"* and *"keep working per my rules"*. Operating contract while they're asleep:

### What you CAN do without them
- Spawn builders / auditors / fixers per the build order
- Merge CLEAN PRs to integration branches (NOT main)
- Push all docs / briefs / reports to GitHub
- Cancel + respawn stuck subagents per §10
- Edit PR bodies, update tracking files
- Run any audit cycle iteration
- Disk hygiene on dormant worktrees

### What you CANNOT do without them (operator-choice triggers)
Surface as a `check`-format response, in the user's choice format (Option (a)/(b)/(c) with description per option):

- **Scope change to the build order** (adding/removing PRs from the 37)
- **Hectacorn-vs-shortcut tradeoff** (anything that smells like "we could just…")
- **Architectural pivot** (e.g., A2's `withRlsContext` pivot would have qualified — that one was approved BEFORE bedtime)
- **Merge to `main` for any non-Phase-2 PR** (Wave 1.5 only goes to `main` at end-of-wave cutover)
- **Scheduling change** (cron cadence, build order timing)
- **Budget / credit signaling** (user said no ceiling, but flag if a single subagent burns notably more than peers — use judgment)
- **Anything ambiguous that could not be undone**

### How to surface a choice
```
[time PDT]

Operator choice needed: <one-line framing>

(a) <option name>
    <what happens, who benefits, what's the tradeoff>

(b) <option name>
    <same>

(c) <option name>
    <same>

Awaiting your call. Continuing other lanes in the meantime.
```

---

## 13. The A1 architectural pivot (the BIG lesson — read in full)

This is the highest-leverage thing the next operator can carry forward. If you don't internalize this, you will burn a full audit cycle on A3 or A5.

### 13.1 The wrong approach (the trap)
A1 builder's first attempt was a Prisma `$allOperations` extension:
```ts
prisma.$extends({
  query: {
    $allOperations({ args, query, operation }) {
      // BEFORE: set_config('app.user_id', userId, true)
      // BEFORE: set_config('app.gym_ids', gymIds, true)
      return query(args)
    }
  }
})
```
This LOOKS right and PASSES unit tests against a non-pooled Postgres. It is wrong in production.

### 13.2 Why it's wrong (the Supabase pgbouncer constraint)
Supabase production uses pgbouncer in **transaction-pool mode** (port 6543). In this mode:
- Each "logical session" maps to a pooled connection only **for the duration of one transaction**
- `set_config(..., true)` is **transaction-scoped** — when the transaction commits/rolls back, the GUC is dropped
- If `set_config` runs OUTSIDE a `$transaction`, it goes onto a connection that pgbouncer immediately returns to the pool. The next query is **probably on a different connection** with no GUC set.
- RLS policies referencing `current_setting('app.gym_ids')` then evaluate against an empty string -> deny-all.

Net result: works locally, silently breaks in production, deny-all RLS, support tickets. This is exactly the "50 documented AI-coding failure patterns" R65 trap (#34, "ORM extension assumes session continuity that pooler breaks").

### 13.3 The right approach (the pivot)
Open an explicit `$transaction` and stamp the GUC on the **tx handle** so the same connection is guaranteed for the lifetime of the work:

```ts
export async function withRlsContext<T>(
  prisma: PrismaClient,
  ctx: { userId: string; gymIds: string[] },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.user_id', $1, true)`, ctx.userId);
    await tx.$executeRawUnsafe(`SELECT set_config('app.gym_ids', $1, true)`, ctx.gymIds.join(','));
    return fn(tx);
  });
}
```

Callers MUST use `tx` (passed into `fn`), not the outer `prisma` client. Any escape to the outer client = different connection = no GUC. A2 wraps this with AsyncLocalStorage + a NestJS interceptor for ergonomics.

### 13.4 The Observable+ALS interceptor trap (will hit you on A3, A5, A6)
NestJS interceptors that wrap `runWithRlsContext(ctx, () => next.handle())` look right but lose the ALS context because the returned Observable subscribes **asynchronously, after the synchronous `intercept` return**. By then `als.run`'s callback has popped, and the handler runs with no ALS context.

**Wrong:**
```ts
intercept(ctx, next) {
  return runWithRlsContext(rlsCtx, () => next.handle()); // ALS pops before subscribe
}
```

**Right (deferred — what A2 ships):**
```ts
intercept(ctx, next) {
  return defer(() => runWithRlsContext(rlsCtx, () => next.handle())); // als.run re-entered at subscribe time
}
```

Or equivalent: `new Observable(sub => runWithRlsContext(ctx, () => next.handle().subscribe(sub)))`.

A2 auditor specifically called this out as the highest-risk check; it passed because builder used `defer()`. Any future interceptor / pipe / guard that touches ALS needs the same pattern. Watch for it on:
- A3 RLS policy interceptor (if introduced)
- A5 Redis cache wrapper (if it returns Observable)
- A6 FeatureFlags controller (if it pipes through ALS)

### 13.5 Reconciling with the legacy interceptor
There is a **pre-existing** legacy RLS interceptor at `src/common/interceptors/rls-context.interceptor.ts` that writes a **different** GUC namespace: `app.current_user_id` / `app.current_user_role`. A2's middleware writes `app.user_id` / `app.gym_ids`. They coexist safely (no conflict, disjoint namespaces, A2 enables no policies yet) but **both run per request** — that's intentional until A3 reconciles. A3's job includes retiring the legacy one once policies migrate to the new namespace. Documented as a comment in `app.module.ts` (P3-2 fix).

---

## 14. Where everything lives

### 14.1 Repositories
- **Backend:** `https://github.com/BradleyGleavePortfolio/growth-project-backend`
- **Mobile:** `https://github.com/BradleyGleavePortfolio/growth-project-mobile`
- **Agent context (handoffs, ADRs, design intelligence):** `https://github.com/BradleyGleavePortfolio/tgp-agent-context`

### 14.2 Branches in flight
- Backend `wave-1-5-planning` — A1 merged (`aacee517`), A2 PR #418 OPEN (`7f70f57`)
- Backend `wave-1-5/a2-rls-prismaservice` — A2 head, fixer mid-flight
- Backend `fix/pr400-followup-r81` — Phase 2 PR1 fixer mid-flight, last commit `6d36dea`
- Backend `main` — last clean state from before Wave 1.5; do NOT direct-push
- Mobile `main` — A1 (#263) merged at commit `31487a1`

### 14.3 Workspace files (everything you'll need)
**Build order & decisions (Wave 1.5):**
- `/home/user/workspace/wave-1-5/HYPERSCALER_BUILD_ORDER.md` — 37 PRs, <=400 LOC, stacked
- `/home/user/workspace/wave-1-5/APPROVED_DECISIONS.md` — 21 OQs locked
- `/home/user/workspace/wave-1-5/MULTI_GYM_MEMBERSHIP_REDUNDANCY_ADDENDUM.md` — 10 binding rules
- `/home/user/workspace/wave-1-5/PLAN_A_CONTENT_PACKAGE_MAPPING.md`
- `/home/user/workspace/wave-1-5/PLAN_B_GYM_OWNER_ROLE_RLS.md`
- `/home/user/workspace/wave-1-5/PLAN_C_EVALUATOR_AND_SLICING.md`
- `/home/user/workspace/wave-1-5/SERVER_SIDE_FEATURE_FLAGS_SPEC.md`
- `/home/user/workspace/wave-1-5/HYPERSCALER_RESEARCH.md` — citations / research base
- `/home/user/workspace/wave-1-5/RESCOPED_BUILD_ORDER.md` — SUPERSEDED; keep for traceability only

**Audit cycle outputs:**
- `/home/user/workspace/audit-work/briefs/CANONICAL_AUDIT_BRIEF.md` — re-usable auditor template
- `/home/user/workspace/audit-work/briefs/W1_5_A2_FIXER_BRIEF.md` — example fixer brief (the one running right now)
- `/home/user/workspace/audit-work/outputs/W1_5_A1_REAUDIT_CORRECTNESS_GPT55.md` — A1 re-audit (CLEAN)
- `/home/user/workspace/audit-work/outputs/W1_5_A1_REAUDIT_TESTS_CONTRACTS_GPT55.md` — A1 re-audit (CLEAN)
- `/home/user/workspace/audit-work/outputs/W1_5_A1_FINAL_GPT55_AUDIT.md` — A1 final (1 P3 — fixed inline by user)
- `/home/user/workspace/audit-work/outputs/W1_5_A2_AUDIT_CORRECTNESS_GPT55.md` — A2 audit (CLEAN, 0/0/0)
- `/home/user/workspace/audit-work/outputs/W1_5_A2_AUDIT_TESTS_CONTRACTS_GPT55.md` — A2 audit (1 P2, 2 P3 — fixer in flight)

**Phase 2 audit inputs (one per Phase 2 PR):**
- `POST_MERGE_PR400_AUDIT_2026-06-15.md` — input to current Phase 2 PR1 fixer
- `POST_MERGE_PR396_AUDIT_2026-06-15.md` — input to next Phase 2 PR2
- `POST_MERGE_PR398_AUDIT_2026-06-15.md`
- `POST_MERGE_PR397_AUDIT_2026-06-15.md`
- `POST_MERGE_PR252_AUDIT_2026-06-15.md` + `POST_MERGE_PR252_SOLO_AUDIT_2026-06-15.md`
- `POST_MERGE_PR250_AUDIT_2026-06-15.md` + `POST_MERGE_PR250_SOLO_AUDIT_2026-06-15.md`
- `POST_MERGE_PR249_AUDIT_2026-06-15.md` + `POST_MERGE_PR249_SOLO_AUDIT_2026-06-15.md`
- `POST_MERGE_PR254_AUDIT_2026-06-15.md` + `POST_MERGE_PR254_SOLO_AUDIT_2026-06-15.md`

**Snapshots / rescue artifacts:**
- `/home/user/workspace/pr263-closeout-snapshot/` — rescued worktree from hung subagent
- `/home/user/workspace/cron_tracking/3b014359/` — watchdog cron output

**Repo-side authoritative docs (read these for rules):**
- `growth-project-backend/AGENT_RULES.md` — all R-rules, decacorn doctrine
- `growth-project-backend/ENGINEERING_RULES.md` — auth, RLS, errors, DTO hygiene, stripe
- `growth-project-backend/docs/decisions/` — ADRs (R68)
- `growth-project-backend/docs/PRE_EXISTING_TEST_FAILURES.md` — R10 retirement note
- `growth-project-backend/docs/REPO_DOCTRINE_GUARDS.md` — R70 fail-fast lane index
- `tgp-agent-context/quality-references/MOBILE_APP_DESIGN_INTELLIGENCE.md` — R73 planner source-of-truth (~17k words; read in FULL, not search)

---

## 15. Todo list / next PRs (state at handoff)

The full plan is `HYPERSCALER_BUILD_ORDER.md`. State at handoff:

| # | PR | Status | Notes |
|---|---|---|---|
| 1 | Mobile PR #263 | MERGED | commit `31487a1`, 5 findings closed |
| 2 | W1.5-A1 | MERGED | commit `aacee517` to wave-1-5-planning, 17 findings closed via `withRlsContext` pivot |
| 3 | **W1.5-A2** | FIXER IN FLIGHT | PR #418, 1 P2 + 2 P3 from tests/contracts auditor; fixer brief at `audit-work/briefs/W1_5_A2_FIXER_BRIEF.md` |
| 4 | **Phase 2 PR1 (#400 followup)** | FIXER IN FLIGHT | branch `fix/pr400-followup-r81`, last commit `6d36dea` closing F1/F2/F4/F5 |
| 5 | W1.5-A3 — RLS policies for User/Gym/GymMembership | Next after A2 CLEAN | Builder brief not yet drafted |
| 6 | W1.5-A4 — RLS live-DB test harness | Pending A3 | |
| 7 | W1.5-A5 — Redis client + module skeleton | Pending A4 | |
| 8 | W1.5-A6 — FeatureFlagsModule scaffold | Pending A5 | |
| 9 | W1.5-A7 — `gym_owner` role plumbing | Pending A6 | |
| 10 | W1.5-A8 — Termination cascade contract (read-only) | Pending A7 | |
| 11 | CHAIN B (12 schema PRs, parallel-in-tier) | After A4 unblocks Tier B1 | |
| 12 | CHAIN C (17 feature PRs, serial sub-chains) | After A+B complete | |
| 13 | Phase 2 PR2 — #396 backend | Pending Phase 2 PR1 CLEAN | Audit at `POST_MERGE_PR396_AUDIT_2026-06-15.md` |
| 14 | Phase 2 PR3 — #398 backend | Pending | |
| 15 | Phase 2 PR4 — #397 backend | Pending | |
| 16 | Phase 2 PR5 — #252 mobile (StripeConnect a11y + screen) | Pending; R73 Planner stage required | |
| 17 | Phase 2 PR6 — #250 mobile | Pending; R73 Planner if screen mod | |
| 18 | Phase 2 PR7 — #249 mobile | Pending; R73 Planner | |
| 19 | Phase 2 PR8 — #254 mobile | Pending; R73 Planner | |
| 20 | GOD-PR — CoachWorkoutBuilderScreen.tsx refactor | Quarantined; after Phase 2 | 1,783 LOC -> 4 hooks |
| 21 | Final merge sequence + staging soak + prod flag flip | End of wave | |

### Immediate next action when you pick up
1. Wait on the two in-flight Opus 4.8 fixers (A2 fixer + Phase 2 PR1 fixer)
2. When A2 fixer completes:
   a. Read `audit-work/outputs/W1_5_A2_FIXER_REPORT.md`
   b. Spawn DUAL GPT-5.5 re-auditors (same focus split) for PR #418
   c. When both return CLEAN -> squash-merge #418 to `wave-1-5-planning` with `gh pr merge 418 --squash --auto`
   d. Draft W1.5-A3 builder brief (use §9.1 template) and spawn Opus 4.8 builder
3. When Phase 2 PR1 fixer completes:
   a. Spawn DUAL GPT-5.5 re-auditors for the followup
   b. Loop until CLEAN
   c. Merge to `main` (Phase 2 lands on main directly — these close post-merge findings on already-merged code)
   d. Spawn Phase 2 PR2 fixer for #396 using `POST_MERGE_PR396_AUDIT_2026-06-15.md` as input

---

## 16. Decision log — things we said NO to

So you don't re-litigate them:

| Considered | Rejected because |
|---|---|
| Sonnet for fixers | User explicit "never Sonnet for fixers — Opus 4.8 ONLY" |
| Pairing builder + auditor in same subagent | R31 separation; degrades audit signal |
| Merging A2 before A1 P3 closed | R81 strict — true zero before merge |
| Demoting A2 warn to `debug` instead of once-per-process | Loses ops signal entirely; once-per-process keeps boot visibility |
| Watchdog cadence 30 / 15 min | Platform minimum 60 min; rejected by `schedule_cron` |
| `$allOperations` Prisma extension for RLS | Breaks under Supabase pgbouncer tx-pool (§13) |
| Re-running stuck subagent | Rescue from worktree + cancel; spawning duplicate burns credits |
| `browser_task` for `gh pr view` | R79 — `gh` CLI only |
| Single auditor for "small" PRs | DUAL auditors per PR per user rule; no exceptions |
| Wave 1.5 PRs to `main` mid-wave | Integration branch first; single cutover at end |
| 25-PR Wave 1.5 at 560 LOC median | Hyperscaler self-test failed; rewrote to 37 PRs at 260 median |
| Storing fixer briefs only in workspace | R64 — push everything to GitHub; sandbox can evict |
| `message_subagent` to redirect running coding subagent | Coding subagents can't receive follow-ups; only `cancel_subagent` |

---

## 17. Connected services / tools available

Confirmed via `list_external_tools` this session:
- `github_mcp_direct` (also via `gh` CLI which is preferred for code workflows)
- `supabase` (RLS validation, migration status — use if you need to query live DB state, but coordinate carefully under R64)
- `posthog__pipedream` (event telemetry — useful for R78 verification)
- `plaid` (not used this session; available if needed)
- `finance` (not used this session)

For anything else (Slack, email, etc.) — `list_external_tools` first, never assume unavailable.

---

## 18. Glossary of session-specific shorthand

| Term | Meaning |
|---|---|
| **R81** | The audit cycle: dual GPT-5.5, loop until true zero, fix all P0/P1/P2/P3 |
| **Wave 1.5** | The 37-PR build (CHAIN A + B + C) currently in flight |
| **Phase 2** | The 8-PR post-merge cleanup of PRs #249-#254, #396-#400 already on main |
| **Hectacorn** | The quality bar (see §2) |
| **Luxury doctrine** | Quiet luxury palette + voice; Maya is the persona (head coach) |
| **Coach Maya** | The default coach persona in copy / unlock UX / message-coach orphan flow |
| **Roman** | The R31 audit stack / persona (GPT-5.5 reasoning trace) |
| **Roman pre-write pattern** | Write shadow rows -> atomic swap -> audit log — used for irreversible writes (B-Q4 termination cascade) |
| **`check`** | Hourly watchdog heartbeat — respond per §11 |
| **Operator choice** | A decision the user wants surfaced in (a)/(b)/(c) format with descriptions |
| **GOD-PR** | A pathologically large PR that needs quarantined refactor (CoachWorkoutBuilderScreen.tsx, 1783 LOC) |
| **`withRlsContext`** | The A1 helper that opens `$transaction` + stamps GUC on tx handle (the pivot — §13) |
| **`set_config(..., true)`** | Transaction-scoped Postgres GUC setter; the `true` is critical (means LOCAL/tx-scoped vs. session-scoped) |
| **pgbouncer tx-pool mode** | Supabase port 6543 — connection returned to pool at tx end; session-scoped state DOES NOT survive |
| **`gym_ids` claim** | JWT claim that A2 reads to populate RLS context; no code populates it yet (B1b ships it) |
| **Stacked PRs** | Graphite/Stripe Minions pattern: each PR depends only on the previous in its chain; squash-merge to integration branch |

---

## 19. If you're stuck — escalation order

1. **Read this doc fully first.** 80% of "I don't know what to do" cases are answered above.
2. **Check `growth-project-backend/AGENT_RULES.md`** — the R-rule definitive source.
3. **Search prior sessions** with `memory_search` for the topic. The user has decacorn-quality continuity expectations.
4. **Surface an operator choice** (§12 format) on the next `check` heartbeat. Do NOT spam the user before they wake up — batch decisions.
5. **Never** silently change scope, model, or doctrine to "unblock". The user would rather you pause than ship something off-bar.

---

## 20. Final note from the outgoing operator

The user is fundamentally building a hectacorn-grade SaaS for a niche market, fully aware that their AI agents are doing the heavy lifting. Their bar is non-negotiable not because they're picky but because they intend to ship this in front of 800 people (R13) and the only defense against AI-coding's 50 documented failure patterns (R65) is **process discipline they can't relax** — small PRs, dual audits, R81 strict, Opus-only fixers, GitHub-push-everything, hectacorn voice.

They reward operators who execute the protocol cleanly. They are vocally frustrated by operators who cut corners. The fastest path to their respect is: ship clean PRs through the cycle at velocity, never compromise on R81, surface operator choices in the (a)/(b)/(c) format, and treat every `check` heartbeat as a chance to demonstrate signal-to-noise.

You've got this. The plan is real, the chain is loaded, the rules are clear. Go.

— outgoing operator, 2026-06-16 09:10 PDT
