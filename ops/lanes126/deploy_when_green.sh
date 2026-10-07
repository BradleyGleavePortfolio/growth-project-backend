#!/usr/bin/env bash
# Deploy current backend main once its CI is complete+success. Run from an operator bash call WITH api_credentials=["github"].
# Usage: deploy_when_green.sh [max_wait_seconds]
set -uo pipefail
R=BradleyGleavePortfolio/growth-project-backend; max=${1:-240}; end=$(( $(date +%s) + max ))
while :; do
  H=$(gh api repos/$R/commits/main --jq .sha)
  ci=$(gh api "repos/$R/actions/runs?head_sha=$H&per_page=30" --jq '[.workflow_runs[]|select(.name=="CI")][0]|"\(.status)/\(.conclusion)"' 2>/dev/null)
  echo "$(TZ=America/Los_Angeles date +%H:%M) main=${H:0:8} CI=$ci"
  if [ "$ci" = "completed/success" ]; then
    PRISMA=$(cd /home/user/workspace/wt/RO-backend && git fetch -q origin main && git diff --name-only "$(gh api repos/$R/deployments --jq '.[0].sha' 2>/dev/null)" origin/main -- prisma 2>/dev/null | head -1)
    echo "prisma delta since last deployment: ${PRISMA:-none}"
    gh workflow run fly-deploy.yml --repo $R -f release_sha="$H" -f confirm=deploy && sleep 10
    RID=$(gh api "repos/$R/actions/workflows/fly-deploy.yml/runs?per_page=1" --jq '.workflow_runs[0].id')
    echo "deploy run=$RID"; /home/user/workspace/ops/approve_deploy.sh "$RID" 90; echo "$RID" > /home/user/workspace/ops/lanes126/last_deploy_run
    exit 0
  fi
  [ $(date +%s) -ge $end ] && { echo "still not green; re-run later"; exit 2; }
  sleep 45
done
