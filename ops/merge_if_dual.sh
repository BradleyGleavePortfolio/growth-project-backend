#!/bin/bash
# usage: merge_if_dual.sh <owner/repo> <pr>  — merges only if BOTH lenses APPROVE at the exact current head and no check is failing/pending
R=$1; n=$2
sha=$(gh pr view $n --repo $R --json headRefOid --jq .headRefOid)
opus=$(gh api repos/$R/issues/$n/comments --paginate --jq "[.[]|select(.body|startswith(\"AUDIT Claude Opus 5.5\"))|select(.body|split(\"\n\")[0]|test(\"@ $sha — VERDICT: APPROVE\"))]|length")
sol=$(gh api repos/$R/issues/$n/comments --paginate --jq "[.[]|select(.body|startswith(\"AUDIT GPT-6.1 Sol\"))|select(.body|split(\"\n\")[0]|test(\"@ $sha — VERDICT: APPROVE\"))]|length")
bad=$(gh pr view $n --repo $R --json statusCheckRollup --jq '[.statusCheckRollup[]|select((.conclusion // .state // "PENDING")|test("FAILURE|ERROR|PENDING|IN_PROGRESS|QUEUED|CANCELLED|TIMED_OUT|ACTION_REQUIRED"))]|length')
echo "$R#$n head=$sha opus_approve=$opus sol_approve=$sol bad_checks=$bad"
if [ "$opus" -ge 1 ] && [ "$sol" -ge 1 ] && [ "$bad" = 0 ]; then
  gh pr merge $n --repo $R --merge --match-head-commit $sha && echo "MERGED $R#$n"
else
  echo "SKIP $R#$n (not dual-approved at head or checks not green)"
fi
