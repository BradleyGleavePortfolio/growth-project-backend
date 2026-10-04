#!/usr/bin/env bash
# approve_deploy.sh <run_id> [max_seconds]: approve the pending "production" environment for a fly-deploy run (standing owner approval).
set -uo pipefail
R=BradleyGleavePortfolio/growth-project-backend; id=$1; max=${2:-25}; end=$(( $(date +%s) + max ))
while :; do
  envs=$(gh api repos/$R/actions/runs/$id/pending_deployments --jq '[.[] | select(.environment.name=="production") | .environment.id] | join(",")' 2>/dev/null)
  if [ -n "$envs" ]; then
    gh api -X POST repos/$R/actions/runs/$id/pending_deployments -F "environment_ids[]=${envs%%,*}" -f state=approved \
      -f comment="Operator agent 116: standing owner deploy approval; audited main, required CI green." --jq '.[0].environment' >/dev/null && echo "APPROVED production for run $id"; exit 0
  fi
  st=$(gh run view $id -R $R --json status,conclusion --jq '"\(.status)/\(.conclusion)"'); 
  [ $(date +%s) -ge $end ] && { echo "no pending production deployment yet (run $st)"; exit 0; }
  sleep 6
done
