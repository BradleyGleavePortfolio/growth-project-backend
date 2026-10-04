#!/usr/bin/env bash
# Operator board: every PR in every lens queue + extras; flags MERGEABLE (dual APPROVE at head, checks pass, CLEAN).
cd /home/user/workspace/ops
for p in $(cat lanes115/q/*.txt | grep -oE '^(backend|mobile)#[0-9]+' | sort -u) backend#611; do k=${p%%#*}; n=${p##*#}
  l=$(./prstate.sh $k $n)
  if grep -q 'opus=APPROVE sol=APPROVE' <<<"$l" && grep -q 'merge=CLEAN' <<<"$l" && ! grep -qE 'checks=[^ ]*(fail|pending)' <<<"$l"; then echo "MERGEABLE $l"; else echo "          $l"; fi
done | sed 's/ full=[0-9a-f]*//'
echo "-- sandbox: $(df -h / | tail -1 | awk '{print $5}') disk, $(free -m | awk 'NR==2{print $7}') MB avail, load $(cut -d' ' -f1-3 /proc/loadavg), heavy-procs $(pgrep -fc "ops/heavy.sh")"
