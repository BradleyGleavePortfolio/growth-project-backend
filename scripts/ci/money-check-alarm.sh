#!/usr/bin/env bash
# MONEY-ALARM-BE (owner #202-E3, 202-S1 op 1): tell the owner when the daily
# money check goes quiet. Run by .github/workflows/money-check-alarm.yml every
# hour. Reads GET /api/money-check/status on the URL the fly-deploy.yml smoke
# test uses: {"status":"on_time"|"late"|"off","lastDay":"YYYY-MM-DD"|null}.
# late, read twice RETRY_DELAY seconds apart, opens one issue labelled
# money-check-late, assigned to the repo owner so GitHub emails them, or
# refreshes the open one (an edit sends no email). on_time closes it with a
# comment. off (the daily check is switched off) opens none and closes an open
# one with a comment. Any other answer (none, another code or another body)
# changes no issue: a server that is down is production-uptime.yml's to report.
# Never the production-down issue, never /readyz. Prints the state, the HTTP
# code and the day only, never a response body. Needs only GH_TOKEN (the
# default GITHUB_TOKEN) and runs no fly command.
set -euo pipefail

BASE_URL="${BASE_URL:-https://backend-spring-lake-3890.fly.dev}"
STATUS_URL="${BASE_URL}/api/money-check/status"
RETRY_DELAY="${RETRY_DELAY:-60}"
LABEL=money-check-late
RUN_URL="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"

# Sets STATE (on_time, late, off or unreadable), DAY (YYYY-MM-DD or empty) and CODE.
read_status() {
  local out body s d
  STATE=unreadable DAY=""
  out=$(curl -s --max-time 20 -w '\n%{http_code}' "$STATUS_URL") || true
  CODE=${out##*$'\n'}
  body=${out%$'\n'*}
  [[ "$CODE" =~ ^[0-9]{3}$ ]] || CODE=000
  [ "$CODE" = 200 ] || return 0
  s=$(jq -r '.status // ""' <<<"$body" 2>/dev/null) || s=""
  d=$(jq -r '.lastDay // ""' <<<"$body" 2>/dev/null) || d=""
  case "$s" in on_time | late | off) STATE=$s ;; esac
  if [[ "$d" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then DAY=$d; fi
  return 0
}

open_issue=$(gh issue list --label "$LABEL" --state open --limit 1 --json number --jq '.[0].number // empty')

read_status
if [ "$STATE" = late ]; then
  sleep "$RETRY_DELAY"
  read_status
fi
NOW=$(date -u +%FT%TZ)
LAST="${DAY:-none on record}"
echo "${NOW} money check: ${STATE} (HTTP ${CODE}); last finished day: ${LAST}"

case "$STATE" in
  on_time)
    if [ -n "$open_issue" ]; then
      gh issue close "$open_issue" --comment "Recovered: the money check status is on time (last finished day: ${LAST}, UTC; checked ${NOW}). A queued push does not prove that it reached your phone or that you read it. Closed automatically by the money check alarm. Run: ${RUN_URL}"
    fi
    ;;
  off)
    echo "::notice::The daily money check is switched off (RECONCILIATION_DAILY_ENABLED is 'false')."
    if [ -n "$open_issue" ]; then
      gh issue close "$open_issue" --comment "Switched off: the daily money check is off (RECONCILIATION_DAILY_ENABLED is 'false'), so it is not late; it does not run until it is switched back on. Last finished day: ${LAST} (UTC). Closed automatically by the money check alarm. Run: ${RUN_URL}"
    fi
    ;;
  late)
    body="The daily money check has not finished with a notice to you in the last 26 hours.

- Last finished day: ${LAST} (UTC)
- Checked: ${NOW}, twice, ${RETRY_DELAY} seconds apart
- Status: ${STATUS_URL}
- Run: ${RUN_URL}

The check runs once a day at 11:00 UTC (03:00 PST, 04:00 PDT). When a run finishes, it emails the result to the address in the server setting OWNER_ALERT_EMAIL, writes it to your inbox in the app if an account has the owner role, and queues one push to your phone if a phone is signed in to that account. This alarm counts a day only when the run reached every purchase and could confirm at least one of them, a match or a mismatch (or there were none to check), and its result reached you: the email provider accepted the email, or it was saved to your inbox in the app (or, if your in-app alerts are off, queued as a push). Whether a phone got the push does not change the count. A queued push does not prove that it reached your phone or that you read it. An accepted email does not prove that it reached your mailbox or that you read it.

This opens when the run did not start, stopped before it reached every purchase, or could confirm none of them (for example the server was down or restarting at 11:00 UTC, the check could not read its lock, or it hit its time limit), or when its result reached you by no route: the email was not accepted (OWNER_ALERT_EMAIL is not set or is not one address, or the email provider refused it) and nothing was saved to your inbox (no account has the owner role, the inbox write failed, or your in-app alerts are off and no push could be queued). Running the reconciliation sweeper by hand (the admin run-sweeper route) checks purchases but sends no daily result, so it does not close this issue. If the check was just switched back on, this closes after its next run.

What to look for in the server logs around 11:00 UTC: no MONEY_DAILY_ line means the run did not start; MONEY_DAILY_LOCK_ERROR means it could not read its lock; MONEY_DAILY_DONE means the sweep ended, and the line after it says whether the day was counted and, if not, why. A day with no phone signed in, or with no account that has the owner role, still counts when the email was accepted or the result reached your inbox; MONEY_DAILY_NO_EMAIL and MONEY_DAILY_EMAIL_FAILED say why no email was accepted.

This issue is updated every hour while the check is late and closes by itself after the next run that is counted."
    echo "::warning::The daily money check is late; last finished day: ${LAST}"
    if [ -n "$open_issue" ]; then
      gh issue edit "$open_issue" --body "$body"
    else
      gh label create "$LABEL" --color D93F0B --description "The daily money check has not reported in 26 hours" --force
      gh issue create --title "Money check is late: no daily result in 26 hours" --label "$LABEL" --assignee "$OWNER" --body "$body"
    fi
    ;;
  *)
    echo "::warning::The money check status could not be read (HTTP ${CODE}); no issue was changed. A server that is down is reported by the production uptime check."
    ;;
esac
