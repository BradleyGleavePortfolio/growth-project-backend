#!/usr/bin/env bash
# Same as ops/ci-lane/ci_lane.sh (backend) but with the Postgres-service variant workflow (B-T12-116).
set -euo pipefail
wt=$1; br=$2; shift 2
case "$br" in ci/*) ;; *) echo "branch must start with ci/"; exit 2;; esac
cd "$wt"
mkdir -p .github/workflows
cp /home/user/workspace/ops/b-t12-116/backend-ci-lane-pg.yml .github/workflows/ci-lane.yml
printf "%s\n" "$@" > .ci-lane-specs; [ "${LANE_TSC:-}" = 1 ] && touch .ci-lane-tsc
git add .github/workflows/ci-lane.yml .ci-lane-specs; [ -f .ci-lane-tsc ] && git add .ci-lane-tsc
git -c user.name="TGP Agent 116" -c user.email="agent@tgp.invalid" commit -qm "ci-lane: targeted run (never merge)" --no-verify
git push -q -f origin "HEAD:refs/heads/$br"
git reset -q --soft HEAD~1 && git restore --staged .github/workflows/ci-lane.yml .ci-lane-specs $( [ -f .ci-lane-tsc ] && echo .ci-lane-tsc ) && rm -f .github/workflows/ci-lane.yml .ci-lane-specs .ci-lane-tsc
sleep 8
gh run list -R BradleyGleavePortfolio/growth-project-backend --branch "$br" --workflow ci-lane -L 1 --json databaseId,url,status --jq '.[0] | "run \(.databaseId) \(.status) \(.url)"'
