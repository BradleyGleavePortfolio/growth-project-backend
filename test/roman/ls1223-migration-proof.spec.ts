/**
 * LS-1223 independent review evidence. CI-only, disposable local database.
 * Never merge this probe into the product branch.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../../src/prisma.service';
import { RomanMessageReportService } from '../../src/roman/roman-message-report.service';

const ROOT = path.resolve(__dirname, '../..');
const NAME = '20270502011200_roman_message_report';
const DB = 'ls1223_review_probe';
// Ephemeral CI fixture credentials, never an application connection.
const URL = `postgresql://ls1223:ls1223_local_fixture@localhost:5432/${DB}`;
const env = { ...process.env, DATABASE_URL: URL, DIRECT_URL: URL };
const run = (cmd: string, args: string[], extraEnv = env) =>
  execFileSync(cmd, args, { cwd: ROOT, env: extraEnv, encoding: 'utf8', timeout: 240_000, maxBuffer: 16 * 1024 * 1024 });
const sql = (statement: string) => run('psql', [URL, '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-c', statement]).trim();
const file = (p: string) => run('psql', [URL, '-X', '-v', 'ON_ERROR_STOP=1', '-f', p]);
const dump = () => run('pg_dump', [URL, '--schema-only', '--no-owner', '--no-privileges'])
  .replace(/^\\(?:un)?restrict .*$/gm, '');

describe('LS-1223 main-first deploy and real isolation proof', () => {
  let temp = '';
  let prisma: PrismaClient;
  let service: RomanMessageReportService;
  let oldSchema = '';
  let oldRow = '';
  let stageTwoOutput = '';
  let mainCount = 0;
  let started = false;

  beforeAll(async () => {
    if (process.env.CI !== 'true') throw new Error('This review probe is CI-only.');
    // Match the PR's green forward-migration gate exactly. The hosted runner's
    // native server has a different major version and historical catalog guards.
    run('docker', ['run', '--detach', '--rm', '--name', 'ls1223-review-probe',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-p', '5432:5432', 'postgres:15.18']);
    started = true;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        run('docker', ['exec', 'ls1223-review-probe', 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
        ready = true;
        break;
      } catch { /* Check readiness again, without an arbitrary delay. */ }
    }
    expect(ready).toBe(true);
    run('docker', ['exec', 'ls1223-review-probe', 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-c',
      "CREATE ROLE ls1223 LOGIN SUPERUSER PASSWORD 'ls1223_local_fixture'"]);
    run('docker', ['exec', 'ls1223-review-probe', 'createdb', '-U', 'postgres', '-O', 'ls1223', DB]);
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ls1223-main-first-'));
    const target = path.join(temp, 'migrations');
    fs.cpSync(path.join(ROOT, 'prisma/migrations'), target, { recursive: true });
    fs.rmSync(path.join(target, NAME), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'prisma/schema.prisma'), path.join(temp, 'schema.prisma'));
    const mainNames = fs.readdirSync(target).filter((n) => /^\d{14}_/.test(n)).sort();
    expect(mainNames[mainNames.length - 1]).toBe('20270502011100_plan_swaps_revisions');
    mainCount = mainNames.length;
    file(path.join(ROOT, 'prisma/migrations/_supabase_bootstrap.sql'));
    run(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', path.join(temp, 'schema.prisma')]);
    expect(Number(sql('SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL'))).toBe(mainCount);
    expect(sql("SELECT to_regclass('public.\"RomanMessageReport\"') IS NULL")).toBe('t');
    sql(`INSERT INTO "User" (id, supabase_id, email, name, role) VALUES
      ('ls1223-A', '00000000-0000-4000-8000-000000000001', 'ls1223-a', 'Review A', 'student'),
      ('ls1223-B', '00000000-0000-4000-8000-000000000002', 'ls1223-b', 'Review B', 'student'),
      ('ls1223-K', '00000000-0000-4000-8000-000000000003', 'ls1223-k', 'Review K', 'coach'),
      ('ls1223-L', '00000000-0000-4000-8000-000000000004', 'ls1223-l', 'Review L', 'coach'),
      ('ls1223-O', '00000000-0000-4000-8000-000000000005', 'ls1223-o', 'Review O', 'owner');
      UPDATE "User" SET coach_id = 'ls1223-K' WHERE id = 'ls1223-A';
      INSERT INTO "RomanSession" (id, user_id, surface, day_key, updated_at)
      VALUES ('ls1223-session', 'ls1223-A', 'client', '2026-11-05', CURRENT_TIMESTAMP);
      INSERT INTO "RomanMessage" (id, session_id, user_id, role, content)
      VALUES ('ls1223-message', 'ls1223-session', 'ls1223-A', 'roman', 'Review fixture reply');`);
    oldRow = sql(`SELECT row_to_json(m)::text FROM "RomanMessage" m WHERE id = 'ls1223-message'`);
    oldSchema = dump();
    fs.cpSync(path.join(ROOT, 'prisma/migrations', NAME), path.join(target, NAME), { recursive: true });
    stageTwoOutput = run(process.execPath, [
      'node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', path.join(temp, 'schema.prisma'),
    ]);
    prisma = new PrismaClient({ datasources: { db: { url: URL } } });
    service = new RomanMessageReportService(prisma as PrismaService);
  }, 360_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
    if (started) run('docker', ['rm', '--force', 'ls1223-review-probe']);
  });

  it('deploys only 11200 after every main migration and preserves an existing reply', () => {
    expect(stageTwoOutput).toContain(`Applying migration \`${NAME}\``);
    expect(stageTwoOutput.match(/Applying migration /g)).toHaveLength(1);
    expect(Number(sql('SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL'))).toBe(mainCount + 1);
    expect(sql(`SELECT row_to_json(m)::text FROM "RomanMessage" m WHERE id = 'ls1223-message'`)).toBe(oldRow);
  });

  it.each(['B', 'K', 'L'])('refuses another client/coach %s filing against the reply in a real database', async (who) => {
    await expect(service.report({ id: `ls1223-${who}`, role: who === 'B' ? 'student' : 'coach' },
      'ls1223-message', { reason: 'spam' })).rejects.toMatchObject({ status: 404 });
    expect(await prisma.romanMessageReport.count()).toBe(0);
  });

  it('keeps exactly one row and the first reason across simultaneous repeat taps', async () => {
    const first = await service.report({ id: 'ls1223-A', role: 'student' }, 'ls1223-message', { reason: 'harassment' });
    expect(first.status).toBe('received');
    const retries = await Promise.all(Array.from({ length: 8 }, () =>
      service.report({ id: 'ls1223-A', role: 'student' }, 'ls1223-message', { reason: 'other' })));
    expect(retries.every((r) => r.reportId === first.reportId && r.status === 'already_reported')).toBe(true);
    expect(await prisma.romanMessageReport.findMany({ select: { reason: true } })).toEqual([{ reason: 'harassment' }]);
  });

  it('gives the team the report and target, only the reporter the target, and other coaches/clients neither', () => {
    for (const [who, role, expected] of [
      ['O', 'owner', '1|1'], ['A', 'student', '0|1'], ['B', 'student', '0|0'],
      ['K', 'coach', '0|0'], ['L', 'coach', '0|0'],
    ]) {
      const result = sql(`BEGIN; SET LOCAL ROLE authenticated;
        SELECT set_config('app.current_user_id', 'ls1223-${who}', true);
        SELECT set_config('app.current_user_role', '${role}', true);
        SELECT (SELECT count(*) FROM "RomanMessageReport") || '|' ||
          (SELECT count(*) FROM "RomanMessage" WHERE id = 'ls1223-message');
        ROLLBACK;`);
      expect(result.split('\n')).toContain(expected);
    }
  });

  it('runs the shipped live report RLS suite against the independently deployed complete chain', () => {
    const output = run(process.execPath, [
      'node_modules/jest/bin/jest.js', '--config', 'jest.rls.config.js', '--runInBand',
      'test/rls/roman-message-report-rls.spec.ts',
    ], { ...env, TEST_DATABASE_URL: URL });
    expect(output).not.toContain('FAIL');
  }, 120_000);

  it('down.sql removes only its own table and leaves the pre-migration schema unchanged', () => {
    file(path.join(ROOT, 'prisma/migrations', NAME, 'down.sql'));
    expect(sql("SELECT to_regclass('public.\"RomanMessageReport\"') IS NULL")).toBe('t');
    expect(dump()).toBe(oldSchema);
    expect(sql(`SELECT row_to_json(m)::text FROM "RomanMessage" m WHERE id = 'ls1223-message'`)).toBe(oldRow);
  });
});
