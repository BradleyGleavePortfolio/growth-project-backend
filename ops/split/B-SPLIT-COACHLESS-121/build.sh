#!/usr/bin/env bash
# build.sh <worktree> <M sha> <piece k> <branch> <from-ref> <commit-subject>  — builds and commits piece k (no push)
set -euo pipefail
wt=$1; M=$2; k=$3; br=$4; from=$5; subj=$6
D=/home/user/workspace/ops/split/B-SPLIT-COACHLESS-121
FIX=test/coachless/coachless-fixture.ts
cd "$wt"
git checkout -q -B "$br" "$from"
files=$(python3 -c "import json; r=json.load(open('$D/plan.json')); print('\n'.join(p for p,v in r.items() if v==$k))")
for f in $files; do [ "$f" = "$FIX" ] || git checkout "$M" -- "$f"; done
if [ "$k" = 2 ]; then git show "$M:$FIX" > /tmp/coachless121_fixture.ts; python3 "$D/fixture_subset.py" /tmp/coachless121_fixture.ts > "$FIX"; fi
if [ "$k" = 3 ]; then git checkout "$M" -- "$FIX"; fi
git add -A -- $files; [ "$k" -ge 2 ] && git add -A -- "$FIX"
git -c user.name="Bradley Gleave" -c user.email="bradley@bradleytgpcoaching.com" commit -q -m "$subj"
echo "piece $k @ $(git rev-parse HEAD): $(git diff --shortstat "$from" HEAD)"
