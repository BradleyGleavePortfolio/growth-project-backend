#!/usr/bin/env bash
# GH-LANES preflight (no PG, no npm): parse PROOF_TARGET (exact allowlist), verify the run commit is bound to HARNESS_SHA,
# shallow-fetch the exact target, pin package-lock, derive the stage manifest from the target tree, validate every EXPECT_*
# against it, and emit the job matrix. Fail closed: any doubt -> exit 70 before any PG job.
# Usage: preflight.sh <harness checkout = run commit, fetch-depth 2> <repo url> <out dir>
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd); . "$HERE/lanes.sh"
HD=$1; URL=$2; OUT=$3; mkdir -p "$OUT"; R=$OUT/PREFLIGHT; : >"$R"
fail(){ echo "PREFLIGHT_FAIL $*" | tee -a "$R" >&2; exit 70; }
ERR=$(pt_parse "$HD/PROOF_TARGET" 2>&1 >/dev/null) || fail "PROOF_TARGET refused: $ERR"
pt_parse "$HD/PROOF_TARGET"
ERR=$(run_binding "$HD" "$PT_HARNESS" 2>&1) || fail "run binding refused: $ERR"
MODE=FULL; [ "$PT_PARTIAL" = 1 ] && MODE=PARTIAL
{ echo "TARGET=$PT_SHA"; echo "HARNESS_SHA=$PT_HARNESS"; echo "RUN_COMMIT=$(git -C "$HD" rev-parse HEAD)"; echo "MODE=$MODE"; echo "STAGES_REQUESTED=${PT_STAGES:-all}"; } >>"$R"
T=$(mktemp -d); git init -q "$T"; git -C "$T" remote add origin "$URL"
timeout 300 git -C "$T" fetch -q --depth=1 --no-tags origin "$PT_SHA" 2>>"$R" || fail "target $PT_SHA not fetchable from $URL"
[ "$(git -C "$T" rev-parse FETCH_HEAD)" = "$PT_SHA" ] && [ "$(git -C "$T" cat-file -t "$PT_SHA")" = commit ] || fail "fetched object is not commit $PT_SHA"
git -C "$T" cat-file -e "$PT_SHA:package-lock.json" 2>/dev/null || fail "no package-lock.json at target"
PKG=$(git -C "$T" show "$PT_SHA:package-lock.json" | sha256sum | cut -c1-64)
[ "$PKG" = "$PT_PKG" ] || fail "package-lock.json sha256 $PKG != expected $PT_PKG"
MIGS=$(git -C "$T" ls-tree -d --name-only "$PT_SHA:prisma/migrations" | LC_ALL=C sort)
{ echo "TREE=$(git -C "$T" rev-parse "$PT_SHA^{tree}")"; echo "PKG_LOCK_SHA256=$PKG"; echo "MIGRATIONS_AT_HEAD=$(grep -c . <<<"$MIGS")"; echo "LAST_MIGRATION_AT_HEAD=$(tail -1 <<<"$MIGS")"; } >>"$R"
MAN=$(manifest "$T" "$PT_SHA" "$PT_STAGES" 2>&1) || fail "manifest: $MAN"
while read -r L N S; do echo "MANIFEST lane=$L stage=$N status=$S" >>"$R"; done <<<"$MAN"
# every lane nonempty in FULL mode; every EXPECT_* names something that will actually run
if [ "$MODE" = FULL ]; then for L in $LANES; do grep -q "^$L [^ ]* run$" <<<"$MAN" || fail "lane $L has no runnable stage at target"; done; fi
for k in "${!PT_EXPECT[@]}"; do
  case "$k" in
    EXPECT_TOTAL_*) grep -q "^${k#EXPECT_TOTAL_} [^ ]* run$" <<<"$MAN" || fail "$k pins lane ${k#EXPECT_TOTAL_}, which runs no stage in this run";;
    EXPECT_*) grep -q "^[^ ]* ${k#EXPECT_} run$" <<<"$MAN" || fail "$k pins stage ${k#EXPECT_}, which is absent at target or not selected";;
  esac
  echo "PIN $k=${PT_EXPECT[$k]}" >>"$R"
done
INC=""
for L in $LANES; do
  RUNS=$(awk -v l="$L" '$1==l && $3=="run"{print $2}' <<<"$MAN" | paste -sd, -)
  [ -z "$RUNS" ] && continue
  [ "$MODE" = FULL ] && LS=ALL || LS=$RUNS
  INC="$INC${INC:+,}{\"kind\":\"lane\",\"lane\":\"$L\",\"stages\":\"$LS\"}"
  for N in ${RUNS//,/ }; do INC="$INC,{\"kind\":\"stage\",\"lane\":\"$L\",\"stages\":\"$N\"}"; done
done
[ -n "$INC" ] || fail "no stages selected"
echo "PREFLIGHT_OK" >>"$R"; cat "$R"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  { echo "sha=$PT_SHA"; echo "pkg_lock=$PKG"; echo "mode=$MODE"; echo "matrix={\"include\":[$INC]}"; } >>"$GITHUB_OUTPUT"
fi
