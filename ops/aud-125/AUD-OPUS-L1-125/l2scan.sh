#!/bin/bash
# usage: l2scan.sh  -- lists agent125 PRs, head, READY lines, Opus verdict heads (Sol masked)
for r in mobile backend; do
  R=BradleyGleavePortfolio/growth-project-$r
  for n in $(gh api "repos/$R/pulls?state=open&per_page=100" --jq '.[] | select(.head.ref | test("^agent125/")) | .number'); do
    h=$(gh api repos/$R/pulls/$n --jq .head.sha)
    echo "## $r#$n head=${h:0:8}"
    gh api "repos/$R/issues/$n/comments?per_page=100" --jq '.[] | "\(.created_at) \(.body | split("\n")[0])"' | grep -E "READY|FIX ROUND|HEAD MOVED|AUDIT Claude Opus|AUDIT GPT" | sed -E 's/(AUDIT GPT-6\.1 Sol).*/\1 <hidden by Opus lens>/' | cut -c1-220
  done
done
