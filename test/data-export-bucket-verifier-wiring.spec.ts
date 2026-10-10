/**
 * A-636-1 — static wiring checks for the data-exports bucket privacy proof
 * (build-and-test, no database).
 *
 * The behavioural proof is the live suite
 * test/rls/data-export-storage-bucket-rls.spec.ts (rls-live-tests job). This
 * file pins what would silently weaken it if edited later:
 *   - the rls-live-tests CI job runs that live suite;
 *   - the release requires the bucket verifier;
 *   - the migration creates the restrictive fence and down.sql removes it;
 *   - the verifier checks catalog state (RLS flag, fence shape, role
 *     attributes, views) and does not pass on a NOTICE-only path when the
 *     Storage schema exists.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..');
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8');
const MIG = 'prisma/migrations/20270221000000_data_export_storage_bucket';

function stripSqlComments(sql: string): string {
  return sql
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');
}

describe('data-exports bucket verifier wiring (A-636-1)', () => {
  it('the rls-live-tests CI job runs the live fence + verifier suite', () => {
    const ci = read('.github/workflows/ci.yml');
    const job = ci.slice(ci.indexOf('\n  rls-live-tests:'), ci.indexOf('\n  mwb-3-live-tests:'));
    // D5: the job runs every RLS suite through the runner; this one may not be parked as pending.
    expect(job).toContain('node scripts/ci/run-rls-suites.mjs');
    const pending = JSON.parse(read('scripts/ci/rls-suites-pending.json')) as Record<string, { path: string }[]>;
    expect([...pending.suites, ...pending.operatorOnly].map((s) => s.path)).not.toContain('test/rls/data-export-storage-bucket-rls.spec.ts');
  });

  it('the release requires the bucket verifier', () => {
    const required = read('scripts/release-required-verifiers.txt')
      .split('\n')
      .map((l) => l.trim());
    expect(required).toContain('20270221000000_data_export_storage_bucket');
  });

  it('the migration creates the restrictive fence for every role; down.sql drops it', () => {
    const migration = stripSqlComments(read(`${MIG}/migration.sql`));
    expect(migration).toMatch(
      /CREATE POLICY data_exports_api_roles_fence ON storage\.objects\s+AS RESTRICTIVE\s+FOR ALL\s+TO PUBLIC\s+USING \(bucket_id IS DISTINCT FROM 'data-exports'\)\s+WITH CHECK \(bucket_id IS DISTINCT FROM 'data-exports'\)/,
    );
    expect(stripSqlComments(read(`${MIG}/down.sql`))).toMatch(
      /DROP POLICY IF EXISTS data_exports_api_roles_fence ON storage\.objects/,
    );
  });

  it('the verifier proves catalog state, not policy text', () => {
    const verify = stripSqlComments(read(`${MIG}/verify.sql`));
    expect(verify).toMatch(/relrowsecurity/);
    expect(verify).toMatch(/polpermissive/);
    expect(verify).toMatch(/rolbypassrls/);
    expect(verify).toMatch(/security_invoker/);
    expect(verify).toMatch(/v_public IS DISTINCT FROM false/);
    // The only early pass is "no Storage at all".
    expect(verify.match(/RETURN;/g)).toHaveLength(1);
  });
});
