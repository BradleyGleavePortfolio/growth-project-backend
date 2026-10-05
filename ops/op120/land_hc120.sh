#!/usr/bin/env bash
# Land mobile Health Connect H1-H8 (#359-#364, #369, #370) as one (rule 11 + rule 12 merge-only main refresh), agent 120.
# Usage: land_hc120.sh A   -> verify all 8 heads = audited heads, chain ancestry, ff piece branches #360..#369 to #370's head,
#                             build merge(#370 head, origin/main) candidate, tree check, push candidate to #359's branch.
#        land_hc120.sh B <cand sha> -> mark #359 ready, merge with --match-head-commit.
set -euo pipefail
R=BradleyGleavePortfolio/growth-project-mobile
cd /home/user/workspace/repos/growth-project-mobile
git fetch -q origin
declare -A H=( [359]=e0f3d2a7 [360]=fde1875e [361]=574b32a8 [362]=261e7d4c [363]=5266d658 [364]=1266038c [369]=a2bfe2fa906ff5e3b991613a6838a82456db920c [370]=c7014623520baf23a697f4d646e3d80a423789c5 )
ORDER="359 360 361 362 363 364 369 370"
if [ "$1" = A ]; then
  for n in $ORDER; do
    h=$(gh api repos/$R/pulls/$n --jq .head.sha); case "$h" in ${H[$n]}*) ;; *) echo "#$n head $h != ${H[$n]}"; exit 1;; esac
  done
  TOP=${H[370]}
  prev=""
  for n in $ORDER; do s=$(gh api repos/$R/pulls/$n --jq .head.sha); [ -z "$prev" ] || git merge-base --is-ancestor $prev $s || { echo "chain broken at #$n"; exit 1; }; prev=$s; done
  W=/home/user/workspace/wt/LAND-hc-120; rm -rf $W; git worktree prune
  git worktree add -q --detach $W $TOP
  git -C $W -c user.name="Bradley Gleave" -c user.email="bradley@bradleytgpcoaching.com" merge --no-ff -q \
     -m "Merge main ($(git rev-parse --short origin/main)) into Health Connect H1-H8 for landing (merge-only, operator agent 120)" origin/main
  C=$(git -C $W rev-parse HEAD); echo "candidate $C"
  bash /home/user/workspace/ops/tree_check.sh . $TOP $C
  for n in 370 369 364 363 362 361 360; do
    b=$(gh api repos/$R/pulls/$n --jq .head.ref)
    git merge-base --is-ancestor origin/$b $TOP || { echo "not ff: $b"; exit 1; }
    [ "$(git rev-parse origin/$b)" = "$TOP" ] || { git push -q origin $TOP:refs/heads/$b && echo "ff $b -> ${TOP:0:8}"; }
  done
  b1=$(gh api repos/$R/pulls/359 --jq .head.ref)
  git merge-base --is-ancestor origin/$b1 $C || { echo "cand not ff"; exit 1; }
  git push -q origin $C:refs/heads/$b1 && echo "#359 head -> $C"
  git worktree remove --force $W
fi
if [ "$1" = B ]; then
  SHA=$2
  h=$(gh api repos/$R/pulls/359 --jq .head.sha); test "$h" = "$SHA" || { echo "#359 head $h"; exit 1; }
  gh pr ready 359 -R $R 2>/dev/null || true
  gh pr merge 359 -R $R --merge --match-head-commit $SHA
  git fetch -q origin; echo "mobile main now $(git rev-parse origin/main)"
fi
