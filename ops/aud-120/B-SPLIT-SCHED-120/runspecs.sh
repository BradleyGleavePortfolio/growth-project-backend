#!/usr/bin/env bash
# runspecs.sh <worktree> <spec...> : one jest spec at a time via heavy.sh; prints pass/fail summary per spec.
wt=$1; shift; cd "$wt" || exit 1
for f in "$@"; do
  NODE_OPTIONS=--max-old-space-size=3072 /home/user/workspace/ops/heavy.sh npx jest --ci --runInBand "$f" > /tmp/s120_one.log 2>&1
  t=$(grep -E '^Tests:' /tmp/s120_one.log); [ -z "$t" ] && t="SUITE-FAIL: $(grep -m1 -E 'error TS|Cannot find|ENOENT|●' /tmp/s120_one.log | cut -c1-160)"
  echo "$f | $t"
  grep -E "✕" /tmp/s120_one.log | head -6 | sed 's/^/     /'
done
