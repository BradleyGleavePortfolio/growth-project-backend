#!/usr/bin/env bash
set -euo pipefail
out=/home/user/workspace/ops/aud-121/AUD-SOL-INV3-121
deadline=$(TZ=America/Los_Angeles date -d '2026-10-05 13:38:42 PDT' +%s)
next=${NEXT_POLL_EPOCH:-$(TZ=America/Los_Angeles date -d '2026-10-05 13:04:12 PDT' +%s)}
poll=${POLL_NUMBER:-6}
limit=${MAX_POLLS:-1}
completed=0
while :; do
  now=$(date +%s)
  wake=$next
  [ "$wake" -gt "$deadline" ] && wake=$deadline
  if [ "$wake" -gt "$now" ]; then sleep "$((wake-now))"; fi
  TZ=America/Los_Angeles date '+%Y-%m-%d %H:%M:%S %Z'
  all=1
  for n in 708 709 710 711; do
    gh api "repos/BradleyGleavePortfolio/growth-project-backend/issues/$n/comments" --paginate |
      jq '[.[] | select(.body | contains("B-MSG-FIN-121") and contains("READY FOR AUDIT"))
        | {id,html_url,body,created_at}]' > "$out/ready$n-poll$poll.json"
    count=$(jq length "$out/ready$n-poll$poll.json")
    printf '#%s READY comments: %s\n' "$n" "$count"
    [ "$count" -eq 0 ] && all=0
  done
  if [ "$all" -eq 1 ]; then
    for n in 708 709 710 711; do
      printf '\n#%s\n' "$n"
      jq -r '.[]|.html_url,.body' "$out/ready$n-poll$poll.json"
    done
    printf '\nALL FOUR READY — verify each exact head before auditing.\n'
    exit 0
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    printf '\nHANDOFF: sixty-minute READY wait expired.\n'
    exit 0
  fi
  completed=$((completed+1))
  if [ "$completed" -ge "$limit" ]; then
    printf '\nWAITING: resume with poll %s after at least five minutes.\n' "$((poll+1))"
    exit 0
  fi
  poll=$((poll+1))
  next=$((next+300))
done
