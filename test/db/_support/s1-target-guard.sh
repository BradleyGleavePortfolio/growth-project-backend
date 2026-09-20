# S1-DB-01 disposable-target guard — sourced by test/db/s1-rls-close-public-exposure.sh
# BEFORE that harness runs any psql / pg_dump / node command.
#
# The harness is destructive (DROP DATABASE ... WITH (FORCE)). R2 audit finding
# S1-R2-A-01: the only pre-R3 check was "the URL variable is set". This file
# makes the target boundary executable and fail-closed in two layers:
#
#   s1_guard_offline   — pure string validation, no connection at all:
#                        literal loopback URL grammar, pinned port, disposable
#                        database-name namespace, explicit destructive
#                        confirmation (double entry of the endpoint).
#   s1_guard_preflight — ONE read-only connection to the superuser URL that must
#                        prove the server is the disposable synthetic cluster:
#                        actual bound address/port, database, superuser session,
#                        PG 17.x, cluster_name marker, no foreign databases, and
#                        expected flags on any pre-existing fixture role.
#
# Every refusal prints "S1-GUARD REFUSED <code>: <reason>" to stderr and exits
# with S1_GUARD_EXIT (64). Nothing destructive can run before both layers pass.
# Negative tests: test/db/s1-harness-guard.spec.sh (offline, command stubs).
#
# Contract (all inputs are literal; nothing is inferred from the environment):
#   S1_PG_SUPER_URL          postgresql://<user>:<pw>@127.0.0.1:<port>/postgres
#                            user/pw: [A-Za-z0-9_]+ ; no query string, percent
#                            escapes, hostnames, IPv6, sockets or a second '@'.
#   S1_PG_PORT               pinned TCP port the URL MUST use (default 54321).
#   dbname argument          ^s1_rls_[a-z0-9_]{1,40}$ ; the harness ALSO destroys the
#                            derived "<dbname>_lock"; both must fit PostgreSQL's
#                            63-byte identifier limit (checked in bytes, ASCII only).
#   S1_PG_DISPOSABLE_CONFIRM must equal exactly
#                            "DESTROY-127.0.0.1:<port>/<dbname>,<dbname>_lock"
#                            i.e. the confirmation binds endpoint AND both exact
#                            database names that will be dropped.
#   cluster_name marker      FIXED: the server must report cluster_name =
#                            's1-disposable-pg17' (set only in the synthetic
#                            cluster's postgresql.conf). Not overridable.
#   data_directory root      FIXED: the server's data_directory must be a
#                            canonical absolute path under
#                            /home/user/pg17/clusters/ (no '.', '..', '//',
#                            trailing '/'), must exist on THIS host (loopback
#                            server = same host) and must realpath to itself
#                            (no symlink escape). Not overridable.
#   preflight bounds         PGCONNECT_TIMEOUT=5, statement_timeout=5s and an
#                            outer `timeout 20s` around the psql process.
# Refusal messages never echo the URL or password.

S1_GUARD_EXIT=64
S1_GUARD_HOST='127.0.0.1'
S1_GUARD_DB_RE='^s1_rls_[a-z0-9_]{1,40}$'
S1_GUARD_NAMEDATALEN=63   # PostgreSQL identifier limit in BYTES (NAMEDATALEN-1)
S1_GUARD_CLUSTER_MARKER='s1-disposable-pg17'      # fixed, not configurable
S1_GUARD_DATA_ROOT='/home/user/pg17/clusters/'    # fixed, not configurable

s1_guard_refuse() { # <code> <reason>
  printf 'S1-GUARD REFUSED %s: %s\n' "$1" "$2" >&2
  exit "$S1_GUARD_EXIT"
}

# s1_guard_offline <super_url> <dbname>
# Exports: S1_GUARD_PORT S1_GUARD_HOSTPORT S1_GUARD_USER
s1_guard_offline() {
  local url=$1 db=$2
  local port=${S1_PG_PORT:-54321}
  local confirm=${S1_PG_DISPOSABLE_CONFIRM-}

  case "$port" in
    ''|*[!0-9]*) s1_guard_refuse PORT_PIN "S1_PG_PORT must be a literal TCP port number" ;;
  esac
  [ "$port" -ge 1024 ] && [ "$port" -le 65535 ] || s1_guard_refuse PORT_PIN "S1_PG_PORT $port outside 1024-65535"

  [ -n "$url" ] || s1_guard_refuse URL_EMPTY "S1_PG_SUPER_URL is empty"
  # Whole-string grammar. Anything not matching is refused: hostnames
  # (including localhost), IPv6, unix sockets, query strings (?sslmode=,
  # ?host= overrides), percent escapes, a second '@', extra path segments.
  local re="^postgresql://([A-Za-z0-9_]+):([A-Za-z0-9_]+)@127\.0\.0\.1:([0-9]{4,5})/postgres$"
  if ! [[ $url =~ $re ]]; then
    case "$url" in
      *'?'*)              s1_guard_refuse URL_QUERY   "query string / connection overrides are not allowed in S1_PG_SUPER_URL" ;;
      *'%'*)              s1_guard_refuse URL_ESCAPE  "percent escapes are not allowed in S1_PG_SUPER_URL" ;;
      *@*@*)              s1_guard_refuse URL_AT      "more than one '@' in S1_PG_SUPER_URL" ;;
      *'@127.0.0.1:'*)    s1_guard_refuse URL_SHAPE   "S1_PG_SUPER_URL must be postgresql://<user>:<pw>@127.0.0.1:<port>/postgres (maintenance db 'postgres', simple credentials)" ;;
      *)                  s1_guard_refuse URL_HOST    "S1_PG_SUPER_URL host must be the literal loopback address 127.0.0.1 (no hostnames, localhost, IPv6, sockets, remote endpoints)" ;;
    esac
  fi
  S1_GUARD_USER=${BASH_REMATCH[1]}
  S1_GUARD_PORT=${BASH_REMATCH[3]}
  [ "$S1_GUARD_PORT" = "$port" ] || s1_guard_refuse URL_PORT "S1_PG_SUPER_URL port $S1_GUARD_PORT does not match pinned S1_PG_PORT $port"
  S1_GUARD_HOSTPORT="${S1_GUARD_HOST}:${S1_GUARD_PORT}"

  [ -n "$db" ] || s1_guard_refuse DB_EMPTY "database name argument is empty"
  [[ $db =~ $S1_GUARD_DB_RE ]] || s1_guard_refuse DB_NAMESPACE "database name is outside the disposable namespace $S1_GUARD_DB_RE (lowercase ASCII; the derived '<name>_lock' is destroyed too)"
  # byte length (LC_ALL=C makes ${#..} count bytes; the regex already restricts to ASCII)
  local blen
  blen=$(LC_ALL=C; printf '%s' "${db}_lock" | wc -c)
  [ "$blen" -le "$S1_GUARD_NAMEDATALEN" ] || s1_guard_refuse DB_LENGTH "derived database name '<name>_lock' is $blen bytes; PostgreSQL identifiers are limited to $S1_GUARD_NAMEDATALEN bytes (silent truncation would target a different database)"
  S1_GUARD_DB=$db
  S1_GUARD_DB_LOCK="${db}_lock"

  local expected="DESTROY-${S1_GUARD_HOSTPORT}/${S1_GUARD_DB},${S1_GUARD_DB_LOCK}"
  [ -n "$confirm" ] || s1_guard_refuse CONFIRM "S1_PG_DISPOSABLE_CONFIRM is unset; this harness DROPS databases '$S1_GUARD_DB' and '$S1_GUARD_DB_LOCK' on $S1_GUARD_HOSTPORT and requires the literal confirmation '$expected'"
  [ "$confirm" = "$expected" ] || s1_guard_refuse CONFIRM "S1_PG_DISPOSABLE_CONFIRM does not bind this exact endpoint and both database names; required literal: '$expected'"
  export S1_GUARD_PORT S1_GUARD_HOSTPORT S1_GUARD_USER S1_GUARD_DB S1_GUARD_DB_LOCK
  return 0
}

# s1_guard_preflight <super_url> <dbname>
# One read-only psql connection. Refuses unless the server proves it is the
# disposable synthetic cluster. Uses only the "psql" found on PATH so the
# offline spec can stub it.
s1_guard_preflight() {
  local url=$1 db=$2
  local want_cluster=$S1_GUARD_CLUSTER_MARKER
  local want_root=$S1_GUARD_DATA_ROOT
  local out rc
  # All facts in one statement so the check is a single round trip; the
  # output is a fixed-width field list.
  local sql
  sql="select
    'addr='||coalesce(host(inet_server_addr()),'NULL'),
    'port='||coalesce(inet_server_port()::text,'NULL'),
    'db='||current_database(),
    'super='||(select rolsuper from pg_roles where rolname=current_user),
    'ver='||current_setting('server_version_num'),
    'cluster='||coalesce(nullif(current_setting('cluster_name'),''),'NULL'),
    'datadir='||current_setting('data_directory'),
    'foreign='||coalesce((select string_agg(datname, '+' order by datname) from pg_database
        where datname not in ('postgres','template0','template1') and datname !~ '^s1_rls_'),''),
    'roles='||coalesce((select string_agg(rolname||'/'||rolsuper||rolbypassrls||rolcanlogin||rolinherit, '+' order by rolname)
        from pg_roles where rolname in ('postgres','authenticator','anon','authenticated','service_role')),'');"
  # bounded connect; -X (no psqlrc); read-only single statement. The password
  # never appears in output: psql does not echo it and refusals redact the URL.
  # bounds: connect 5 s, server-side statement 5 s, and an outer process deadline
  # of 20 s so a stalled/black-holed server cannot hang the guard.
  out=$(PGCONNECT_TIMEOUT=5 PGOPTIONS='-c statement_timeout=5s' timeout -k 2 20 psql "$url" -X -qAt -F ' ' -v ON_ERROR_STOP=1 -c "$sql" 2>&1); rc=$?
  [ $rc -ne 124 ] && [ $rc -ne 137 ] || s1_guard_refuse PREFLIGHT_TIMEOUT "read-only preflight exceeded the 20 s process deadline (server stalled?)"
  [ $rc -eq 0 ] || s1_guard_refuse PREFLIGHT_CONNECT "read-only preflight query failed (rc=$rc): $(printf '%s' "$out" | sed -E 's#://[^@[:space:]]*@#://<redacted>@#g' | head -3 | tr '\n' ' ')"

  local addr port cdb super ver cluster datadir foreign roles
  addr=$(s1_guard_field "$out" addr); port=$(s1_guard_field "$out" port); cdb=$(s1_guard_field "$out" db)
  super=$(s1_guard_field "$out" super); ver=$(s1_guard_field "$out" ver); cluster=$(s1_guard_field "$out" cluster)
  datadir=$(s1_guard_field "$out" datadir); foreign=$(s1_guard_field "$out" foreign); roles=$(s1_guard_field "$out" roles)

  [ -n "$addr" ] && [ -n "$port" ] && [ -n "$ver" ] || s1_guard_refuse PREFLIGHT_SHAPE "preflight output not understood: $(printf '%s' "$out" | head -1)"
  [ "$addr" = "$S1_GUARD_HOST" ] || s1_guard_refuse SERVER_ADDR "server bound address is '$addr', not $S1_GUARD_HOST (tunnel or forwarded endpoint?)"
  [ "$port" = "$S1_GUARD_PORT" ] || s1_guard_refuse SERVER_PORT "server port is '$port', not pinned $S1_GUARD_PORT"
  [ "$cdb" = "postgres" ] || s1_guard_refuse SERVER_DB "connected database is '$cdb', not postgres"
  [ "$super" = "t" ] || s1_guard_refuse SERVER_ROLE "session role is not a superuser; the fixture bootstrap needs the disposable cluster's superuser"
  case "$ver" in
    17[0-9][0-9][0-9][0-9]) ;;
    *) s1_guard_refuse SERVER_VERSION "server_version_num '$ver' is not PostgreSQL 17.x (documented fixture is 17.6)" ;;
  esac
  [ "$cluster" = "$want_cluster" ] || s1_guard_refuse CLUSTER_MARKER "cluster_name is '$cluster', expected disposable marker '$want_cluster' (set only in the synthetic cluster's postgresql.conf)"
  # data_directory: canonical string under the fixed root, present on this host,
  # and resolving to itself (a symlinked directory pointing outside the root is refused).
  case "$datadir" in
    "$want_root"?*) ;;
    *) s1_guard_refuse SERVER_DATADIR "server data_directory '$datadir' is not under the controlled execution root '$want_root'" ;;
  esac
  case "$datadir" in
    *//*|*/./*|*/../*|*/.|*/..|*/) s1_guard_refuse SERVER_DATADIR "server data_directory '$datadir' is not a canonical path" ;;
  esac
  local real
  real=$(realpath -e -- "$datadir" 2>/dev/null) || s1_guard_refuse SERVER_DATADIR "server data_directory '$datadir' does not exist on this host; a 127.0.0.1 disposable cluster must live on this host under '$want_root'"
  [ "$real" = "$datadir" ] || s1_guard_refuse SERVER_DATADIR "server data_directory '$datadir' resolves to '$real' (symlink escape from the controlled root is refused)"
  [ -z "$foreign" ] || s1_guard_refuse FOREIGN_DB "cluster holds database(s) outside the disposable namespace: $foreign"

  # Pre-existing fixture roles must already carry the flags the bootstrap
  # would create them with (rolsuper rolbypassrls rolcanlogin rolinherit).
  local r name flags want
  local IFS='+'
  for r in $roles; do
    name=${r%%/*}; flags=${r#*/}
    case "$name" in
      postgres)      want=ftft ;;
      authenticator) want=fftf ;;
      service_role)  want=ftff ;;
      anon|authenticated) want=ffff ;;
      *) continue ;;
    esac
    [ "$flags" = "$want" ] || s1_guard_refuse ROLE_FLAGS "pre-existing role $name has flags super/bypassrls/login/inherit=$flags, fixture expects $want; not the synthetic fixture (or a stale one) — refuse rather than reuse"
  done
  unset IFS
  return 0
}

s1_guard_field() { # <output> <name> -> value of "name=value" token
  printf '%s\n' "$1" | tr ' ' '\n' | sed -n "s/^$2=//p" | head -1
}
