#!/bin/bash
# usage: prinfo.sh <backend|mobile> <n>
r=$1; n=$2; R=BradleyGleavePortfolio/growth-project-$r
D=/home/user/workspace/ops/aud-125/AUD-OPUS-L1-125/raw
gh api repos/$R/pulls/$n --jq '"HEAD \(.head.sha) base=\(.base.ref) +\(.additions) -\(.deletions) files=\(.changed_files) mergeable=\(.mergeable_state)\nTITLE \(.title)"'
echo "--- BODY"; gh api repos/$R/pulls/$n --jq .body | head -c 6000; echo
echo "--- COMMENTS (first lines)"
gh api "repos/$R/issues/$n/comments?per_page=100" --jq '.[] | "[\(.created_at) \(.user.login)] \(.body | split("\n")[0] | if test("GPT-6.1 Sol") then "AUDIT GPT-6.1 Sol <hidden by Opus lens>" else . end)"'
echo "--- CHECKS"
gh pr view $n --repo $R --json statusCheckRollup --jq '.statusCheckRollup[] | "\(.name // .context) \(.status // "") \(.conclusion // .state)"' | sort | uniq -c | sort -rn | head -60
echo "--- FILES"
gh api "repos/$R/pulls/$n/files?per_page=100" --jq '.[] | "\(.additions)+ \(.deletions)- \(.filename)"'
gh api repos/$R/pulls/$n -H "Accept: application/vnd.github.v3.diff" > $D/$r-$n.diff
echo "diff saved $D/$r-$n.diff ($(wc -l < $D/$r-$n.diff) lines)"
