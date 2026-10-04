#!/usr/bin/env bash
# MERGE_DEPENDENCY_GUIDE rule 12 tree check. Usage: tree_check.sh <repo dir> <approved sha> <new sha>. Exit 0 = exception applies.
set -euo pipefail; cd "$1"; A=$2; N=$3; git fetch -q origin
P=($(git rev-list --parents -n1 "$N")); [ ${#P[@]} -eq 3 ] || { echo "FAIL 1: new head is not a two-parent merge"; exit 1; }
M=""; for p in "${P[@]:1}"; do [ "$p" = "$A" ] && continue; M=$p; done
{ [ "${P[1]}" = "$A" ] || [ "${P[2]}" = "$A" ]; } && git merge-base --is-ancestor "$M" origin/main || { echo "FAIL 1: parents are not <approved> + a main commit"; exit 1; }
B=$(git merge-base "$A" "$M"); bad=0
for f in $(git diff --name-only "$(git merge-base "$B" "$A")" "$A"); do
  a=$(git rev-parse -q --verify "$A:$f" || echo none); n=$(git rev-parse -q --verify "$N:$f" || echo none)
  [ "$a" = "$n" ] || { echo "FAIL 2: $f changed ($a -> $n)"; bad=1; }; done
[ $bad -eq 0 ] || exit 1
for c in $(git rev-list --no-merges "$A..$N"); do git merge-base --is-ancestor "$c" origin/main || { echo "FAIL 3: non-main commit $c"; exit 1; }; done
echo "PASS 1-3: parents $A + $M (main); all PR files byte-identical; only main commits. Item 4: confirm every required check green at $N."
