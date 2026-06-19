#!/usr/bin/env bash
#
# scripts/setup-branch-protection.sh
#
# Configures GitHub branch protection on `main` per AGENT_RULES R102.
#
# Why this is a script, not a workflow:
#   1. Branch protection requires GitHub Pro on private repos. The
#      git-agent-proxy mirror does not have Pro, so the API rejects
#      `/repos/.../branches/main/protection` with 403. Run this script
#      against the *upstream* repo (github.com/BradleyGleavePortfolio/...)
#      from the operator's local machine where a Pro plan is in effect.
#   2. Branch protection is a one-shot setup, not a per-PR ritual.
#
# Q3 decision: `main` is the only persistent branch in this repo. All other
# branches are short-lived feature/audit/agent branches that are merged or
# deleted within hours. Protection on `main` alone covers the security model.
#
# Q4 decision: enforce_admins=true. Owner is included; admins cannot bypass the
# protection itself. The required review still needs a second approver — see the
# single-maintainer bypass note below for how a solo owner satisfies that.
#
# ┌───────────────────────────────────────────────────────────────────────┐
# │ WARNING — DESTRUCTIVE: this script issues a full PUT to                 │
# │ /repos/{owner}/{repo}/branches/main/protection, which REPLACES the      │
# │ entire branch-protection configuration. Any settings configured        │
# │ outside this script (e.g. required_signatures enabled in the UI, custom │
# │ push restrictions/allow-lists, a different required_linear_history)     │
# │ will be CLOBBERED. "Idempotent" below means running this script twice   │
# │ yields the same result — it does NOT mean the PUT is a non-destructive  │
# │ merge. Review the current config (this script backs it up first) and    │
# │ fold any settings you want to keep into PAYLOAD before running.         │
# └───────────────────────────────────────────────────────────────────────┘
#
# Single-maintainer bypass note (F-B14):
#   required_approving_review_count=1 with enforce_admins=true means the repo
#   owner cannot self-approve and admins cannot bypass — so a solo maintainer
#   can be locked out of merging their own PRs. Resolve with one of:
#     (a) a dedicated bot/GitHub App that approves green PRs, OR
#     (b) a second PAT acting as reviewer (`gh pr review --approve`), OR
#     (c) temporarily setting required_approving_review_count=0 until a
#         second human joins.
#   Current decision: option (b) — owner reviews from a second PAT. Revisit
#   when a second maintainer joins.
#
# Required env:
#   GH_TOKEN     — a PAT with `repo` scope (Settings → Developer settings).
#   GH_REPO      — owner/repo, e.g. BradleyGleavePortfolio/growth-project-backend
#
# Usage:
#   GH_TOKEN=ghp_xxx GH_REPO=BradleyGleavePortfolio/growth-project-backend \
#     bash scripts/setup-branch-protection.sh
#
# Idempotent — running twice yields the same result (see destructive note above).

set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN env var is required (PAT with repo scope)}"
: "${GH_REPO:?GH_REPO env var is required, e.g. owner/repo}"

# Validate GH_REPO is a well-formed owner/repo before interpolating it into
# the API URL — the :? check above only proves it is non-empty.
if ! printf '%s' "$GH_REPO" | grep -qE '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'; then
  echo "ERROR: GH_REPO must be in owner/repo format (got: '$GH_REPO')." >&2
  exit 1
fi

# Required status checks — names must match the actual check_run names emitted
# by the workflows. Update this list whenever a new required check ships.
#
# CANONICAL RULE: a check may be REQUIRED only if its workflow runs on EVERY
# pull request to main (no `paths:` filter). A required check from a
# path-filtered workflow stays PENDING on PRs that do not touch its paths and
# permanently blocks the merge (GitHub treats a never-reported required check
# as not-yet-satisfied under strict mode). The lists below were derived by
# auditing each workflow's `on:` trigger in-repo.
#
# ALWAYS-RUN (no paths filter) — eligible to be REQUIRED:
#   ci.yml              (pull_request, no paths): build-and-test,
#                        rls-floor-guard, rls-live-tests, mwb-3-live-tests
#   danger.yml          (pull_request: branches:[main], no paths): danger
#   r100-quality-gate.yml (pull_request: branches:[main], no paths):
#                        Banned cast tokens, LOC budget, Test density
#
# PATH-FILTERED — intentionally EXCLUDED from required checks:
#   infra-lint.yml      (paths: .github/workflows/**, scripts/**, dangerfile.js):
#                        checks: "shellcheck (scripts/*.sh)",
#                        "actionlint (.github/workflows/*.yml)",
#                        "danger dry-run (dangerfile.js)"
#   migration-dry-run.yml (paths: prisma/migrations/**, the workflow file):
#                        Forward migration applies cleanly,
#                        New migrations are reversible (...)
#   These gates still HARD-FAIL when their paths are touched; they just are not
#   marked required, so a PR that does not touch those paths is not blocked by a
#   check that will never report.
#
# NOT PRESENT IN THIS REPO — EXCLUDED:
#   CodeQL — no CodeQL workflow exists on this branch's base. Marking a
#   nonexistent check required would permanently block every PR. Add it back
#   (as the exact reported name) once a CodeQL workflow actually ships and runs
#   on every PR.
REQUIRED_CHECKS=(
  # ci.yml — runs on every PR (no paths filter)
  "build-and-test"
  "rls-floor-guard"
  "rls-live-tests"
  "mwb-3-live-tests"
  # danger.yml — runs on every PR to main (no paths filter)
  "danger"
  # r100-quality-gate.yml — runs on every PR to main (no paths filter)
  "Banned cast tokens (R75 / R100.A2)"
  "LOC budget (R100.A3)"
  "Test density (R100.A1)"
)

CHECKS_JSON=$(printf '%s\n' "${REQUIRED_CHECKS[@]}" | jq -R . | jq -s 'map({context: ., app_id: -1})')

PAYLOAD=$(jq -n \
  --argjson checks "$CHECKS_JSON" \
  '{
    required_status_checks: {
      strict: true,
      checks: $checks
    },
    enforce_admins: true,
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      require_code_owner_reviews: true,
      required_approving_review_count: 1,
      require_last_push_approval: true
    },
    restrictions: null,
    required_linear_history: true,
    allow_force_pushes: false,
    allow_deletions: false,
    block_creations: false,
    required_conversation_resolution: true,
    lock_branch: false,
    allow_fork_syncing: false
  }')

echo "Applying branch protection to $GH_REPO @ main"
echo "Required checks (${#REQUIRED_CHECKS[@]}):"
printf '  - %s\n' "${REQUIRED_CHECKS[@]}"
echo ""

PROTECTION_URL="https://api.github.com/repos/${GH_REPO}/branches/main/protection"

# Back up the CURRENT protection config before the destructive PUT so the
# prior state can be restored if this replacement is wrong. A 404 (no
# protection yet) is fine — we record an empty baseline.
BACKUP_FILE="/tmp/branch-protection-backup-$(date +%s).json"
echo "Backing up current protection to $BACKUP_FILE ..."
if curl --fail-with-body -sS \
  -H "Authorization: Bearer ${GH_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "$PROTECTION_URL" > "$BACKUP_FILE" 2>/dev/null; then
  echo "  Backed up existing protection."
else
  echo "  No existing protection (or not readable); recording empty baseline."
  echo '{}' > "$BACKUP_FILE"
fi

curl --fail-with-body -sS -X PUT \
  -H "Authorization: Bearer ${GH_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "$PROTECTION_URL" \
  -d "$PAYLOAD" \
  | jq -r '.url, "Protection applied."'
