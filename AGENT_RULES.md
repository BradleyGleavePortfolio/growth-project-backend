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

## Build Discipline (R66–R70) — added 2026-06-08

Codified after the community v1-1 PR #365 unblock. The PR sat red for
5 days on a single `doctrine-cleanup` token collision; the round-1
auditor's sandbox died before completing, the dispatch state was
lost, and the original builder shipped without running the full test
suite locally. R66–R70 close those holes. See `docs/decisions/0001-community-v1-1-doctrine-collision-path-a.md` for the precipitating incident.

**R66 — Full-Suite-Before-PR.** Every builder/fixer MUST run
`npx jest --runInBand` to completion BEFORE force-pushing. Targeted
subsets are fine for iteration, but the push itself is gated by a
full green suite — recorded to a log file in `/home/user/workspace/`.
No exceptions; partial runs hide cross-suite regressions (the
class of failure that killed PR #365 in the first place). Pre-existing
grandfathered failures are listed in `docs/PRE_EXISTING_TEST_FAILURES.md`
and may be excluded ONLY by name in the log header.

**R67 — Dispatch-State-Persisted.** When the parent agent dispatches
any code-writing or auditing subagent, it MUST also push a row to
`handoffs/dispatch.json` in `tgp-agent-context` BEFORE waiting:
`{ts, subagent_id, role, worktree, base_sha, branch, brief_path}`.
This is the recovery breadcrumb if the parent sandbox dies mid-flight.
Dispatch-without-persist is forbidden; the next operator must be
able to resume from `dispatch.json` alone.

**R68 — Doctrine-Decision-Of-Record.** Every decision that affects
a doctrine guard, a banned-token list, an invariant test, or a
repo-wide naming convention MUST land in a merged Markdown file
under `docs/decisions/NNNN-<slug>.md` (ADR format). The decision
is not in force until that PR is merged. No verbal/Slack/journal-only
doctrine changes — those vanish when sandboxes die. See
`docs/decisions/0001-community-v1-1-doctrine-collision-path-a.md`
for the template.

**R69 — Skipped-Tests-Are-Red.** Any `it.skip`, `describe.skip`,
`xit`, or `xdescribe` in a committed test file MUST be annotated
with a `// SKIP-BECAUSE: <reason> — owner: <name> — expires: <YYYY-MM-DD>`
comment on the line immediately above. CI rejects PRs where an
unannotated skip appears. Environment-gated skips (`liveDbUrl()
? describe : describe.skip`) are exempt because the skip reason
IS the gate expression — but the surrounding comment block must
still say what the gate means.

**R70 — Fail-Fast Pre-Push Lane.** Before the full R66 suite,
builders MUST run the <30s doctrine fail-fast lane first:
```
npx jest test/doctrine-cleanup.spec.ts test/invariants/locked_defaults.spec.ts \
         test/diagnostic-prompt-doctrine.spec.ts --runInBand
```
If the fast lane is red, fix BEFORE running the full suite. This
is the lane that would have caught PR #365's `Reaction`-token
regression in 6 seconds instead of 26-minute CI cycles. See
`docs/REPO_DOCTRINE_GUARDS.md` for the canonical guard-test index
and recommended fail-fast lanes for other domains.

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

## Parallelization Discipline (R71–R72) — codified 2026-06-12

Both rules emerged from the WAVE 3 community-expansion cycle (June 10–12,
2026), where up to 5 concurrent subagents per cycle produced shipping
velocity but also surfaced two new failure modes: silent file-surface
collisions between parallel siblings, and auditors that stopped at the
first finding instead of sweeping the full diff.

**R71 — Parallel-PR file ownership (NON-NEGOTIABLE).** When two or
more code-writing subagents are dispatched concurrently, each builder/
fixer brief MUST enumerate:
1. The files/directories that PR **OWNS** (exclusive write access)
2. The files/directories that PR **MUST NOT touch** (owned by a
   sibling lane)
3. Shared-append-only files (e.g., `featureFlags.ts`, `.env.example`,
   navigators, barrel exports) where conflict resolution rule is
   **second-merger rebases and re-runs the R70 fail-fast lane** before
   re-pushing.

Sibling subagents coordinate ONLY through shared documents (briefs,
journal, `dispatch.json`) — they NEVER read each other's branches.
On merge collision the second-merging PR must rebase, re-run R70,
and re-attest R66 idempotency on the rebased SHA before re-pushing.

Parent agent performs a `§7C file_surface_overlap_check` pre-dispatch:
diff each pending brief's OWNS-list against every other in-flight
brief's OWNS-list. Any overlap is a malformed dispatch and must be
serialized or refactored before spawn. Concurrent-lane cap is 5 by
default; operator may raise/lower per cycle.

**R72 — Audits must be exhaustive.** Auditors NEVER stop at the
first finding. Every audit sweeps the ENTIRE changed-file diff,
applies the full 50-failures checklist (R65), and produces a single
report listing ALL findings ranked P0 → P1 → P2 → P3. A "P1 found,
verdict DIRTY, stopping here" report is malformed and must be
re-dispatched. Audit-stop-on-first is forbidden because the next
audit round wastes a full cycle re-discovering issues the first
sweep should have caught.

## Mobile Design Gate (R73) — added 2026-06-12

The TGP product surface is judged on FEEL, not function (`MOBILE_APP_DESIGN_INTELLIGENCE.md`,
Parts I–VII). Builders left to their own devices ship functional but
emotionally flat screens. R73 closes that gap by inserting a **Planner**
stage before every mobile screen build, with the design-intelligence
manual as the planner's source of truth.

**R73 — Mobile screen planner gate (NON-NEGOTIABLE).** Any subagent
that creates, redesigns, or substantively modifies a mobile screen
(`src/screens/**/*.tsx` — new file, OR an existing file with > 100
net LOC change, OR any change to the screen's emotional architecture,
information density, default-path, or motion budget) MUST be preceded
by a fresh **GPT-5.5 Planner** subagent.

The Planner is read-only. Its output is a written brief —
`PLANNER_BRIEF_<PR>_<SCREEN>.md` — covering, at minimum:
1. **Emotional architecture** (Norman's three levels §1.2 — visceral,
   behavioral, reflective)
2. **Cognitive-load budget** (intrinsic / extraneous / germane §4.2)
3. **Default path** (Hick's law §4.4 — what is the one tap the user
   makes 80% of the time?)
4. **Progressive disclosure plan** (§4.5)
5. **Domain-specific moves** (§5.4 Implementation Matrix, picked per
   screen domain)
6. **Master Checklist** (§6.2 — each item explicitly ticked PASS /
   N/A / DEFERRED with rationale)
7. **Anti-patterns to avoid** (§5.5)
8. **Component-level decisions** — typography, motion budget (max
   300ms per Roman spec), haptics, color tokens (semantic only),
   copy tone (Roman voice if Roman-facing surface)
9. **Screen Design Protocol §5.1 walk-through** — applied to THIS
   screen, not in the abstract

**Planner doctrine source-of-truth:** `tgp-agent-context/quality-references/MOBILE_APP_DESIGN_INTELLIGENCE.md`.
Planner MUST read it in full at the start of every run — not search,
not skim. The manual is ~17,000 words; full read is the price of
entry for designing a screen on TGP.

**Builder receives the planner brief as mandatory input.** Builder
implements to the planner spec OR documents a declared deviation
with rationale in the builder report. Auditor grades against the
planner brief in addition to the existing R65 / R72 sweep.

**Separation invariant:** Planner ≠ Builder ≠ Auditor ≠ Fixer.
R31 (builder ≠ auditor) extends to R73: the four roles are four
distinct fresh subagents per PR. Planner uses GPT-5.5 (Roman / R31
auditor stack — different runtime context window, different reasoning
trace). Builder uses Opus 4.8. Auditor uses GPT-5.5. Fixer uses
Opus 4.8.

**Exemptions** (Planner stage is OPTIONAL — operator-confirmable —
NOT required):
- Bug fixes / fixer rounds on an EXISTING audited screen (the original
  Planner brief still governs)
- Hygiene-only PRs (comments, lint, dead-code, file renames)
- Backend-only PRs (R73 is mobile-screen-scoped)
- Dependabot / dependency-bump PRs
- Test-only PRs that don't change runtime screen behavior

For ambiguous cases, the parent agent calls `confirm_action` with
the operator before spawning the Builder without a Planner.

**Effective:** 2026-06-12. Applies to every mobile screen build
from this rule's merge SHA forward. Retroactive Planners are not
required for screens already in flight at merge time.
