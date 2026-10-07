#!/bin/bash
# LX-OPUS-126 queue: agent126/* non-draft PRs with READY at current head and no Claude Opus 5.5 verdict at that head.
O=BradleyGleavePortfolio
for repo in growth-project-mobile growth-project-backend; do
  for n in $(gh pr list --repo $O/$repo --state open --limit 100 --json number,headRefName,isDraft --jq '.[]|select(.headRefName|startswith("agent126/"))|select(.isDraft|not)|.number' | sort -n); do
    head=$(gh api repos/$O/$repo/pulls/$n --jq .head.sha)
    firsts=$(gh api --paginate repos/$O/$repo/issues/$n/comments --jq '.[]|.body|split("\n")[0]')
    ready=$(echo "$firsts" | grep -c "READY FOR AUDIT" )
    readyhead=$(echo "$firsts" | grep "READY FOR AUDIT" | grep -c "$head")
    opus=$(echo "$firsts" | grep "^AUDIT Claude Opus 5.5" | grep -c "$head")
    echo "$repo#$n head=${head:0:8} readyAny=$ready readyAtHead=$readyhead opusAtHead=$opus"
  done
done
