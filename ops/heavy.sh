#!/usr/bin/env bash
# Serialize heavy jobs (npm, jest, tsc, prisma generate, eslint over many files, builds) across ALL agents in this sandbox
# (2 CPU / 7.9 GB RAM). Operator 113 (16:50 10-02): THREE slots, memory-guarded (slot 2 needs >=2.2 GB available, slot 3 needs
# >=3.5 GB), each job capped at a 2.5 GB Node heap unless NODE_OPTIONS is set. `npx prisma generate` is served from a cache keyed
# by the schema hash when possible (no slot needed). Usage: /home/user/workspace/ops/heavy.sh <cmd...>
set -uo pipefail
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=2560}"
export CI=true HUSKY=0 LEFTHOOK=0
D=/home/user/workspace/ops
PC=/home/user/workspace/deps/prisma-cache
is_gen=0
if [ "$*" = "npx prisma generate" ] && [ -f prisma/schema.prisma ] && [ -d node_modules ]; then
  is_gen=1
  h=$( (cat prisma/schema.prisma; cat node_modules/@prisma/client/package.json 2>/dev/null) | sha256sum | cut -c1-16)
  if [ -f "$PC/$h/READY" ]; then
    rm -rf node_modules/.prisma && mkdir -p node_modules/.prisma && cp -r "$PC/$h/client" node_modules/.prisma/client \
      && { echo "[heavy] prisma client served from cache $h (no generate needed)" >&2; exit 0; }
  fi
fi
echo "[heavy] waiting for a slot: $*" >&2
deadline=$(( $(date +%s) + 5400 ))
while :; do
  for L in "$D/heavy.lock" "$D/heavy.lock.2" "$D/heavy.lock.3"; do
    exec 9>>"$L"
    if flock -n 9; then
      avail=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
      if [ "$L" = "$D/heavy.lock.2" ] && [ "$avail" -lt 2200 ]; then flock -u 9; exec 9>&-; continue; fi
      if [ "$L" = "$D/heavy.lock.3" ] && [ "$avail" -lt 3500 ]; then flock -u 9; exec 9>&-; continue; fi
      nice -n 10 "$@"; rc=$?
      if [ $is_gen = 1 ] && [ $rc = 0 ] && [ -d node_modules/.prisma/client ] && [ ! -f "$PC/$h/READY" ]; then
        mkdir -p "$PC/$h.tmp.$$" && cp -r node_modules/.prisma/client "$PC/$h.tmp.$$/client" && touch "$PC/$h.tmp.$$/READY" \
          && mv -T "$PC/$h.tmp.$$" "$PC/$h" 2>/dev/null || rm -rf "$PC/$h.tmp.$$"
      fi
      flock -u 9; exit $rc
    fi
    exec 9>&-
  done
  [ "$(date +%s)" -ge "$deadline" ] && { echo "[heavy] timed out waiting for a slot" >&2; exit 124; }
  sleep 3
done
