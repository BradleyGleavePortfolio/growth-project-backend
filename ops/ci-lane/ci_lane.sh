#!/usr/bin/env bash
# ci_lane.sh <backend|mobile> <worktree> <branch: ci/<LANE>-... or audit/<LANE>/...> <spec> [spec...]
# Run from a worktree whose HEAD is what you want to test (e.g. PR head + your new test, without the fix).
# Adds the one-job ci-lane workflow + .ci-lane-specs in a throwaway commit on <branch>, force-pushes that branch, prints the run.
set -euo pipefail
kind=$1; wt=$2; br=$3; shift 3
case "$br" in ci/*|audit/*) ;; *) echo "branch must start with ci/ or audit/"; exit 2;; esac
cd "$wt"
mkdir -p .github/workflows
cp /home/user/workspace/ops/ci-lane/$kind-ci-lane.yml .github/workflows/ci-lane.yml
printf '%s\n' "$@" > .ci-lane-specs
git add .github/workflows/ci-lane.yml .ci-lane-specs
git -c user.name="Bradley Gleave" -c user.email="bradley@bradleytgpcoaching.com" commit -qm "ci-lane: targeted run (never merge)" --no-verify
git push -q -f origin "HEAD:refs/heads/$br"
git reset -q --soft HEAD~1 && git restore --staged .github/workflows/ci-lane.yml .ci-lane-specs && rm -f .github/workflows/ci-lane.yml .ci-lane-specs
sleep 8
gh run list -R BradleyGleavePortfolio/growth-project-$kind --branch "$br" --workflow ci-lane -L 1 --json databaseId,url,status --jq '.[0] | "run \(.databaseId) \(.status) \(.url)"'
echo "watch: gh run watch <id> -R BradleyGleavePortfolio/growth-project-$kind --exit-status ; logs: gh run view <id> --log-failed"
