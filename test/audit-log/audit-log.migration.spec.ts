/**
 * H6 — audit_log migration + schema static integrity (D-H6-1 LOCKED).
 *
 * STATIC assertions (always run, no database required), mirroring the pattern
 * of test/roman-coach-reviewed-migration.spec.ts: read the migration.sql,
 * down.sql, and schema.prisma off disk and assert the LOCKED 13-column shape,
 * the DB-level append-only REVOKE statements, RLS enablement (R125 tier 1),
 * the three indexes, and that down.sql reverses the forward migration
 * operation-for-operation. Anyone editing the SQL or the schema must mirror
 * the change here or explain why it broke.
 *
 * A genuine Postgres up/down roundtrip belongs in the disposable-DB backlog
 * alongside the other live migration tests; this lane ships the static layer
 * (the migration is additive DDL only, so the down path is a mechanical DROP
 * POLICY / DROP INDEX / DROP TABLE captured in down.sql).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const MIGRATION_DIR = join(ROOT, 'prisma', 'migrations', '20261226000000_create_audit_log');

function readMigrationSql(): string {
  return readFileSync(join(MIGRATION_DIR, 'migration.sql'), 'utf8');
}
function readDownSql(): string {
  return readFileSync(join(MIGRATION_DIR, 'down.sql'), 'utf8');
}
function readSchema(): string {
  return readFileSync(join(ROOT, 'prisma', 'schema.prisma'), 'utf8');
}

// The 13 LOCKED columns (D-H6-1), in declared order.
const COLUMNS = [
  'id',
  'tenant_id',
  'actor_id',
  'actor_type',
  'action',
  'resource_type',
  'resource_id',
  'before_state',
  'after_state',
  'reason',
  'request_id',
  'ip_address',
  'created_at',
];

describe('H6 audit_log migration — static integrity (D-H6-1)', () => {
  const sql = readMigrationSql();
  const down = readDownSql();
  const schema = readSchema();

  describe('migration.sql forward DDL', () => {
    it('creates the audit_log table', () => {
      expect(sql).toMatch(/CREATE TABLE audit_log/);
    });

    it('declares all 13 LOCKED columns', () => {
      // Slice to the CREATE TABLE block so we count the column declarations,
      // not incidental mentions elsewhere in the file.
      const start = sql.indexOf('CREATE TABLE audit_log');
      const block = sql.slice(start, sql.indexOf(');', start));
      for (const col of COLUMNS) {
        expect(block).toMatch(new RegExp(`\\b${col}\\b`));
      }
      expect(COLUMNS).toHaveLength(13);
    });

    it('pins the key column types and nullability from the LOCKED schema', () => {
      const start = sql.indexOf('CREATE TABLE audit_log');
      const block = sql.slice(start, sql.indexOf(');', start));
      expect(block).toMatch(/id\s+uuid\s+PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
      expect(block).toMatch(/tenant_id\s+uuid\s+NOT NULL/);
      expect(block).toMatch(/actor_id\s+uuid\s+NULL/);
      expect(block).toMatch(/actor_type\s+text\s+NOT NULL/);
      expect(block).toMatch(/action\s+text\s+NOT NULL/);
      expect(block).toMatch(/resource_type\s+text\s+NOT NULL/);
      expect(block).toMatch(/resource_id\s+text\s+NULL/);
      expect(block).toMatch(/before_state\s+jsonb\s+NULL/);
      expect(block).toMatch(/after_state\s+jsonb\s+NULL/);
      expect(block).toMatch(/reason\s+text\s+NULL/);
      expect(block).toMatch(/request_id\s+text\s+NULL/);
      expect(block).toMatch(/ip_address\s+inet\s+NULL/);
      expect(block).toMatch(/created_at\s+timestamptz\s+NOT NULL DEFAULT now\(\)/);
    });

    it('creates the three LOCKED indexes', () => {
      expect(sql).toMatch(
        /CREATE INDEX audit_log_tenant_created_idx ON audit_log \(tenant_id, created_at DESC\)/,
      );
      expect(sql).toMatch(
        /CREATE INDEX audit_log_actor_idx\s+ON audit_log \(actor_id\) WHERE actor_id IS NOT NULL/,
      );
      expect(sql).toMatch(
        /CREATE INDEX audit_log_resource_idx\s+ON audit_log \(resource_type, resource_id\)/,
      );
    });

    it('enables RLS in the SAME migration (R125 tier 1)', () => {
      expect(sql).toMatch(/ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY/);
      expect(sql).toMatch(/ALTER TABLE audit_log FORCE ROW LEVEL SECURITY/);
    });

    it('defines tenant-isolation SELECT and admin read policies', () => {
      expect(sql).toMatch(/CREATE POLICY audit_log_tenant_isolation ON audit_log/);
      expect(sql).toMatch(/current_setting\('app\.tenant_id', true\)::uuid/);
      expect(sql).toMatch(
        /CREATE POLICY audit_log_admin_read ON audit_log\s+FOR SELECT TO admin_role/,
      );
    });

    it('has NO UPDATE or DELETE policy (append-only by absence)', () => {
      expect(sql).not.toMatch(/CREATE POLICY[^\n]*FOR UPDATE/i);
      expect(sql).not.toMatch(/CREATE POLICY[^\n]*FOR DELETE/i);
    });

    it('applies DB-level REVOKE UPDATE, DELETE from PUBLIC and app_runtime (D-H6-1)', () => {
      expect(sql).toMatch(/REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC/);
      expect(sql).toMatch(/REVOKE UPDATE, DELETE ON audit_log FROM app_runtime/);
    });

    it('creates the named roles defensively with IF NOT EXISTS guards (Supabase portability)', () => {
      expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'admin_role'\)/);
      expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime'\)/);
    });
  });

  describe('down.sql reverses the forward migration (R82 reversibility)', () => {
    it('drops the table', () => {
      expect(down).toMatch(/DROP TABLE IF EXISTS audit_log/);
    });

    it('drops every index the forward migration created', () => {
      expect(down).toMatch(/DROP INDEX IF EXISTS audit_log_resource_idx/);
      expect(down).toMatch(/DROP INDEX IF EXISTS audit_log_actor_idx/);
      expect(down).toMatch(/DROP INDEX IF EXISTS audit_log_tenant_created_idx/);
    });

    it('drops every policy the forward migration created', () => {
      const policies = [
        'deny_all_anon_audit_log',
        'audit_log_service_role_read',
        'audit_log_service_role_write',
        'audit_log_admin_read',
        'audit_log_tenant_isolation',
      ];
      for (const p of policies) {
        expect(down).toMatch(new RegExp(`DROP POLICY IF EXISTS ${p} ON audit_log`));
      }
    });

    it('every CREATE POLICY in forward has a matching DROP POLICY in down (symmetric)', () => {
      const created = [...sql.matchAll(/CREATE POLICY (\w+) ON audit_log/g)].map((m) => m[1]);
      const dropped = [...down.matchAll(/DROP POLICY IF EXISTS (\w+) ON audit_log/g)].map(
        (m) => m[1],
      );
      for (const p of created) {
        expect(dropped).toContain(p);
      }
    });

    it('every CREATE INDEX in forward has a matching DROP INDEX in down (symmetric)', () => {
      const created = [...sql.matchAll(/CREATE INDEX (\w+) ON audit_log/g)].map((m) => m[1]);
      const dropped = [...down.matchAll(/DROP INDEX IF EXISTS (\w+)/g)].map((m) => m[1]);
      for (const idx of created) {
        expect(dropped).toContain(idx);
      }
    });
  });

  describe('schema.prisma consistency (AuditLogEntry -> audit_log)', () => {
    const model = schema.slice(schema.indexOf('model AuditLogEntry ')).split(/\n}/)[0];

    it('maps the model to the snake_case audit_log table', () => {
      expect(model).toMatch(/@@map\("audit_log"\)/);
    });

    it('models all 13 columns with snake_case names', () => {
      const fields = [
        ['id', /id\s+String/],
        ['tenant_id', /tenant_id\s+String/],
        ['actor_id', /actor_id\s+String\?/],
        ['actor_type', /actor_type\s+String/],
        ['action', /action\s+String/],
        ['resource_type', /resource_type\s+String/],
        ['resource_id', /resource_id\s+String\?/],
        ['before_state', /before_state\s+Json\?/],
        ['after_state', /after_state\s+Json\?/],
        ['reason', /reason\s+String\?/],
        ['request_id', /request_id\s+String\?/],
        ['ip_address', /ip_address\s+String\?/],
        ['created_at', /created_at\s+DateTime/],
      ] as const;
      for (const [, re] of fields) {
        expect(model).toMatch(re);
      }
      expect(fields).toHaveLength(13);
    });

    it('has no @updatedAt (append-only at the model level)', () => {
      expect(model).not.toMatch(/@updatedAt/);
    });

    it('carries the named indexes matching the migration', () => {
      expect(model).toMatch(/map: "audit_log_tenant_created_idx"/);
      expect(model).toMatch(/map: "audit_log_resource_idx"/);
    });
  });
});
