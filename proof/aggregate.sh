#!/usr/bin/env bash
# GH-LANES aggregate. Authoritative verdict of a run; independent of the preflight job's outputs:
#   - every upstream job result (needs.<job>.result) must be `success`;
#   - PROOF_TARGET re-parsed with the exact allowlist; run commit bound to HARNESS_SHA (single parent, only PROOF_TARGET differs);
#   - the stage manifest is re-derived from the target tree (fresh shallow fetch), package-lock re-pinned;
#   - the SERIAL lane receipt (lane-<lane>: one cluster, one bootstrap, local stage order) must PASS every manifest stage,
#     record SKIP_ABSENT_AT_HEAD exactly for absent optional stages, and nothing else; lane total > 0;
#   - each per-stage fast-signal receipt (stage-<lane>-<stage>) must PASS with the same count as the lane;
#   - one binding (TREE, pkg-lock, client, exact migration set) across all receipts; every EXPECT_* pin checked (and listed).
# Verdicts: PASS (exit 0) only in FULL mode. PARTIAL mode never prints PASS: clean -> "PARTIAL" and exit 78. FAIL -> exit 1.
# Usage: aggregate.sh <harness checkout = run commit, fetch-depth 2> <artifacts dir> <out dir> <repo url>
# Env: NEEDS_JSON = ${{ toJSON(needs) }} (every needed job; each must be `success`; preflight and run must be present)
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd); . "$HERE/lanes.sh"
declare -A PT_EXPECT=(); PT_PARTIAL=""; PT_STAGES=""; TREE_T=""
HD=$1; A=$2; OUT=$3; URL=$4; mkdir -p "$OUT"; S=$OUT/SUMMARY.md; BAD=(); PINS=()
bad(){ BAD+=("$*"); }
field(){ grep -m1 "^$1=" "$2" 2>/dev/null | cut -d= -f2-; }
sr(){ grep -m1 "^STAGE_RESULT name=$1 " "$2" 2>/dev/null | grep -oE "(^| )$3=[^ ]+" | head -1 | sed 's/^ //' | cut -d= -f2-; }
# 1. upstream job conclusions
NR=$(jq -r 'to_entries[] | "\(.key)=\(.value.result)"' <<<"${NEEDS_JSON:-}" 2>/dev/null | paste -sd' ' -)
for j in preflight run; do grep -qE "(^| )$j=" <<<"$NR" || bad "needs.$j.result not provided"; done
for kv in $NR; do [ "${kv#*=}" = success ] || bad "job ${kv%%=*} result=${kv#*=} (must be success)"; done
# 2. PROOF_TARGET + binding
MODE=UNKNOWN; MAN=""; RUN_COMMIT=$(git -C "$HD" rev-parse HEAD 2>/dev/null)
if ERR=$(pt_parse "$HD/PROOF_TARGET" 2>&1 >/dev/null); then pt_parse "$HD/PROOF_TARGET"
  MODE=FULL; [ "$PT_PARTIAL" = 1 ] && MODE=PARTIAL
  ERR=$(run_binding "$HD" "$PT_HARNESS" 2>&1) || bad "run binding: $ERR"
  # 3. independent manifest from the target tree
  T=$(mktemp -d); git init -q "$T"; git -C "$T" remote add origin "$URL"
  if timeout 300 git -C "$T" fetch -q --depth=1 --no-tags origin "$PT_SHA" 2>/dev/null && [ "$(git -C "$T" rev-parse FETCH_HEAD)" = "$PT_SHA" ]; then
    PKG=$(git -C "$T" show "$PT_SHA:package-lock.json" 2>/dev/null | sha256sum | cut -c1-64); [ "$PKG" = "$PT_PKG" ] || bad "package-lock $PKG != $PT_PKG"
    TREE_T=$(git -C "$T" rev-parse "$PT_SHA^{tree}")
    MAN=$(manifest "$T" "$PT_SHA" "$PT_STAGES" 2>&1) || { bad "manifest: $MAN"; MAN=""; }
  else bad "target $PT_SHA not fetchable"; fi
else bad "PROOF_TARGET refused: $ERR"; PT_SHA=unknown; PT_HARNESS=unknown; fi
# 4-7. receipts
declare -A LTOT LPASS; BIND=""; ROWS=""
bindchk(){ local R=$1 who=$2 B
  B="$(field TREE "$R") $(field PKG_LOCK_SHA256 "$R") $(field CLIENT_INDEX_DTS_SHA256 "$R") $(field MIGRATIONS_AT_HEAD "$R") $(field LAST_MIGRATION_AT_HEAD "$R")"
  [ "$(field HEAD "$R")" = "$PT_SHA" ] || bad "$who: HEAD $(field HEAD "$R") != target"
  [ "$(field TREE "$R")" = "${TREE_T:-x}" ] || bad "$who: TREE != target tree"
  if [ -z "$BIND" ]; then BIND=$B; elif [ "$B" != "$BIND" ]; then bad "$who: binding differs ($B vs $BIND)"; fi
  if [ -n "$(sr bootstrap "$R" status)" ]; then [ "$(sr bootstrap "$R" status)" = PASS ] && [ "$(sr bootstrap "$R" exact_set)" = yes ] || bad "$who: bootstrap not PASS with exact migration set"; fi; }
for L in $LANES; do
  LM=$(awk -v l="$L" '$1==l' <<<"$MAN"); RUNS=$(awk '$3=="run"{print $2}' <<<"$LM")
  if [ -z "$RUNS" ]; then [ "$MODE" = FULL ] && bad "lane $L: no runnable stage (every lane must be nonempty)"; continue; fi
  R=$A/lane-$L/RESULT
  if [ ! -f "$R" ]; then bad "lane $L: serial lane RESULT missing"; continue; fi
  [ "$(field RC "$R")" = 0 ] && [ "$(field STAGE "$R")" = done ] || bad "lane $L: RC=$(field RC "$R") stage=$(field STAGE "$R")"
  WANT=ALL; [ "$MODE" = PARTIAL ] && WANT=$(paste -sd, - <<<"$RUNS")
  [ "$(field JOB_STAGES "$R")" = "$WANT" ] || bad "lane $L: JOB_STAGES=$(field JOB_STAGES "$R") != $WANT"
  bindchk "$R" "lane $L"
  # exact stage set in the lane receipt (bootstrap aside), in local table order
  GOT=$(grep '^STAGE_RESULT ' "$R" | grep -oE 'name=[^ ]+' | cut -d= -f2 | grep -vx bootstrap | paste -sd' ' -)
  EXPS=$(awk '{print $2}' <<<"$LM" | paste -sd' ' -); [ "$GOT" = "$EXPS" ] || bad "lane $L: stages in receipt [$GOT] != manifest [$EXPS]"
  LP=0; LT=0
  while read -r _ N ST; do
    if [ "$ST" = skip-absent ]; then [ "$(sr "$N" "$R" status)" = SKIP_ABSENT_AT_HEAD ] || bad "lane $L/$N: expected SKIP_ABSENT_AT_HEAD"; ROWS="$ROWS| $L | $N | SKIP_ABSENT_AT_HEAD | | | | |\n"; continue; fi
    P=$(sr "$N" "$R" passed); TT=$(sr "$N" "$R" total); SK=$(sr "$N" "$R" skipped); E=$(sr "$N" "$R" expected); SEC=$(sr "$N" "$R" secs)
    [ "$(sr "$N" "$R" status)" = PASS ] && [ "${SK:-x}" = 0 ] && [ -n "$TT" ] && [ "$TT" -gt 0 ] && [ "$P" = "$TT" ] || bad "lane $L/$N: status=$(sr "$N" "$R" status) passed=$P total=$TT skipped=$SK"
    X=${PT_EXPECT[EXPECT_$N]:-}; if [ -n "$X" ]; then PINS+=("EXPECT_$N=$X got $TT"); [ "$TT" = "$X" ] || bad "lane $L/$N: total=$TT != EXPECT_$N=$X"; fi
    # per-stage fast signal
    FR=$A/stage-$L-$N/RESULT; FS="missing"
    if [ -f "$FR" ]; then FT=$(sr "$N" "$FR" total); FS="$(sr "$N" "$FR" status) $(sr "$N" "$FR" passed)/$FT"
      [ "$(field RC "$FR")" = 0 ] && [ "$(sr "$N" "$FR" status)" = PASS ] && [ "$FT" = "$TT" ] || bad "stage $L/$N fast signal: $FS rc=$(field RC "$FR") (lane total $TT)"
      bindchk "$FR" "stage $L/$N"
    else bad "stage $L/$N: fast-signal RESULT missing"; fi
    LP=$((LP + ${P:-0})); LT=$((LT + ${TT:-0}))
    ROWS="$ROWS| $L | $N | $(sr "$N" "$R" status) | ${P:-?}/${TT:-?} | ${E:-?} | ${SK:-?} | $FS | ${SEC:-?} |\n"
  done <<<"$LM"
  [ "$LT" -gt 0 ] && [ "$LP" = "$LT" ] || bad "lane $L: TOTAL $LP/$LT (must be > 0 and all passed)"
  grep -q "^TOTAL passed=$LP failed=0 skipped=0 total=$LT$" "$R" || bad "lane $L: receipt TOTAL line != $LP/$LT"
  X=${PT_EXPECT[EXPECT_TOTAL_$L]:-}; if [ -n "$X" ]; then PINS+=("EXPECT_TOTAL_$L=$X got $LT"); [ "$LT" = "$X" ] || bad "lane $L: TOTAL $LT != EXPECT_TOTAL_$L=$X"; fi
  LTOT[$L]=$LT; LPASS[$L]=$LP; ROWS="$ROWS| **$L** | **TOTAL** | | **$LP/$LT** | | | | lane job $(field DURATION_S "$R") s |\n"
done
# every pin must have been checked
for k in "${!PT_EXPECT[@]}"; do printf '%s\n' "${PINS[@]}" | grep -q "^$k=" || bad "pin $k was not checked (stage/lane did not run)"; done
read -r TREE PKGB CLI MIGN LASTM <<<"${BIND:-none none none none none}"
if [ "${#BAD[@]}" -gt 0 ]; then V=FAIL; RC=1; elif [ "$MODE" = FULL ]; then V=PASS; RC=0; else V="PARTIAL (diagnostic subset; NOT a proof; aggregate exits 78 by design)"; RC=78; fi
{ echo "# proof-lanes summary — mode $MODE"
  echo; echo "- target HEAD: \`$PT_SHA\`  TREE: \`$TREE\`"; echo "- harness_sha: \`$PT_HARNESS\`  run commit: \`$RUN_COMMIT\`"
  echo "- package-lock sha256: \`$PKGB\`  client index.d.ts: \`$CLI\`"; echo "- migrations at HEAD: $MIGN (last \`$LASTM\`), exact applied set checked in every live job"
  echo "- jobs: ${NR:-none}"; echo "- run: ${GITHUB_SERVER_URL:-}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}"
  echo; echo "| lane | stage | serial lane status | passed/total | expected(static) | skipped | per-stage fast signal | jest s |"; echo "|---|---|---|---|---|---|---|---|"
  printf "%b" "$ROWS"
  echo; echo "Pins checked: ${#PINS[@]}"; for p in "${PINS[@]}"; do echo "- $p"; done
  echo; echo "**VERDICT: $V**"; for b in "${BAD[@]}"; do echo "- $b"; done
} >"$S"
cat "$S"; [ -n "${GITHUB_STEP_SUMMARY:-}" ] && cat "$S" >>"$GITHUB_STEP_SUMMARY"
exit $RC
