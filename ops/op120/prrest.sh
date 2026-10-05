#!/usr/bin/env bash
# usage: prrest.sh <backend|mobile> <n> [since-iso]  (REST only; robust to GraphQL 502)
k=$1; n=$2; since=${3:-2026-10-04T22:40:00Z}; R=BradleyGleavePortfolio/growth-project-$k
p=$(gh api repos/$R/pulls/$n) || { echo "#$n ERROR"; exit 0; }
echo "#$n $(jq -r '"\(.state) merged=\(.merged) head=\(.head.sha) base=\(.base.ref) +\(.additions)/-\(.deletions) files=\(.changed_files) mstate=\(.mergeable_state) title=\(.title[0:60])"' <<<"$p")"
echo "  commits since $since:"
gh api "repos/$R/pulls/$n/commits?per_page=100" --paginate --jq ".[] | select(.commit.committer.date >= \"$since\") | \"    \(.sha[0:8]) \(.commit.committer.date) \(.parents|length)p \(.commit.message|split(\"\n\")[0][0:90])\""
echo "  comments since $since:"
gh api "repos/$R/issues/$n/comments?per_page=100" --paginate --jq ".[] | select(.created_at >= \"$since\") | \"    \(.created_at) \(.id) :: \(.body|split(\"\n\")[0][0:200])\""
