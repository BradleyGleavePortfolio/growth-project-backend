#!/usr/bin/env bash
# S5 G2 proof bootstrap for the dedicated disposable database on S1's isolated
# PostgreSQL 17 server. Validation harness only: it never touches a hosted or
# application database, never edits schema/migration/generator sources, and
# stops on the first unexpected state instead of repairing it.
#
# Required environment (all explicit; nothing is inferred from DATABASE_URL):
#   G2_PG17_DATABASE_URL  postgresql://s5_super@127.0.0.1:<port>/g2_s5_etq0_disposable?schema=public&connection_limit=2
#   G2_PG17_CONFIRM       g2_s5_etq0_disposable:<port>
#   G2_PG17_PASSWORD      S1's disposable local fixture password (never written to a file or URL by this harness)
#   G2_PG17_PSQL          absolute path of a psql binary compatible with the PG17 server
#   G2_PG17_OLD_ROOT      checkout of the preserved O source 925780e0 (git worktree)
#   G2_PG17_OLD_CLIENT    directory that receives the independently generated O Prisma client
# Optional:
#   G2_PG17_SERVER_VERSION  expected server_version_num (default 170006 = 17.6)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OLD_HEAD=925780e0a1906593e5383c618311b6b17364b8dc
E_MIGRATION=20270118000000_scout_ledger_platform_expand
EXPECTED_VERSION="${G2_PG17_SERVER_VERSION:-170006}"

for name in G2_PG17_DATABASE_URL G2_PG17_CONFIRM G2_PG17_PASSWORD G2_PG17_PSQL G2_PG17_OLD_ROOT G2_PG17_OLD_CLIENT; do
  [[ -n "${!name:-}" ]] || { echo "missing $name" >&2; exit 2; }
done
[[ -x "$G2_PG17_PSQL" ]] || { echo "psql binary not executable: $G2_PG17_PSQL" >&2; exit 2; }
[[ -d "$ROOT/node_modules/prisma" ]] || { echo "node_modules missing in $ROOT (run npm ci under the heavy lock first)" >&2; exit 2; }

# Validate the target before opening any connection (same guard as the spec).
eval "$(cd "$ROOT" && node -r ts-node/register/transpile-only -e '
  const { g2Pg17TestTarget } = require("./test/utils/g2-pg17-db");
  const t = g2Pg17TestTarget(process.env.G2_PG17_DATABASE_URL, process.env.G2_PG17_CONFIRM);
  const q = (s) => "\x27" + s.replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
  console.log("PRISMA_URL=" + q(t.prismaUrl)); console.log("PSQL_URL=" + q(t.psqlUrl));
  console.log("MAINT_URL=" + q(t.maintenanceUrl));
  const { withFixturePassword } = require("./test/utils/g2-pg17-db");
  console.log("PRISMA_AUTH_URL=" + q(withFixturePassword(t.prismaUrl, process.env.G2_PG17_PASSWORD)));
')"
export PGPASSWORD="$G2_PG17_PASSWORD"

psql_maint() { "$G2_PG17_PSQL" -X -w -qAt -v ON_ERROR_STOP=1 "$MAINT_URL" "$@"; }
psql_db() { "$G2_PG17_PSQL" -X -w -qAt -v ON_ERROR_STOP=1 "$PSQL_URL" "$@"; }

# 1. Server identity: PostgreSQL 17.x on loopback, expected exact version.
VERSION="$(psql_maint -c 'SHOW server_version_num')"
ADDRESS="$(psql_maint -c 'SELECT inet_server_addr()')"
[[ "$VERSION" == "$EXPECTED_VERSION" ]] || { echo "server_version_num $VERSION != expected $EXPECTED_VERSION" >&2; exit 3; }
[[ "$ADDRESS" == "127.0.0.1" ]] || { echo "server address $ADDRESS is not loopback" >&2; exit 3; }
[[ "$(psql_maint -c 'SELECT rolsuper FROM pg_roles WHERE rolname=current_user')" == "t" ]] \
  || { echo "bootstrap role must be superuser on the disposable cluster" >&2; exit 3; }

# 2. Dedicated database (create once; never drop anything).
if [[ "$(psql_maint -c "SELECT count(*) FROM pg_database WHERE datname='g2_s5_etq0_disposable'")" == "0" ]]; then
  psql_maint -c 'CREATE DATABASE g2_s5_etq0_disposable'
fi

# 3. CI-only Supabase shim (roles, auth schema/helpers) from the candidate root,
#    plus harness-only LOGIN for service_role so worker processes can connect as
#    the runtime role over loopback trust. Neither is ever applied to Supabase.
psql_db -f "$ROOT/scripts/ci/supabase-shim.sql" >/dev/null
psql_db -c "GRANT anon, authenticated, service_role TO s5_super;"
printf '%s\n' "ALTER ROLE service_role LOGIN PASSWORD :'pw';" | psql_db -v pw="$G2_PG17_PASSWORD"

# 4. Preserved O source: exact head, shared dependency tree, 164 base migrations.
[[ "$(git -C "$G2_PG17_OLD_ROOT" rev-parse HEAD)" == "$OLD_HEAD" ]] || { echo "old root is not $OLD_HEAD" >&2; exit 4; }
git -C "$G2_PG17_OLD_ROOT" diff --quiet HEAD -- package.json package-lock.json src prisma \
  || { echo "old root has uncommitted source/dependency changes" >&2; exit 4; }
git -C "$ROOT" diff --quiet "$OLD_HEAD" HEAD -- package.json package-lock.json \
  || { echo "dependency manifests differ between O and candidate; a shared node_modules is unsafe" >&2; exit 4; }
[[ -e "$G2_PG17_OLD_ROOT/node_modules" ]] || ln -s "$ROOT/node_modules" "$G2_PG17_OLD_ROOT/node_modules"
[[ ! -d "$G2_PG17_OLD_ROOT/prisma/migrations/$E_MIGRATION" ]] || { echo "old root unexpectedly contains E" >&2; exit 4; }
OLD_COUNT="$(find "$G2_PG17_OLD_ROOT/prisma/migrations" -mindepth 1 -maxdepth 1 -type d | wc -l)"
[[ "$OLD_COUNT" == "164" ]] || { echo "old root has $OLD_COUNT migrations, expected 164" >&2; exit 4; }

# 5. Full base history through the real release mechanism on the O schema.
(cd "$G2_PG17_OLD_ROOT" && DATABASE_URL="$PRISMA_AUTH_URL" DIRECT_URL="$PRISMA_AUTH_URL" \
  "$ROOT/node_modules/.bin/prisma" migrate deploy --schema prisma/schema.prisma)
APPLIED="$(psql_db -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")"
[[ "$APPLIED" == "164" ]] || { echo "base history applied $APPLIED migrations, expected 164" >&2; exit 5; }
[[ "$(psql_db -c "SELECT count(*) FROM pg_attribute WHERE attrelid='public.\"ScoutReconstructionLedger\"'::regclass AND attname='source_platform' AND NOT attisdropped")" == "0" ]] \
  || { echo "ledger already has source_platform before E" >&2; exit 5; }

# 6. Independent O client generated from the O schema into its own directory.
mkdir -p "$G2_PG17_OLD_CLIENT"
OLD_SCHEMA_COPY="$G2_PG17_OLD_CLIENT/.schema-for-generate.prisma"
sed "s|provider = \"prisma-client-js\"|provider = \"prisma-client-js\"\n  output   = \"$G2_PG17_OLD_CLIENT\"|" \
  "$G2_PG17_OLD_ROOT/prisma/schema.prisma" > "$OLD_SCHEMA_COPY"
(cd "$G2_PG17_OLD_ROOT" && "$ROOT/node_modules/.bin/prisma" generate --schema "$OLD_SCHEMA_COPY" >/dev/null)
grep -q 'model ScoutReconstructionLedger' "$G2_PG17_OLD_CLIENT/schema.prisma"
! awk '/model ScoutReconstructionLedger \{/,/\}/' "$G2_PG17_OLD_CLIENT/schema.prisma" | grep -q source_platform \
  || { echo "generated O client unexpectedly knows source_platform" >&2; exit 6; }

# 7. Candidate (E/T) client in the candidate root.
(cd "$ROOT" && ./node_modules/.bin/prisma generate >/dev/null)
awk '/model ScoutReconstructionLedger \{/,/\}/' "$ROOT/node_modules/.prisma/client/schema.prisma" | grep -q 'source_platform' \
  || { echo "candidate client lacks source_platform" >&2; exit 7; }

psql_db -c "SELECT json_build_object('database',current_database(),'version',current_setting('server_version_num'),
  'directory',current_setting('data_directory'),'address',inet_server_addr(),'port',inet_server_port(),
  'applied',(SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL))"
echo "G2_PG17_BOOTSTRAP_OK"
