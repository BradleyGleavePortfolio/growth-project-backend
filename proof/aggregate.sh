#!/usr/bin/env bash
# GH-LANES aggregate: collect per-stage RESULT receipts, write SUMMARY (HEAD/TREE/pkg-lock/migrations/per-stage counts/TOTAL),
# compare against the expectations, fail if any scheduled stage failed, is missing, or disagrees on the binding.
# Usage: aggregate.sh <PROOF_TARGET> <artifacts dir> <out dir>
# Env: MATRIX (preflight matrix JSON), PREFLIGHT_RESULT (preflight job result), SKIPS (preflight optional skips).
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd); . "$HERE/lanes.sh"
PT=$1; A=$2; OUT=$3; mkdir -p "$OUT"; S=$OUT/SUMMARY.md; BAD=()
bad(){ BAD+=("$*"); }
kv(){ sed -n '2,$p' "$PT" | tr -d '\r' | grep -E "^$1=" | tail -1 | cut -d= -f2- || true; }
SHA=$(sed -n 1p "$PT" | tr -d '\r' | sed 's/[[:space:]]*$//')
field(){ grep -m1 "^$1=" "$2" | cut -d= -f2-; }
sr(){ grep -m1 "^STAGE_RESULT name=$1 " "$2" | grep -oE "(^| )$3=[^ ]+" | head -1 | cut -d= -f2-; }
[ "${PREFLIGHT_RESULT:-}" = success ] || bad "preflight result=${PREFLIGHT_RESULT:-unknown}"
PF=$(find "$A" -name PREFLIGHT -type f | head -1)
[ -n "$PF" ] && grep -qx PREFLIGHT_OK "$PF" || bad "no PREFLIGHT_OK receipt"
declare -A LP LT; for L in $LANES; do LP[$L]=0; LT[$L]=0; done
ROWS=""; BIND=""
M=${MATRIX:-}; [ -n "$M" ] || M='{"include":[]}'
mapfile -t JOBS < <(jq -r '.include[] | "\(.lane) \(.stage)"' <<<"$M" 2>/dev/null)
[ "${#JOBS[@]}" -gt 0 ] || bad "empty or unreadable matrix"
for j in "${JOBS[@]}"; do L=${j% *}; N=${j#* }; R=$A/result-$L-$N/RESULT
  if [ ! -f "$R" ]; then bad "$L/$N: RESULT missing"; ROWS="$ROWS| $L | $N | MISSING | | | | | |\n"; continue; fi
  RC=$(field RC "$R"); ST=$(sr "$N" "$R" status); P=$(sr "$N" "$R" passed); T=$(sr "$N" "$R" total); SK=$(sr "$N" "$R" skipped)
  E=$(sr "$N" "$R" expected); SEC=$(sr "$N" "$R" secs); BS=$(sr bootstrap "$R" status); DUR=$(field DURATION_S "$R")
  [ "$RC" = 0 ] && [ "$(field STAGE "$R")" = done ] || bad "$L/$N: RC=$RC stage=$(field STAGE "$R")"
  [ "$ST" = PASS ] || bad "$L/$N: status=${ST:-none}"
  [ "$(field HEAD "$R")" = "$SHA" ] || bad "$L/$N: HEAD $(field HEAD "$R") != target"
  [ "${SK:-x}" = 0 ] || bad "$L/$N: skipped=${SK:-none}"
  X=$(kv "EXPECT_$N"); [ -z "$X" ] || [ "$T" = "$X" ] || bad "$L/$N: total=$T != EXPECT_$N=$X"
  B="$(field TREE "$R") $(field PKG_LOCK_SHA256 "$R") $(field CLIENT_INDEX_DTS_SHA256 "$R") $(field MIGRATIONS_AT_HEAD "$R") $(field LAST_MIGRATION_AT_HEAD "$R")"
  if [ -z "$BIND" ]; then BIND=$B; elif [ "$B" != "$BIND" ]; then bad "$L/$N: binding differs ($B vs $BIND)"; fi
  if [ "${BS:-}" != "" ]; then MA=$(field MIGRATIONS_APPLIED "$R"); [ "$BS" = PASS ] && [ "$MA" = "$(field MIGRATIONS_AT_HEAD "$R")" ] || bad "$L/$N: bootstrap=$BS applied=$MA"; fi
  LP[$L]=$(( ${LP[$L]} + ${P:-0} )); LT[$L]=$(( ${LT[$L]} + ${T:-0} ))
  ROWS="$ROWS| $L | $N | ${ST:-?} | ${P:-?}/${T:-?} | ${E:-?} | ${SK:-?} | ${BS:-n/a} | ${SEC:-?} / ${DUR:-?} |\n"
done
for sk in ${SKIPS:-}; do ROWS="$ROWS| ${sk%/*} | ${sk#*/} | SKIP_ABSENT_AT_HEAD | | | | | |\n"; done
for L in $LANES; do X=$(kv "EXPECT_TOTAL_$L"); [ -z "$X" ] || [ "${LT[$L]}" = "$X" ] && [ "${LP[$L]}" = "${LT[$L]}" ] || bad "lane $L: TOTAL ${LP[$L]}/${LT[$L]} vs EXPECT_TOTAL_$L=${X:-unset}"; done
read -r TREE PKG CLI MIGN LASTM <<<"${BIND:-none none none none none}"
{ echo "# proof-lanes summary"
  echo; echo "- HEAD: \`$SHA\`"; echo "- TREE: \`$TREE\`"; echo "- package-lock sha256: \`$PKG\`"; echo "- generated client index.d.ts sha256: \`$CLI\`"
  echo "- migrations at HEAD: $MIGN (last \`$LASTM\`)"; echo "- harness: \`${GITHUB_SHA:-local}\` run ${GITHUB_SERVER_URL:-}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}"
  echo; echo "| lane | stage | status | passed/total | expected(static) | skipped | bootstrap | jest s / job script s |"; echo "|---|---|---|---|---|---|---|---|"
  printf "%b" "$ROWS"
  echo; for L in $LANES; do echo "- TOTAL $L: ${LP[$L]}/${LT[$L]} (expected: $(X=$(kv "EXPECT_TOTAL_$L"); echo "${X:-not pinned}"))"; done
  echo; if [ "${#BAD[@]}" = 0 ]; then echo "**VERDICT: PASS**"; else echo "**VERDICT: FAIL**"; for b in "${BAD[@]}"; do echo "- $b"; done; fi
} >"$S"
cat "$S"; [ -n "${GITHUB_STEP_SUMMARY:-}" ] && cat "$S" >>"$GITHUB_STEP_SUMMARY"
[ "${#BAD[@]}" = 0 ]
