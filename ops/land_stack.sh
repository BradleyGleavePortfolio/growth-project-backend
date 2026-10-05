#!/usr/bin/env bash
# land_stack.sh <owner/repo> "<pr:approved_sha> ..." (top first, bottom last). Merges each PR into its base top-down with
# --match-head-commit; checks the final bottom head tree equals the audited top tree. Does NOT merge the bottom PR into main.
set -euo pipefail
R=$1; shift; LIST=($1)
TOP_SHA=${LIST[0]#*:}
CUR_EXPECT=""
for i in "${!LIST[@]}"; do
  n=${LIST[$i]%%:*}; want=${LIST[$i]#*:}
  head=$(gh api repos/$R/pulls/$n --jq .head.sha)
  base=$(gh api repos/$R/pulls/$n --jq .base.ref)
  if [ $i -gt 0 ]; then want=$head; fi   # lower PR heads moved because of the merge above
  [ $i -eq 0 ] && [ "$head" != "$want" ] && { echo "STOP #$n head $head != approved $want"; exit 1; }
  if [ "$base" = "main" ]; then echo "bottom #$n head $head base main"; BOTTOM=$n; BOTTOM_HEAD=$head; break; fi
  gh pr ready $n -R $R >/dev/null 2>&1 || true
  gh pr merge $n -R $R --merge --match-head-commit $head >/dev/null && echo "merged #$n @ ${head:0:8} into $base"
  sleep 4
done
t_top=$(gh api repos/$R/commits/$TOP_SHA --jq .commit.tree.sha); t_bot=$(gh api repos/$R/commits/$BOTTOM_HEAD --jq .commit.tree.sha)
echo "top tree $t_top | bottom #$BOTTOM tree $t_bot | $([ "$t_top" = "$t_bot" ] && echo EQUAL || echo DIFFERENT)"
