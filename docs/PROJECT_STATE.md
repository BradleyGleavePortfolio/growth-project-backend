# PROJECT_STATE.md — Master Source of Truth

**Last updated:** 2026-05-26 19:40 PDT
**Maintained by:** Computer (the AI agent)
**Read this file FIRST on every session resume.**

This is the canonical durable state of the project. Conversation summaries can evict; this file does not. Every section below points to either a workspace file or a GitHub state — both survive session boundaries.

---

## 0. Mission + Standards (Non-Negotiable)

### Operating rules (active)

| Rule | Statement |
|---|---|
| **R1 Supreme Law** | "Does this raise the bar of quality OR hold the bar at decacorn quality?" Every decision filters through this. |
| **CLEAN BAR** | "A decacorn does not merge on red CI. Stripe doesn't. Notion doesn't. CLEAN = CI GREEN + ZERO P0's OR P1's OR P2's." |
| **R52** | "WASTED CREDITS = TAKING FOOD OUT OF MY BABY DAUGHTER'S MOUTH." Scope tight. No speculative refactors. |
| **Audit rule** | "AUDIT BOTS MUST BE EXHAUSTIVE, THERE IS NO 'ENOUGH FOUND' — find EVERY single P0-P3 possible." |
| **R61** | Push every 2 minutes during active work. |
| **R56** | Worktree discipline — separate worktree per task, NEVER `git checkout` switch. |
| **R6** | Computer (the AI) merges when CLEAN. Subagents cannot merge. |
| **R10** | RETIRED (closed via PR #278 — stale test-helper bugs). |
| **R4** | RELAXED — user does not care about GitHub squash-merge author defaulting to PR opener. Don't flag. |

### The Stillwater Standard (NEW — set this session)

The user's vision for the app, codified in `/home/user/workspace/design-system/00-stillwater-standard.md`:

> **Calm, premium, mindful, de-loading. Less bro-gym, more lifestyle. Habit-rewarding.**
>
> One notch ABOVE what a decacorn would ship. Design becomes the moat.

Haptics, micro-animations, thoughtful path design through every screen. The 7 principles, tone of voice, anti-patterns, and 5 redesign specs are in `/home/user/workspace/design-system/`.

### Author + signing

- Author for all commits: `Dynasia G <dynasia@trygrowthproject.com>`
- NO `Co-Authored-By` lines (user has explicitly disallowed this).

---

## 1. Repo State

**Repo:** `BradleyGleavePortfolio/growth-project-backend`
**Main HEAD as of last write:** `e17c362a` — "Nudge v1 (#282)". Train merged: `b552df28` (#280 CNAME P4) → `a3e79c10` (#281 Dunning v1) → `e17c362a` (#282 Nudge v1).
**Sibling repos:** `BradleyGleavePortfolio/growth-project-mobile`, `BradleyGleavePortfolio/tgp-platform-site`

### Recently shipped (this session's work — all merged)

| PR | Title | Merge commit | Audit chain |
|---|---|---|---|
| #280 | CNAME Phase 4 — prisma regen + claim race + DNS timeout | `b552df28` | v1 DIRTY 0/0/2/12 → refix → v2 CLEAN 0/0/0/13 |
| #281 | Dunning v1 — webhook-driven cadence + admin override + 4 templates | `a3e79c10` | v1 DIRTY 0/1/4/5 → refix → v2 CLEAN 0/0/0/5 |
| #282 | Nudge v1 — 4 triggers, frequency cap, quiet hours, opt-out | `e17c362a` | v1 DIRTY 0/2/4/5 → refix → v2 CLEAN 0/0/0/7 |

### Open PRs (this session)

| PR | Title | Status |
|---|---|---|
| **#283** | docs: persist operator state | THIS PR. Awaiting CI + audit + merge. |

### Open PRs (pre-existing, in queue)

| PR | Title | Status / Disposition |
|---|---|---|
| #272 | CRM Phase 3 — CRM adapters + lead sync + analytics | Next after the 3 above. Needs audit + known 3 P0 SSRFs to fix + $/visitor metric. |
| #275 | Operator handoff 2026-05-26 | Future. Docs only. |
| #268 | RLS-01 Helper function search_path lockdown + HIBP | DRAFT. Future. |
| #277 | R15 — GitHub as only source of truth (agent workflow discipline) | **Leave stashed.** User decision: "leave PR #277 stashed". stash@{1} in main repo, do not touch. |
| #183 | Phase 11 talent marketplace scaffold | Older. Stale check needed before action. |
| #105, #251, #255, #256, #257, #258 | Dependabot deps | Sweep after main train completes. |

### Worktrees (as of last write)

| Worktree | Branch | Status |
|---|---|---|
| `/home/user/workspace/repos/growth-project-backend` | main | clean at `e17c362a` (may have local stash@{1}) |
| `/home/user/workspace/tgp/backend-docs-context` | docs/operator-state-2026-05-26 | This PR (#283) |

**Mobile repo:** `/home/user/workspace/repos/growth-project-mobile`, branch `agent/cpo/r-new-github-source-of-truth/e1477683`
**Platform site:** `/home/user/workspace/repos/tgp-platform-site`

---

## 2. Active Workstreams (live this session)

| Workstream | Status | Output location |
|---|---|---|
| Docs PR #283 (this PR) | awaiting CI + audit + merge | `docs/` directory |

Merge train (#280, #281, #282) — DONE.

---

## 3. Completed This Session (chronological)

1. ✅ Merged PR #278 (R10 cleanup — fix 3 stale-helper tests). Commit `780187c7`.
2. ✅ Merged PR #273 (docs R56-R61). Commit `1df67cfc`.
3. ✅ Merged PR #274 (LP-RENDERER-V2). Commit `d77b5c49`.
4. ✅ Rebased all 5 fix branches onto fresh main.
5. ✅ Refixer cycle: money path 3 P2s, integration P1 + 2 P2s + CI env gap.
6. ✅ Built integration branch `integration/checkout-hardening`, opened PR #279.
7. ✅ Two CLEAN v3 audits + one CLEAN v2 re-audit at HEAD `2dea978a`.
8. ✅ **Merged PR #279** (squash `22f21caf`). Closed #276. Cleaned all merged worktrees.
9. ✅ Wrote `audits/ux_review_rubric.md`. Spawned GPT-5.5 UX subagent.
10. ✅ UX subagent returned: full report on 203 surfaces, heatmap, worst-10, strongest-10, top-20 fixes. Saved to `audits/ux_review_report.md`.
11. ✅ Wrote + ranked 17 third-party hygiene findings (2 batches). Saved to `audits/codebase_hygiene_findings.md`.
12. ✅ Spawned 4 parallel Opus subagents: CNAME P4 + Dunning v1 + Nudge v1 + Stillwater Standard spec.
13. ✅ Stillwater Standard subagent returned: 10 deliverables under `/home/user/workspace/design-system/`.
14. ✅ CNAME P4 subagent returned: PR #280 CI green.
15. ✅ Dunning v1 subagent returned: PR #281, CI failed lint, Computer fixed + pushed `af02b8e8`.
16. ✅ Nudge v1 subagent returned: PR #282 opened.
17. ✅ Wrote `PROJECT_STATE.md` (this file).
18. ✅ PR #280 v2 audit CLEAN → **merged `b552df28`**, cleaned up worktrees.
19. ✅ PR #281 v1 audit DIRTY 0/1/4/5 → refix (1 P1 + 4 P2s in 2 commits) → v2 audit CLEAN → **merged `a3e79c10`**, cleaned up.
20. ✅ PR #282 v1 audit DIRTY 0/2/4/5 → refix (2 P1 + 4 P2s in 3 commits) → v2 audit CLEAN → **merged `e17c362a`**, cleaned up.
21. 🔄 Opened PR #283 (this docs persistence PR) — committing operator state to repo so it survives session boundaries.

---

## 4. Backlog (Sequenced Roadmap)

### Tier 1 — In flight
1. **PR #283 docs persistence** (this PR) — awaiting CI + audit + merge

### Tier 1 (just shipped)
- ✅ PR #280 CNAME P4 — merged `b552df28`
- ✅ PR #281 Dunning v1 — merged `a3e79c10`
- ✅ PR #282 Nudge v1 — merged `e17c362a`

### Tier 2 — Next backend train (per user sequencing)
4. **PR #272 CRM Phase 3** — known: 3 P0 SSRFs to fix + $/visitor metric missing. Needs exhaustive audit first.
5. **Dependabot sweep** — #105, #251, #255, #256, #257, #258. Audit-as-batch, separate PRs if any introduce risk.
6. **PR #268 RLS-01** — currently DRAFT. Promote when ready.
7. **PR #277 R15 source-of-truth rules** — currently stashed, user said "leave stashed"; revisit when user prompts.

### Tier 3 — Hygiene sweep (post-CRM) — 6 PRs A→F, sequenced
From `audits/codebase_hygiene_findings.md`:

| PR | Scope | Findings | Why this order |
|---|---|---|---|
| **PR-A: AI cost + security hardening** | spend cap + GatewayInvokeDto + dedicated throttle + reject in-history `system` role | #9, #10, #11, #16 | LLM cost is the actively bleeding P&L edge |
| **PR-B: Stripe/Billing hardening** | portal-session throttle + service extraction + OwnerBilling throttle/Swagger + start-subscription DTO | #12, #13, #14, #15 | Stripe API quota + real-customer rows |
| **PR-C: Security parity sweep** | coach-messaging @Roles + storefront GET throttle + real-meal-plans guard lift | Batch1 #1, #2, #5 | Known security parity gaps |
| **PR-D: Admin controller cleanup** | cursor pagination + PaginationQueryDto + Swagger + coach-brief cursor + dead-410 cleanup | Batch1 #3, #4, #6, #7 + Batch2 #17 | Single highest-debt file |
| **PR-E: payment-ops Swagger pass** | annotate all 29 endpoints | Batch1 #8 | Isolated annotation work |
| **PR-F: CI lint rules** | encode all conventions as CI checks | covers all | Prevents future regressions |

### Tier 4 — UX implementation (from Stillwater Standard rollout)
8. **Tactile primitives library** (`useHaptic`, `useSpring`, `CompletionMoment`) — gated dependency for everything else
9. **Top-5 redesigns** parallelizable once primitives ship:
   - client/HomeScreen polish (4.3 → 5.0)
   - client/SettingsScreen (1.7 → 4+, grouped drill-down)
   - coach/AIMealPlanDraftScreen (summary-first approval)
   - BrandedCheckoutWebViewScreen (Phantom CALM trust choreography)
   - Notification Preferences (3 presets + Advanced)
10. **Lifestyle voice rewrite** — copy patches across worst-10 screens

Full Tier 1/2/3 UX rollout plan: `/home/user/workspace/design-system/04-rollout-plan.md`

### Deferred (by user)
- **Placeholder env var GitHub list** — user said "wait until the app's done." Defer until product launch.
- **PR #183 Phase 11 talent marketplace** — needs stale check before any action.

---

## 5. Artifacts Index (all durable files)

### Design system (Stillwater Standard)
- `/home/user/workspace/design-system/README.md` — index of all design docs
- `/home/user/workspace/design-system/00-stillwater-standard.md` — manifesto, 7 principles, tone of voice, anti-patterns
- `/home/user/workspace/design-system/01-tactile-primitives.md` — `useHaptic`, `useSpring`, `CompletionMoment` contracts
- `/home/user/workspace/design-system/02-screen-grammar.md` — One Decision Rule, Path Spec, Cognitive Budget, De-Load Checklist
- `/home/user/workspace/design-system/03-redesign-specs/` — 5 screen redesign specs
- `/home/user/workspace/design-system/04-rollout-plan.md` — sequencing + effort sizing

### Design intelligence (source docs from user)
- `/home/user/workspace/Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md` (134KB)
- `/home/user/workspace/Website-Landing-Page-Design-Intelligence-The-Exhaustive-Agent-Training-Document.md` (81KB)

### UX audit
- `/home/user/workspace/audits/ux_review_rubric.md` — 3-ideal scoring rubric
- `/home/user/workspace/audits/ux_review_report.md` — full audit of 203 surfaces
- `/home/user/workspace/audits/ux_scored_surfaces.tsv` — sortable scored data
- `/home/user/workspace/audits/ux_scored_surfaces.json`
- `/home/user/workspace/audits/ux_surface_inventory.json`
- `/home/user/workspace/audits/ux_surface_metrics.json`

### Codebase hygiene
- `/home/user/workspace/audits/codebase_hygiene_findings.md` — all 17 findings, ranked, sequenced into 6 PRs

### Active PR audits + plans
- `/home/user/workspace/audits/cname_phase4_plan.md` + `cname_phase4_result.md`
- `/home/user/workspace/audits/dunning_v1_plan.md` + `dunning_v1_result.md`
- `/home/user/workspace/audits/nudge_v1_result.md`
- `/home/user/workspace/audits/pr280_audit.md` (audit subagent writing now)

### Closed/historical PR audits
- `/home/user/workspace/audits/pr273_audit.md`, `pr274_audit.md`, `pr276_audit.md`
- `/home/user/workspace/audits/pr276_fix1_audit.md`, `pr276_fix3_audit_v2.md`
- `/home/user/workspace/audits/pr276_fix4_audit_v3.md`, `pr276_fix5_audit_v3.md`
- `/home/user/workspace/audits/pr276_fix2_6_7_audit_v3.md`
- `/home/user/workspace/audits/pr279_integration_audit.md`, `pr279_integration_audit_v2.md`

### Other workspace files (pre-existing)
- `/home/user/workspace/CPO_BRIEFING.docx`, `CPO_MASTER_HANDOFF_PART_2.docx`
- `/home/user/workspace/EXHAUSTIVE_BACKLOG.docx`
- `/home/user/workspace/OPERATOR_HANDOFF_2026-05-26.docx`
- `/home/user/workspace/NEXT_OPERATOR_MEGA_PROMPT.docx`
- `/home/user/workspace/pr276_fix_2_6_7_p2_summary.md`, `pr279_p1_p2_refix_summary.md`

---

## 6. Decisions Log (this session, verbatim quotes)

| Decision | User quote | Disposition |
|---|---|---|
| Placeholder env var list | "lets wait until the apps done for that." | Deferred until launch |
| PR #277 stashed branch | "leave PR #277 stashed" | Don't touch the stash@{1} in main worktree |
| R4 relaxation | "i dont care about author signature" | Squash-merge author defaulting to PR opener is fine. Don't flag. (Saved to memory) |
| Merge train order | "Wait for PR #279 CI to go green / Merge PR #279 → close PR #276 / Then: PR #272 CRM Phase 3 fixes, CNAME Phase 4, Dunning v1 rewrite, Nudge v1 wiring / lets get these done!" | Followed |
| UX review approach | "Have a gpt5.5 model go through all our apps screens and give a raiting based on our core ideals - premium, rewarding, and cognitevly simple even with so much fucntionality" | Done. Then upgraded to Opus for follow-up. |
| Stillwater Standard | "lets target a new standard in UI/UX -> Not jsut what a decacorn would ship, but truly beautiful, clean, and rearding the underlying habits we want the user to do every day! Haptic feedback is big, small animations, and directions/ thought out paths through pages is perfect" | Codified in `design-system/00-stillwater-standard.md` |
| Parallel execution | "Yes — all 4 in parallel" (CNAME / Dunning / Nudge / Stillwater) | Spawned in 4 worktrees |
| UX scope | "Is 'spec only' jsut planning and getting plans for you to audit/improve?" → confirmed spec-only | UX subagent was spec-only; implementation deferred to separate cycle after spec approval |
| Model choice | "make all of these opus models" | All 4 ran on Opus 4.7 |

---

## 7. Memory Entries (long-term persistent state)

Saved to persistent memory this and prior sessions:
- User wants Computer to merge when CLEAN (R6).
- User does NOT care about Co-Authored-By or squash-merge author signatures (R4 relaxed).
- User uses worktree discipline (R56) — never `git checkout` switch.
- User wants R61 (push every 2 minutes during active work).
- Author for any commit: `Dynasia G <dynasia@trygrowthproject.com>`.

**To add to memory after this session resolves:**
- The Stillwater Standard exists and is the canonical UX standard above decacorn.
- The 6-PR hygiene sweep sequence (A→F) is the codified roadmap from the 17 third-party findings.

---

## 8. Quick-Start for New Agent Sessions

If you are a new agent resuming this work, do the following before any action:

1. **Read this file in full.**
2. **Check `audits/codebase_hygiene_findings.md`** for outstanding R1 violations.
3. **Check `design-system/`** for active UX direction.
4. **Run `gh pr list --state open` in `/home/user/workspace/repos/growth-project-backend`** for current PR state.
5. **Run `git worktree list`** in the backend repo to see active workspaces.
6. **Check `git log --oneline -10` on main** for last merged commit.
7. **Confirm CLEAN bar still active:** ZERO P0/P1/P2 at any merge.

If the user asks "where are we" — point them at this file.
