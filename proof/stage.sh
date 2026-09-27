#!/usr/bin/env bash
# GH-LANES stage runner: ONE stage of one lane on a GitHub-hosted runner, against a target checked out by
# setup-runner.sh target and installed by `npm ci`. Port of the common body of the qualified local runners
# (execution/42d8c5b5/proof/lane-s11.sh / lane-s10b.sh) with sandbox paths parameterised. Differences, all deliberate:
#   - no canonical lock / runtime sentinel / donor copy (a hosted runner is private to this job);
#   - node_modules come from `npm ci` of the target's own package-lock (its sha256 is pinned by preflight and re-checked here);
#   - one stage per job: a live stage gets its own fresh cluster + bootstrap; guard needs no PG;
#   - the PG 17.6 dist is the same zonky artifact (pins in lanes.sh); psql client is PGDG 18.
# Pass rules are unchanged: rc 0, 0 failed/skipped/todo, passed==total, suites all passed == file count, a PASS line per file,
# total == static `it(` count at HEAD (>= when it.each/test.each/test( is used). Any skipped test = FAIL.
# Usage: stage.sh <lane> <stage> <HEAD_SHA> <target dir> <RUN_DIR (must not exist)>
# Env: PG_DIST (dir with bin/ lib/), LANE_PSQL (psql path), PKG_LOCK_EXPECT (64-hex).
# RC: 0 ok | 64 usage | 70 precondition/refused | 71 deps | 72 jest count/skip or pg init | 73 identity | 74 teardown/post | other = stage rc.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd); . "$HERE/lanes.sh"
[ $# = 5 ] || { echo "usage: stage.sh <lane> <stage> <HEAD_SHA> <target dir> <RUN_DIR>" >&2; exit 64; }
LANE=$1; STAGE=$2; HEAD_SHA=$3; W=${4%/}; RUN_DIR=${5%/}
lane_load "$LANE" || { echo "unknown lane $LANE" >&2; exit 64; }
[[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "bad HEAD_SHA" >&2; exit 64; }
mkdir -p "$(dirname "$RUN_DIR")"; mkdir "$RUN_DIR" || { echo "RUN_DIR exists" >&2; exit 76; }
for v in $(compgen -e | grep -E '^G2_'); do unset "$v"; done
export GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 GIT_LFS_SKIP_SMUDGE=1 NODE_OPTIONS=--max-old-space-size=3072 \
       CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1 PRISMA_GENERATE_SKIP_AUTOINSTALL=1 npm_config_offline=true \
       npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
DIST=${PG_DIST:?PG_DIST}; PSQL=${LANE_PSQL:-/usr/lib/postgresql/18/bin/psql}; PKG_EXPECT=${PKG_LOCK_EXPECT:-$DEFAULT_PKG_LOCK_SHA256}
SCR=${RUNNER_TEMP:-/tmp}/lane-$LANE-$STAGE-$$; mkdir -p "$SCR"
PORT_LO=55650; PORT_HI=55699
LOG=$RUN_DIR/runner.log
ts(){ date -u +%FT%TZ; }; now(){ date +%s; }
log(){ echo "$(ts) $*" | tee -a "$LOG"; }
sha(){ sha256sum "$1" 2>/dev/null | cut -c1-64; }
HARNESS_SHA=$(git -C "$HERE" rev-parse HEAD 2>/dev/null || echo none); STAGE_SH_SHA=$(sha "${BASH_SOURCE[0]}"); LANES_SHA=$(sha "$HERE/lanes.sh")
T0=$(now); START_TS=$(ts)
CUR_STAGE=preflight; FINAL_RC=""; CHILD=""; PGDATA=""; PORT=none; TREE=none; PKG_LOCK=none; SEL=""
MIG_N=none; LAST_MIG=none; MIG_APPLIED=none; CLIENT_SHA=none; TEARDOWN=none; RES=(); SUM_P=0; SUM_F=0; SUM_S=0; SUM_T=0
die(){ FINAL_RC=$1; shift; log "FAIL stage=$CUR_STAGE rc=$FINAL_RC $*"; exit "$FINAL_RC"; }
run_bounded(){ local secs=$1 lf=$2 cwd=$3; shift 3
  ( cd "$cwd" && exec setsid timeout -k 30 "$secs" "$@" ) >>"$lf" 2>&1 </dev/null &
  CHILD=$!; wait "$CHILD"; local rc=$?; CHILD=""; return $rc; }
pm_pid(){ [ -n "$PGDATA" ] && head -1 "$PGDATA/postmaster.pid" 2>/dev/null; }
pm_alive(){ local p; p=$(pm_pid) || return 1; [ -n "$p" ] && kill -0 "$p" 2>/dev/null && grep -qF -- "$PGDATA" <<<"$(tr '\0' ' ' </proc/"$p"/cmdline 2>/dev/null)"; }
listeners(){ local s; s=$(ss -ltn 2>/dev/null || true); grep -cE "[:.]$1 " <<<"$s" || true; }
teardown_all(){ local bad=0 p
  if pm_alive; then
    run_bounded 75 "$RUN_DIR/pg_ctl.log" / env LD_LIBRARY_PATH="$DIST/lib" "$DIST/bin/pg_ctl" -D "$PGDATA" -m fast -w -t 45 stop
    pm_alive && run_bounded 60 "$RUN_DIR/pg_ctl.log" / env LD_LIBRARY_PATH="$DIST/lib" "$DIST/bin/pg_ctl" -D "$PGDATA" -m immediate -w -t 30 stop
    if pm_alive; then p=$(pm_pid); log "TEARDOWN postmaster $p survived fast+immediate stop; SIGKILL"; kill -KILL "$p" 2>/dev/null; sleep 3; fi
  fi
  pm_alive && bad=1
  [ -f "$SCR/pg.log" ] && cp -p "$SCR/pg.log" "$RUN_DIR/pg.log" 2>/dev/null
  local pl=0; [ "$PORT" != none ] && pl=$(listeners "$PORT"); [ "$pl" = 0 ] || bad=1
  TEARDOWN="postmaster_alive=$(pm_alive && echo yes || echo no) port_listeners=$pl"
  log "TEARDOWN $TEARDOWN bad=$bad"; return $bad; }
write_result(){ local rc=$1 T1; T1=$(now)
  { echo "RC=$rc"; echo "STAGE=$CUR_STAGE"; echo "LANE=$LANE_NAME"; echo "JOB_STAGE=$STAGE"; echo "HEAD=$HEAD_SHA"; echo "TREE=$TREE"
    echo "PKG_LOCK_SHA256=$PKG_LOCK"; echo "PKG_LOCK_EXPECTED=$PKG_EXPECT"; echo "MIGRATIONS_AT_HEAD=$MIG_N"; echo "LAST_MIGRATION_AT_HEAD=$LAST_MIG"
    echo "MIGRATIONS_APPLIED=$MIG_APPLIED"; echo "CLIENT_INDEX_DTS_SHA256=$CLIENT_SHA"; echo "HARNESS_COMMIT=$HARNESS_SHA"
    echo "STAGE_SH_SHA256=$STAGE_SH_SHA"; echo "LANES_SH_SHA256=$LANES_SHA"; echo "PORT=$PORT"
    echo "RUNNER=${RUNNER_NAME:-local} ${ImageOS:-} ${ImageVersion:-} nproc=$(nproc) node=$(node --version 2>/dev/null) pg=$(LD_LIBRARY_PATH="$DIST/lib" "$DIST/bin/postgres" --version 2>/dev/null | awk '{print $3}') psql=$("$PSQL" --version 2>/dev/null | awk '{print $3}')"
    echo "GH_RUN=${GITHUB_SERVER_URL:-}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-} attempt=${GITHUB_RUN_ATTEMPT:-}"
    for l in "${RES[@]}"; do echo "$l"; done
    echo "TOTAL passed=$SUM_P failed=$SUM_F skipped=$SUM_S total=$SUM_T"
    echo "START=$START_TS"; echo "END=$(ts)"; echo "DURATION_S=$((T1 - T0))"; echo "TEARDOWN=$TEARDOWN"; } >"$RUN_DIR/RESULT"; }
finish(){ local rc=$?; trap - EXIT TERM INT HUP
  [ -n "$FINAL_RC" ] && rc=$FINAL_RC
  if ! teardown_all; then [ "$rc" = 0 ] && { rc=74; CUR_STAGE=teardown; }; fi
  log "END rc=$rc stage=$CUR_STAGE"; write_result "$rc"
  ( cd "$RUN_DIR" && sha256sum $(ls -A | grep -vx RECEIPTS.sha256) >RECEIPTS.sha256 2>/dev/null )
  cat "$RUN_DIR/RESULT"; exit "$rc"; }
on_signal(){ log "SIGNAL $1 during stage=$CUR_STAGE"
  if [ -n "$CHILD" ]; then kill -TERM -- "-$CHILD" 2>/dev/null; sleep 5; kill -KILL -- "-$CHILD" 2>/dev/null; fi
  RES+=("STAGE_RESULT name=$CUR_STAGE status=ABORTED_BY_SIGNAL_$1 rc=124"); FINAL_RC=124; exit 124; }
trap finish EXIT; trap 'on_signal TERM' TERM; trap 'on_signal INT' INT; trap 'on_signal HUP' HUP
log "START lane=$LANE_NAME stage=$STAGE head=$HEAD_SHA target=$W harness=$HARNESS_SHA stage_sh=$STAGE_SH_SHA"
# ---- select: the job's stage (+ bootstrap if live)
ROW=""; for s in "${STAGE_TABLE[@]}"; do [ "${s%%|*}" = "$STAGE" ] && ROW=$s; done
[ -n "$ROW" ] || die 64 "unknown stage '$STAGE' for lane $LANE_NAME"
IFS='|' read -r _ _ _ _ SKIND _ <<<"$ROW"
NEED_PG=0; [ "$SKIND" = live ] && NEED_PG=1
SEL=" $STAGE "; [ "$NEED_PG" = 1 ] && SEL=" bootstrap$SEL"
# ---- tools
CUR_STAGE=tools
NODEV=$(node --version 2>/dev/null); grep -q '^v20\.' <<<"$NODEV" || die 70 "node major != 20 ($NODEV)"
if [ "$NEED_PG" = 1 ]; then
  [ -x "$PSQL" ] || die 70 "no psql client at $PSQL"
  "$PSQL" --version | grep -qE '\(PostgreSQL\) 1[7-9]\.' || die 70 "psql major < 17"
  PGV=$(LD_LIBRARY_PATH="$DIST/lib" "$DIST/bin/postgres" --version 2>/dev/null); [ "${PGV##* }" = 17.6 ] || die 70 "server not 17.6 ($PGV)"
  P=$(pgrep -cx postgres || true); [ "$P" = 0 ] || die 70 "postgres processes already running ($P); lanes never share a server"
fi
log "TOOLS node=$NODEV pg='${PGV:-n/a}' psql=$PSQL nproc=$(nproc) mem=$(free -g | awk '/Mem/{print $2}')G"
# ---- target checkout (fetched by setup-runner.sh target) + npm ci output
CUR_STAGE=clone
[ "$(git -C "$W" rev-parse HEAD 2>/dev/null)" = "$HEAD_SHA" ] || die 71 "target dir not at HEAD"
[ -z "$(git -C "$W" status --porcelain --untracked-files=all)" ] || die 71 "target not clean at HEAD"
TREE=$(git -C "$W" rev-parse 'HEAD^{tree}'); PKG_LOCK=$(sha "$W/package-lock.json")
MIGS=$(find "$W/prisma/migrations" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | LC_ALL=C sort); MIG_N=$(grep -c . <<<"$MIGS"); LAST_MIG=$(tail -1 <<<"$MIGS")
log "CLONE_OK head=$HEAD_SHA tree=$TREE pkg_lock=$PKG_LOCK migrations=$MIG_N last=$LAST_MIG"
[ "$PKG_LOCK" = "$PKG_EXPECT" ] || die 70 "REFUSED: package-lock.json at HEAD ($PKG_LOCK) != expected ($PKG_EXPECT)"
CUR_STAGE=node_modules
[ -d "$W/node_modules/prisma" ] && [ ! -L "$W/node_modules" ] || die 71 "target node_modules absent (npm ci must run first)"
[ -f "$W/node_modules/.package-lock.json" ] || die 71 "no node_modules/.package-lock.json (not an npm ci tree)"
CUR_STAGE=prisma_generate
run_bounded 600 "$RUN_DIR/prisma-generate.log" "$W" ./node_modules/.bin/prisma generate --schema prisma/schema.prisma || die 71 "prisma generate failed"
CLIENT_SHA=$(sha "$W/node_modules/.prisma/client/index.d.ts"); [ -n "$CLIENT_SHA" ] || die 71 "no generated client"
[ -z "$(git -C "$W" status --porcelain --untracked-files=all)" ] || die 71 "target dirty after npm ci/generate"
log "DEPS_OK client_index_dts=$CLIENT_SHA jest=$(cd "$W" && ./node_modules/.bin/jest --version 2>/dev/null) prisma=$(cd "$W" && ./node_modules/.bin/prisma --version 2>/dev/null | awk '/^prisma /{print $3}')"
# ---- fresh cluster + bootstrap + identity (verbatim from the local common body, paths parameterised)
if [ "$NEED_PG" = 1 ]; then
  CUR_STAGE=pg-init
  DBTXT=$(cat "$W/$DB_TS" 2>/dev/null) && BOOTTXT=$(cat "$W/$BOOT_SH" 2>/dev/null) || die 70 "lane harness files absent at HEAD ($DB_TS, $BOOT_SH)"
  DBNAME=$(grep -oP "export const ${LANE_ENV}_DATABASE = '\K[^']+" <<<"$DBTXT" | head -1)
  ADMIN=$(grep -oP "export const ${LANE_ENV}_ROLE = '\K[^']+" <<<"$DBTXT" | head -1)
  MARKER=$(grep -oP "export const ${LANE_ENV}_CLUSTER_MARKER = '\K[^']+" <<<"$DBTXT" | head -1)
  BMARKER=$(grep -m1 '^CLUSTER_MARKER=' <<<"$BOOTTXT" | cut -d= -f2-); DB_MARKER=$(grep -m1 '^DB_MARKER=' <<<"$BOOTTXT" | cut -d= -f2-)
  [ -n "$DBNAME" ] && [ -n "$ADMIN" ] && [ -n "$MARKER" ] && [ "$MARKER" = "$BMARKER" ] && [ -n "$DB_MARKER" ] || die 70 "lane literals unreadable/inconsistent at HEAD (db=$DBNAME role=$ADMIN marker=$MARKER/$BMARKER)"
  for p in $(seq "$PORT_LO" "$PORT_HI"); do grep -qE "^ +'$p',\$" <<<"$DBTXT" && continue; [ "$(listeners "$p")" = 0 ] || continue; PORT=$p; break; done
  [ "$PORT" != none ] || die 70 "no free port in $PORT_LO-$PORT_HI"
  PGDATA=$SCR/pg-data; SOCK=$SCR/s; mkdir -p "$SOCK"; PWF=$SCR/pw; echo "$FIXPASS" >"$PWF"
  run_bounded 120 "$RUN_DIR/initdb.log" "$SCR" env LD_LIBRARY_PATH="$DIST/lib" "$DIST/bin/initdb" -D "$PGDATA" -U "$ADMIN" -A scram-sha-256 --pwfile="$PWF" -E UTF8 --locale=C.UTF-8 || die 72 "initdb failed"
  rm -f "$PWF"
  cat >>"$PGDATA/postgresql.conf" <<CONF
# --- 42d8c5b5 GH proof lane $LANE_NAME/$STAGE (disposable; same settings as the local 2 vCPU lane) ---
cluster_name = '$MARKER'
port = $PORT
listen_addresses = '127.0.0.1'
unix_socket_directories = '$SOCK'
shared_buffers = 128MB
work_mem = 8MB
maintenance_work_mem = 64MB
max_connections = 40
fsync = off
synchronous_commit = off
full_page_writes = off
log_min_messages = warning
log_lock_waits = on
deadlock_timeout = 500ms
CONF
  CUR_STAGE=pg-start
  run_bounded 90 "$RUN_DIR/pg_ctl.log" "$SCR" env LD_LIBRARY_PATH="$DIST/lib" "$DIST/bin/pg_ctl" -D "$PGDATA" -l "$SCR/pg.log" -w -t 60 start || die 72 "pg_ctl start failed"
  pm_alive || die 72 "postmaster not alive after start"
  log "PG_UP port=$PORT pid=$(pm_pid) data=$PGDATA marker=$MARKER db=$DBNAME role=$ADMIN"
  export "${LANE_ENV}_DATABASE_URL=postgresql://$ADMIN@127.0.0.1:$PORT/$DBNAME?schema=public&connection_limit=$CONN_LIMIT" \
         "${LANE_ENV}_CONFIRM=$DBNAME:$PORT" "${LANE_ENV}_PASSWORD=$FIXPASS" "${LANE_ENV}_PSQL=$PSQL" \
         "${LANE_ENV}_DATA_DIRECTORY=$PGDATA" "${LANE_ENV}_SERVER_VERSION=170006" "${LANE_ENV}_CANDIDATE_HEAD=$HEAD_SHA"
  CUR_STAGE=bootstrap; TB=$(now)
  run_bounded 900 "$RUN_DIR/bootstrap.log" "$W" bash "$BOOT_SH" bootstrap; rc=$?
  BL=$(cat "$RUN_DIR/bootstrap.log")
  if [ $rc != 0 ]; then RES+=("STAGE_RESULT name=bootstrap status=FAIL rc=$rc secs=$(( $(now) - TB ))"); tail -40 "$RUN_DIR/bootstrap.log"; die "$rc" "bootstrap rc=$rc"; fi
  grep -q "^${LANE_ENV}_BOOTSTRAP_OK" <<<"$BL" && grep -q "^CANDIDATE_HEAD=$HEAD_SHA" <<<"$BL" && grep -q "^CANDIDATE_CLIENT_VERIFIED dir=$W/node_modules/.prisma/client " <<<"$BL" \
    || { RES+=("STAGE_RESULT name=bootstrap status=FAIL rc=72 secs=$(( $(now) - TB )) reason=markers"); die 72 "bootstrap OK/candidate/client lines missing"; }
  CUR_STAGE=identity
  psqlq(){ PGPASSWORD=$FIXPASS timeout -k 10 15 "$PSQL" -X -v ON_ERROR_STOP=1 -At "postgresql://$ADMIN@127.0.0.1:$PORT/$DBNAME" -c "$1" 2>>"$LOG"; }
  DD=$(psqlq 'SHOW data_directory'); VN=$(psqlq 'SHOW server_version_num'); CN=$(psqlq "SELECT current_setting('cluster_name')")
  DM=$(psqlq "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()")
  MIG_APPLIED=$(psqlq 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')
  ML=$(psqlq 'SELECT max(migration_name) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'); PT=$(psqlq 'SELECT inet_server_port()')
  ID="data_directory=$DD server_version_num=$VN cluster_name=$CN db_marker_ok=$([ "$DM" = "$DB_MARKER" ] && echo yes || echo NO) applied=$MIG_APPLIED last=$ML port=$PT"
  [ "$DD" = "$PGDATA" ] && [ "$VN" = 170006 ] && [ "$CN" = "$MARKER" ] && [ "$DM" = "$DB_MARKER" ] && [ "$MIG_APPLIED" = "$MIG_N" ] && [ "$ML" = "$LAST_MIG" ] && [ "$PT" = "$PORT" ] \
    || { RES+=("STAGE_RESULT name=bootstrap status=FAIL rc=73 secs=$(( $(now) - TB )) identity=[$ID]"); die 73 "identity mismatch: $ID"; }
  RES+=("STAGE_RESULT name=bootstrap status=PASS rc=0 secs=$(( $(now) - TB )) migrations_applied=$MIG_APPLIED last=$ML")
  log "BOOTSTRAP_IDENTITY_OK $ID"
fi
# ---- the jest stage (verbatim pass rules from the local common body)
GUARD_RE='requires its explicitly confirmed|unsupported or ambiguous connection option|requires a plain fixture password|connects only as a fixture matrix login role|candidate head, not the accepted base|not the attested candidate|uncommitted changes|G2 proof requires|server identity mismatch'
jnum(){ local v; v=$(grep -oE "[0-9]+ $1" <<<"$2" | head -1 | awk '{print $1}'); echo "${v:-0}"; }
for s in "${STAGE_TABLE[@]}"; do
  IFS='|' read -r NAME CFG TMO FILES KIND REQ <<<"$s"
  case "$SEL" in *" $NAME "*) ;; *) continue;; esac
  CUR_STAGE=$NAME; MISSING=""; for f in $FILES; do [ -f "$W/$f" ] || MISSING="$MISSING $f"; done
  # Optional-absent stages are dropped by preflight; a job that was scheduled for a missing file is a FAIL.
  if [ -n "$MISSING" ]; then RES+=("STAGE_RESULT name=$NAME status=FAIL rc=70 missing=[$MISSING]"); die 70 "stage $NAME spec files absent at HEAD:$MISSING"; fi
  if case " $NEED_RG_FOR " in *" $NAME "*) true;; *) false;; esac; then command -v rg >/dev/null || { RES+=("STAGE_RESULT name=$NAME status=FAIL rc=70 reason=rg-missing"); die 70 "rg not on PATH"; }; fi
  EXP=0; LB=0; NF=0
  for f in $FILES; do NF=$((NF + 1)); c=$(grep -cE '^\s*it\(' "$W/$f" || true); EXP=$((EXP + c)); grep -qE '\b(it|test)\.each\b|^\s*test\(' "$W/$f" && LB=1; done
  JL=$RUN_DIR/jest-$NAME.log; ENVU=()
  if [ "$KIND" = guard ]; then for v in $(compgen -e | grep -E '^G2_'); do ENVU+=(-u "$v"); done; fi
  log "JEST_START $NAME cfg=$CFG bound=${TMO}s files=[$FILES] static_it=$EXP lower_bound=$LB kind=$KIND"
  TS0=$(now)
  run_bounded "$TMO" "$JL" "$W" env "${ENVU[@]}" ./node_modules/.bin/jest -c "$CFG" --runInBand --ci --runTestsByPath $FILES; JRC=$?
  SECS=$(( $(now) - TS0 )); J=$(cat "$JL")
  TL_=$(grep -E '^Tests:' <<<"$J" | tail -1); SL_=$(grep -E '^Test Suites:' <<<"$J" | tail -1)
  TP=$(jnum passed "$TL_"); TF=$(jnum failed "$TL_"); TS=$(jnum skipped "$TL_"); TT=$(jnum todo "$TL_"); TN=$(jnum total "$TL_")
  SP=$(jnum passed "$SL_"); SF=$(jnum failed "$SL_"); SS=$(jnum skipped "$SL_"); SN=$(jnum total "$SL_")
  grep -qE "$GUARD_RE" <<<"$J" && log "GUARD_REFUSAL_OBSERVED_IN_JEST_LOG $NAME"
  PASSL=1; for f in $FILES; do grep -qE "^PASS .*${f//./\\.}( |\$)" <<<"$J" || PASSL=0; done
  WHY=""
  [ "$JRC" = 0 ] || WHY="$WHY jest_rc=$JRC"
  [ "$TF" = 0 ] || WHY="$WHY failed=$TF"; [ "$TS" = 0 ] || WHY="$WHY skipped=$TS(live-expected)"; [ "$TT" = 0 ] || WHY="$WHY todo=$TT"
  [ "$TN" -gt 0 ] && [ "$TP" = "$TN" ] || WHY="$WHY passed!=total($TP/$TN)"
  if [ "$LB" = 1 ]; then [ "$TN" -ge "$EXP" ] || WHY="$WHY total<static($TN<$EXP)"; else [ "$TN" = "$EXP" ] || WHY="$WHY total!=static($TN!=$EXP)"; fi
  [ "$SP" = "$NF" ] && [ "$SN" = "$NF" ] && [ "$SF" = 0 ] && [ "$SS" = 0 ] || WHY="$WHY suites=$SP/$SN(want $NF/$NF)"
  [ "$PASSL" = 1 ] || WHY="$WHY missing-PASS-line"
  ST=PASS; [ -z "$WHY" ] || ST=FAIL
  SUM_P=$((SUM_P + TP)); SUM_F=$((SUM_F + TF)); SUM_S=$((SUM_S + TS)); SUM_T=$((SUM_T + TN))
  RES+=("STAGE_RESULT name=$NAME status=$ST passed=$TP failed=$TF skipped=$TS todo=$TT total=$TN expected=$([ "$LB" = 1 ] && echo ">=")$EXP suites=$SP/$SN rc=$JRC secs=$SECS${WHY:+ reason=[${WHY# }]}")
  log "JEST_END $NAME status=$ST rc=$JRC secs=$SECS | $SL_ | $TL_${WHY:+ | why:$WHY}"
  if [ "$ST" != PASS ]; then tail -80 "$JL"; if [ "$JRC" != 0 ]; then die "$JRC" "stage $NAME failed"; else die 72 "stage $NAME count/skip check failed:$WHY"; fi; fi
done
# ---- post (read-only)
CUR_STAGE=post
[ "$(git -C "$W" rev-parse HEAD)" = "$HEAD_SHA" ] && [ -z "$(git -C "$W" status --porcelain --untracked-files=all)" ] || die 74 "target changed during the run"
log "POST_OK target clean at HEAD"
CUR_STAGE=done; FINAL_RC=0; exit 0
