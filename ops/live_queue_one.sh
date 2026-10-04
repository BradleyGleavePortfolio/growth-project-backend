#!/bin/bash
repo=$1; n=$2
for i in 1 2 3; do
  out=$(timeout 40 gh pr view $n -R BradleyGleavePortfolio/$repo --json number,title,headRefOid,baseRefName,additions,deletions,isDraft,state,mergeStateStatus,statusCheckRollup 2>/dev/null) && { echo "$out" | jq -c --arg r "$repo" '{repo:$r,number,title,head:.headRefOid,base:.baseRefName,size:(.additions+.deletions),draft:.isDraft,state,merge:.mergeStateStatus,fail:([.statusCheckRollup[]|select((.conclusion//"")|test("FAILURE|TIMED_OUT|CANCELLED"))|.name]|unique),pending:([.statusCheckRollup[]|select((.status//"COMPLETED")!="COMPLETED")]|length)}' > ${repo#growth-project-}-$n.json; exit 0; }
  sleep 3
done
echo "FAILED $repo $n" >&2
