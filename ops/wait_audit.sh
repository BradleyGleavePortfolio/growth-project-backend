#!/usr/bin/env bash
# wait_audit.sh "<Claude Opus 5.5|GPT-6.1 Sol>" <max_seconds> <queue file with one backend#n|mobile#n per line> (re-read every loop)
# Blocks until at least one PR is auditable by this lens, or max_seconds pass. Auditable = open, READY FOR AUDIT comment naming the
# exact head sha, required checks all pass/skipping (none pending/fail), no verdict from this lens at that head, and the other lens has
# not already returned REQUEST CHANGES/BLOCK at that head (a fix round is coming; audit the next head instead).
# CLAIM before you start: mkdir /home/user/workspace/ops/lanes116/claims/<backend|mobile>-<n>-<head8>-<opus|sol>
# (if mkdir fails, another lens of your model owns it: skip it).
set -uo pipefail
lens=$1; max=$2; qf=$3; end=$(( $(date +%s) + max ))
key=opus; other=sol; [ "$lens" = "GPT-6.1 Sol" ] && { key=sol; other=opus; }
while :; do
  found=0
  for p in $(grep -oE '^(backend|mobile)#[0-9]+' "$qf" | sort -u); do k=${p%%#*}; n=${p##*#}
    l=$(/home/user/workspace/ops/prstate.sh "$k" "$n") || continue
    st=$(grep -o 'state=[A-Z]*' <<<"$l"|cut -d= -f2); rd=$(grep -o 'ready=[a-z]*' <<<"$l"|cut -d= -f2)
    mv=$(grep -o " $key=[A-Z_-]*" <<<"$l"|cut -d= -f2); ov=$(grep -o " $other=[A-Z_-]*" <<<"$l"|cut -d= -f2); ck=$(grep -o 'checks=[^ ]*' <<<"$l"|cut -d= -f2)
    if [ "$st" = OPEN ] && [ "$rd" = true ] && [ "$mv" = "-" ] && ! grep -qE 'REQUEST|BLOCK' <<<"$ov" && ! grep -qE 'fail|pending|cancel' <<<"$ck" && [ "$ck" != none ]; then
      h8=$(grep -o 'head=[0-9a-f]*' <<<"$l"|cut -d= -f2)
      if [ -d "/home/user/workspace/ops/lanes116/claims/$k-$n-$h8-$key" ]; then echo "CLAIMED-BY-OTHER-$key-LENS (skip) $k#$n@$h8"; else echo "AUDITABLE $l"; found=1; fi
    fi
  done
  [ $found = 1 ] && exit 0
  [ $(date +%s) -ge $end ] && { echo "NOTHING AUDITABLE after ${max}s"; exit 0; }
  sleep 150
done
