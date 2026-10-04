#!/usr/bin/env bash
# usage: run.sh <config> <cachedir> <log> specs...
cfg=$1; cd_=$2; log=$3; shift 3
cd /home/user/workspace/wt/B-CI-116-1
rm -rf "$cd_"
start=$(date +%s)
/home/user/workspace/ops/heavy.sh npx jest --config "$cfg" --cacheDirectory="$cd_" --ci --runInBand --logHeapUsage "$@" > "$log" 2>&1
echo "EXIT=$? WALL=$(( $(date +%s) - start ))s" >> "$log"
