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
# Q4 decision: enforce_admins=true. Owner is included. No bypass.
#
# Required env:
#   GH_TOKEN     — a PAT with `repo` scope (Settings → Developer settings).
#   GH_REPO      — owner/repo, e.g. BradleyGleavePortfolio/growth-project-backend
#
# Usage:
#   GH_TOKEN=ghp_xxx GH_REPO=BradleyGleavePortfolio/growth-project-backend \
#     bash scripts/setup-branch-protection.sh
#
# Idempotent — running twice is fine.

set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN env var is required (PAT with repo scope)}"
: "${GH_REPO:?GH_REPO env var is required, e.g. owner/repo}"

# Required status checks — names must match the actual check_run names emitted
# by the workflows. Update this list whenever a new required check ships.
REQUIRED_CHECKS=(
  # From .github/workflows/ci.yml
  "build-and-test"
  "rls-floor-guard"
  "rls-live-tests"
  # From H1 PR #455
  "CodeQL"
  # From H2 (this PR)
  "Forward migration applies cleanly"
  "New migrations are reversible (or explicitly marked IRREVERSIBLE)"
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
      require_code_owner_reviews: false,
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

curl --fail-with-body -sS -X PUT \
  -H "Authorization: Bearer ${GH_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/${GH_REPO}/branches/main/protection" \
  -d "$PAYLOAD" \
  | jq -r '.url, "Protection applied."'
