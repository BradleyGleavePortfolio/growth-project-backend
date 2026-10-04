#!/usr/bin/env bash
# Operator 112 sandbox monitor: one line per minute -> ops/sandbox.log (mem used/avail MB, load1, disk %, heavy queue depth, worktrees, top RSS)
LOG=/home/user/workspace/ops/sandbox.log
while true; do
  read -r used avail < <(free -m | awk '/^Mem:/{print $3, $7}')
  load=$(cut -d' ' -f1 /proc/loadavg)
  disk=$(df --output=pcent / | tail -1 | tr -d ' %')
  q=$(pgrep -fc '^bash /home/user/workspace/ops/heavy.sh' 2>/dev/null || echo 0)
  wt=$(ls /home/user/workspace/wt 2>/dev/null | wc -l)
  top=$(ps -eo rss,comm --sort=-rss | awk 'NR==2{printf "%dMB:%s", $1/1024, $2}')
  echo "$(TZ=America/Los_Angeles date +%H:%M) used=${used}MB avail=${avail}MB load1=${load} disk=${disk}% heavyq=${q} wt=${wt} top=${top}" >> $LOG
  sleep 60
done
