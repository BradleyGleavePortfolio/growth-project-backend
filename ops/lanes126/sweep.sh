#!/usr/bin/env bash
# One sweep: merge_if_dual on every open non-draft agent126/* PR based on main. Run from a bash call WITH api_credentials=["github"].
O=BradleyGleavePortfolio
for repo in growth-project-backend growth-project-mobile; do
  for n in $(gh pr list --repo $O/$repo --state open --limit 100 --json number,headRefName,baseRefName,isDraft \
      --jq '.[]|select(.headRefName|startswith("agent126/"))|select(.baseRefName=="main")|select(.isDraft|not)|.number'); do
    # Approval holds override mechanical promotion, even with dual verdicts.
    if { [ "$repo" = "growth-project-backend" ] && [ -f /home/user/workspace/ops/lanes126/backend-promotion-hold ]; } ||
       { [ "$repo" = "growth-project-backend" ] && [[ " 809 820 822 " == *" $n "* ]]; } ||
       { [ "$repo" = "growth-project-mobile" ] && [ "$n" = "451" ]; }; then
      echo "HOLD $repo#$n (production release freeze or owner approval pending)"
      continue
    fi
    out=$(/home/user/workspace/ops/merge_if_dual.sh $O/$repo $n 2>&1)
    echo "$(TZ=America/Los_Angeles date +%H:%M) $out" | tee -a /home/user/workspace/ops/lanes126/merge_loop.log | grep -E "MERGED|approve=1" || true
  done
done
