# TGP Standing Rules (read at the start of every session)

1. EVERYTHING MUST BE BUILT TO DECACORN QUALITY.
2. ALL NEW FEATURES MUST BE BUILT, AUDITED BY CHATGPT 5.5, FIXED PER THE AUDIT, AUDITED AGAIN, AND FIXED AGAIN UNTIL CLEAN.
3. ASSUME THE OWNER HAS THE TECH KNOWLEDGE OF A 7TH GRADER. EXPLAIN CHOICES IN SIMPLE LANGUAGE.
4. ASK QUESTIONS FOR CLARITY AT EVERY NEW FEATURE PROJECT.
5. AVOID THE 50 DOCUMENTED PATTERN FAILURES OF AI CODING AT ENTERPRISE SCALE.
6. NEVER KICK THE CAN. FIX ISSUES AT THE ROOT THE MOMENT THEY APPEAR.
7. DECACORN QUALITY / DEPTH / ENTERPRISE GRADE / 99.99% UPTIME IS THE GOAL.
8. CHECKOUT MUST FEEL IN-APP AND BRANDED — NEVER VISIBLY LEAVE THE APP.
9. NO RAW ERROR CODES TO USERS. EVERY ERROR MUST BE STRUCTURED AND CLEAR.
10. ALWAYS DEFAULT TO THE HIGHEST QUALITY, MOST THOROUGH PATH (DECACORN DEFAULT).
11. NEVER DELETE FEATURES OR SHRINK FEATURE ABILITIES. ALWAYS BUILD OUTWARD.
12. THE OWNER CANNOT CHECK FLY OR GCP VALUES DIRECTLY — DO NOT ASK.
13. OAUTH CONSENT SCREEN MUST BE IN PRODUCTION MODE (LAUNCHING IN FRONT OF 800 PEOPLE).
14. ALWAYS BUILD WITH THE LATEST VERSION OF ALL "PLUMBING" — DEPENDENCIES, LIBRARIES, SDKS, RUNTIMES, GITHUB ACTIONS, TOOLING. WHEN STARTING ANY NEW FEATURE OR PR, USE THE NEWEST STABLE VERSION OF EVERY DEPENDENCY IT TOUCHES. WHEN DEPENDABOT OPENS AN UPGRADE PR, "MERGE IT" IS THE DEFAULT OUTCOME. MAJOR-VERSION BREAKS GET THEIR OWN PR + AUDIT, NEVER DEFERRED INDEFINITELY. STALE PLUMBING IS TECH DEBT.

## Worktree Discipline (R56–R60) — added 2026-05-26

Codified after the CHECKOUT-HARDENING trampling incident: multiple
parallel subagents in the same `git worktree` (`tgp/backend-main`)
ran independent `git checkout` operations and destroyed each other's
uncommitted work. Plus a full Claude Code runtime exit dropped 8
concurrent subagents at once, exposing the fact that uncommitted work
on the sandbox is unrecoverable.

**R56 — One subagent per worktree, always.** Before spawning any
code-writing subagent (codebase / general-purpose with file edits in
a repo), the parent MUST create a dedicated `git worktree add` path.
Subagent objective MUST contain the exact absolute path and the
instruction "work ONLY in this directory; do not cd elsewhere."

**R57 — `backend-main` and `mobile` are READ-ONLY for subagents.**
They exist for inspecting current main and as a stable source of
symlinkable `node_modules` / `prisma.config.ts`. No subagent ever
writes there. If a subagent's objective directs work into backend-main
or mobile, the objective is malformed and must be rejected before spawn.

**R58 — Worktree naming convention.** Format:
`/home/user/workspace/tgp/{repo}-{short-task-slug}`. Examples:
`backend-272-fix`, `backend-checkout-hardening`, `backend-dunning`,
`mobile-wb-fix`. Slug is short, lowercase, hyphenated, unique per
concurrent task. Parent maintains a slug→subagent_id ledger.

**R59 — Pre-flight worktree check.** Before spawning a code-writing
subagent, run `ls /home/user/workspace/tgp/` and confirm target
path doesn't already exist. If orphaned: reuse only if same branch
and clean; otherwise `git worktree remove --force` then add fresh,
or pick a new slug. Never silently overwrite.

**R60 — Audits get worktrees too.** R31 audit subagents that
checkout PR branches need isolated worktrees per R56. Use slug
pattern `{repo}-{task}-audit` (e.g. `backend-wb-audit`).

## Sandbox Preservation (R61) — added 2026-05-26

**R61 — Push to GitHub every 2 minutes, always.** Every active
worktree with uncommitted or unpushed work must be force-pushed to
GitHub at minimum every 2 minutes. If the sandbox dies right now,
all ongoing work must be preserved on the remote. The parent agent
runs `git add -A && git -c user.email=... commit -m "wip-autopush:
$(date -Iseconds)" && git push -u origin $BRANCH` for every active
branch on every natural breakpoint (after spawning subagents,
before waiting, after each completion). Uncommitted work on a
sandbox is unrecoverable. Push first, push often.

## Retired rules

- **R10 — RETIRED 2026-05-26.** Original intent: grandfathered failing
  tests on `main` could remain red while a domain ticket existed. The
  3 remaining grandfathered failures turned out to be stale test-helper
  bugs (A1-C5-P1-1, A1-C5-P1-3, A1-C5-P1-4), all fixed in
  `chore/r10-cleanup-fix-stale-tests`. New CLEAN bar replaces R10:
  **CI green + 0 P0 + 0 P1 + 0 P2** on `main` at all times. Rule
  reference preserved here so old PRs/audits citing R10 remain
  traceable. See `docs/PRE_EXISTING_TEST_FAILURES.md` for the full
  retirement note.
