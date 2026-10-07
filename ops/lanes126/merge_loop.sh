#!/usr/bin/env bash
# agent 126: every 3 min, run merge_if_dual.sh on open, non-draft agent126/* PRs whose base is main. Log only.
O=BradleyGleavePortfolio
while true; do
  for repo in growth-project-backend growth-project-mobile; do
    for n in $(gh pr list --repo $O/$repo --state open --limit 100 --json number,headRefName,baseRefName,isDraft \
        --jq '.[]|select(.headRefName|startswith("agent126/"))|select(.baseRefName=="main")|select(.isDraft|not)|.number' 2>/dev/null); do
      out=$(/home/user/workspace/ops/merge_if_dual.sh $O/$repo $n 2>&1)
      case "$out" in *MERGED*) echo "$(TZ=America/Los_Angeles date +%H:%M) $out" >> /home/user/workspace/ops/lanes126/merged.log;; esac
      echo "$(TZ=America/Los_Angeles date +%H:%M) $(echo "$out" | head -1)" >> /home/user/workspace/ops/lanes126/merge_loop.log
    done
  done
  sleep 180
done
