#!/usr/bin/env bash
# S11 G2 proof bootstrap (the ONE S11 harness, docs/decisions/2026-09-26-s11-journey.md D-S11-6),
# derived by literal substitution from the landed S9-C bootstrap test/utils/g2-s9c-bootstrap.sh
# (as landed at 92b96715, unchanged) for the S11-only disposable cluster/database; only the lane
# descriptor and base pin differ. S11-A1 ships NO migration: the candidate's prisma tree must be
# byte-identical to the base 711c1f8f (S10-A → S10-B → S10-D D1 → S11-0 record; the landed S10-B
# prisma tree), so there is no OLD side here. The full accepted history (173 migrations, S8-B, S7-L
# and S10-B included; the last is S10-B) is installed from the
# CANDIDATE root through the real release mechanism (`prisma migrate deploy`), and the S11 specs then
# drive the candidate journey (real pairing, lifecycle, ingest, progress, settle and read services,
# two worker processes = two server hosts) against it.
# Validation harness only: it never touches a hosted or application database, never edits
# schema/migration/generator sources, and stops on the first unexpected state instead of
# repairing it.
#
# Required environment (all explicit; nothing is inferred from DATABASE_URL):
#   G2_S11_DATABASE_URL  postgresql://s11_super@127.0.0.1:<port>/g2_s11_disposable?schema=public&connection_limit=2
#   G2_S11_CONFIRM       g2_s11_disposable:<port>
#   G2_S11_PASSWORD      disposable local fixture password shared by s11_super/postgres/service_role
#                         (never written to a file by this harness; only into process env / in-memory URLs)
#   G2_S11_PSQL          absolute path of a psql binary compatible with the PG17 server
#   G2_S11_CANDIDATE_HEAD  the attested final candidate head (40 hex); the runtime root must be
#                        checked out exactly there and clean, and it must not be the base itself
# Optional:
#   G2_S11_SERVER_VERSION  expected server_version_num (default 170006 = 17.6)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Base pin (kept identical in test/utils/g2-s11-pg-harness.ts and test/utils/g2-s11-db-guard.spec.ts).
BASE_HEAD=711c1f8f8b42157bca97f2a721557be7ef006667
S8B_MIGRATION=20270122000000_scout_native_provenance_expand
S7L_MIGRATION=20270123000000_scout_run_lifecycle_expand
S10B_MIGRATION=20270124000000_scout_run_observation_expand
# 172 accepted migrations through S8-B and S7-L plus S10-B = 173 tracked by the base (the last
# directory is S10-B's); S11-A1 adds none.
EXPECTED_MIGRATIONS=173
S10B_TABLES="ScoutRunDeclaration ScoutRunObservation ScoutRunSettledBasis"
EXPECTED_VERSION="${G2_S11_SERVER_VERSION:-170006}"
# Distinctive S11 fixture markers: pinned literals, never read from the environment (see
# test/utils/g2-s11-db.ts G2_S11_CLUSTER_MARKER / G2_S11_DATABASE_MARKER, kept identical by
# test/utils/g2-s11-db-guard.spec.ts). The lane's postgresql.conf must set
# cluster_name = 's11-disposable-pg17'; the disposable database carries DB_MARKER as its comment.
CLUSTER_MARKER=s11-disposable-pg17
DB_MARKER=s11-g2-journey-multi-host-synthetic-disposable-fixture-safe-to-drop

for name in G2_S11_DATABASE_URL G2_S11_CONFIRM G2_S11_PASSWORD G2_S11_PSQL G2_S11_CANDIDATE_HEAD; do
  [[ -n "${!name:-}" ]] || { echo "missing $name" >&2; exit 2; }
done
# Candidate binding (mirrors g2S11CandidateHead in test/utils/g2-s11-db.ts): one attested head, clean.
[[ "$G2_S11_CANDIDATE_HEAD" =~ ^[0-9a-f]{40}$ ]] || { echo "G2_S11_CANDIDATE_HEAD is not a 40-hex commit id" >&2; exit 2; }
[[ "$G2_S11_CANDIDATE_HEAD" != "$BASE_HEAD" ]] || { echo "G2_S11_CANDIDATE_HEAD is the accepted base, not a candidate" >&2; exit 2; }
ACTUAL_HEAD="$(git -C "$ROOT" rev-parse HEAD)"
[[ "$ACTUAL_HEAD" == "$G2_S11_CANDIDATE_HEAD" ]] || { echo "runtime root $ROOT is at $ACTUAL_HEAD, not the attested candidate $G2_S11_CANDIDATE_HEAD" >&2; exit 2; }
[[ -z "$(git -C "$ROOT" status --porcelain)" ]] || { echo "runtime root $ROOT has uncommitted changes; the attested head must be checked out clean" >&2; exit 2; }
git -C "$ROOT" merge-base --is-ancestor "$BASE_HEAD" "$ACTUAL_HEAD" || { echo "candidate $ACTUAL_HEAD does not descend from base $BASE_HEAD" >&2; exit 2; }
echo "CANDIDATE_HEAD=$ACTUAL_HEAD"
[[ -x "$G2_S11_PSQL" ]] || { echo "psql binary not executable: $G2_S11_PSQL" >&2; exit 2; }
[[ -d "$ROOT/node_modules/prisma" ]] || { echo "node_modules missing in $ROOT (the isolated copy of the accepted dependency tree must be in place first; no npm ci)" >&2; exit 2; }
# Dependency provenance is closed: nothing in this harness may auto-install.
export PRISMA_GENERATE_SKIP_AUTOINSTALL=1

# Validate the target before opening any connection (same guard as the spec).
eval "$(cd "$ROOT" && node -r ts-node/register/transpile-only -e '
  const { g2S11TestTarget, withFixturePassword } = require("./test/utils/g2-s11-db");
  const t = g2S11TestTarget(process.env.G2_S11_DATABASE_URL, process.env.G2_S11_CONFIRM);
  const q = (s) => "\x27" + s.replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
  console.log("PRISMA_URL=" + q(t.prismaUrl)); console.log("PSQL_URL=" + q(t.psqlUrl));
  console.log("MAINT_URL=" + q(t.maintenanceUrl));
  console.log("MIGRATE_AUTH_URL=" + q(withFixturePassword(t.prismaUrl, process.env.G2_S11_PASSWORD, "postgres")));
')"
export PGPASSWORD="$G2_S11_PASSWORD"

psql_maint() { "$G2_S11_PSQL" -X -w -qAt -v ON_ERROR_STOP=1 "$MAINT_URL" "$@"; }
psql_db() { "$G2_S11_PSQL" -X -w -qAt -v ON_ERROR_STOP=1 "$PSQL_URL" "$@"; }

MODE="${1:-bootstrap}"
case "$MODE" in bootstrap|verify-only) ;; *) echo "usage: g2-s11-bootstrap.sh [bootstrap|verify-only]" >&2; exit 2;; esac
if [[ "$MODE" == bootstrap ]]; then
# 1. Server identity: PostgreSQL 17.x on loopback, expected exact version.
VERSION="$(psql_maint -c 'SHOW server_version_num')"
ADDRESS="$(psql_maint -c 'SELECT inet_server_addr()')"
[[ "$VERSION" == "$EXPECTED_VERSION" ]] || { echo "server_version_num $VERSION != expected $EXPECTED_VERSION" >&2; exit 3; }
[[ "$ADDRESS" == "127.0.0.1" ]] || { echo "server address $ADDRESS is not loopback" >&2; exit 3; }
[[ "$(psql_maint -c 'SELECT rolsuper FROM pg_roles WHERE rolname=current_user')" == "t" ]] \
  || { echo "bootstrap role must be superuser on the disposable cluster" >&2; exit 3; }
# 1b. Disposable identity marker BEFORE any write: a blank or foreign cluster_name means this is
#     not the S11 lane initialised for this proof; stop without creating roles or databases.
CLUSTER="$(psql_maint -c "SELECT current_setting('cluster_name')")"
[[ "$CLUSTER" == "$CLUSTER_MARKER" ]] || { echo "cluster_name '$CLUSTER' is not the S11 fixture marker '$CLUSTER_MARKER'; refusing to touch this server" >&2; exit 3; }
[[ "$(psql_maint -c "SELECT count(*) FROM pg_roles WHERE rolname IN ('supabase_admin','supabase_auth_admin','supabase_storage_admin','authenticator','pgbouncer')")" == "0" ]] \
  || { echo "server carries hosted-platform roles; not a synthetic fixture" >&2; exit 3; }

# 2. Explicit fixture role matrix (cluster-level, disposable lane only; shape
#    mirrors S1's Supabase-like fixture and the hosted role model):
#      postgres      LOGIN NOSUPERUSER CREATEDB CREATEROLE BYPASSRLS  (owner + migrator)
#      service_role  BYPASSRLS runtime role (+ harness-only LOGIN for worker processes)
#      anon/authenticated  NOLOGIN API roles (RLS denial via SET ROLE)
#    All fixture logins share the one synthetic password from the environment.
psql_maint -v pw="$G2_S11_PASSWORD" <<'SQL'
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
#    by the operator (DROP DATABASE g2_s11_disposable as the cluster superuser) first.
#    The database is stamped with DB_MARKER at creation; an existing database of the same name
#    without exactly that comment is foreign and is refused (never repaired, never dropped here).
if [[ "$(psql_maint -c "SELECT count(*) FROM pg_database WHERE datname='g2_s11_disposable'")" == "0" ]]; then
  psql_maint -c 'CREATE DATABASE g2_s11_disposable OWNER postgres'
  psql_maint -v marker="$DB_MARKER" <<'SQL'
COMMENT ON DATABASE g2_s11_disposable IS :'marker';
SQL
fi
EXISTING_MARKER="$(psql_maint -c "SELECT COALESCE(shobj_description(oid,'pg_database'),'') FROM pg_database WHERE datname='g2_s11_disposable'")"
[[ "$EXISTING_MARKER" == "$DB_MARKER" ]] \
  || { echo "g2_s11_disposable exists without the S11 disposable marker comment; refusing to reuse it" >&2; exit 3; }
psql_maint -c 'ALTER DATABASE g2_s11_disposable OWNER TO postgres'
[[ "$(psql_db -c "SELECT count(*) FROM pg_tables WHERE schemaname='public'")" == "0" ]] \
  || { echo "g2_s11_disposable already has public tables; reset it explicitly before bootstrapping again" >&2; exit 3; }
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

# 4. Candidate source: S11-A1 ships no migration. The prisma tree (schema + migrations) must be
#    byte-identical to the base and track exactly the accepted 173 directories, S8-B, S7-L and S10-B
#    included, with S10-B's as the last (sorted) directory.
git -C "$ROOT" cat-file -e "$BASE_HEAD^{commit}" || { echo "base $BASE_HEAD unknown in $ROOT" >&2; exit 4; }
[[ -z "$(git -C "$ROOT" diff --name-only "$BASE_HEAD" HEAD -- prisma)" ]] \
  || { echo "candidate prisma tree differs from base $BASE_HEAD; S11-A1 must ship no schema/migration change" >&2; exit 4; }
git -C "$ROOT" diff --quiet HEAD -- prisma || { echo "candidate has uncommitted prisma changes" >&2; exit 4; }
git -C "$ROOT" diff --quiet "$BASE_HEAD" HEAD -- package.json package-lock.json \
  || { echo "dependency manifests differ from base; the isolated dependency tree is unsafe" >&2; exit 4; }
COUNT="$(find "$ROOT/prisma/migrations" -mindepth 1 -maxdepth 1 -type d | wc -l)"
[[ "$COUNT" == "$EXPECTED_MIGRATIONS" ]] || { echo "candidate has $COUNT migrations, expected $EXPECTED_MIGRATIONS" >&2; exit 4; }
[[ -f "$ROOT/prisma/migrations/$S8B_MIGRATION/migration.sql" ]] || { echo "candidate lacks the accepted S8-B migration" >&2; exit 4; }
[[ -f "$ROOT/prisma/migrations/$S7L_MIGRATION/migration.sql" ]] || { echo "candidate lacks the accepted S7-L migration" >&2; exit 4; }
[[ -f "$ROOT/prisma/migrations/$S10B_MIGRATION/migration.sql" ]] || { echo "candidate lacks the accepted S10-B migration" >&2; exit 4; }
LAST_MIGRATION="$(find "$ROOT/prisma/migrations" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | LC_ALL=C sort | tail -n 1)"
[[ "$LAST_MIGRATION" == "$S10B_MIGRATION" ]] || { echo "last migration is $LAST_MIGRATION, expected S10-B's $S10B_MIGRATION" >&2; exit 4; }

if [[ "$MODE" == bootstrap ]]; then
# 5. Full accepted history (S8-B and S7-L included) through the real release mechanism from the candidate root.
#    Runs as the non-superuser BYPASSRLS `postgres` role (owner), never as the cluster superuser.
(cd "$ROOT" && DATABASE_URL="$MIGRATE_AUTH_URL" DIRECT_URL="$MIGRATE_AUTH_URL" \
  "$ROOT/node_modules/.bin/prisma" migrate deploy --schema prisma/schema.prisma)
[[ "$(psql_db -c "SELECT count(DISTINCT tableowner) FROM pg_tables WHERE schemaname='public'")" == "1" ]] \
  && [[ "$(psql_db -c "SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname='public'")" == "postgres" ]] \
  || { echo "public tables are not all owned by postgres" >&2; exit 5; }
APPLIED="$(psql_db -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")"
[[ "$APPLIED" == "$EXPECTED_MIGRATIONS" ]] || { echo "accepted history applied $APPLIED migrations, expected $EXPECTED_MIGRATIONS" >&2; exit 5; }
[[ "$(psql_db -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name='$S8B_MIGRATION' AND finished_at IS NOT NULL")" == "1" ]] \
  || { echo "S8-B not recorded as applied" >&2; exit 5; }
[[ "$(psql_db -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name='$S7L_MIGRATION' AND finished_at IS NOT NULL")" == "1" ]] \
  || { echo "S7-L not recorded as applied" >&2; exit 5; }
[[ "$(psql_db -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name='$S10B_MIGRATION' AND finished_at IS NOT NULL")" == "1" ]] \
  || { echo "S10-B not recorded as applied" >&2; exit 5; }
# S10-B tables must be PRESENT with RLS ENABLED AND FORCED (the landed base; fix 3). S11-A1 writes
# them only as a posture fixture: their insert-only triggers pass only the parent-run ON DELETE
# CASCADE the fixture reset uses.
for rel in $S10B_TABLES; do
  [[ "$(psql_db -c "SELECT relrowsecurity::text || '/' || relforcerowsecurity::text FROM pg_class WHERE oid=to_regclass('public.\"$rel\"')")" == "true/true" ]] \
    || { echo "S10-B table $rel absent, or RLS not enabled and forced, after the accepted history" >&2; exit 5; }
done
# S7-L run objects the S8-G/S11 settle path depends on must be PRESENT (the accepted target of this slice).
for col in mode import_intent_id phase accepted_start_at deadline_at last_observed_at execution_epoch fenced_at fence_reason reason_code; do
  [[ "$(psql_db -c "SELECT count(*) FROM pg_attribute WHERE attrelid='public.\"ScoutImport\"'::regclass AND attname='$col' AND NOT attisdropped")" == "1" ]] \
    || { echo "ScoutImport lacks S7-L's $col" >&2; exit 5; }
done
# S8-B objects the S8-G writer and the S9-B facts reader depend on must be PRESENT (the accepted target of this slice).
[[ "$(psql_db -c "SELECT to_regclass('public.\"ImportNativeProvenance\"') IS NOT NULL")" == "t" ]] \
  || { echo "ImportNativeProvenance absent after the accepted history" >&2; exit 5; }
[[ "$(psql_db -c "SELECT count(*) FROM pg_attribute WHERE attrelid='public.\"ScoutReconstructionLedger\"'::regclass AND attname='target_kind' AND NOT attisdropped")" == "1" ]] \
  || { echo "ScoutReconstructionLedger lacks S8-B's target_kind" >&2; exit 5; }
[[ "$(psql_db -c "SELECT count(*) FROM pg_constraint WHERE conrelid='public.\"ImportNativeProvenance\"'::regclass AND contype='c'")" -ge "3" ]] \
  || { echo "ImportNativeProvenance CHECK constraints absent" >&2; exit 5; }
for rel in WorkoutProgram WorkoutPlan WorkoutPlanExercise WorkoutPlanRevision ExerciseCatalogItem ScoutReconstructedEntity; do
  [[ "$(psql_db -c "SELECT to_regclass('public.\"$rel\"') IS NOT NULL")" == "t" ]] || { echo "$rel absent after the accepted history" >&2; exit 5; }
done
fi # MODE=bootstrap step 5

# Provenance reads are enforced, never decorative: a missing file is a refusal (exit 6).
hash_required() { # <label> <file>
  [[ -f "$2" ]] || { echo "$1 provenance file missing: $2" >&2; exit 6; }
  sha256sum "$2" | cut -c1-64
}
ENGINE=libquery_engine-debian-openssl-3.0.x.so.node
PINNED_ENGINE_SHA="$(hash_required 'pinned @prisma/engines' "$ROOT/node_modules/@prisma/engines/$ENGINE")"
PINNED_RUNTIME="$(cd "$ROOT" && node -p 'require("fs").realpathSync(require.resolve("@prisma/client/runtime/library.js"))')"
PINNED_RUNTIME_SHA="$(hash_required 'pinned @prisma/client runtime' "$PINNED_RUNTIME")"

# 6. Candidate client in the candidate root: generated once by the runtime setup (the schema is
#    the base schema, so it is the accepted S10-B client) and only VERIFIED here; no `prisma generate`.
[[ -f "$ROOT/node_modules/.prisma/client/index.d.ts" ]] || { echo "candidate client missing in $ROOT/node_modules/.prisma/client (isolated tree not in place)" >&2; exit 7; }
CANDIDATE_ENGINE_SHA="$(hash_required 'generated candidate client engine' "$ROOT/node_modules/.prisma/client/$ENGINE")"
[[ "$CANDIDATE_ENGINE_SHA" == "$PINNED_ENGINE_SHA" ]] \
  || { echo "generated candidate client engine differs from the pinned @prisma/engines copy" >&2; exit 6; }
CANDIDATE_RUNTIME="$(node -p 'try { require("fs").realpathSync(require.resolve("@prisma/client/runtime/library.js", { paths: [process.argv[1]] })) } catch (e) { "UNRESOLVED" }' "$ROOT/node_modules/.prisma/client")"
[[ "$CANDIDATE_RUNTIME" == "$PINNED_RUNTIME" ]] \
  || { echo "candidate client runtime resolves to $CANDIDATE_RUNTIME, not the pinned $PINNED_RUNTIME" >&2; exit 6; }
# The generated client copy is normalized by Prisma (never byte-equal to prisma/schema.prisma), so it
# is verified STRUCTURALLY: it must carry the accepted S7-L run fields and relation, S8-B's provenance
# model and target_kind, and N's ledger source_platform. A stale pre-S7-L client is refused (exit 7).
[[ -f "$ROOT/node_modules/.prisma/client/schema.prisma" ]] \
  || { echo "candidate client schema copy missing in $ROOT/node_modules/.prisma/client (isolated tree not in place)" >&2; exit 7; }
for field in mode import_intent_id phase accepted_start_at deadline_at last_observed_at execution_epoch fenced_at fence_reason reason_code; do
  awk '/model ScoutImport \{/,/\}/' "$ROOT/node_modules/.prisma/client/schema.prisma" | grep -Eq "^ +$field +" \
    || { echo "candidate client ScoutImport lacks $field; a pre-S7-L client (stale generated client)" >&2; exit 7; }
done
awk '/model ScoutImport \{/,/\}/' "$ROOT/node_modules/.prisma/client/schema.prisma" | grep -Eq '^ +intent +ImportIntent\?' \
  || { echo "candidate client ScoutImport lacks the ImportIntent relation (stale generated client)" >&2; exit 7; }
grep -q 'model ImportNativeProvenance ' "$ROOT/node_modules/.prisma/client/schema.prisma" \
  || { echo "candidate client lacks ImportNativeProvenance (pre-S8-B client)" >&2; exit 7; }
awk '/model ScoutReconstructionLedger \{/,/\}/' "$ROOT/node_modules/.prisma/client/schema.prisma" | grep -Eq '^ +target_kind +String\?' \
  || { echo "candidate client ledger lacks target_kind String? (pre-S8-B client)" >&2; exit 7; }
awk '/model ScoutReconstructionLedger \{/,/\}/' "$ROOT/node_modules/.prisma/client/schema.prisma" | grep -Eq 'source_platform +String( |$)' \
  || { echo "candidate client does not carry N's required ledger source_platform" >&2; exit 7; }
awk '/model ScoutIngestEntity \{/,/\}/' "$ROOT/node_modules/.prisma/client/schema.prisma" | grep -Eq '^ +entity_type +String( |$)' \
  || { echo "candidate client staged rows lack entity_type" >&2; exit 7; }
for model in $S10B_TABLES; do
  grep -q "model $model " "$ROOT/node_modules/.prisma/client/schema.prisma" \
    || { echo "candidate client lacks $model (pre-S10-B client)" >&2; exit 7; }
done
echo "CANDIDATE_CLIENT_VERIFIED dir=$ROOT/node_modules/.prisma/client engine_sha256=$CANDIDATE_ENGINE_SHA runtime=$CANDIDATE_RUNTIME runtime_sha256=$PINNED_RUNTIME_SHA"

if [[ "$MODE" == verify-only ]]; then echo "G2_S11_VERIFY_OK"; exit 0; fi   # no connection in this mode
psql_db -c "SELECT json_build_object('database',current_database(),'version',current_setting('server_version_num'),
  'directory',current_setting('data_directory'),'address',inet_server_addr(),'port',inet_server_port(),
  'applied',(SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL))"
echo "G2_S11_BOOTSTRAP_OK"
