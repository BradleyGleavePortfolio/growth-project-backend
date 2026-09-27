#!/usr/bin/env bash
# GH-LANES preflight: parse PROOF_TARGET, prove the SHA exists on the remote, check package-lock and stage files at the
# target (shallow fetch; no PG, no npm), and emit the job matrix. Fail closed: any doubt -> non-zero before any PG job.
# Usage: preflight.sh <PROOF_TARGET file> <repo url> <out dir>
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd); . "$HERE/lanes.sh"
PT=$1; URL=$2; OUT=$3; mkdir -p "$OUT"; R=$OUT/PREFLIGHT
fail(){ echo "PREFLIGHT_FAIL $*" | tee -a "$R" >&2; exit 70; }
: >"$R"
[ -f "$PT" ] || fail "PROOF_TARGET missing"
SHA=$(sed -n 1p "$PT" | tr -d '\r' | sed 's/[[:space:]]*$//')
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || fail "line 1 of PROOF_TARGET is not a 40-hex lowercase commit id: '$SHA'"
kv(){ sed -n '2,$p' "$PT" | tr -d '\r' | grep -E "^$1=" | tail -1 | cut -d= -f2- || true; }
# Unknown keys are refused (typos must not silently weaken a proof).
while IFS= read -r l; do
  [ -z "$l" ] && continue; case "$l" in \#*) continue;; esac
  k=${l%%=*}; [[ "$l" == *=* ]] || fail "PROOF_TARGET line '$l' is not KEY=VALUE"
  case "$k" in STAGES|PKG_LOCK_SHA256|EXPECT_TOTAL_s11|EXPECT_TOTAL_s10b|EXPECT_*) ;; *) fail "unknown PROOF_TARGET key '$k'";; esac
done < <(sed -n '2,$p' "$PT" | tr -d '\r')
PKG_EXPECT=$(kv PKG_LOCK_SHA256); PKG_EXPECT=${PKG_EXPECT:-$DEFAULT_PKG_LOCK_SHA256}
[[ "$PKG_EXPECT" =~ ^[0-9a-f]{64}$ ]] || fail "PKG_LOCK_SHA256 not 64-hex"
REQ=$(kv STAGES | tr ',' ' ')
echo "TARGET=$SHA" >>"$R"; echo "STAGES_REQUESTED=${REQ:-all}" >>"$R"
# Shallow fetch of exactly the target commit: fails for an unknown/unreachable SHA.
T=$(mktemp -d); git init -q "$T"; git -C "$T" remote add origin "$URL"
timeout 300 git -C "$T" fetch -q --depth=1 --no-tags origin "$SHA" 2>>"$R" || fail "target $SHA not fetchable from $URL"
[ "$(git -C "$T" rev-parse FETCH_HEAD)" = "$SHA" ] && [ "$(git -C "$T" cat-file -t "$SHA")" = commit ] || fail "fetched object is not commit $SHA"
TREE=$(git -C "$T" rev-parse "$SHA^{tree}")
PKG=$(git -C "$T" show "$SHA:package-lock.json" 2>/dev/null | sha256sum | cut -c1-64)
git -C "$T" cat-file -e "$SHA:package-lock.json" 2>/dev/null || fail "no package-lock.json at target"
[ "$PKG" = "$PKG_EXPECT" ] || fail "package-lock.json sha256 $PKG != expected $PKG_EXPECT"
MIG_N=$(git -C "$T" ls-tree -d --name-only "$SHA:prisma/migrations" | grep -c . || true)
LAST_MIG=$(git -C "$T" ls-tree -d --name-only "$SHA:prisma/migrations" | LC_ALL=C sort | tail -1)
{ echo "TREE=$TREE"; echo "PKG_LOCK_SHA256=$PKG"; echo "MIGRATIONS_AT_HEAD=$MIG_N"; echo "LAST_MIGRATION_AT_HEAD=$LAST_MIG"; } >>"$R"
ALL=""; for L in $LANES; do lane_load "$L"; for s in "${STAGE_TABLE[@]}"; do ALL="$ALL ${s%%|*}"; done; done
for n in $REQ; do [ "$n" = bootstrap ] && continue; case " $ALL " in *" $n "*) ;; *) fail "unknown stage '$n' (known:$ALL)";; esac; done
INC=""; SKIPS=""
for L in $LANES; do lane_load "$L"
  for s in "${STAGE_TABLE[@]}"; do IFS='|' read -r NAME _ _ FILES _ RQ <<<"$s"
    if [ -n "$REQ" ]; then case " $REQ " in *" $NAME "*) ;; *) continue;; esac; fi
    MISSING=""; for f in $FILES; do git -C "$T" cat-file -e "$SHA:$f" 2>/dev/null || MISSING="$MISSING $f"; done
    if [ -n "$MISSING" ]; then
      if [ "$RQ" = opt ] && [ -z "$REQ" ]; then SKIPS="$SKIPS $L/$NAME"; echo "STAGE_RESULT lane=$L name=$NAME status=SKIP_ABSENT_AT_HEAD files=[$FILES]" >>"$R"; continue; fi
      fail "stage $L/$NAME spec files absent at target:$MISSING"
    fi
    INC="$INC${INC:+,}{\"lane\":\"$L\",\"stage\":\"$NAME\"}"
  done
done
[ -n "$INC" ] || fail "no stages selected"
echo "PREFLIGHT_OK" >>"$R"; cat "$R"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  { echo "sha=$SHA"; echo "pkg_lock=$PKG"; echo "matrix={\"include\":[$INC]}"; echo "skips=${SKIPS# }"; } >>"$GITHUB_OUTPUT"
fi
