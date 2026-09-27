#!/usr/bin/env bash
# S8-F G2 proof bootstrap, derived by substitution and REDUCTION from the S8-B bootstrap
# test/utils/g2-s8b-bootstrap.sh (unchanged; it keeps governing the S8-B proof). S8-F ships NO
# migration and NO writer, so there is no OLD side, no OLD client and no pending-migration
# choreography here: the disposable database receives the whole accepted history of the candidate
# root (the S8-F reader source composed onto the accepted S8-C head) through `prisma migrate deploy`,
# and the spec then exercises the real readers against seeded synthetic rows. Validation harness
# only: it never touches a hosted or application database and never edits schema/migration/generator
# sources. PREPARED, NOT EXECUTED by the S8-F source-preparation lane.
#
# Required environment (operator; nothing here is read from a checked-in file):
#   G2_S8F_DATABASE_URL  postgresql://s8f_super@127.0.0.1:<port>/g2_s8f_disposable?schema=public&connection_limit=2
#   G2_S8F_CONFIRM       g2_s8f_disposable:<port>
#   G2_S8F_PASSWORD      disposable local fixture password shared by s8f_super/postgres/service_role
#                         (must equal the password the lane superuser was created with)
#   G2_S8F_PSQL          absolute path of a psql binary compatible with the PG17 server
# Optional:
#   G2_S8F_SERVER_VERSION  expected server_version_num (default 170006 = 17.6)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EXPECTED_VERSION="${G2_S8F_SERVER_VERSION:-170006}"
# Distinctive S8-F fixture markers: pinned literals, never read from the environment (see
# test/utils/g2-s8f-db.ts G2_S8F_CLUSTER_MARKER / G2_S8F_DATABASE_MARKER, kept identical by
# test/scout/g2-s8f-db-guard.spec.ts). The lane's postgresql.conf must set
# cluster_name = 's8f-disposable-pg17'; the disposable database carries DB_MARKER as its comment.
CLUSTER_MARKER=s8f-disposable-pg17
DB_MARKER=s8f-g2-native-reader-synthetic-disposable-fixture-safe-to-drop

for name in G2_S8F_DATABASE_URL G2_S8F_CONFIRM G2_S8F_PASSWORD G2_S8F_PSQL; do
  [[ -n "${!name:-}" ]] || { echo "missing $name" >&2; exit 2; }
done
[[ -x "$G2_S8F_PSQL" ]] || { echo "psql binary not executable: $G2_S8F_PSQL" >&2; exit 2; }
# The candidate client must already be generated in the pinned tree (no install/generate here).
[[ -f "$ROOT/node_modules/.prisma/client/schema.prisma" ]] \
  || { echo "candidate Prisma client is not generated in $ROOT/node_modules; generate it in the pinned tree first" >&2; exit 2; }
grep -q 'model ImportNativeProvenance ' "$ROOT/node_modules/.prisma/client/schema.prisma" \
  || { echo "candidate client lacks ImportNativeProvenance; the S8-F readers need the S8-B/S8-C-composed client" >&2; exit 2; }

# Validate the target before opening any connection (same guard as the spec).
eval "$(cd "$ROOT" && node -r ts-node/register/transpile-only -e '
  const { g2S8fTestTarget, withFixturePassword } = require("./test/utils/g2-s8f-db");
  const t = g2S8fTestTarget(process.env.G2_S8F_DATABASE_URL, process.env.G2_S8F_CONFIRM);
  const q = (s) => "\x27" + s.replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
  console.log("PRISMA_URL=" + q(t.prismaUrl)); console.log("PSQL_URL=" + q(t.psqlUrl));
  console.log("MAINT_URL=" + q(t.maintenanceUrl));
  console.log("MIGRATE_AUTH_URL=" + q(withFixturePassword(t.prismaUrl, process.env.G2_S8F_PASSWORD, "postgres")));
')"
export PGPASSWORD="$G2_S8F_PASSWORD"

psql_maint() { "$G2_S8F_PSQL" -X -w -qAt -v ON_ERROR_STOP=1 "$MAINT_URL" "$@"; }
psql_db() { "$G2_S8F_PSQL" -X -w -qAt -v ON_ERROR_STOP=1 "$PSQL_URL" "$@"; }

# 1. Server identity: PostgreSQL 17.x on loopback, expected exact version, superuser bootstrap role.
VERSION="$(psql_maint -c 'SHOW server_version_num')"
ADDRESS="$(psql_maint -c 'SELECT inet_server_addr()')"
[[ "$VERSION" == "$EXPECTED_VERSION" ]] || { echo "server_version_num $VERSION != expected $EXPECTED_VERSION" >&2; exit 3; }
[[ "$ADDRESS" == "127.0.0.1" ]] || { echo "server address $ADDRESS is not loopback" >&2; exit 3; }
[[ "$(psql_maint -c 'SELECT rolsuper FROM pg_roles WHERE rolname=current_user')" == "t" ]] \
  || { echo "bootstrap role must be superuser on the disposable cluster" >&2; exit 3; }
# 1b. Disposable identity marker BEFORE any write: a blank or foreign cluster_name means this is
#     not the S8-F lane initialised for this proof; stop without creating roles or databases.
CLUSTER="$(psql_maint -c "SELECT current_setting('cluster_name')")"
[[ "$CLUSTER" == "$CLUSTER_MARKER" ]] || { echo "cluster_name '$CLUSTER' is not the S8-F fixture marker '$CLUSTER_MARKER'; refusing to touch this server" >&2; exit 3; }
[[ "$(psql_maint -c "SELECT count(*) FROM pg_roles WHERE rolname IN ('supabase_admin','supabase_auth_admin','supabase_storage_admin','authenticator','pgbouncer')")" == "0" ]] \
  || { echo "server carries hosted-platform roles; not a synthetic fixture" >&2; exit 3; }

# 2. Explicit fixture role matrix (identical shape to the S8-B/N/Q1/S1 fixtures):
#      postgres      LOGIN NOSUPERUSER CREATEDB CREATEROLE BYPASSRLS  (owner + migrator + seeder)
#      service_role  BYPASSRLS runtime role (+ harness-only LOGIN for the reader worker processes)
#      anon/authenticated  NOLOGIN API roles (RLS denial via SET ROLE)
psql_maint -v pw="$G2_S8F_PASSWORD" <<'SQL'
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
#    Stamped with DB_MARKER at creation; a same-named database without exactly that comment is
#    foreign and refused (never repaired, never dropped here).
if [[ "$(psql_maint -c "SELECT count(*) FROM pg_database WHERE datname='g2_s8f_disposable'")" == "0" ]]; then
  psql_maint -c 'CREATE DATABASE g2_s8f_disposable OWNER postgres'
  psql_maint -v marker="$DB_MARKER" <<'SQL'
COMMENT ON DATABASE g2_s8f_disposable IS :'marker';
SQL
fi
EXISTING_MARKER="$(psql_maint -c "SELECT COALESCE(shobj_description(oid,'pg_database'),'') FROM pg_database WHERE datname='g2_s8f_disposable'")"
[[ "$EXISTING_MARKER" == "$DB_MARKER" ]] \
  || { echo "g2_s8f_disposable exists without the S8-F disposable marker comment; refusing to reuse it" >&2; exit 3; }
psql_maint -c 'ALTER DATABASE g2_s8f_disposable OWNER TO postgres'
[[ "$(psql_db -c "SELECT count(*) FROM pg_tables WHERE schemaname='public'")" == "0" ]] \
  || { echo "g2_s8f_disposable already has public tables; reset it explicitly before bootstrapping again" >&2; exit 3; }
psql_db -c 'ALTER SCHEMA public OWNER TO postgres; GRANT USAGE, CREATE ON SCHEMA public TO postgres;'
# Verbatim CI shim (roles already exist; adds auth schema/helpers and GRANT ... TO postgres).
psql_db -f "$ROOT/scripts/ci/supabase-shim.sql" >/dev/null
psql_db -c 'GRANT USAGE ON SCHEMA auth TO postgres, anon, authenticated, service_role;'
psql_db -c 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;'
psql_db -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS "uuid-ossp"; CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS btree_gist; CREATE EXTENSION IF NOT EXISTS pg_stat_statements;'

# 4. Whole accepted history of the CANDIDATE root through the real release mechanism. S8-F adds no
#    migration, so the candidate's migrations directory must be exactly the composed head's.
git -C "$ROOT" diff --quiet HEAD -- prisma/migrations prisma/schema.prisma \
  || { echo "candidate has uncommitted schema/migration changes; S8-F must not carry any" >&2; exit 4; }
(cd "$ROOT" && DATABASE_URL="$MIGRATE_AUTH_URL" DIRECT_URL="$MIGRATE_AUTH_URL" \
  "$ROOT/node_modules/.bin/prisma" migrate deploy --schema prisma/schema.prisma)
TRACKED="$(find "$ROOT/prisma/migrations" -mindepth 1 -maxdepth 1 -type d | wc -l)"
APPLIED="$(psql_db -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")"
[[ "$APPLIED" == "$TRACKED" ]] || { echo "applied $APPLIED migrations, candidate tracks $TRACKED" >&2; exit 5; }
# The readers' native joins need the S8-B catalog shape to be present after the history.
[[ "$(psql_db -c "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename='ImportNativeProvenance'")" == "1" ]] \
  || { echo "ImportNativeProvenance is absent after the accepted history; not the S8-B-composed head" >&2; exit 5; }
[[ "$(psql_db -c "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='ScoutReconstructionLedger' AND column_name='target_kind'")" == "1" ]] \
  || { echo "ScoutReconstructionLedger.target_kind is absent after the accepted history; not the S8-B-composed head" >&2; exit 5; }

psql_db -c "SELECT json_build_object('database',current_database(),'version',current_setting('server_version'),
  'cluster',current_setting('cluster_name'),'marker',shobj_description((SELECT oid FROM pg_database WHERE datname=current_database()),'pg_database'),
  'applied',(SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL))"
echo "G2_S8F_BOOTSTRAP_OK"
