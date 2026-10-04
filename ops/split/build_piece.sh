#!/usr/bin/env bash
# build_piece.sh <worktree> <refreshed-sha> <resolved.json> <piece> <new-branch> <from-ref>
# Creates <new-branch> at <from-ref>, applies piece files from <refreshed-sha>, runs tsc, the piece's specs, and every
# existing spec that imports a source file changed in this piece. Does NOT commit.
set -uo pipefail
wt=$1; R=$2; plan=$3; k=$4; br=$5; from=$6
cd "$wt" || exit 1
git reset -q --hard && git clean -fdq -e node_modules && git checkout -q -f -B "$br" "$from" || exit 1
files=$(python3 -c "import json,sys; r=json.load(open('$plan')); print('\n'.join(p for p,v in r.items() if v==$k))")
for f in $files; do
  if git cat-file -e "$R:$f" 2>/dev/null; then git checkout "$R" -- "$f"; else git rm -q -f "$f" 2>/dev/null || true; fi
done
git add -A
echo "piece $k: $(git diff --cached --shortstat)"
NODE_OPTIONS=--max-old-space-size=6144 timeout 900 npx tsc --noEmit -p tsconfig.json > /tmp/tsc_piece.log 2>&1; echo "tsc=$?"; head -8 /tmp/tsc_piece.log
specs=$(echo "$files" | grep -E '\.(spec|test)\.[tj]sx?$')
if echo "$files" | grep -qE '^(app\.json|app\.config\.js|eas\.json|package\.json)$'; then specs="$specs
$(ls scripts/__tests__/*.test.js src/config/__tests__/*.test.* 2>/dev/null)"; fi
for f in $(echo "$files" | grep -E '^src/.*\.tsx?$' | grep -vE '\.(spec|test)\.tsx?$'); do
  m=$(basename "$f"); m=${m%.tsx}; m=${m%.ts}
  specs="$specs
$(grep -rlE "/${m}[\"']" test src --include='*.spec.ts' --include='*.test.ts' --include='*.test.tsx' --include='*.test.js' 2>/dev/null)"
done
specs=$(echo "$specs" | grep -E '\.(spec|test)\.[tj]sx?$' | grep -vE '\.live\.spec\.ts$' | sort -u | head -90 | tr '\n' ' ')
echo "specs: $(echo $specs | wc -w)"
if [ -n "$specs" ]; then NODE_OPTIONS=--max-old-space-size=4096 timeout 480 npx jest $specs --runInBand --forceExit > /tmp/jest_piece.log 2>&1; grep -E "^Tests:|^Test Suites:|✕|^FAIL" /tmp/jest_piece.log | sort -u | head -14; fi
