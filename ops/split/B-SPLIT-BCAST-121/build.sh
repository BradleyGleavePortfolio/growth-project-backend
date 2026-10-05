#!/usr/bin/env bash
# build.sh <worktree> <M' sha> <piece k> <branch> <from-ref> <commit-subject> — builds and commits piece k (no push)
set -euo pipefail
wt=$1; M=$2; k=$3; br=$4; from=$5; subj=$6
D=/home/user/workspace/ops/split/B-SPLIT-BCAST-121
cd "$wt"
git checkout -q -B "$br" "$from"
files=$(python3 -c "import json; r=json.load(open('$D/plan.json')); print('\n'.join(p for p,v in r.items() if v==$k))")
for f in $files; do git checkout "$M" -- "$f"; done
git add -A -- $files
git -c user.name="Bradley Gleave" -c user.email="bradley@bradleytgpcoaching.com" commit -q -m "$subj"
echo "piece $k @ $(git rev-parse HEAD): $(git diff --shortstat "$from" HEAD)"
