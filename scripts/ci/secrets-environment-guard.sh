#!/usr/bin/env bash
# scripts/ci/secrets-environment-guard.sh
#
# Production-secrets environment guard (owner decision ALM-D11 op 1,
# 2026-11-27). The operator workflows that write production secrets, database
# URLs and launch flags, or open a shell on a production machine, run their one
# real job in the `production-secrets` environment, whose required reviewer
# (the owner) approves each run. This script runs first, in its own job, and
# exits 0 only when that environment, read from the GitHub API, is set up the
# way the decision needs:
#
#   1. it exists, with exactly the expected name;
#   2. it has at least one required reviewer (the reviewers of every
#      required_reviewers rule, summed, the way release-evidence-gate.sh
#      counts them);
#   3. admins cannot bypass its rules (can_admins_bypass is exactly false);
#   4. its deployment branches are "selected branches" (custom_branch_policies
#      true, protected_branches false);
#   5. its branch rules are exactly one rule: name "main", type "branch".
#
# Why its own job, bound to no environment: the bound job needs this one and
# runs only on its success. A check inside the bound job would run only after
# GitHub had started that job in the environment, and GitHub creates an
# environment that a job names, with no protection, when it is first used. A
# job outside any environment stops the run before any job enters
# production-secrets, so a dispatch made before the owner's setup enters no
# environment and loads no secret into a step.
#
# It only reads (gh api GET, no flags) and fails closed: a failed read, a
# non-JSON body or any unexpected value refuses. It prints counts and booleans
# only, never a reviewer, an API body or anything from a secret, and it never
# turns on xtrace (the repository and its run logs are public). Tested with a
# fake gh in test/ci/secrets-environment-guard.spec.ts.

set -Eeuo pipefail

GH_REPO="${GH_REPO:-}"
REQUIRED_ENVIRONMENT="${REQUIRED_ENVIRONMENT:-}"
ENV_SHOWN="(unset or malformed)"
[[ "$REQUIRED_ENVIRONMENT" =~ ^[A-Za-z0-9_.-]+$ ]] && ENV_SHOWN="$REQUIRED_ENVIRONMENT"

# fail <check> <detail>: the one refusal line, then exit 1.
fail() {
  echo "::error::secrets-environment-guard: environment '${ENV_SHOWN}' is not ready to run production jobs ($1: $2), so no job ran in it and no secret was read. Fix: set it up as docs/delivery-controls.md section 2.2 says, then dispatch again." >&2
  exit 1
}

[[ "$GH_REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail inputs "GH_REPO must be owner/repo"
[[ "$ENV_SHOWN" == "$REQUIRED_ENVIRONMENT" ]] || fail inputs "REQUIRED_ENVIRONMENT must be letters, digits, '_', '.' or '-'"
command -v gh >/dev/null 2>&1 || fail tools "gh CLI not available"
command -v jq >/dev/null 2>&1 || fail tools "jq not available"

ERR_FILE=$(mktemp)
trap 'rm -f "$ERR_FILE"' EXIT

# api <check> <path>: a non-zero gh exit, or a body that is not a JSON object,
# refuses. A failed read's refusal carries gh's own error text cut to 300
# characters (it names the HTTP status), never a body.
api() {
  local check=$1 path=$2 body
  if ! body=$(gh api "$path" 2>"$ERR_FILE"); then
    fail "$check" "GitHub API read failed: $(tr '\n' ' ' <"$ERR_FILE" | cut -c1-300)"
  fi
  printf '%s' "$body" | jq -e 'type == "object"' >/dev/null 2>&1 ||
    fail "$check" "GitHub API returned a body that is not a JSON object"
  printf '%s' "$body"
}

# jqf <check> <json> <filter> [jq args...]: a jq error refuses too.
jqf() {
  local check=$1 json=$2 filter=$3 out
  shift 3
  out=$(printf '%s' "$json" | jq -r "$@" "$filter" 2>/dev/null) || fail "$check" "unexpected response shape"
  printf '%s' "$out"
}

# Booleans and null print as themselves; any other value prints as "other".
B='def b: if type == "boolean" or type == "null" then tostring else "other" end;'

# 1. The environment exists, with exactly the expected name.
ENV_JSON=$(api "environment read" "repos/${GH_REPO}/environments/${REQUIRED_ENVIRONMENT}")
env_name=$(jqf "name" "$ENV_JSON" '.name | if type == "string" then . else "" end')
[[ "$env_name" == "$REQUIRED_ENVIRONMENT" ]] || fail "name" "the API answered for a different environment name"

# 2. At least one required reviewer.
reviewers=$(jqf "required reviewers" "$ENV_JSON" '
  [ .protection_rules[]? | objects | select(.type == "required_reviewers")
    | if (.reviewers | type) == "array" then (.reviewers | length) else 0 end ] | add // 0')
[[ "$reviewers" =~ ^[0-9]+$ ]] || fail "required reviewers" "count unreadable"
((reviewers >= 1)) || fail "required reviewers" "reviewers=${reviewers}"

# 3. Admin bypass off: exactly false (true, null, missing, "false" and 0 refuse).
bypass=$(jqf "admin bypass" "$ENV_JSON" "${B}"' if .can_admins_bypass == false then "ok" else (.can_admins_bypass | b) end')
[[ "$bypass" == "ok" ]] || fail "admin bypass" "can_admins_bypass=${bypass}"

# 4. Deployment branches: selected branches, not protected branches or any branch.
policy=$(jqf "deployment branches" "$ENV_JSON" "${B}"'
  .deployment_branch_policy
  | if type != "object" then "deployment_branch_policy=\(if type == "null" then "null" else "other" end)"
    elif .custom_branch_policies == true and .protected_branches == false then "ok"
    else "custom_branch_policies=\(.custom_branch_policies | b) protected_branches=\(.protected_branches | b)" end')
[[ "$policy" == "ok" ]] || fail "deployment branches" "$policy"

# 5. Exactly one branch rule: name "main", type "branch".
RULES_JSON=$(api "branch rules read" "repos/${GH_REPO}/environments/${REQUIRED_ENVIRONMENT}/deployment-branch-policies?per_page=100")
rules=$(jqf "branch rules" "$RULES_JSON" '
  if .total_count == 1 and (.branch_policies | type) == "array" and (.branch_policies | length) == 1
     and (.branch_policies[0] | type) == "object"
     and .branch_policies[0].name == "main" and .branch_policies[0].type == "branch" then "ok"
  else "rules=\(.branch_policies | if type == "array" then length else "other" end) total_count=\(.total_count | if type == "number" then tostring else "other" end)" end')
[[ "$rules" == "ok" ]] || fail "branch rules" "$rules"

echo "secrets-environment-guard: OK environment ${REQUIRED_ENVIRONMENT} has ${reviewers} required reviewer(s), admin bypass off and deployments from main only; the next job waits for a reviewer's approval"
