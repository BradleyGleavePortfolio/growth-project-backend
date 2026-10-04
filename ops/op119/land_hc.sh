#!/usr/bin/env bash
# Land mobile Health Connect H1-H6 (#359-#364) as one (rule 11 + rule 12 main refresh), agent 119.
# Usage: land_hc.sh A <top sha>   -> verify heads, ff piece branches to top, build merge(top, origin/main) candidate, tree check,
#                                   push candidate to #359's branch (PR CI then runs incl. Analyze).
#        land_hc.sh B <cand sha>  -> mark #359 ready, merge with --match-head-commit.
set -euo pipefail
R=BradleyGleavePortfolio/growth-project-mobile
step=$1; SHA=$2
cd /home/user/workspace/repos/growth-project-mobile
git fetch -q origin
if [ "$step" = A ]; then
  h=$(gh pr view 364 -R $R --json headRefOid --jq .headRefOid); test "$h" = "$SHA" || { echo "#364 head $h != $SHA"; exit 1; }
  W=/home/user/workspace/wt/LAND-hc-119; rm -rf $W; git worktree prune
  git worktree add -q --detach $W $SHA
  git -C $W -c user.name="Bradley Gleave" -c user.email="bradley@bradleytgpcoaching.com" merge --no-ff -q \
     -m "Merge main ($(git rev-parse --short origin/main)) into Health Connect H1-H6 for landing (merge-only, operator agent 119)" origin/main
  C=$(git -C $W rev-parse HEAD); echo "candidate $C"
  bash /home/user/workspace/ops/tree_check.sh . $SHA $C
  for b in agent115/wear-split-5-sheet-race-tests agent115/wear-split-4-connect-ui agent115/wear-split-3-ondevice-sync-copy \
           agent115/wear-split-2-platform-sync; do
    git merge-base --is-ancestor origin/$b $SHA || { echo "not ff: $b"; exit 1; }
    git push -q origin $SHA:refs/heads/$b && echo "ff $b -> ${SHA:0:8}"
  done
  git merge-base --is-ancestor origin/agent115/wear-split-1-ingest-foundation $C || { echo "cand not ff"; exit 1; }
  git push -q origin $C:refs/heads/agent115/wear-split-1-ingest-foundation && echo "#359 head -> ${C:0:8}"
  git worktree remove --force $W
fi
if [ "$step" = B ]; then
  h=$(gh pr view 359 -R $R --json headRefOid --jq .headRefOid); test "$h" = "$SHA" || { echo "#359 head $h"; exit 1; }
  gh pr ready 359 -R $R 2>/dev/null || true
  gh pr merge 359 -R $R --merge --match-head-commit $SHA
  git fetch -q origin; echo "mobile main now $(git rev-parse origin/main)"
fi
