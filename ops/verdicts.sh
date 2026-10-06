#!/usr/bin/env bash
# verdicts.sh <b|m> <n...>: AUDIT lines at the current head + current head
for n in "${@:2}"; do
  R=BradleyGleavePortfolio/growth-project-$([ "$1" = b ] && echo backend || echo mobile)
  h=$(gh pr view $n --repo $R --json headRefOid --jq .headRefOid)
  echo "$1#$n head $h"
  gh api "repos/$R/issues/$n/comments?per_page=100" --paginate --jq '.[]|select(.body|startswith("AUDIT") or startswith("MERGE-ONLY"))|"   \(.id) \(.body|split("\n")[0])"' | grep "$h" | sed 's/growth-project-[a-z]*//' | cut -c1-140
done
