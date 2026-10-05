#!/usr/bin/env bash
# usage: prdump.sh <backend|mobile> <n> [since-iso]
k=$1; n=$2; since=${3:-2026-10-04T07:00:00Z}; R=BradleyGleavePortfolio/growth-project-$k
gh pr view $n -R $R --json number,headRefOid,baseRefName,mergeStateStatus,additions,deletions,changedFiles,statusCheckRollup > /tmp/pr-$k-$n.json
jq -r '"#\(.number) head=\(.headRefOid) base=\(.baseRefName) \(.mergeStateStatus) +\(.additions)/-\(.deletions) files=\(.changedFiles)"' /tmp/pr-$k-$n.json
jq -r '[.statusCheckRollup[] | {n:(.name // .context), s:((.conclusion // .state) // .status)}] | group_by(.s) | map("\(.[0].s)=\(length)") | join(" ")' /tmp/pr-$k-$n.json
jq -r '.statusCheckRollup[] | select(((.conclusion // .state) // "") as $c | ($c=="FAILURE" or $c=="failure" or $c=="ERROR" or $c=="CANCELLED" or $c=="TIMED_OUT")) | "  FAIL: \(.name // .context) \(.detailsUrl // .targetUrl)"' /tmp/pr-$k-$n.json
jq -r '.statusCheckRollup[] | select((.status // "")=="IN_PROGRESS" or (.status // "")=="QUEUED" or (.status//"")=="PENDING") | "  PENDING: \(.name)"' /tmp/pr-$k-$n.json | head -5
echo "  commits since $since:"
gh api "repos/$R/pulls/$n/commits?per_page=100" --paginate --jq ".[] | select(.commit.committer.date >= \"$since\") | \"    \(.sha[0:8]) \(.commit.committer.date) \(.parents|length)p \(.commit.message|split(\"\n\")[0][0:90])\""
echo "  comments since $since:"
gh api "repos/$R/issues/$n/comments?per_page=100" --paginate --jq ".[] | select(.created_at >= \"$since\") | \"    \(.created_at) \(.html_url|split(\"#\")[1]) :: \(.body|split(\"\n\")[0][0:170])\""
