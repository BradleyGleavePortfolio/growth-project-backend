#!/usr/bin/env bash
# O2 (REL-09): tell the owner when production is down or failing.
# Run by .github/workflows/production-uptime.yml every 10 minutes. Probes the
# public /health and /readyz of the URL the fly-deploy.yml smoke test uses and
# the public app /privacy page.
# Two failed rounds in a row (RETRY_DELAY seconds apart) open one issue
# labelled production-down, assigned to the repo owner so GitHub emails them,
# or refresh the open one (an edit sends no email). A passing round closes it
# with a comment. Prints status codes only, never a response body. Needs only
# GH_TOKEN (the default GITHUB_TOKEN) and runs no fly command.
set -euo pipefail

BASE_URL="${BASE_URL:-https://backend-spring-lake-3890.fly.dev}"
PUBLIC_PAGE_URL="https://app.trygrowthproject.com/privacy"
RETRY_DELAY="${RETRY_DELAY:-60}"
LABEL=production-down
RUN_URL="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"

# Sets RESULTS to each probe's status code; fails unless all three are 200.
probe_round() {
  local path code failed=0
  RESULTS=""
  for path in /health /readyz; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "${BASE_URL}${path}") || true
    RESULTS="${RESULTS:+${RESULTS}; }${path} ${code:-000}"
    [ "$code" = "200" ] || failed=1
  done
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$PUBLIC_PAGE_URL") || true
  RESULTS="${RESULTS}; public /privacy ${code:-000}"
  [ "$code" = "200" ] || failed=1
  echo "$(date -u +%FT%TZ) ${RESULTS}"
  return "$failed"
}

open_issue=$(gh issue list --label "$LABEL" --state open --limit 1 --json number --jq '.[0].number // empty')

if probe_round || { sleep "$RETRY_DELAY"; probe_round; }; then
  if [ -n "$open_issue" ]; then
    gh issue close "$open_issue" --comment "Recovered: ${RESULTS} at $(date -u +%FT%TZ). Closed automatically by the production uptime check. Run: ${RUN_URL}"
  fi
  exit 0
fi

body="Production probes failed in two consecutive rounds, ${RETRY_DELAY} seconds apart.

- Last failed check: $(date -u +%FT%TZ)
- Results: ${RESULTS}
- Checked: ${BASE_URL}/health, ${BASE_URL}/readyz and ${PUBLIC_PAGE_URL}
- Run: ${RUN_URL}

Codes: 000 means no answer within 20 seconds. 503 on /readyz means the server is up but cannot reach the database. Any other code means the server answered with an error.

Next steps: docs/soc2/policies/business-continuity-plan.md section 6.1, and docs/deploy-runbook.md section 7 for a rollback. This issue is updated every 10 minutes while the checks fail and closes by itself when both pass again."

echo "::warning::Production is down: ${RESULTS}"
if [ -n "$open_issue" ]; then
  gh issue edit "$open_issue" --body "$body"
else
  gh label create "$LABEL" --color B60205 --description "Production health checks are failing" --force
  gh issue create --title "Production is down: health checks are failing" --label "$LABEL" --assignee "$OWNER" --body "$body"
fi
