# shellcheck shell=bash
# GH-LANES lane definitions. Ported verbatim from the qualified local runners
# (tgp-private-evidence execution/42d8c5b5/proof/lane-s11.sh e9470a92..., lane-s10b.sh ec15b4d0...).
# Do not re-invent stage definitions here: any change must be made in the local runners first.
# Table row: name|jest config|timeout s|spec files (space-separated)|kind (live|guard)|required (req|opt)
lane_load() {
  case "$1" in
    s11)
      LANE_NAME=s11
      LANE_ENV=G2_S11
      DB_TS=test/utils/g2-s11-db.ts
      BOOT_SH=test/utils/g2-s11-bootstrap.sh
      CONN_LIMIT=2
      FIXPASS=s11_local_synthetic
      STAGE_TABLE=(
        "rls-g2-s11|jest.rls.config.js|1500|test/rls-g2-s11.spec.ts|live|req"
        "journey-core|jest.config.js|1500|test/scout/s11/journey-core.pg.spec.ts|live|req"
        "readiness|jest.config.js|900|test/scout/s11/readiness.pg.spec.ts|live|req"
        "settle-redrive|jest.config.js|3000|test/scout/s11/settle-redrive.pg.spec.ts|live|req"
        "journey-induction|jest.config.js|3000|test/scout/s11/journey-induction.pg.spec.ts|live|req"
        "journey-full|jest.config.js|4200|test/scout/s11/journey-full.pg.spec.ts|live|opt"
        "guard|jest.config.js|300|test/utils/g2-s11-db-guard.spec.ts|guard|req"
      )
      NEED_RG_FOR="journey-full"
      ;;
    s10b)
      LANE_NAME=s10b
      LANE_ENV=G2_S10B
      DB_TS=test/utils/g2-s10b-db.ts
      BOOT_SH=test/utils/g2-s10b-bootstrap.sh
      CONN_LIMIT=4
      FIXPASS=s10b_local_synthetic
      STAGE_TABLE=(
        "rls-s10b-s10c|jest.rls.config.js|1500|test/rls-g2-s10b.spec.ts test/rls-g2-s10c.spec.ts|live|req"
        "s10-unseen|jest.config.js|1500|test/scout/s10/s10-unseen.pg.spec.ts|live|req"
      )
      NEED_RG_FOR=""
      ;;
    *) return 1 ;;
  esac
}
LANES="s11 s10b"
# Accepted dependency tree (donor x42 / local runners); a target whose package-lock differs is REFUSED
# unless PROOF_TARGET pins another PKG_LOCK_SHA256 explicitly.
DEFAULT_PKG_LOCK_SHA256=b7fed5ed611c004615022cf69375b83956e9a69604807123fbe0e7965aea9c55
# PG 17.6 server: the same zonky artifact and pins as runtime/rt-setup-42d8c5b5.sh.
PG_JAR_URL=https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-linux-amd64/17.6.0/embedded-postgres-binaries-linux-amd64-17.6.0.jar
PG_JAR_SHA256=23da5a044b4fb7a5a081a45008c95749c873305328d73f86aefd56922ce1d29d
PG_TXZ_SHA256=26fa633461a3340913015503d0783d73a28384110257e2f17d9936bdf8b067c0
PG_POSTGRES_SHA256=23cd174849b273064c47d581b55be596be2f5cf0ee5d3e76c0146e2464bf873a
PG_INITDB_SHA256=b7db9bc2463a4ffbe1e405977512afb50c9846fd3af2b694e315e6d5a270882a
PG_PGCTL_SHA256=af53d826845af4679a0aaba2bda319f5e527f3b94f3794c67fa174049c9b9401

# ---- shared PROOF_TARGET parser (preflight AND aggregate use this; fail closed on anything unexpected) ----
# Format: line 1 = 40-hex target; then KEY=VALUE lines (blank / # comments allowed). Exact key allowlist:
#   HARNESS_SHA=<40hex> (required; the run commit's parent must be exactly this)
#   PKG_LOCK_SHA256=<64hex>   STAGES=<comma list of known stage names>   PARTIAL=1 (required iff STAGES is set)
#   EXPECT_TOTAL_<lane>=<decimal>   EXPECT_<stage>=<decimal>   (lane/stage names from the tables above, exactly)
# Duplicate keys are refused. Sets PT_SHA PT_HARNESS PT_PKG PT_STAGES PT_PARTIAL and assoc PT_EXPECT[key]=value.
all_stage_names(){ local L s out=""; for L in $LANES; do lane_load "$L"; for s in "${STAGE_TABLE[@]}"; do out="$out ${s%%|*}"; done; done; echo "${out# }"; }
stage_lane(){ local L s; for L in $LANES; do lane_load "$L"; for s in "${STAGE_TABLE[@]}"; do [ "${s%%|*}" = "$1" ] && { echo "$L"; return 0; }; done; done; return 1; }
pt_parse(){ # <file>; echo reason on stderr and return 1 on refusal
  local f=$1 l k v n=0 ALLN; declare -gA PT_EXPECT=(); PT_SHA=""; PT_HARNESS=""; PT_PKG=""; PT_STAGES=""; PT_PARTIAL=""
  local -A seen=()
  [ -f "$f" ] || { echo "PROOF_TARGET missing" >&2; return 1; }
  ALLN=" $(all_stage_names) "
  while IFS= read -r l || [ -n "$l" ]; do l=${l%$'\r'}; n=$((n + 1))
    if [ $n = 1 ]; then l=${l%%[[:space:]]}; [[ "$l" =~ ^[0-9a-f]{40}$ ]] || { echo "line 1 is not a 40-hex lowercase commit id: '$l'" >&2; return 1; }; PT_SHA=$l; continue; fi
    [ -z "$l" ] && continue; case "$l" in \#*) continue;; esac
    [[ "$l" =~ ^([A-Za-z0-9_-]+)=(.*)$ ]] || { echo "line $n '$l' is not KEY=VALUE" >&2; return 1; }
    k=${BASH_REMATCH[1]}; v=${BASH_REMATCH[2]}
    [ -z "${seen[$k]:-}" ] || { echo "duplicate key $k" >&2; return 1; }; seen[$k]=1
    case "$k" in
      HARNESS_SHA) [[ "$v" =~ ^[0-9a-f]{40}$ ]] || { echo "HARNESS_SHA not 40-hex" >&2; return 1; }; PT_HARNESS=$v;;
      PKG_LOCK_SHA256) [[ "$v" =~ ^[0-9a-f]{64}$ ]] || { echo "PKG_LOCK_SHA256 not 64-hex" >&2; return 1; }; PT_PKG=$v;;
      PARTIAL) [ "$v" = 1 ] || { echo "PARTIAL must be exactly 1" >&2; return 1; }; PT_PARTIAL=1;;
      STAGES) [[ "$v" =~ ^[a-z0-9-]+(,[a-z0-9-]+)*$ ]] || { echo "STAGES malformed" >&2; return 1; }
        for s in ${v//,/ }; do case "$ALLN" in *" $s "*) ;; *) echo "unknown stage '$s' in STAGES" >&2; return 1;; esac; done; PT_STAGES=${v//,/ };;
      EXPECT_TOTAL_*) case " $LANES " in *" ${k#EXPECT_TOTAL_} "*) ;; *) echo "unknown lane in $k (lanes: $LANES)" >&2; return 1;; esac
        [[ "$v" =~ ^[0-9]+$ ]] || { echo "$k value '$v' is not a nonnegative decimal" >&2; return 1; }; PT_EXPECT[$k]=$((10#$v));;
      EXPECT_*) case "$ALLN" in *" ${k#EXPECT_} "*) ;; *) echo "unknown stage in $k (stages:$ALLN)" >&2; return 1;; esac
        [[ "$v" =~ ^[0-9]+$ ]] || { echo "$k value '$v' is not a nonnegative decimal" >&2; return 1; }; PT_EXPECT[$k]=$((10#$v));;
      *) echo "unknown PROOF_TARGET key '$k'" >&2; return 1;;
    esac
  done <"$f"
  [ -n "$PT_SHA" ] || { echo "empty PROOF_TARGET" >&2; return 1; }
  [ -n "$PT_HARNESS" ] || { echo "HARNESS_SHA is required" >&2; return 1; }
  if [ -n "$PT_STAGES" ] && [ "$PT_PARTIAL" != 1 ]; then echo "STAGES subset requires PARTIAL=1 (authoritative runs use the full manifest)" >&2; return 1; fi
  if [ "$PT_PARTIAL" = 1 ] && [ -z "$PT_STAGES" ]; then echo "PARTIAL=1 requires STAGES" >&2; return 1; fi
  PT_PKG=${PT_PKG:-$DEFAULT_PKG_LOCK_SHA256}; return 0; }
# ---- manifest derived from the target tree: prints "<lane> <stage> run|skip-absent", fails if a required spec is absent.
# In PARTIAL mode ($2 = stage list) only the listed stages are emitted, and each must be present.
manifest(){ # <git dir holding the target commit> <sha> [partial stage list]
  local G=$1 SHA=$2 SUB=${3:-} L s NAME FILES RQ f miss
  for L in $LANES; do lane_load "$L"
    for s in "${STAGE_TABLE[@]}"; do IFS='|' read -r NAME _ _ FILES _ RQ <<<"$s"
      if [ -n "$SUB" ]; then case " $SUB " in *" $NAME "*) ;; *) continue;; esac; fi
      miss=""; for f in $FILES; do git -C "$G" cat-file -e "$SHA:$f" 2>/dev/null || miss="$miss $f"; done
      if [ -z "$miss" ]; then echo "$L $NAME run"
      elif [ "$RQ" = opt ] && [ -z "$SUB" ]; then echo "$L $NAME skip-absent"
      else echo "required spec absent for $L/$NAME:$miss" >&2; return 1; fi
    done
  done; }
# ---- run-commit binding: HEAD has exactly one parent == HARNESS_SHA and differs from it only by PROOF_TARGET.
run_binding(){ # <run-commit checkout (fetch-depth >= 2)> <HARNESS_SHA>
  local D=$1 H=$2 P N
  P=$(git -C "$D" rev-list --parents -n1 HEAD 2>/dev/null) || { echo "cannot read run commit parents" >&2; return 1; }
  N=$(wc -w <<<"$P"); [ "$N" = 2 ] || { echo "run commit must have exactly one parent (has $((N - 1)))" >&2; return 1; }
  [ "${P#* }" = "$H" ] || { echo "run commit parent ${P#* } != HARNESS_SHA $H" >&2; return 1; }
  [ "$(git -C "$D" diff --name-only HEAD^ HEAD)" = PROOF_TARGET ] || { echo "run commit changes more than PROOF_TARGET: $(git -C "$D" diff --name-only HEAD^ HEAD | tr '\n' ' ')" >&2; return 1; }
  [ "$(git -C "$D" diff --name-only HEAD)" = "" ] && [ -z "$(git -C "$D" status --porcelain --untracked-files=no)" ] || { echo "harness checkout is not clean at the run commit" >&2; return 1; }
  return 0; }
