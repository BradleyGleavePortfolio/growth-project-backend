# Operator Handoff — 2026-05-27 14:07 PDT

**For:** Next Computer (AI) operator continuing the AI Bugs Sweep
**From:** Computer instance that drove PR #293 to CLEAN through 3 audit/refix rounds
**Status:** PR #293 is **CLEAN, MERGE-APPROVED, READY TO MERGE** — but **NOT YET MERGED**. User asked for this handoff before merge; check user instruction on whether to merge immediately on resume.

---

## 1. Standing Rules (verbatim — these govern every action)

- **R1 Supreme Law:** "Does this raise the bar of quality OR hold the bar at decacorn quality?"
- **CLEAN BAR:** "CLEAN = CI GREEN + ZERO P0'S OR P1'S OR P2'S"
- **R52:** "WASTED CREDITS = TAKING FOOD OUT OF MY BABY DAUGHTER'S MOUTH"
- **Audit rule:** "AUDIT BOTS MUST BE EXHAUSTIVE, THERE IS NO 'ENOUGH FOUND' -> FIND EVERY SINGLE P0-P3 possible!"
- **R61:** Push every 2 minutes
- **R56:** Worktree discipline — separate worktree per task, NEVER `git checkout` switch
- **R6:** Computer (AI parent) merges when CLEAN; subagents cannot merge
- **Stillwater Standard:** decacorn UX target with tactile feedback / small animations / thought-out paths
- **Commit author:** `Dynasia G <dynasia@trygrowthproject.com>`, **NO Co-Authored-By footer**
- **User direction this session:** No parallel work touching AI code — single-track execution

---

## 2. Critical Files to Read (in this order)

### Tier 1 — READ FIRST before any action

1. `/home/user/workspace/audits/pr293_audit_round3.md` — **CLEAN verdict report** (top of file states verdict, P3 list at bottom). HEAD `9d9cfbf0`. Verdict: CLEAN. Counts: 0 P0 / 0 P1 / 0 P2 / 6 P3. Recommendation: MERGE APPROVED.
2. `/home/user/workspace/audits/pr293_refixer_report_round3.md` — what the round-3 refixer changed.
3. `/home/user/workspace/audits/pr293_audit_round2.md` — the round-2 DIRTY audit that prompted round-3 (context for what was fixed).
4. `/home/user/workspace/audits/pr293_refixer_report_round2.md` — round-2 refixer changes.
5. `/home/user/workspace/audits/pr293_audit.md` — original DIRTY audit (round 1).
6. `/home/user/workspace/audits/ai_pr3_refixer_report.md` — original refixer report (round 0 → ff69877e).

### Tier 2 — Canonical specs (source of truth for follow-up PRs)

7. `docs/audits/ai_usage_economics_plan_2026-05-27.md` (on `main` branch, PR #294 merged) — **THE CANONICAL DOC**. Locks: $40 actual cap / 5× multiplier / $200 displayed envelope; combined coach+clients single envelope; face-value credit packs ($25/$50/$99/Custom min $10 max $500, 80% margin); 80% dynamic walkthrough + buy-more CTA; 95% banner+push; 100% hard pause; dormancy guard = skip auto-brief if last 3 daily briefs unread; sub-coaches share head coach's envelope; 2% TGP take rate logic.
8. `docs/audits/ai_credit_marketplace_2026-05-27.md` (on main, PRs #291+#292) — credit packs spec.
9. `docs/audits/bug_register_round3_open_hunt_2026-05-27.md` (on main, PR #290) — 18 findings including BUG-S3 GDPR-AIDraft.
10. `/home/user/workspace/ai_bugs_sweep_plan.md` — local plan tracker (status of each PR in sweep).

### Tier 3 — Optional but useful

11. `/home/user/workspace/PROJECT_STATE.md` — overall project state.
12. `/home/user/workspace/OPERATOR_HANDOFF_2026-05-26.md` — yesterday's handoff (prior context).
13. `/home/user/workspace/NEXT_OPERATOR_MEGA_PROMPT.md` — broader operator-level priorities (read if scope expands).

---

## 3. Repos & Worktrees

**Primary repo:** `BradleyGleavePortfolio/growth-project-backend`

| Worktree | Path | Branch / HEAD | Purpose | Cleanup? |
|---|---|---|---|---|
| Main | `/home/user/workspace/repos/growth-project-backend` | `main` @ `f23f3451` | Read main; spawn new feature branches | KEEP |
| AI-approval feature | `/home/user/workspace/tgp/backend-ai-approval` | `feat/ai-approval-materialise` @ `9d9cfbf0` | PR #293 work (now CLEAN) | **REMOVE AFTER MERGE** |
| AI-approval audit | `/home/user/workspace/tgp/backend-audit-ai-approval` | detached @ `9d9cfbf0` | Audit-only read-only worktree | **REMOVE AFTER MERGE** |

**Other repos (untouched this session):** `growth-project-mobile`, `tgp-platform-site`.

**Cleanup commands (run AFTER merging #293):**
```
cd /home/user/workspace/repos/growth-project-backend
git worktree remove --force /home/user/workspace/tgp/backend-ai-approval
git worktree remove --force /home/user/workspace/tgp/backend-audit-ai-approval
git push origin --delete feat/ai-approval-materialise  # only if merge used squash and branch isn't auto-deleted
git branch -D feat/ai-approval-materialise 2>/dev/null || true
```

---

## 4. What Has Been Done (this session, chronological)

1. **Closed all 6 Dependabot PRs** via 4 replacement PRs (#286 ESLint, #285 openai, #287 expo, #289 Prisma) — all CLEAN merged.
2. **PR #290** — Filed Bug Register Round 3 (Open Hunt) verbatim. 18 findings including BUG-S3 (GDPR-AIDraft missing from exports). Merged at `4014d38f`.
3. **AI economics locked through 3 user-driven iterations:**
   - Round 1: $20 / 6.25× / $125
   - Round 2: split coach/client caps proposed → user said combined single envelope
   - Round 3: surfaced 2% TGP take rate → **$40 / 5× / $200 (final)**
4. **PR #291** — Filed credit marketplace doc. Merged at `c6547150`.
5. **PR #292** — Revised credit-pack pricing to face-value ($25/$50/$99/Custom, 80% margin). Merged at `2c87b5d4`.
6. **PR #294** — Filed canonical AI Usage Economics plan consolidating all decisions. Merged at `f23f3451`. **This is the source of truth for AI-1..AI-5 + Credits-1..3.**
7. **PR #293** (the active one) — feature: AI-3 approval-loop materialiser, fixes PRODUCT-1 silent message non-send.
   - Round 0: refixer produced `ff69877e`, 12 files +1004 −5, 28 new tests, CI green.
   - Round 1 audit (`pr293_audit.md`): **DIRTY** — 1 P1 race-window, 3 P2 (stuck-claim / loser-audit-row / non-atomic decide), 4 P3 deferred.
   - Round 2 refixer (`3a4c2743`): updateMany gate + observable-commit polling. Tests 3164 → 3167.
   - Round 2 audit (`pr293_audit_round2.md`): **DIRTY** — 1 NEW P1 (approve+reject race delivers message for rejected draft), 1 NEW P2 (noop gate incompatibility), 8 P3.
   - Round 3 refixer (`9d9cfbf0`): added `status:'pending'` to claim WHERE + poll status-check + reject-gate `materialised_at:null` + expireStaleDrafts symmetric guard + gate keyed on `materialisationRef !== null`. Tests 3167 → 3170. CI green.
   - Round 3 audit (`pr293_audit_round3.md`): **CLEAN — MERGE APPROVED**. 0 P0/P1/P2, 6 P3.

---

## 5. What Needs to Be Done — Ordered Queue

### IMMEDIATE (PR #293)

**P0 next action: MERGE PR #293.** Only Computer (AI parent) can merge per R6.

```bash
# verify CLEAN one more time
gh pr view 293 --json mergeable,statusCheckRollup
# squash-merge (this repo's convention)
gh pr merge 293 --squash --delete-branch --subject "feat(ai): approval-loop materialiser fixes PRODUCT-1 (#293)"
# clean up worktrees (see section 3 cleanup commands)
```

Use `bash` with `api_credentials=["github"]` for all `gh` calls. **Do NOT use the github_mcp_direct connector** (this session and prior have standardized on `gh` CLI).

**CHECK with user first if any uncertainty** — user may want to inspect the PR or review the round-3 audit report before merge.

### AFTER MERGE — PR Sequencing (per canonical doc)

| Order | PR | Findings addressed | Status |
|---|---|---|---|
| 1 | **AI-1** combined spend envelope + DTOs + cron caps + unread-guard | A1, A2, A6, A9, PRODUCT-2 FM2 | Queued — start next |
| 2 | **AI-2** prompt-injection hardening + named throttle buckets + opaque ai_engine | A3, A5, A7, A8 | Queued |
| 3 | **AI-4** brief numeric reconciliation + cursor pagination + staleness | A4, PRODUCT-2 FM1/FM3 | Queued |
| 4 | **AI-5** GDPR export AIDraft (+ other BUG-S3 items) | BUG-S3 GDPR-AIDraft | Queued |
| 5 | **Credits-1** Stripe credit packs backend | per credits spec | Follow-up |
| 6 | **Credits-2** Mobile walkthrough at 80% / 95% / 100% | per credits spec | Follow-up |
| 7 | **Credits-3** Admin tooling for credit grants | per credits spec | Follow-up |

User explicitly said: **P0 first, solo, no parallel AI work.** Single-track execution.

### Standing follow-ups (file as issues, do not block merge)

- **P3-α (round-3 audit)** — Stuck-claim drafts can no longer be rejected via decide(reject) due to round-3 reject-gate `at=null` clause. Combined with approve-on-stuck-claim 409 and expire-cron `at=null`, a stuck-claim draft is permanently jammed until ops intervention. Deliberate trade-off. **Recommend follow-up: write ops runbook** + admin endpoint to manually clear stuck-claim state.
- **Test coverage gap** — `expireStaleDrafts`'s new `materialised_at: null` clause not pinned by a dedicated test. Add in AI-1 or as a small follow-up.
- **P3-C carry** — 409s lack `Retry-After` header. Mobile clients retry immediately and may reproduce race. Add in AI-1 or as small follow-up.
- Round-1 deferred P3s still open: orphan backfill script, test count arith, audit metadata redaction (PII in raw error messages), Symbol DI token.
- Round-2 deferred P3s still open: P3-B (no backoff in poll), P3-D (unused payload param), P3-E (loose Prisma typing on decideGate), P3-G (test global pollution).

---

## 6. Mid-Flight Work — Current Status

**There is NO active mid-flight subagent.** The round-3 re-audit (`pr_293_re_audit_round_3_mpojp9gy`) completed at 14:07 PDT with verdict **CLEAN — MERGE APPROVED**.

**The only mid-flight item is the merge itself** — PR #293 is CLEAN, CI green on both runs of `9d9cfbf0`, mergeable=MERGEABLE per `gh pr view`, audit explicitly says MERGE APPROVED. Per user's explicit instruction, the prior operator was told **not to launch any further fixer** and to write this handoff first. **Do not merge until user confirms** (or unless user's standing instruction is to proceed on CLEAN — re-check user direction on resume).

### Mid-flight state details

- Branch `feat/ai-approval-materialise` at `9d9cfbf0` is pushed to origin.
- CI: both runs green on `9d9cfbf0`.
  - https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/26538119392
  - https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/26538113240
- Tests: 3170 passing (16 skipped, 5 todo, 3188 total).
- Commits on branch (since `main`):
  - `9d9cfbf0` fix(ai): close approve+reject race (P1) + gate compat with noop materialisers (P2)
  - `71cde37f` wip(ai): round-3 P1-A + P2-A scaffold
  - `3a4c2743` fix(ai): close race-window in approval materialiser (P1) + stuck-claim retry (P2) + atomic decide guard (P2)
  - `01c86b94` wip(ai): P1-1 race-window fix scaffold + interface racing state
  - `ff69877e` feat(ai): materialise approved drafts via capability registry (fixes silent message non-send)
- All 5 commits authored as `Dynasia G <dynasia@trygrowthproject.com>`, no Co-Authored-By footer (verified by round-2 audit).
- Squash-merge will collapse these to a single commit on main with the title above.

---

## 7. Locked Business Numbers (do not relitigate)

From `docs/audits/ai_usage_economics_plan_2026-05-27.md`:

- **Base cap:** $40 actual Anthropic spend / coach / month (combined coach + ALL his clients)
- **Multiplier:** 5.0× → **$200 displayed allowance**
- **Env vars:** `COACH_AI_MAX_ACTUAL_CENTS=4000`, `COACH_AI_VALUE_MULTIPLIER=5.0`
- **Credit packs face-value:** $25 / $50 / $99 / Custom (min $10, max $500). Coach pays $X, gets $X displayed, TGP cost = $X/5 → **80% gross margin**.
- **Dormancy guard:** skip auto-brief if last 3 daily briefs unread (`CoachBrief.read_at` null check). No last_login guard.
- **80% UI:** dynamic walkthrough + "Top up credits" CTA.
- **95% UI:** banner + push notification.
- **100% UI:** hard pause until rollover or pack purchase.
- **Sub-coaches:** share head coach's envelope; head coach is the billing entity.
- **TGP take rate:** 2% on coach's $5K/mo processed → $100/coach/mo revenue → 75% margin at typical roster; $40 cap protects against $950 adversarial loss.

---

## 8. Tool & Workflow Patterns That Work (proven this session)

- `bash` with `api_credentials=["github"]` for ALL `gh` CLI invocations. Never use `github_mcp_direct` connector tools.
- Refixers run in the feature worktree (`backend-ai-approval`); audits run in a separate detached read-only worktree (`backend-audit-ai-approval`).
- Subagent model: **Opus 4.7** for audits and refixers (highest quality). Sonnet 4.6 acceptable for cheap docs-only audits.
- After audit DIRTY: read full report, fire refixer with specific P0/P1/P2 fix list + new tests required, re-audit, repeat to CLEAN.
- CI on this repo does NOT auto-trigger on PR push; **must dispatch**: `gh workflow run CI --ref <branch>` after every push.
- When sibling PR lands mid-flight: rebase + `npm install --package-lock-only --ignore-scripts --legacy-peer-deps` to regenerate lockfile.
- Worktree cleanup: `git worktree remove --force <path>` + `git push origin --delete <branch>` + `git branch -D <branch>`.
- Subagents share the same sandbox + workspace as parent. Pass file paths in objectives, not contents.
- Docs PRs (markdown-only) can be audited inline (no subagent needed).

### Critical: do NOT use these tools

- `github_mcp_direct` connector tools — use `gh` CLI via bash with `api_credentials=["github"]` instead.
- Do not run `git checkout` to switch branches — always use worktrees (R56).
- Do not parallelize AI-code work — user said single-track.

---

## 9. Connectors Available

```
github_mcp_direct    # AVAILABLE but DO NOT USE — prefer gh CLI
posthog__pipedream   # available, unused
supabase             # available, unused
sentry               # available, unused
finance              # available, unused
```

---

## 10. Memory Already Saved

From this session: "User's locked AI budget is $40 actual / 5× / $200 displayed combined coach+clients with face-value credit packs."

---

## 11. Skills Loaded

None active at handoff time. No skill reloads required to resume — the resume action is straightforward (merge PR + start next PR per queue).

---

## 12. Resume Action

1. Read `/home/user/workspace/audits/pr293_audit_round3.md` (CLEAN verdict, 6 P3 follow-ups).
2. Confirm with user whether to merge PR #293 immediately, or wait for their review.
3. If green-lit: squash-merge per command in section 5.
4. Clean up worktrees per section 3.
5. File the 3 standing follow-ups from section 5 as GitHub issues (P3-α stuck-claim runbook, expireStaleDrafts test, Retry-After header).
6. Begin **PR AI-1** (combined spend envelope + cron caps + unread-guard) per canonical doc. Single-track, no parallel AI work.
