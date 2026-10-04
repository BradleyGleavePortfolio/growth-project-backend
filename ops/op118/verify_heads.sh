#!/usr/bin/env bash
# verify_heads.sh (agent 118 for agent 119). Compares every open stack PR with the heads in HANDOFF_AGENT_119.md section 3.
# MOVED = someone pushed after 118 stopped: read the new commits and comments before trusting any verdict listed in the handoff.
# Run from Computer bash with api_credentials=["github"].
O=BradleyGleavePortfolio
while read -r k n want; do
  [ -z "$k" ] && continue
  j=$(gh pr view $n -R $O/growth-project-$k --json headRefOid,state,mergeStateStatus,additions,deletions 2>/dev/null) || { echo "$k#$n  ERROR"; continue; }
  h=$(jq -r .headRefOid <<<"$j"); st=$(jq -r .state <<<"$j"); ms=$(jq -r .mergeStateStatus <<<"$j"); sz=$(jq -r '.additions+.deletions' <<<"$j")
  req=$(gh pr checks $n -R $O/growth-project-$k --required --json state --jq 'group_by(.state)|map("\(.[0].state)=\(length)")|join(",")' 2>/dev/null)
  [ "${h:0:8}" = "$want" ] && m=MATCH || m="MOVED(${h:0:8})"
  printf "%-7s #%-4s %-8s %-15s %-6s %-9s %5s  %s\n" "$k" "$n" "$want" "$m" "$st" "$ms" "$sz" "$req"
done <<'LIST'
backend 681 e9650dc4
backend 682 70f879a2
backend 683 cc183e0a
backend 684 6b13af56
backend 697 88c72200
backend 685 c5e282fb
backend 686 8cb7b2d4
backend 678 77bce450
backend 679 8bbf4a41
backend 680 216489ff
backend 696 276610a3
backend 701 72eb096b
backend 661 f80f0088
backend 702 20d2eb4f
backend 671 c75002c9
backend 672 2690c07c
backend 673 5fdb5f5c
backend 674 f9e21a87
backend 676 ccd60bbc
backend 677 4799c6af
backend 687 38d9b3ab
backend 688 2368d5fa
backend 689 bb992fed
backend 690 06307883
backend 691 e0afe678
backend 642 4fee3c02
mobile 338 48b5e6b5
mobile 342 56f281ad
mobile 343 fd739d58
mobile 344 e7fcc5d2
mobile 345 97c9005e
mobile 346 2baea5b8
mobile 347 3beab160
mobile 348 90501f84
mobile 349 35aa8163
mobile 350 6fb21216
mobile 351 352d768e
mobile 352 ac244d22
mobile 353 05d84f27
mobile 354 f084cc0f
mobile 355 902c64a6
mobile 356 40ee678a
mobile 357 b364b9ea
mobile 358 4dcf0aff
mobile 359 e0f3d2a7
mobile 360 fde1875e
mobile 361 574b32a8
mobile 362 b3bc0ce4
mobile 363 2858bac5
mobile 364 529ba345
mobile 335 641fe891
mobile 312 8016a79e
mobile 339 8165ca95
mobile 340 2e77dcb6
LIST
echo "main: backend $(gh api repos/$O/growth-project-backend/commits/main --jq '.sha[0:8]') (118 stop: 3e9a9a75), mobile $(gh api repos/$O/growth-project-mobile/commits/main --jq '.sha[0:8]') (118 stop: cc4ceeed)"
curl -s -m 10 https://api.trygrowthproject.com/health; echo
