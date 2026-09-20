#!/usr/bin/env bash
# Offline negative tests for the S1-DB-01 harness disposable-target guard
# (R2 finding S1-R2-A-01). NO database is used or needed.
#
# Method: run the REAL harness entry point (test/db/s1-rls-close-public-exposure.sh)
# with a PATH-first directory of recording stubs for psql, pg_dump and node. Every
# invocation of those commands is appended to a per-case journal. For each
# rejected target we assert (a) the harness exits with the guard exit code and
# the expected refusal code, (b) the journal contains NO destructive or
# mutating command (DROP DATABASE / CREATE DATABASE / node / pg_dump / -f file),
# and (c) for offline refusals the journal is completely EMPTY (no connection at
# all). Preflight cases let the psql stub answer the single read-only preflight
# query with a crafted server identity and assert the harness still refuses
# before any destructive command. One positive case proves the guard lets a
# correct disposable identity through to exactly the first destructive step
# (which the stub refuses, ending the run) — i.e. the guard is not vacuous.
#
# Usage: test/db/s1-harness-guard.spec.sh        (exit 0 only if all cases pass)
set -u
cd "$(dirname "$0")/../.."
HARNESS=test/db/s1-rls-close-public-exposure.sh
WORK=$(mktemp -d)   # removed by cleanup (set below, after the spec dirs exist)
STUBS=$WORK/stubs; mkdir -p "$STUBS"
JOURNAL=$WORK/journal
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "PASS  $1"; }
bad(){ FAIL=$((FAIL+1)); echo "FAIL  $1"; }

# --- recording stubs ---------------------------------------------------------
# psql stub: records argv (redacting anything that looks like a URL credential),
# then answers ONLY the guard's preflight query using the identity in
# $STUB_PREFLIGHT; any other invocation is recorded as OTHER and fails.
cat >"$STUBS/psql" <<'STUB'
#!/usr/bin/env bash
args="$*"
red=$(printf '%s' "$args" | sed -E 's#://[^@[:space:]]*@#://<cred>@#g')
if printf '%s' "$args" | grep -q "inet_server_addr"; then
  echo "PSQL PREFLIGHT $red" >>"$STUB_JOURNAL"
  if [ "${STUB_PREFLIGHT_RC:-0}" != 0 ]; then echo "psql: error: connection refused (stub)" >&2; exit "$STUB_PREFLIGHT_RC"; fi
  printf '%s\n' "$STUB_PREFLIGHT"; exit 0
fi
echo "PSQL OTHER $red" >>"$STUB_JOURNAL"
echo "stub psql: refusing non-preflight invocation" >&2
exit 97
STUB
for c in pg_dump node; do
  cat >"$STUBS/$c" <<STUB
#!/usr/bin/env bash
echo "$(echo $c | tr a-z A-Z) \$*" >>"\$STUB_JOURNAL"; exit 97
STUB
done
chmod +x "$STUBS"/*

# The guard's data_directory check is host-local (fixed root /home/user/pg17/clusters/, must exist
# and realpath to itself). The spec creates a throw-away directory under that root for the
# positive identity and a symlink escaping the root for the negative case; both removed on exit.
FIXED_ROOT=/home/user/pg17/clusters
ROOT_PREEXISTED=1; [ -d "$FIXED_ROOT" ] || ROOT_PREEXISTED=0
SPEC_DIR="$FIXED_ROOT/guard-spec-$$"; SPEC_LINK="$FIXED_ROOT/guard-spec-link-$$"
mkdir -p "$SPEC_DIR" "$WORK/outside-root" && ln -s "$WORK/outside-root" "$SPEC_LINK" || { echo "cannot create spec dirs"; exit 2; }
cleanup(){ rm -rf "$SPEC_DIR" "$SPEC_LINK"; [ $ROOT_PREEXISTED -eq 0 ] && rmdir -p "$FIXED_ROOT" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT
GOOD_ID="addr=127.0.0.1 port=54321 db=postgres super=t ver=170006 cluster=s1-disposable-pg17 datadir=$SPEC_DIR foreign= roles="
GOOD_URL='postgresql://s1_super:s1_local_synthetic@127.0.0.1:54321/postgres'
GOOD_DB='s1_rls_proof'
GOOD_CONFIRM='DESTROY-127.0.0.1:54321/s1_rls_proof,s1_rls_proof_lock'

# run_case <name> <expected-refusal-code|ALLOW> <url> <db> <confirm> <port> <preflight-identity> [preflight-rc]
run_case(){
  local name=$1 want=$2 url=$3 db=$4 confirm=$5 port=$6 ident=$7 prc=${8:-0}
  : >"$JOURNAL"
  local err rc
  err=$(STUB_JOURNAL="$JOURNAL" STUB_PREFLIGHT="$ident" STUB_PREFLIGHT_RC="$prc" PATH="$STUBS:$PATH" \
        S1_PG_SUPER_URL="$url" S1_PG_PORT="$port" S1_PG_DISPOSABLE_CONFIRM="$confirm" \
        S1_PROOF_LOG="$WORK/harness.log" bash "$HARNESS" "$db" 2>&1 >/dev/null); rc=$?
  local destructive; destructive=$(grep -cE 'DROP DATABASE|CREATE DATABASE|^NODE |^PG_DUMP |-f ' "$JOURNAL")
  local preflights; preflights=$(grep -c '^PSQL PREFLIGHT' "$JOURNAL")
  local others; others=$(grep -c '^PSQL OTHER' "$JOURNAL")
  if [ "$want" = ALLOW ]; then
    # positive control: guard passes; the first thing the harness does next is the
    # destructive DROP/CREATE on the stub, which refuses -> harness exits 1 "cannot create db".
    if [ $rc -eq 1 ] && [ "$preflights" = 1 ] && [ "$others" = 1 ] && grep -q 'PSQL OTHER .*DROP DATABASE IF EXISTS "s1_rls_proof" WITH (FORCE)' "$JOURNAL" \
       && grep -q 'DROP DATABASE IF EXISTS "s1_rls_proof_lock" WITH (FORCE)' "$JOURNAL" ; then
      ok "$name: guard passes a correct disposable identity; exactly 1 preflight then the quoted DROP/CREATE step (stub refused, rc=1)"
    else
      bad "$name: unexpected flow rc=$rc preflights=$preflights others=$others journal: $(tr '\n' ' ' <"$JOURNAL" | cut -c1-300)"
    fi
    return
  fi
  local code; code=$(printf '%s\n' "$err" | sed -n 's/^S1-GUARD REFUSED \([A-Z_]*\):.*/\1/p' | head -1)
  if [ $rc -eq 64 ] && [ "$code" = "$want" ] && [ "$destructive" = 0 ] && [ "$others" = 0 ]; then
    ok "$name: refused $want, no destructive/mutating command (preflight connections: $preflights)"
  else
    bad "$name: rc=$rc code=[$code] want=$want destructive=$destructive others=$others :: $(printf '%s' "$err" | head -2 | tr '\n' ' ')"
  fi
  # offline refusals must not have connected at all
  case "$want" in
    URL_*|PORT_PIN|DB_*|CONFIRM)
      [ "$preflights" = 0 ] && ok "$name: refused OFFLINE (zero connections)" || bad "$name: offline refusal made $preflights connection(s)";;
  esac
  # never leak the password in refusal output
  printf '%s' "$err" | grep -q 's1_local_synthetic' && bad "$name: refusal output leaked the URL password" || true
}

echo "== S1 harness guard offline spec (stubs in $STUBS)"
# --- offline: URL grammar / endpoint -----------------------------------------
run_case "remote host"            URL_HOST   'postgresql://postgres:pw@db.example.supabase.co:5432/postgres' "$GOOD_DB" "$GOOD_CONFIRM" 54321 "$GOOD_ID"
run_case "remote host, port pinned" URL_HOST 'postgresql://postgres:pw@10.0.0.5:54321/postgres' "$GOOD_DB" 'DESTROY-127.0.0.1:54321/s1_rls_proof,s1_rls_proof_lock' 54321 "$GOOD_ID"
run_case "localhost hostname"     URL_HOST   'postgresql://s1_super:pw@localhost:54321/postgres' "$GOOD_DB" "$GOOD_CONFIRM" 54321 "$GOOD_ID"
run_case "IPv6 loopback"          URL_HOST   'postgresql://s1_super:pw@[::1]:54321/postgres' "$GOOD_DB" "$GOOD_CONFIRM" 54321 "$GOOD_ID"
run_case "unix socket via ?host="  URL_QUERY  'postgresql://s1_super:pw@/postgres?host=/tmp' "$GOOD_DB" "$GOOD_CONFIRM" 54321 "$GOOD_ID"
run_case "unix socket via %2F path" URL_ESCAPE 'postgresql://s1_super:pw@%2Ftmp/postgres' "$GOOD_DB" "$GOOD_CONFIRM" 54321 "$GOOD_ID"
run_case "no host at all"          URL_HOST   'postgresql://s1_super:pw@:54321/postgres' "$GOOD_DB" "$GOOD_CONFIRM" 54321 "$GOOD_ID"
run_case "query-string override"  URL_QUERY  'postgresql://s1_super:pw@127.0.0.1:54321/postgres?host=db.internal' "$GOOD_DB" "$GOOD_CONFIRM" 54321 "$GOOD_ID"
run_case "sslmode query"          URL_QUERY  'postgresql://s1_super:pw@127.0.0.1:54321/postgres?sslmode=require' "$GOOD_DB" "$GOOD_CONFIRM" 54321 "$GOOD_ID"
run_case "percent escape"         URL_ESCAPE 'postgresql://s1_super:p%40w@127.0.0.1:54321/postgres' "$GOOD_DB" "$GOOD_CONFIRM" 54321 "$GOOD_ID"
run_case "second @ (host smuggling)" URL_AT  'postgresql://s1_super:pw@evil.example.com@127.0.0.1:54321/postgres' "$GOOD_DB" "$GOOD_CONFIRM" 54321 "$GOOD_ID"
run_case "wrong maintenance db in URL" URL_SHAPE 'postgresql://s1_super:pw@127.0.0.1:54321/production' "$GOOD_DB" "$GOOD_CONFIRM" 54321 "$GOOD_ID"
run_case "wrong port vs pin"      URL_PORT   'postgresql://s1_super:pw@127.0.0.1:5432/postgres' "$GOOD_DB" 'DESTROY-127.0.0.1:5432/s1_rls_proof,s1_rls_proof_lock' 54321 "$GOOD_ID"
run_case "empty URL"              URL_EMPTY  '' "$GOOD_DB" "$GOOD_CONFIRM" 54321 "$GOOD_ID"
run_case "non-numeric port pin"   PORT_PIN   "$GOOD_URL" "$GOOD_DB" "$GOOD_CONFIRM" '54321;' "$GOOD_ID"
# --- offline: database identifier --------------------------------------------
run_case "arbitrary existing db name" DB_NAMESPACE "$GOOD_URL" 'app_production' 'DESTROY-127.0.0.1:54321/app_production,app_production_lock' 54321 "$GOOD_ID"
run_case "SQL metacharacters"     DB_NAMESPACE "$GOOD_URL" 's1_rls_x" WITH (FORCE); DROP DATABASE "prod' 'DESTROY-127.0.0.1:54321/x,y' 54321 "$GOOD_ID"
run_case "semicolon in name"      DB_NAMESPACE "$GOOD_URL" 's1_rls_a;b' 'DESTROY-127.0.0.1:54321/s1_rls_a;b,s1_rls_a;b_lock' 54321 "$GOOD_ID"
run_case "uppercase (quoted-identifier trick)" DB_NAMESPACE "$GOOD_URL" 's1_rls_Proof' 'DESTROY-127.0.0.1:54321/s1_rls_Proof,s1_rls_Proof_lock' 54321 "$GOOD_ID"
run_case "namespace prefix only"  DB_NAMESPACE "$GOOD_URL" 's1_rls_' 'DESTROY-127.0.0.1:54321/s1_rls_,s1_rls__lock' 54321 "$GOOD_ID"
run_case "over-long name (>40 tail)" DB_NAMESPACE "$GOOD_URL" "s1_rls_$(printf 'a%.0s' $(seq 41))" 'x' 54321 "$GOOD_ID"
# harness uses ${1-default}: an EXPLICIT empty argument reaches the guard and is refused
run_case "explicit empty db name"  DB_EMPTY   "$GOOD_URL" '' 'DESTROY-127.0.0.1:54321/,_lock' 54321 "$GOOD_ID"
# --- offline: confirmation binding --------------------------------------------
run_case "missing confirmation"   CONFIRM    "$GOOD_URL" "$GOOD_DB" '' 54321 "$GOOD_ID"
run_case "confirmation binds port only (R2 shape)" CONFIRM "$GOOD_URL" "$GOOD_DB" 'DESTROY-127.0.0.1:54321' 54321 "$GOOD_ID"
run_case "confirmation for a different db" CONFIRM "$GOOD_URL" "$GOOD_DB" 'DESTROY-127.0.0.1:54321/s1_rls_other,s1_rls_other_lock' 54321 "$GOOD_ID"
run_case "confirmation without derived _lock" CONFIRM "$GOOD_URL" "$GOOD_DB" 'DESTROY-127.0.0.1:54321/s1_rls_proof' 54321 "$GOOD_ID"
run_case "confirmation for a different port" CONFIRM "$GOOD_URL" "$GOOD_DB" 'DESTROY-127.0.0.1:54325/s1_rls_proof,s1_rls_proof_lock' 54321 "$GOOD_ID"
# --- preflight (stubbed server identity) -----------------------------------
run_case "preflight: server bound to non-loopback" SERVER_ADDR "$GOOD_URL" "$GOOD_DB" "$GOOD_CONFIRM" 54321 "${GOOD_ID/addr=127.0.0.1/addr=10.1.2.3}"
run_case "preflight: forwarded port differs"      SERVER_PORT "$GOOD_URL" "$GOOD_DB" "$GOOD_CONFIRM" 54321 "${GOOD_ID/port=54321/port=5432}"
run_case "preflight: not a superuser session"     SERVER_ROLE "$GOOD_URL" "$GOOD_DB" "$GOOD_CONFIRM" 54321 "${GOOD_ID/super=t/super=f}"
run_case "preflight: PG 15 server (CI/hosted shape)" SERVER_VERSION "$GOOD_URL" "$GOOD_DB" "$GOOD_CONFIRM" 54321 "${GOOD_ID/ver=170006/ver=150018}"
run_case "preflight: PG 18 server"                SERVER_VERSION "$GOOD_URL" "$GOOD_DB" "$GOOD_CONFIRM" 54321 "${GOOD_ID/ver=170006/ver=180006}"
run_case "preflight: missing cluster_name marker" CLUSTER_MARKER "$GOOD_URL" "$GOOD_DB" "$GOOD_CONFIRM" 54321 "${GOOD_ID/cluster=s1-disposable-pg17/cluster=NULL}"
run_case "preflight: another lane's marker"       CLUSTER_MARKER "$GOOD_URL" "$GOOD_DB" "$GOOD_CONFIRM" 54321 "${GOOD_ID/cluster=s1-disposable-pg17/cluster=s5-disposable-pg17}"
run_case "preflight: data_directory outside execution root" SERVER_DATADIR "$GOOD_URL" "$GOOD_DB" "$GOOD_CONFIRM" 54321 "${GOOD_ID/datadir=$SPEC_DIR/datadir=\/var\/lib\/postgresql\/17\/main}"
run_case "preflight: data_directory with ../ escape" SERVER_DATADIR "$GOOD_URL" "$GOOD_DB" "$GOOD_CONFIRM" 54321 "${GOOD_ID/datadir=$SPEC_DIR/datadir=$FIXED_ROOT\/x\/..\/..\/..\/etc}"
run_case "preflight: data_directory under root but nonexistent" SERVER_DATADIR "$GOOD_URL" "$GOOD_DB" "$GOOD_CONFIRM" 54321 "${GOOD_ID/datadir=$SPEC_DIR/datadir=$FIXED_ROOT\/does-not-exist-$$}"
run_case "preflight: data_directory is a symlink escaping the root" SERVER_DATADIR "$GOOD_URL" "$GOOD_DB" "$GOOD_CONFIRM" 54321 "${GOOD_ID/datadir=$SPEC_DIR/datadir=$SPEC_LINK}"
run_case "preflight: foreign database present"   FOREIGN_DB  "$GOOD_URL" "$GOOD_DB" "$GOOD_CONFIRM" 54321 "${GOOD_ID/foreign=/foreign=app_production+s5_tgp}"
run_case "preflight: stale postgres role is superuser" ROLE_FLAGS "$GOOD_URL" "$GOOD_DB" "$GOOD_CONFIRM" 54321 "${GOOD_ID/roles=/roles=anon\/ffff+postgres\/ttft}"
run_case "preflight: authenticator can BYPASSRLS" ROLE_FLAGS "$GOOD_URL" "$GOOD_DB" "$GOOD_CONFIRM" 54321 "${GOOD_ID/roles=/roles=authenticator\/fttf}"
run_case "preflight: connection failure"          PREFLIGHT_CONNECT "$GOOD_URL" "$GOOD_DB" "$GOOD_CONFIRM" 54321 "$GOOD_ID" 2
run_case "preflight: garbage output"              PREFLIGHT_SHAPE "$GOOD_URL" "$GOOD_DB" "$GOOD_CONFIRM" 54321 "psql: warning: something unexpected"
# --- positive control --------------------------------------------------------
# roles= empty is the truly fresh cluster (bootstrap not yet run); the second case is a
# re-run against a cluster whose fixture roles already carry exactly the bootstrap flags.
run_case "positive control: exact disposable identity (fresh cluster, no fixture roles)" ALLOW "$GOOD_URL" "$GOOD_DB" "$GOOD_CONFIRM" 54321 "$GOOD_ID"
run_case "positive control with existing fixture roles (expected flags)" ALLOW "$GOOD_URL" "$GOOD_DB" "$GOOD_CONFIRM" 54321 "${GOOD_ID/roles=/roles=anon\/ffff+authenticated\/ffff+authenticator\/fftf+postgres\/ftft+service_role\/ftff}"

echo "== $PASS passed, $FAIL failed (guard spec, offline, head $(git rev-parse --short HEAD 2>/dev/null)$(git diff --quiet HEAD -- test/db 2>/dev/null || echo '+dirty'))"
[ $FAIL -eq 0 ]
