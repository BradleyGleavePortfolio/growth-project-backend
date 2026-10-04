#!/usr/bin/env bash
# snapshot.sh "<label>" -> commits /home/user/workspace/ops (minus cache/) to backend branch wip/op118/ops-snapshot and pushes.
set -euo pipefail
G=/home/user/workspace/repos/growth-project-backend/.git
export GIT_INDEX_FILE=$(mktemp -u /tmp/snapidx.XXXX)
cd /home/user/workspace
git --git-dir=$G --work-tree=/home/user/workspace add -f -- ops ':!ops/cache' ':!ops/**/node_modules' 2>/dev/null
T=$(git --git-dir=$G write-tree)
P=$(git --git-dir=$G rev-parse -q --verify refs/remotes/origin/wip/op118/ops-snapshot || true)
M="ops snapshot (agent 118) $(TZ=America/Los_Angeles date '+%Y-%m-%d %H:%M %Z') ${1:-}"
C=$(git --git-dir=$G -c user.name="Bradley Gleave" -c user.email="bradley@bradleytgpcoaching.com" commit-tree $T ${P:+-p $P} -m "$M")
git --git-dir=$G push -q origin $C:refs/heads/wip/op118/ops-snapshot
git --git-dir=$G update-ref refs/remotes/origin/wip/op118/ops-snapshot $C
rm -f $GIT_INDEX_FILE; echo "snapshot $C: $M"
