#!/usr/bin/env bash
# S7-L G2 proof bootstrap, derived by substitution from the committed N/Q1 bootstrap
# test/utils/g2-nq1-bootstrap.sh (blob 96b7668d at 61b93cff, unchanged) for the S7-L-only
# disposable cluster/database, via the accepted S8-B derivation (test/utils/g2-s8b-bootstrap.sh).
# The "old" side is a detached checkout of OLD_HEAD (the S7-L base:
# the accepted S8-B head 93389265), whose `prisma migrate deploy` installs the whole accepted history so that the S7-L
# candidate has EXACTLY ONE migration pending (applied later by the spec through the candidate's
# own `prisma migrate deploy`, L01 — the release mechanism). Validation harness only: it never touches a hosted or
# application database, never edits schema/migration/generator sources, and
# stops on the first unexpected state instead of repairing it.
#
# Required environment (all explicit; nothing is inferred from DATABASE_URL):
#   G2_S7L_DATABASE_URL  postgresql://s7l_super@127.0.0.1:<port>/g2_s7l_disposable?schema=public&connection_limit=2
#   G2_S7L_CONFIRM       g2_s7l_disposable:<port>
#   G2_S7L_PASSWORD      disposable local fixture password shared by s7l_super/postgres/service_role
#                         (never written to a file by this harness; only into process env / in-memory URLs)
#   G2_S7L_PSQL          absolute path of a psql binary compatible with the PG17 server
#   G2_S7L_OLD_ROOT      DETACHED Git checkout of OLD_HEAD (the old-writer side); create/verify it
#                         offline with test/utils/g2-s7l-old-root.sh (a `git archive` extraction is
#                         not a repository and cannot pass step 4 below)
#   G2_S7L_OLD_CLIENT    directory that receives the independently generated OLD Prisma client
# Optional:
#   G2_S7L_SERVER_VERSION  expected server_version_num (default 170006 = 17.6)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# OLD side pin (kept identical in test/utils/g2-s7l-old-root.sh and g2-s7l-pg-harness.ts).
OLD_HEAD=93389265a846095b846fa8f1fb0dad782fb6ee9f
R_MIGRATION=20270120000000_scout_identity_ready
C_MIGRATION=20270121000000_scout_identity_contract
S8B_MIGRATION=20270122000000_scout_native_provenance_expand
S7L_MIGRATION=20270123000000_scout_run_lifecycle_expand
# 164 base migrations + S1 + C1 + E + B + R + C + S8-B tracked by the OLD root (171 at the accepted
# S8-B head 93389265); the candidate tracks exactly one more (S7-L).
EXPECTED_MIGRATIONS=171
E_MIGRATION=20270118000000_scout_ledger_platform_expand
EXPECTED_VERSION="${G2_S7L_SERVER_VERSION:-170006}"
# Distinctive S7-L fixture markers: pinned literals, never read from the environment (see
# test/utils/g2-s7l-db.ts G2_S7L_CLUSTER_MARKER / G2_S7L_DATABASE_MARKER, kept identical by
# test/scout/g2-s7l-db-guard.spec.ts). The lane's postgresql.conf must set
# cluster_name = 's7l-disposable-pg17'; the disposable database carries DB_MARKER as its comment.
CLUSTER_MARKER=s7l-disposable-pg17
DB_MARKER=s7l-g2-run-lifecycle-synthetic-disposable-fixture-safe-to-drop

for name in G2_S7L_DATABASE_URL G2_S7L_CONFIRM G2_S7L_PASSWORD G2_S7L_PSQL G2_S7L_OLD_ROOT G2_S7L_OLD_CLIENT; do
  [[ -n "${!name:-}" ]] || { echo "missing $name" >&2; exit 2; }
done
[[ -x "$G2_S7L_PSQL" ]] || { echo "psql binary not executable: $G2_S7L_PSQL" >&2; exit 2; }
[[ -d "$ROOT/node_modules/prisma" ]] || { echo "node_modules missing in $ROOT (the isolated copy of the accepted C1 dependency tree must be in place first; no npm ci)" >&2; exit 2; }
# Dependency provenance is closed: `prisma generate` must never auto-install anything (B2 finding:
# an output directory outside a package root made the CLI run `npm i` silently). The OLD client is
# generated INSIDE the OLD checkout, whose node_modules is the shared symlink to the pinned npm-ci tree,
# and @prisma/client must resolve from there to exactly $ROOT/node_modules/@prisma/client.
export PRISMA_GENERATE_SKIP_AUTOINSTALL=1
[[ "$G2_S7L_OLD_CLIENT" == "$G2_S7L_OLD_ROOT"/* ]] \
  || { echo "G2_S7L_OLD_CLIENT must live inside G2_S7L_OLD_ROOT (pinned package root); got $G2_S7L_OLD_CLIENT" >&2; exit 2; }

# Validate the target before opening any connection (same guard as the spec).
eval "$(cd "$ROOT" && node -r ts-node/register/transpile-only -e '
  const { g2S7lTestTarget } = require("./test/utils/g2-s7l-db");
  const t = g2S7lTestTarget(process.env.G2_S7L_DATABASE_URL, process.env.G2_S7L_CONFIRM);
  const q = (s) => "\x27" + s.replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
  console.log("PRISMA_URL=" + q(t.prismaUrl)); console.log("PSQL_URL=" + q(t.psqlUrl));
  console.log("MAINT_URL=" + q(t.maintenanceUrl));
  const { withFixturePassword } = require("./test/utils/g2-s7l-db");
  console.log("MIGRATE_AUTH_URL=" + q(withFixturePassword(t.prismaUrl, process.env.G2_S7L_PASSWORD, "postgres")));
')"
export PGPASSWORD="$G2_S7L_PASSWORD"

psql_maint() { "$G2_S7L_PSQL" -X -w -qAt -v ON_ERROR_STOP=1 "$MAINT_URL" "$@"; }
psql_db() { "$G2_S7L_PSQL" -X -w -qAt -v ON_ERROR_STOP=1 "$PSQL_URL" "$@"; }

MODE="${1:-bootstrap}"
case "$MODE" in bootstrap|generate-only) ;; *) echo "usage: g2-s7l-bootstrap.sh [bootstrap|generate-only]" >&2; exit 2;; esac
if [[ "$MODE" == bootstrap ]]; then
# 1. Server identity: PostgreSQL 17.x on loopback, expected exact version.
VERSION="$(psql_maint -c 'SHOW server_version_num')"
ADDRESS="$(psql_maint -c 'SELECT inet_server_addr()')"
[[ "$VERSION" == "$EXPECTED_VERSION" ]] || { echo "server_version_num $VERSION != expected $EXPECTED_VERSION" >&2; exit 3; }
[[ "$ADDRESS" == "127.0.0.1" ]] || { echo "server address $ADDRESS is not loopback" >&2; exit 3; }
[[ "$(psql_maint -c 'SELECT rolsuper FROM pg_roles WHERE rolname=current_user')" == "t" ]] \
  || { echo "bootstrap role must be superuser on the disposable cluster" >&2; exit 3; }
# 1b. Disposable identity marker BEFORE any write: a blank or foreign cluster_name means this is
#     not the S7-L lane initialised for this proof; stop without creating roles or databases.
CLUSTER="$(psql_maint -c "SELECT current_setting('cluster_name')")"
[[ "$CLUSTER" == "$CLUSTER_MARKER" ]] || { echo "cluster_name '$CLUSTER' is not the S7-L fixture marker '$CLUSTER_MARKER'; refusing to touch this server" >&2; exit 3; }
[[ "$(psql_maint -c "SELECT count(*) FROM pg_roles WHERE rolname IN ('supabase_admin','supabase_auth_admin','supabase_storage_admin','authenticator','pgbouncer')")" == "0" ]] \
  || { echo "server carries hosted-platform roles; not a synthetic fixture" >&2; exit 3; }

# 2. Explicit fixture role matrix (cluster-level, disposable lane only; shape
#    mirrors S1's Supabase-like fixture and the hosted role model):
#      postgres      LOGIN NOSUPERUSER CREATEDB CREATEROLE BYPASSRLS  (owner + migrator)
#      service_role  BYPASSRLS runtime role (+ harness-only LOGIN for worker processes)
#      anon/authenticated  NOLOGIN API roles (RLS denial via SET ROLE)
#    All fixture logins share the one synthetic password from the environment.
psql_maint -v pw="$G2_S7L_PASSWORD" <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='postgres') THEN
    CREATE ROLE postgres LOGIN NOSUPERUSER CREATEDB CREATEROLE BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS; END IF;
END $$;
ALTER ROLE postgres LOGIN NOSUPERUSER CREATEDB CREATEROLE BYPASSRLS PASSWORD :'pw';
ALTER ROLE service_role LOGIN BYPASSRLS PASSWORD :'pw';
GRANT anon, authenticated, service_role TO postgres WITH ADMIN OPTION;
SQL
for role in postgres service_role; do
  [[ "$(psql_maint -c "SELECT rolsuper||':'||rolbypassrls||':'||rolcanlogin FROM pg_roles WHERE rolname='$role'")" == "false:true:true" ]] \
    || { echo "fixture role $role is not NOSUPERUSER BYPASSRLS LOGIN" >&2; exit 3; }
done

# 3. Dedicated database owned by the migration role (create once; never drop anything).
#    Single-shot: a database that already carries migration history must be reset explicitly
#    by the operator (DROP DATABASE g2_s7l_disposable as the cluster superuser) first.
#    The database is stamped with DB_MARKER at creation; an existing database of the same name
#    without exactly that comment is foreign and is refused (never repaired, never dropped here).
if [[ "$(psql_maint -c "SELECT count(*) FROM pg_database WHERE datname='g2_s7l_disposable'")" == "0" ]]; then
  psql_maint -c 'CREATE DATABASE g2_s7l_disposable OWNER postgres'
  psql_maint -v marker="$DB_MARKER" <<'SQL'
COMMENT ON DATABASE g2_s7l_disposable IS :'marker';
SQL
fi
EXISTING_MARKER="$(psql_maint -c "SELECT COALESCE(shobj_description(oid,'pg_database'),'') FROM pg_database WHERE datname='g2_s7l_disposable'")"
[[ "$EXISTING_MARKER" == "$DB_MARKER" ]] \
  || { echo "g2_s7l_disposable exists without the S7-L disposable marker comment; refusing to reuse it" >&2; exit 3; }
psql_maint -c 'ALTER DATABASE g2_s7l_disposable OWNER TO postgres'
[[ "$(psql_db -c "SELECT count(*) FROM pg_tables WHERE schemaname='public'")" == "0" ]] \
  || { echo "g2_s7l_disposable already has public tables; reset it explicitly before bootstrapping again" >&2; exit 3; }
psql_db -c 'ALTER SCHEMA public OWNER TO postgres; GRANT USAGE, CREATE ON SCHEMA public TO postgres;'
# Verbatim CI shim (roles already exist; adds auth schema/helpers and GRANT ... TO postgres).
psql_db -f "$ROOT/scripts/ci/supabase-shim.sql" >/dev/null
psql_db -c 'GRANT USAGE ON SCHEMA auth TO postgres, anon, authenticated, service_role;'
# Supabase default privileges for objects postgres creates in public (same shape as S1's
# fixture): API roles receive CRUD on every new table, so RLS policies are the only barrier.
psql_db -c 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;'
# Extensions the migration chain needs (Supabase ships them pre-installed; migration
# 20261221000000_enable_pg_stat_statements requires pg_stat_statements to pre-exist for a non-superuser); superuser-only step.
psql_db -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS "uuid-ossp"; CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS btree_gist; CREATE EXTENSION IF NOT EXISTS pg_stat_statements;'

fi # MODE=bootstrap steps 1-3

# 4. OLD source: exact OLD_HEAD, shared dependency tree, the full accepted history; the candidate adds exactly S7-L.
[[ "$(git -C "$G2_S7L_OLD_ROOT" rev-parse HEAD)" == "$OLD_HEAD" ]] || { echo "old root is not $OLD_HEAD" >&2; exit 4; }
git -C "$G2_S7L_OLD_ROOT" diff --quiet HEAD -- package.json package-lock.json src prisma \
  || { echo "old root has uncommitted source/dependency changes" >&2; exit 4; }
git -C "$ROOT" diff --quiet "$OLD_HEAD" HEAD -- package.json package-lock.json \
  || { echo "dependency manifests differ between OLD and candidate; a shared node_modules is unsafe" >&2; exit 4; }
[[ -e "$G2_S7L_OLD_ROOT/node_modules" ]] || ln -s "$ROOT/node_modules" "$G2_S7L_OLD_ROOT/node_modules"
[[ -d "$G2_S7L_OLD_ROOT/prisma/migrations/$E_MIGRATION" && -d "$G2_S7L_OLD_ROOT/prisma/migrations/$R_MIGRATION" && -d "$G2_S7L_OLD_ROOT/prisma/migrations/$C_MIGRATION" && -d "$G2_S7L_OLD_ROOT/prisma/migrations/$S8B_MIGRATION" ]] \
  || { echo "old root lacks E, R, C or S8-B; it is not a descendant of the accepted S8-B head" >&2; exit 4; }
[[ ! -d "$G2_S7L_OLD_ROOT/prisma/migrations/$S7L_MIGRATION" ]] || { echo "old root unexpectedly contains S7-L" >&2; exit 4; }
OLD_COUNT="$(find "$G2_S7L_OLD_ROOT/prisma/migrations" -mindepth 1 -maxdepth 1 -type d | wc -l)"
[[ "$OLD_COUNT" == "$EXPECTED_MIGRATIONS" ]] || { echo "old root has $OLD_COUNT migrations, expected $EXPECTED_MIGRATIONS" >&2; exit 4; }
# The candidate ships exactly S7-L: migration.sql + down.sql of S7L_MIGRATION and nothing else.
[[ "$(git -C "$ROOT" diff --name-only "$OLD_HEAD" HEAD -- prisma/migrations | sort | tr '\n' ' ')" \
  == "prisma/migrations/$S7L_MIGRATION/down.sql prisma/migrations/$S7L_MIGRATION/migration.sql " ]] \
  || { echo "candidate migrations differ from $OLD_HEAD by other than exactly S7-L's two files" >&2; exit 4; }
[[ -f "$ROOT/prisma/migrations/$S7L_MIGRATION/migration.sql" && -f "$ROOT/prisma/migrations/$S7L_MIGRATION/down.sql" ]] \
  || { echo "candidate lacks S7-L's migration.sql/down.sql" >&2; exit 4; }

if [[ "$MODE" == bootstrap ]]; then
# 5. Full accepted history through the real release mechanism from the OLD root; S7-L is NOT applied here.
#    Runs as the non-superuser BYPASSRLS `postgres` role (owner), never as the cluster superuser.
(cd "$G2_S7L_OLD_ROOT" && DATABASE_URL="$MIGRATE_AUTH_URL" DIRECT_URL="$MIGRATE_AUTH_URL" \
  "$ROOT/node_modules/.bin/prisma" migrate deploy --schema prisma/schema.prisma)
[[ "$(psql_db -c "SELECT count(DISTINCT tableowner) FROM pg_tables WHERE schemaname='public'")" == "1" ]] \
  && [[ "$(psql_db -c "SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname='public'")" == "postgres" ]] \
  || { echo "public tables are not all owned by postgres" >&2; exit 5; }
APPLIED="$(psql_db -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")"
[[ "$APPLIED" == "$EXPECTED_MIGRATIONS" ]] || { echo "accepted history applied $APPLIED migrations, expected $EXPECTED_MIGRATIONS" >&2; exit 5; }
[[ "$(psql_db -c "SELECT count(*) FROM pg_attribute WHERE attrelid='public.\"ScoutReconstructionLedger\"'::regclass AND attname='source_platform' AND NOT attisdropped AND attnotnull")" == "1" ]] \
  || { echo "ledger lacks NOT NULL source_platform after the accepted history (R absent)" >&2; exit 5; }
[[ "$(psql_db -c "SELECT count(*) FROM pg_class WHERE relname IN ('ScoutIngestEntity_identity_key','ScoutReconstructionLedger_identity_key') AND relnamespace='public'::regnamespace")" == "2" ]] \
  || { echo "wide identity keys absent after the accepted history (R absent)" >&2; exit 5; }
# S8-B (the base) must be PRESENT and S7-L ABSENT after the OLD history: the spec applies S7-L (L01)
# and observes the catalog move on ScoutImport.
[[ "$(psql_db -c "SELECT to_regclass('public.\"ImportNativeProvenance\"') IS NOT NULL")" == "t" ]] \
  || { echo "ImportNativeProvenance absent after the OLD history; the OLD root is not the accepted S8-B head" >&2; exit 5; }
[[ "$(psql_db -c "SELECT count(*) FROM pg_attribute WHERE attrelid='public.\"ScoutImport\"'::regclass AND attname IN ('mode','import_intent_id','phase','accepted_start_at','deadline_at','last_observed_at','execution_epoch','fenced_at','fence_reason','reason_code') AND NOT attisdropped")" == "0" ]] \
  || { echo "ScoutImport already carries S7-L lifecycle columns after the OLD history; not a fresh OLD-shaped bootstrap" >&2; exit 5; }
[[ "$(psql_db -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name='$S7L_MIGRATION'")" == "0" ]] \
  || { echo "S7-L already recorded in _prisma_migrations after the OLD history" >&2; exit 5; }

fi # MODE=bootstrap step 5

# Provenance reads are enforced, never decorative (S5-R3-A-05 / S5-R3B-02): a missing file is a
# refusal (exit 6), not an empty field nested inside an echo.
hash_required() { # <label> <file>
  [[ -f "$2" ]] || { echo "$1 provenance file missing: $2" >&2; exit 6; }
  sha256sum "$2" | cut -c1-64
}
ENGINE=libquery_engine-debian-openssl-3.0.x.so.node
PINNED_ENGINE_SHA="$(hash_required 'pinned @prisma/engines' "$ROOT/node_modules/@prisma/engines/$ENGINE")"
# The runtime a generated client actually executes. The default-output candidate client requires
# `@prisma/client/runtime/library.js` from the pinned package (it has no runtime/ copy of its own);
# a custom-output client (the T client) receives a copy under <output>/runtime/.
PINNED_RUNTIME="$(cd "$ROOT" && node -p 'require("fs").realpathSync(require.resolve("@prisma/client/runtime/library.js"))')"
PINNED_RUNTIME_SHA="$(hash_required 'pinned @prisma/client runtime' "$PINNED_RUNTIME")"

# 6. Independent OLD client generated from the OLD schema (pre-S7-L: no ScoutImport lifecycle fields) into its own directory.
mkdir -p "$G2_S7L_OLD_CLIENT"
PINNED_CLIENT_PKG="$(cd "$ROOT" && node -p 'require("fs").realpathSync(require.resolve("@prisma/client/package.json"))')"
RESOLVED_CLIENT_PKG="$(node -p 'try { require("fs").realpathSync(require.resolve("@prisma/client/package.json", { paths: [process.argv[1]] })) } catch (e) { "UNRESOLVED" }' "$G2_S7L_OLD_CLIENT")"
[[ "$RESOLVED_CLIENT_PKG" == "$PINNED_CLIENT_PKG" ]] \
  || { echo "@prisma/client does not resolve from $G2_S7L_OLD_CLIENT to the pinned tree ($RESOLVED_CLIENT_PKG != $PINNED_CLIENT_PKG); refusing to generate" >&2; exit 6; }
echo "OLD_CLIENT_RESOLUTION pinned=$PINNED_CLIENT_PKG version=$(node -p 'require(process.argv[1]).version' "$PINNED_CLIENT_PKG") skip_autoinstall=$PRISMA_GENERATE_SKIP_AUTOINSTALL"
OLD_SCHEMA_COPY="$G2_S7L_OLD_CLIENT/.schema-for-generate.prisma"
sed "s|provider = \"prisma-client-js\"|provider = \"prisma-client-js\"\n  output   = \"$G2_S7L_OLD_CLIENT\"|" \
  "$G2_S7L_OLD_ROOT/prisma/schema.prisma" > "$OLD_SCHEMA_COPY"
(cd "$G2_S7L_OLD_ROOT" && "$ROOT/node_modules/.bin/prisma" generate --schema "$OLD_SCHEMA_COPY" >/dev/null)
grep -q 'model ScoutReconstructionLedger ' "$G2_S7L_OLD_CLIENT/schema.prisma"
O_ENGINE_SHA="$(hash_required 'generated OLD client engine' "$G2_S7L_OLD_CLIENT/$ENGINE")"
[[ "$O_ENGINE_SHA" == "$PINNED_ENGINE_SHA" ]] \
  || { echo "generated OLD client engine differs from the pinned @prisma/engines copy" >&2; exit 6; }
# The OLD client's copied runtime must be the pinned package runtime: identical bytes, or the pinned
# bytes preceded only by the generator's header (observed 130 B for prisma 6.19.3). Any other
# difference is a refusal; a false refusal here fails closed and is reported, never skipped.
O_RUNTIME="$G2_S7L_OLD_CLIENT/runtime/library.js"
O_RUNTIME_SHA="$(hash_required 'generated OLD client runtime' "$O_RUNTIME")"
PINNED_RUNTIME_SIZE="$(stat -c %s "$PINNED_RUNTIME")"
O_RUNTIME_SIZE="$(stat -c %s "$O_RUNTIME")"
[[ "$O_RUNTIME_SIZE" -ge "$PINNED_RUNTIME_SIZE" ]] && cmp -s <(tail -c "$PINNED_RUNTIME_SIZE" "$O_RUNTIME") "$PINNED_RUNTIME" \
  || { echo "generated OLD client runtime ($O_RUNTIME_SIZE B, $O_RUNTIME_SHA) does not end with the pinned @prisma/client runtime ($PINNED_RUNTIME_SIZE B, $PINNED_RUNTIME_SHA)" >&2; exit 6; }
echo "OLD_CLIENT_GENERATED dir=$G2_S7L_OLD_CLIENT engine_sha256=$O_ENGINE_SHA runtime=$O_RUNTIME runtime_sha256=$O_RUNTIME_SHA runtime_header_bytes=$((O_RUNTIME_SIZE - PINNED_RUNTIME_SIZE)) pinned_runtime=$PINNED_RUNTIME pinned_runtime_sha256=$PINNED_RUNTIME_SHA"
# The OLD client is pre-S7-L: it carries S8-B's ImportNativeProvenance but NO ScoutImport lifecycle
# field, while it carries N's required ledger source_platform.
grep -q 'model ImportNativeProvenance ' "$G2_S7L_OLD_CLIENT/schema.prisma" \
  || { echo "generated OLD client lacks S8-B's ImportNativeProvenance; it is not the accepted S8-B client" >&2; exit 6; }
! awk '/model ScoutImport \{/,/\}/' "$G2_S7L_OLD_CLIENT/schema.prisma" | grep -Eq '^ +(mode|import_intent_id|phase|execution_epoch|fenced_at) +' \
  || { echo "generated OLD client already carries S7-L's ScoutImport lifecycle fields; it is not the OLD client" >&2; exit 6; }
awk '/model ScoutReconstructionLedger \{/,/\}/' "$G2_S7L_OLD_CLIENT/schema.prisma" | grep -Eq 'source_platform +String( |$)' \
  || { echo "generated OLD client lacks N's required ledger source_platform" >&2; exit 6; }

# 7. Candidate (S7-L) client in the candidate root: generated once, before commit, in the
#    isolated copy of the accepted dependency tree (S7-L changes prisma/schema.prisma: the ScoutImport
#    lifecycle fields, its ImportIntent relation and the ImportIntent `runs` back-relation) and only
#    VERIFIED here; no `prisma generate` runs in the bootstrap.
[[ -f "$ROOT/node_modules/.prisma/client/index.d.ts" ]] || { echo "candidate client missing in $ROOT/node_modules/.prisma/client (isolated C1 tree not in place)" >&2; exit 7; }
grep -q 'model ScoutReconstructionLedger ' "$ROOT/node_modules/.prisma/client/schema.prisma" \
  || { echo "candidate client schema lacks ScoutReconstructionLedger; refusing (no regeneration in the bootstrap)" >&2; exit 7; }
CANDIDATE_ENGINE_SHA="$(hash_required 'generated candidate client engine' "$ROOT/node_modules/.prisma/client/$ENGINE")"
[[ "$CANDIDATE_ENGINE_SHA" == "$PINNED_ENGINE_SHA" ]] \
  || { echo "generated candidate client engine differs from the pinned @prisma/engines copy" >&2; exit 6; }
# The runtime the candidate client actually loads, resolved from the generated client directory.
CANDIDATE_RUNTIME="$(node -p 'try { require("fs").realpathSync(require.resolve("@prisma/client/runtime/library.js", { paths: [process.argv[1]] })) } catch (e) { "UNRESOLVED" }' "$ROOT/node_modules/.prisma/client")"
[[ "$CANDIDATE_RUNTIME" == "$PINNED_RUNTIME" ]] \
  || { echo "candidate client runtime resolves to $CANDIDATE_RUNTIME, not the pinned $PINNED_RUNTIME" >&2; exit 6; }
echo "CANDIDATE_CLIENT_VERIFIED dir=$ROOT/node_modules/.prisma/client engine_sha256=$CANDIDATE_ENGINE_SHA runtime=$CANDIDATE_RUNTIME runtime_sha256=$PINNED_RUNTIME_SHA"
# The generated client must be S7-L's: the ScoutImport lifecycle fields and the ImportIntent
# back-relation (the schema hunk that lands on the accepted S8-B head), not a stale pre-S7-L client.
for field in mode import_intent_id phase accepted_start_at deadline_at last_observed_at execution_epoch fenced_at fence_reason reason_code; do
  awk '/model ScoutImport \{/,/\}/' "$ROOT/node_modules/.prisma/client/schema.prisma" | grep -Eq "^ +$field +" \
    || { echo "candidate client ScoutImport lacks $field; the S7-L client was not generated (schema hunk absent?)" >&2; exit 7; }
done
awk '/model ScoutImport \{/,/\}/' "$ROOT/node_modules/.prisma/client/schema.prisma" | grep -Eq '^ +intent +ImportIntent\?' \
  || { echo "candidate client ScoutImport lacks the ImportIntent relation; the S7-L client was not generated (schema hunk absent?)" >&2; exit 7; }
awk '/model ImportIntent \{/,/\}/' "$ROOT/node_modules/.prisma/client/schema.prisma" | grep -Eq '^ +runs +ScoutImport\[\]' \
  || { echo "candidate client ImportIntent lacks the runs back-relation; the S7-L client was not generated (schema hunk absent?)" >&2; exit 7; }
grep -q 'model ImportNativeProvenance ' "$ROOT/node_modules/.prisma/client/schema.prisma" \
  || { echo "candidate client lacks S8-B's ImportNativeProvenance (base regression)" >&2; exit 7; }
awk '/model ScoutReconstructionLedger \{/,/\}/' "$ROOT/node_modules/.prisma/client/schema.prisma" | grep -Eq 'source_platform +String( |$)' \
  || { echo "candidate client does not carry N's required ledger source_platform (inherited from N/Q1)" >&2; exit 7; }

if [[ "$MODE" == generate-only ]]; then echo "G2_S7L_GENERATE_OK"; exit 0; fi   # no connection in this mode
psql_db -c "SELECT json_build_object('database',current_database(),'version',current_setting('server_version_num'),
  'directory',current_setting('data_directory'),'address',inet_server_addr(),'port',inet_server_port(),
  'applied',(SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL))"
echo "G2_S7L_BOOTSTRAP_OK"
