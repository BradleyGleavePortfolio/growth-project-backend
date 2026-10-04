#!/usr/bin/env bash
# Cancel queued/in-progress pull_request runs whose head sha is no longer the PR's current head (superseded pushes).
set -uo pipefail
for k in backend mobile; do R=BradleyGleavePortfolio/growth-project-$k
  heads=$(gh pr list -R $R --state open -L 200 --json headRefName,headRefOid --jq '.[] | "\(.headRefName) \(.headRefOid)"')
  for st in queued in_progress; do
    gh run list -R $R --status $st -L 200 --json databaseId,event,headBranch,headSha,workflowName --jq '.[] | select(.event=="pull_request") | "\(.databaseId) \(.headBranch) \(.headSha) \(.workflowName)"' |
    while read -r id br sha wf; do
      cur=$(awk -v b="$br" '$1==b{print $2}' <<<"$heads")
      if [ -z "$cur" ] || [ "$cur" != "$sha" ]; then gh run cancel $id -R $R >/dev/null 2>&1 && echo "cancelled $k run $id ($wf, $br @${sha:0:8}; current ${cur:0:8})"; fi
    done
  done
done
