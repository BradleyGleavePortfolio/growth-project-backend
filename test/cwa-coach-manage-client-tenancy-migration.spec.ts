/**
 * D8 (B-D8-124) — ClientWorkoutAssignment `assignment_coach_manage` client tenancy, static integrity.
 *
 * STATIC assertions (no database): migration 20270319000000_cwa_coach_manage_client_tenancy
 *   - sorts after every migration on main and runs atomically with bounded lock / statement time;
 *   - creates app.caller_coaches_client(text) as STABLE SECURITY DEFINER with search_path = '',
 *     resolving the caller inside from auth.uid() (one argument: the client id), EXECUTE revoked
 *     from PUBLIC and granted to anon / authenticated / service_role only;
 *   - encodes the application rule (assertCanAccessClient / SubCoachScopeService.canAccessClient):
 *     live client, (a) own roster, or (b) sub-coach with explicit membership and an open
 *     SubCoachAssignment to a student;
 *   - recreates the policy with every 20260702000000 condition verbatim plus the helper in BOTH
 *     USING and WITH CHECK; touches no other table and changes no data;
 *   - down.sql restores the 20260702000000 policy text verbatim and drops the helper.
 * The live proof is test/rls/cwa-coach-manage-client-tenancy-rls.spec.ts (rls-live-tests job).
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const NAME = '20270319000000_cwa_coach_manage_client_tenancy';
const DIR = join(ROOT, 'prisma', 'migrations', NAME);
const SQL = readFileSync(join(DIR, 'migration.sql'), 'utf8');
const DOWN = readFileSync(join(DIR, 'down.sql'), 'utf8');
const PRIOR = readFileSync(
  join(ROOT, 'prisma', 'migrations', '20260702000000_fix_workout_rls_coach_role', 'migration.sql'),
  'utf8',
);

/** SQL with comment lines removed and whitespace collapsed. */
function code(sql: string): string {
  return sql
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function policyBody(sql: string): { using: string; check: string } {
  const c = code(sql);
  const m = /CREATE POLICY "assignment_coach_manage" ON (?:public\.)?"ClientWorkoutAssignment" AS PERMISSIVE FOR ALL TO PUBLIC USING \((.*)\) WITH CHECK \((.*?)\);/.exec(
    c,
  );
  if (!m) throw new Error('assignment_coach_manage CREATE POLICY not found');
  return { using: m[1].trim(), check: m[2].trim() };
}

const HELPER_CALL = 'AND app.caller_coaches_client("client_id")';

describe(`${NAME}: placement and transaction`, () => {
  it('sorts after every migration on main (newest before it: 20270318122000_coach_booking_options)', () => {
    const dirs = readdirSync(join(ROOT, 'prisma', 'migrations'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{14}_/.test(e.name))
      .map((e) => e.name)
      .sort();
    expect(dirs).toContain(NAME);
    expect(NAME > '20270318122000_coach_booking_options').toBe(true);
    expect(dirs.filter((d) => d.startsWith('20270319000000_'))).toEqual([NAME]);
  });

  it('runs in one transaction with bounded lock and statement time (up and down)', () => {
    for (const s of [SQL, DOWN]) {
      const c = code(s);
      expect(c.startsWith("BEGIN; SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '30s';")).toBe(true);
      expect(c.endsWith('COMMIT;')).toBe(true);
    }
  });

  it('is tightening only: no data change, no other table, no grant widening on tables', () => {
    const c = code(SQL);
    expect(c).not.toMatch(/\b(INSERT INTO|UPDATE public|DELETE FROM|ALTER TABLE|TRUNCATE)\b/i);
    expect(c).not.toMatch(/GRANT [A-Z, ]+ ON (TABLE )?(public\.)?"/i);
    const policies = [...c.matchAll(/(CREATE|DROP) POLICY (?:IF EXISTS )?"(\w+)" ON (?:public\.)?"(\w+)"/g)].map(
      (m) => `${m[1]} ${m[2]} ${m[3]}`,
    );
    expect(policies).toEqual([
      'DROP assignment_coach_manage ClientWorkoutAssignment',
      'CREATE assignment_coach_manage ClientWorkoutAssignment',
    ]);
  });
});

describe(`${NAME}: app.caller_coaches_client(text)`, () => {
  const c = code(SQL);
  const fn = /CREATE OR REPLACE FUNCTION app\.caller_coaches_client\(client_user_id text\) (.*?) AS \$\$(.*?)\$\$;/.exec(c);

  it('is STABLE SECURITY DEFINER with an empty search_path and a single client-id argument', () => {
    expect(fn).not.toBeNull();
    expect(fn![1]).toBe("RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''");
    expect(c.match(/FUNCTION app\.caller_coaches_client\(/g)).toHaveLength(4); // create + comment + revoke + grant
  });

  it('resolves the caller inside from auth.uid() (same identity as the policy) and references only qualified objects', () => {
    const body = fn![2];
    expect(body).toContain('WHERE caller."supabase_id" = auth.uid()::text');
    expect(body).not.toMatch(/current_user_id|current_setting/);
    for (const t of body.matchAll(/FROM (\S+)|JOIN (\S+)/g)) {
      expect(t[1] ?? t[2]).toMatch(/^public\."(User|TeamSubCoachAssignment|SubCoachAssignment)"$/);
    }
  });

  it('encodes the application rule: live client AND (own roster OR sub-coach with membership + open assignment to a student)', () => {
    const body = fn![2];
    expect(body).toContain('client."deleted_at" IS NULL');
    expect(body).toContain('client."coach_id" = caller."id" OR (');
    expect(body).toContain(`caller."role" = 'coach' AND caller."coach_id" IS NOT NULL AND client."role" = 'student'`);
    expect(body).toContain(
      'seat."head_coach_id" = caller."coach_id" AND seat."sub_coach_id" = caller."id" AND seat."archived_at" IS NULL',
    );
    expect(body).toContain(
      'delegation."head_coach_id" = caller."coach_id" AND delegation."sub_coach_id" = caller."id" AND delegation."unassigned_at" IS NULL',
    );
    expect(body).toContain(
      'sca."sub_coach_id" = caller."id" AND sca."client_id" = client."id" AND sca."unassigned_at" IS NULL',
    );
  });

  it('EXECUTE is revoked from PUBLIC and granted to the three API roles only', () => {
    expect(c).toContain('REVOKE ALL ON FUNCTION app.caller_coaches_client(text) FROM PUBLIC;');
    expect(c).toContain('GRANT EXECUTE ON FUNCTION app.caller_coaches_client(text) TO anon, authenticated, service_role;');
  });
});

describe(`${NAME}: assignment_coach_manage`, () => {
  const prior = policyBody(PRIOR);
  const next = policyBody(SQL);
  const restored = policyBody(DOWN);

  it('keeps every 20260702000000 condition verbatim and adds the tenancy helper to USING', () => {
    expect(next.using).toBe(`${prior.using} ${HELPER_CALL}`);
  });

  it('keeps every 20260702000000 condition verbatim and adds the tenancy helper to WITH CHECK', () => {
    expect(next.check).toBe(`${prior.check} ${HELPER_CALL}`);
  });

  it('is created after the helper and after the drop', () => {
    const c = code(SQL);
    const create = c.indexOf('CREATE POLICY "assignment_coach_manage"');
    expect(c.indexOf('CREATE OR REPLACE FUNCTION app.caller_coaches_client')).toBeLessThan(create);
    expect(c.indexOf('DROP POLICY IF EXISTS "assignment_coach_manage"')).toBeLessThan(create);
  });

  it('down.sql restores the 20260702000000 policy verbatim and drops the helper after the policy', () => {
    expect(restored).toEqual(prior);
    const d = code(DOWN);
    expect(d.indexOf('CREATE POLICY "assignment_coach_manage"')).toBeLessThan(
      d.indexOf('DROP FUNCTION IF EXISTS app.caller_coaches_client(text);'),
    );
  });
});
