#!/bin/bash
R=repos/BradleyGleavePortfolio/growth-project-backend
TZ=America/Los_Angeles date +%H:%M:%S
for pair in 689:68796f675df9c67c0618145efff58caf32a26b04 690:5d41f7678438c11865762a7925ad53520948fe75 691:3dc0e9472954bdd8381d3394aeb79ab0d5712514; do
  n=${pair%%:*}; sha=${pair#*:}
  head=$(gh api $R/pulls/$n --jq .head.sha); [ "$head" = "$sha" ] || echo "#$n HEAD MOVED $head"
  echo "#$n CI: $(gh api "$R/commits/$sha/check-runs?per_page=50" --jq '[.check_runs[] | select(.conclusion != "success" and .conclusion != "skipped") | "\(.name)=\(.conclusion // .status)"] | join(", ")')"
  gh api "$R/issues/$n/comments?per_page=100" --jq '.[] | select(.created_at > "2026-10-05T23:34:00Z") | "  \(.id) \(.body | split("\n")[0] | .[0:140])"'
done
ls -1t /home/user/workspace/ops/lanes122/notify/ | head -4 | tr '\n' ' '; echo
