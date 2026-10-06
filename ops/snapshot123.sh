#!/usr/bin/env bash
# Push /home/user/workspace/ops to backend branch wip/op123/ops-snapshot (parent: previous snapshot). Usage: snapshot122.sh "<note>"
set -euo pipefail
B=/home/user/workspace/growth-project-backend; export GIT_INDEX_FILE=/tmp/snap123.idx; rm -f $GIT_INDEX_FILE
cd /home/user/workspace
git -C $B fetch -q origin wip/op123/ops-snapshot 2>/dev/null && P=$(git -C $B rev-parse FETCH_HEAD) || { git -C $B fetch -q origin wip/op122/ops-snapshot; P=$(git -C $B rev-parse FETCH_HEAD); }
git --git-dir=$B/.git --work-tree=/home/user/workspace add -A -f -- ops ':(exclude)ops/heavy.lock*'
T=$(git -C $B write-tree); unset GIT_INDEX_FILE
C=$(git -C $B -c user.name="Bradley Gleave" -c user.email="bradley@bradleytgpcoaching.com" commit-tree $T -p $P -m "ops snapshot (agent 123) $(TZ=America/Los_Angeles date '+%Y-%m-%d %H:%M PDT') ${1:-}")
git -C $B push -q origin $C:refs/heads/wip/op123/ops-snapshot && echo "snapshot $C"
