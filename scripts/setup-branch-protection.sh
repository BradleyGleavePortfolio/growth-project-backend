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
# Single-maintainer note (F-B14, revised 2026-09-20 per G05/G10):
#   required_approving_review_count=1 with enforce_admins=true means the repo
#   owner cannot self-approve and admins cannot bypass. A second PAT owned by
#   the same person is NOT a reviewer and must not be used to satisfy this
#   rule (identity rules G05/G10: one real identity, no fictional second
#   identity). The only compliant resolutions are (a) a second human
#   maintainer with their own account, or (b) an explicitly recorded owner
#   decision to run with required_approving_review_count=0 while keeping every
#   status check required and the production environment gated. See
#   docs/delivery-controls.md for the current recommendation. Do not run this
#   script until that decision is recorded; the decision is passed explicitly
#   as REQUIRED_APPROVING_REVIEW_COUNT (no default) so the script never
#   encodes an identity assumption on its own.
#
# Required env:
#   GH_TOKEN     — a PAT with `repo` scope (Settings → Developer settings).
#   GH_REPO      — owner/repo, e.g. BradleyGleavePortfolio/growth-project-backend
#   REQUIRED_APPROVING_REVIEW_COUNT — 0 (recorded single-maintainer decision)
#                  or 1+ (a second real human maintainer exists).
#   CHECKS_APP_ID — GitHub App id that must post the required checks
#                  (GitHub Actions = 15368). Binding by app id is what makes a
#                  check name trustworthy; -1 would accept any app.
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
#                        Banned cast tokens (LOC budget / Test density retired
#                        2026-09-20; never list them again)
#   codeql.yml          (pull_request: branches:[main], no paths):
#                        "CodeQL JS/TS (javascript-typescript)" — fail-closed
#                        since 2026-09-20 (no continue-on-error / GHAS fallback)
#   sbom.yml            (pull_request: branches:[main], no paths): build-sbom
#   dependency-audit.yml (pull_request, no paths): npm audit (high+critical, whole graph)
#   h4-readiness.yml    (pull_request, no paths): test-deploy-readiness
#                        (the PR-mode deploy-readiness board; PR-eligible)
#
# NOT PR-ELIGIBLE — intentionally EXCLUDED from required checks:
#   h4-readiness.yml    deploy-readiness-gate — runs ONLY on workflow_dispatch
#                        and push to release/*, never on pull_request. A required
#                        check that never reports on a PR stays permanently
#                        pending and blocks every merge, so it must NOT be listed
#                        here. That strict gate enforces itself by hard-failing on
#                        its own trigger surfaces; it needs no branch-protection
#                        wiring.
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
  # codeql.yml — runs on every PR to main; matrix job name as reported
  "CodeQL JS/TS (javascript-typescript)"
  # h4-readiness.yml — runs on every PR (no paths filter). PR-eligible; the
  # non-PR strict gate (deploy-readiness-gate) is deliberately NOT listed here.
  "test-deploy-readiness"
  # sbom.yml — runs on every PR to main since 2026-09-20; proves the
  # production dependency closure before merge.
  "build-sbom"
  # dependency-audit.yml — runs on every PR (no paths filter); composed from
  # the S3 lane (job name as of its head 5c7b42b3). Required check names are
  # bound to CHECKS_APP_ID, so a renamed job blocks merges until updated here.
  "npm audit (high+critical, whole graph)"
)

: "${REQUIRED_APPROVING_REVIEW_COUNT:?set to 0 (recorded single-maintainer decision) or 1+ (second human maintainer); see header}"
: "${CHECKS_APP_ID:?set to the GitHub App id that posts the checks (GitHub Actions = 15368)}"
printf '%s' "$REQUIRED_APPROVING_REVIEW_COUNT" | grep -qE '^[0-9]+$' || { echo "ERROR: REQUIRED_APPROVING_REVIEW_COUNT must be an integer" >&2; exit 1; }
printf '%s' "$CHECKS_APP_ID" | grep -qE '^[0-9]+$' || { echo "ERROR: CHECKS_APP_ID must be a positive integer app id" >&2; exit 1; }
CHECKS_JSON=$(printf '%s\n' "${REQUIRED_CHECKS[@]}" | jq -R . | jq -s --argjson app "$CHECKS_APP_ID" 'map({context: ., app_id: $app})')

# Code-owner review only makes sense with a second human; with count 0 it
# would demand an approval nobody can give.
if [[ "$REQUIRED_APPROVING_REVIEW_COUNT" -ge 1 ]]; then CODEOWNER_REVIEW=true; else CODEOWNER_REVIEW=false; fi

PAYLOAD=$(jq -n \
  --argjson checks "$CHECKS_JSON" \
  --argjson count "$REQUIRED_APPROVING_REVIEW_COUNT" \
  --argjson codeowner "$CODEOWNER_REVIEW" \
  '{
    required_status_checks: {
      strict: true,
      checks: $checks
    },
    enforce_admins: true,
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      require_code_owner_reviews: $codeowner,
      required_approving_review_count: $count,
      require_last_push_approval: ($count >= 1)
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
