#!/usr/bin/env bash
# usage: checks.sh <backend|mobile> <sha>  -> summary of check-runs at sha (latest per name)
k=$1; s=$2; R=BradleyGleavePortfolio/growth-project-$k
gh api "repos/$R/commits/$s/check-runs?per_page=100" --jq '[.check_runs | group_by(.name)[] | max_by(.started_at)] | (map(.conclusion // .status) | group_by(.) | map("\(.[0])=\(length)") | join(" ")) + "  FAILS: " + (map(select((.conclusion // "") as $c | $c=="failure" or $c=="cancelled" or $c=="timed_out")) | map(.name) | join("; "))'
