#!/usr/bin/env bash
# usage: rungc.sh <config> <cachedir> <log> specs...   (forced GC before each heap sample)
cfg=$1; cd_=$2; log=$3; shift 3
cd /home/user/workspace/wt/B-CI-116-1
rm -rf "$cd_"
start=$(date +%s)
NODE_OPTIONS="--max-old-space-size=2560" /home/user/workspace/ops/heavy.sh node --expose-gc node_modules/jest/bin/jest.js --config "$cfg" --cacheDirectory="$cd_" --ci --runInBand --logHeapUsage "$@" > "$log" 2>&1
echo "EXIT=$? WALL=$(( $(date +%s) - start ))s" >> "$log"
