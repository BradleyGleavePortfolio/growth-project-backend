#!/usr/bin/env bash
# prstat.sh <b|m> <n...>: head, mergeable, check rollup summary, last 2 comment first lines
for n in "${@:2}"; do
  R=BradleyGleavePortfolio/growth-project-$([ "$1" = b ] && echo backend || echo mobile)
  gh pr view $n --repo $R --json number,headRefOid,mergeable,statusCheckRollup,comments --jq '
   "\("'$1'")#\(.number) \(.headRefOid[0:8]) \(.mergeable) checks: " +
   ([.statusCheckRollup[] | "\(.name // .context)=\(.conclusion // .state // .status)"] | map(select(test("SUCCESS|SKIPPED|NEUTRAL")|not)) | join(", ")) +
   "\n   last: " + ([.comments[-2:][] | (.body|split("\n")[0][0:150])] | join("\n   last: "))'
done
