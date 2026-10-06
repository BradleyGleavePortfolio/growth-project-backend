#!/bin/bash
# Mobile-only poll: open agent125/* PRs, head, READY/FIX ROUND lines at current head, and whether an Opus verdict exists at head.
M=BradleyGleavePortfolio/growth-project-mobile
gh pr list --repo $M --state open --limit 100 --json number,headRefName,headRefOid --jq '.[]|select(.headRefName|startswith("agent125/"))|"\(.number) \(.headRefOid)"' | while read n sha; do
  c=$(gh api repos/$M/issues/$n/comments --paginate --jq '.[]|.body|split("\n")[0]')
  ready=$(echo "$c" | grep -E "READY FOR" | grep -c "$sha")
  opus=$(echo "$c" | grep "AUDIT Claude Opus" | grep -c "$sha")
  ci=$(gh pr view $n --repo $M --json statusCheckRollup --jq '[.statusCheckRollup[]|.conclusion]|join(",")')
  echo "m#$n ${sha:0:8} ready_at_head=$ready opus_at_head=$opus ci=$ci"
done
TZ=America/Los_Angeles date +%H:%M
