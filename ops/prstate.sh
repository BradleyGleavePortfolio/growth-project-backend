#!/usr/bin/env bash
# prstate.sh <backend|mobile> <n>  -> one-line PR state for the CURRENT head (cached 90 s, shared by all agents).
# Fields: repo#n head8 state merge draft checks(pass/fail/pending) ready_at_head opus_at_head sol_at_head
set -uo pipefail
k=$1; n=$2; repo=BradleyGleavePortfolio/growth-project-$k
c=/home/user/workspace/ops/cache/$k-$n.txt
if [ -f "$c" ] && [ $(( $(date +%s) - $(stat -c %Y "$c") )) -lt 90 ]; then cat "$c"; exit 0; fi
j=$(gh pr view "$n" -R "$repo" --json headRefOid,state,mergeStateStatus,isDraft,comments 2>/dev/null) || { echo "$k#$n ERROR gh"; exit 1; }
h=$(jq -r .headRefOid <<<"$j")
out=$(jq -r --arg h "$h" '
  def v(l): ([.comments[] | select(.body|startswith("AUDIT "+l)) | select(.body|split("\n")[0]|contains($h))] | last | if .==null then "-" else (.body|split("\n")[0]|capture("VERDICT: (?<x>[A-Z ]+)").x|gsub(" ";"_")) end);
  "head=\($h[0:8]) state=\(.state) merge=\(.mergeStateStatus) draft=\(.isDraft) ready=\(([.comments[]|select((.body|contains($h)) and (.body|test("READY FOR AUDIT")))]|length>0)) opus=\(v("Claude Opus 5.5")) sol=\(v("GPT-6.1 Sol"))"' <<<"$j")
ck=$(gh pr checks "$n" -R "$repo" --required --json bucket --jq '[group_by(.bucket)[]|"\(.[0].bucket)=\(length)"]|join(",")' 2>/dev/null)
[ -z "$ck" ] && ck=$(gh pr checks "$n" -R "$repo" --json bucket --jq '[group_by(.bucket)[]|"\(.[0].bucket)=\(length)"]|join(",")' 2>/dev/null)
line="$k#$n $out checks=${ck:-none} full=$h"
echo "$line" | tee "$c.tmp" >/dev/null; mv "$c.tmp" "$c"; echo "$line"
