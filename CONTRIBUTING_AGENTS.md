# CONTRIBUTING_AGENTS.md

**Operational protocol for every agent (human or AI) working on a TGP repo.**

This is the implementation of **R15** (`AGENT_RULES.md`). If you are an agent and you have not read R15, stop and read it now. R15 is the rule. This doc is the *how*.

---

## TL;DR

1. **GitHub is the only source of truth.** Sandbox-only files are forbidden.
2. **Push every 2 minutes** of active work — and always before spawning a subagent, ending a turn, beginning an audit, or switching context.
3. **Each agent gets its own branch:** `agent/<role>/<task>/<8char-id>`.
4. **Canonical context** (handoffs, rules, audits, briefings) lives in **`tgp-agent-context`** (private repo), not in product repos.
5. **Cross-agent handoffs** happen via PR — never by overwriting another agent's branch.

---

## 1. Why this protocol exists

Prior operator agents lost critical canonical docs (`CPO_MASTER_HANDOFF.md` Part 1, `R36_TO_R45_OPERATOR_RULES.md`, `SUPABASE_RLS_CRISIS.md`, the entire `agent-context/` directory) when their sandboxes were destroyed. The files were never pushed.

Lost work = wasted credits = food off Bradley's daughter's plate (see R52 in `tgp-agent-context`).

This protocol makes that failure mode physically impossible.

---

## 2. Branch naming

**Format:** `agent/<role>/<task>/<8char-id>`

| Component | Example | Rule |
|-----------|---------|------|
| `agent/` | (literal) | Always present. Distinguishes agent branches from human branches and from `main`. |
| `<role>` | `cpo`, `audit`, `fix`, `infra`, `mobile`, `site`, `data` | One short token. Lowercase. |
| `<task>` | `rls-crisis`, `pr-272-audit`, `coach-brief-v1`, `r-new-github-source-of-truth` | kebab-case. Descriptive. |
| `<8char-id>` | `e1477683`, `a3f9c2d1` | 8 hex chars. Generate with `python3 -c "import secrets; print(secrets.token_hex(4))"`. Prevents collisions when two agents pick the same task name. |

**Examples:**
- `agent/cpo/r-new-github-source-of-truth/e1477683`
- `agent/audit/pr-272-deep-dive/a3f9c2d1`
- `agent/fix/rls-helper-lockdown/9b4e0c7a`
- `agent/infra/ci-verify-doc-refs/2d8f1e90`

**Forbidden:**
- Pushing directly to `main`.
- Pushing to another agent's branch (`agent/<other-role>/...`).
- Reusing a branch ID across tasks. New task = new ID.

---

## 3. The 2-minute push cadence

**Hard rule:** Every agent pushes work-in-progress to its branch at least every **2 minutes** of active work.

**Always push before:**
- Spawning a subagent (subagent must be able to read your latest state from GitHub).
- Ending a turn (next operator inherits via GitHub, not via sandbox).
- Beginning an audit (auditor reads from GitHub, not from your local copy).
- Switching context (closing the tab, moving to another repo, starting a different task).

**Acceptable commit hygiene during the 2-min cadence:**
- `wip: <one-line context>` commits are fine.
- `git commit --amend` is fine on your own branch.
- Squash before opening the PR if the history is noisy.
- **Never** `git push --force` after another agent has pulled from your branch.

**Enforcement:**
- `pre-commit-stale-warn` hook (local) warns if uncommitted changes are >2 minutes old.
- `verify-push-cadence` CI check (per-PR) fails if the branch has commits >24h old without push activity to that branch.
- `verify-doc-refs` CI check fails any PR that references a doc path that does not exist in the repo.

---

## 4. Where things live

| Artifact | Home repo | Notes |
|----------|-----------|-------|
| Backend code, backend `AGENT_RULES.md`, backend `ENGINEERING_RULES.md`, `BACKLOG.md`, `CHANGELOG.md`, `README.md`, `docs/` | `growth-project-backend` | NestJS API. |
| Mobile code, mobile `AGENT_RULES.md`, mobile `ENGINEERING_RULES.md`, `SETUP.md`, `PLAY_STORE_READINESS.md` | `growth-project-mobile` | RN/Expo. |
| Marketing site code, `STATE.md`, `AUDIT.md`, `DEPLOY.md`, `QA_ISSUES.md` | `tgp-platform-site` | Next.js, `growthprojecthq.com`. |
| Finance app | `tgp-finance-app` | — |
| **Canonical agent context:** R-canon (R1–R6X), handoffs (`CPO_MASTER_HANDOFF.md` Part 1 & 2, `CPO_BRIEFING.md`, `BRADLEY_BRIEFING.md`, operator handoffs), strategy (`COMPETITIVE_INTEL.md`, `FEATURE_ROADMAP_CANONICAL.md`, `SUPABASE_RLS_CRISIS.md`, `CYCLE_B_RLS_PLAN.md`), design bibles (`simplicity-ideology.md`, `LANDING_PAGE_DESIGN_DOCTRINE.md`, `Mobile-App-Design-Intelligence.md`, `Website-Landing-Page-Design-Intelligence.md`, `50_FAILURES.md`), audits (`PR_272_AUDIT.md`, `WORKOUT_BUILDER_AUDIT.md`, etc.), and operator-meta (`NEXT_OPERATOR_MEGA_PROMPT.md`, `OPERATOR_HANDOFF_<date>.md`, `BACKLOG_DEDUP_<date>.md`, `SECURITY_SPRINT_*.md`) | **`tgp-agent-context`** (private) | Single source of truth for all cross-cutting canonical docs. Replaces the previously-stranded `agent-context/` directory. |

**Mirror rules:**
- `AGENT_RULES.md` in product repos contains the *summary* + per-repo nuance.
- The **full canonical R1–R6X list** lives in `tgp-agent-context/RULES.md` (or whatever the agreed filename becomes). Product repos may link to it but must not diverge silently.
- When R-canon changes, the PR touches *both* `tgp-agent-context` *and* the affected product repo's `AGENT_RULES.md` in the same wave.

---

## 5. Agent kickoff checklist

Before writing a single line of code or prose, every agent runs through this:

1. ☐ Pull latest `main` from the relevant product repo(s).
2. ☐ Pull latest `main` from `tgp-agent-context`.
3. ☐ Read the R-canon (`tgp-agent-context/RULES.md`) — at minimum R1, R15/R34, R52, and any R-rule named in the task brief.
4. ☐ Read the relevant operator handoff and CPO briefing.
5. ☐ Generate a branch ID: `python3 -c "import secrets; print(secrets.token_hex(4))"`.
6. ☐ Create branch: `agent/<role>/<task>/<id>`.
7. ☐ First commit: empty marker commit `chore(agent): start <task> [<id>]` so the branch exists on GitHub before any work begins.
8. ☐ Push the empty branch immediately.
9. ☐ Now begin work. Push every 2 minutes.

---

## 6. Cross-agent handoffs

**When you hand work to another agent, you do it via PR — never by overwriting their branch.**

**Pattern:**
1. Finish your slice on `agent/<your-role>/<task>/<your-id>`.
2. Push.
3. Open a PR to `main` (or, if the next agent will build on top, open it as draft and tag the next agent in the description).
4. The next agent branches *from your branch* with a new ID: `agent/<their-role>/<task>/<their-id>`, based on `agent/<your-role>/<task>/<your-id>`.
5. They never push to your branch. Their PR targets yours (or `main` if yours has merged).

This means the commit graph stays traceable per-agent, conflicts get surfaced via PR review, and no one silently overwrites another agent's work.

---

## 7. Forbidden moves

- ❌ Working in `/tmp`, `/home/user/workspace/`, or any local-only path without a corresponding GitHub branch.
- ❌ Citing a doc that does not exist in any GitHub repo.
- ❌ `git push --force` on a branch another agent has pulled.
- ❌ Deleting an agent branch before its PR is merged or explicitly abandoned in writing (commit message or PR comment).
- ❌ Storing rules, briefings, or audits in any chat tool, Notion, Google Doc, or local file system as the *primary* copy. Those are mirrors at best. GitHub is the primary.
- ❌ Working >2 minutes without pushing.

---

## 8. Enforcement summary

| Layer | Mechanism | What it catches |
|-------|-----------|-----------------|
| Local | `.githooks/pre-commit-stale-warn` | Uncommitted changes older than 2 minutes. |
| CI | `.github/workflows/verify-doc-refs.yml` | Any `.md` file referencing a path that doesn't exist in the repo (with an allowlist for known-missing legacy docs being rescued). |
| CI | `.github/workflows/verify-push-cadence.yml` | Branches with commits >24h old that haven't seen push activity (stale work). |
| Process | This doc + R15/R34 | Everything else. |

---

## 9. Glossary

- **R-canon** — the numbered rules (R1, R2, …, R6X) that govern all agent behavior. Lives in `tgp-agent-context`.
- **Sandbox** — any ephemeral execution environment (agent VM, container, REPL). Sandboxes die. GitHub doesn't.
- **Canonical** — the authoritative source. If two copies disagree, GitHub wins.
- **Stranded doc** — a doc referenced by a canonical handoff but not present in any GitHub repo. To be rescued into `tgp-agent-context`.

---

*Owner:* Bradley Gleave
*Last updated:* 2026-05-26
*Lives in:* every product repo (backend, mobile, site, finance) — and is identical across all of them. PRs that change this doc in one repo must change it in all of them in the same wave.
