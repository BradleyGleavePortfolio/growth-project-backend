/**
 * LS-1223R2 independent review proof. Disposable CI database only.
 * Never merge this test-only review branch into the product.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../../src/prisma.service';
import { RomanMessageReportService } from '../../src/roman/roman-message-report.service';
import { ReportAlertService } from '../../src/report-alerts/report-alert.service';
import { EmailService } from '../../src/email/email.service';

const ROOT = path.resolve(__dirname, '../..');
const NAME = '20270502011200_roman_message_report';
const DB = 'ls1223r2_review_probe';
const CONTAINER = 'ls1223r2-review-probe';
const URL = `postgresql://postgres@localhost:5432/${DB}`;
const env = { ...process.env, DATABASE_URL: URL, DIRECT_URL: URL };
const run = (cmd: string, args: string[], extraEnv = env) =>
  execFileSync(cmd, args, { cwd: ROOT, env: extraEnv, encoding: 'utf8', timeout: 240_000, maxBuffer: 16 * 1024 * 1024 });
const sql = (statement: string) => run('psql', [URL, '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-c', statement]).trim();
const file = (p: string) => run('psql', [URL, '-X', '-v', 'ON_ERROR_STOP=1', '-f', p]);
const dump = () => run('pg_dump', [URL, '--schema-only', '--no-owner', '--no-privileges'])
  .replace(/^\\(?:un)?restrict .*$/gm, '');
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('LS-1223R2 main-first deploy, isolation and alert proof', () => {
  let temp = '';
  let prisma: PrismaClient;
  let service: RomanMessageReportService;
  let oldSchema = '';
  let oldRow = '';
  let deployOutput = '';
  let mainCount = 0;
  let started = false;
  const send = jest.fn(async (_input: unknown) => ({ status: 'sent' as const }));

  beforeAll(async () => {
    if (process.env.CI !== 'true') throw new Error('This review proof is CI-only.');
    run('docker', ['run', '--detach', '--rm', '--name', CONTAINER,
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-p', '5432:5432', 'postgres:15.18']);
    started = true;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        run('docker', ['exec', CONTAINER, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
        ready = true;
        break;
      } catch { /* Retry the actual readiness check without a fixed sleep. */ }
    }
    expect(ready).toBe(true);
    run('docker', ['exec', CONTAINER, 'createdb', '-U', 'postgres', '-O', 'postgres', DB]);
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ls1223r2-main-first-'));
    const migrations = path.join(temp, 'migrations');
    fs.cpSync(path.join(ROOT, 'prisma/migrations'), migrations, { recursive: true });
    fs.rmSync(path.join(migrations, NAME), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'prisma/schema.prisma'), path.join(temp, 'schema.prisma'));
    const mainNames = fs.readdirSync(migrations).filter((n) => /^\d{14}_/.test(n)).sort();
    expect(mainNames.at(-1)).toBe('20270502011100_plan_swaps_revisions');
    mainCount = mainNames.length;
    file(path.join(ROOT, 'scripts/ci/supabase-shim.sql'));
    run(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', path.join(temp, 'schema.prisma')]);
    expect(Number(sql('SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL'))).toBe(mainCount);
    expect(sql("SELECT to_regclass('public.\"RomanMessageReport\"') IS NULL")).toBe('t');
    sql(`INSERT INTO "User" (id, supabase_id, email, name, role) VALUES
      ('ls1223r2-A', '00000000-0000-4000-8000-000000000001', 'ls1223r2-a', 'Review A', 'student'),
      ('ls1223r2-B', '00000000-0000-4000-8000-000000000002', 'ls1223r2-b', 'Review B', 'student'),
      ('ls1223r2-K', '00000000-0000-4000-8000-000000000003', 'ls1223r2-k', 'Review K', 'coach'),
      ('ls1223r2-L', '00000000-0000-4000-8000-000000000004', 'ls1223r2-l', 'Review L', 'coach'),
      ('ls1223r2-O', '00000000-0000-4000-8000-000000000005', 'ls1223r2-o', 'Review O', 'owner');
      UPDATE "User" SET coach_id = 'ls1223r2-K' WHERE id = 'ls1223r2-A';
      INSERT INTO "RomanSession" (id, user_id, surface, day_key, updated_at)
      VALUES ('ls1223r2-session', 'ls1223r2-A', 'client', '2026-11-05', CURRENT_TIMESTAMP);
      INSERT INTO "RomanMessage" (id, session_id, user_id, role, content) VALUES
      ('ls1223r2-message', 'ls1223r2-session', 'ls1223r2-A', 'roman', 'Review fixture reply'),
      ('ls1223r2-failed-alert', 'ls1223r2-session', 'ls1223r2-A', 'roman', 'Review fixture reply');`);
    oldRow = sql(`SELECT row_to_json(m)::text FROM "RomanMessage" m WHERE id = 'ls1223r2-message'`);
    oldSchema = dump();
    fs.cpSync(path.join(ROOT, 'prisma/migrations', NAME), path.join(migrations, NAME), { recursive: true });
    deployOutput = run(process.execPath, [
      'node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', path.join(temp, 'schema.prisma'),
    ]);
    prisma = new PrismaClient({ datasources: { db: { url: URL } } });
    service = new RomanMessageReportService(prisma as PrismaService,
      new ReportAlertService({ send } as unknown as EmailService));
  }, 360_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
    if (started) run('docker', ['rm', '--force', CONTAINER]);
  });

  it('deploys only 11200 on complete main schema and preserves an existing reply', () => {
    expect(deployOutput).toContain(`Applying migration \`${NAME}\``);
    expect(deployOutput.match(/Applying migration /g)).toHaveLength(1);
    expect(Number(sql('SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL'))).toBe(mainCount + 1);
    expect(sql(`SELECT row_to_json(m)::text FROM "RomanMessage" m WHERE id = 'ls1223r2-message'`)).toBe(oldRow);
  });

  it.each(['B', 'K', 'L', 'O'])('refuses foreign client/coach/owner %s filing against the reply', async (who) => {
    const role = who === 'B' ? 'student' : who === 'O' ? 'owner' : 'coach';
    await expect(service.report({ id: `ls1223r2-${who}`, role },
      'ls1223r2-message', { reason: 'spam' })).rejects.toMatchObject({ status: 404 });
    expect(await prisma.romanMessageReport.count()).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('persists once and alerts once across real simultaneous repeats, ids only', async () => {
    const first = await service.report({ id: 'ls1223r2-A', role: 'student' },
      'ls1223r2-message', { reason: 'self_harm', details: 'private review fixture detail' });
    expect(first.status).toBe('received');
    const retries = await Promise.all(Array.from({ length: 8 }, () =>
      service.report({ id: 'ls1223r2-A', role: 'student' }, 'ls1223r2-message', { reason: 'other' })));
    await tick();
    expect(retries.every((r) => r.reportId === first.reportId && r.status === 'already_reported')).toBe(true);
    expect(await prisma.romanMessageReport.findMany({ select: { reason: true } })).toEqual([{ reason: 'self_harm' }]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({
      idempotencyKey: `report-alert:roman:${first.reportId}`,
      data: { report_id: first.reportId, target_id: 'ls1223r2-message', self_harm: true },
    });
    const emailed = JSON.stringify(send.mock.calls[0][0]);
    expect(emailed).not.toContain('private review fixture detail');
    expect(emailed).not.toContain('ls1223r2-A');
    expect(emailed).not.toContain('ls1223r2-K');
  });

  it('gives only team the report; reporter can read target; other clients/coaches neither', () => {
    for (const [who, role, expected] of [
      ['O', 'owner', '1|1'], ['A', 'student', '0|1'], ['B', 'student', '0|0'],
      ['K', 'coach', '0|0'], ['L', 'coach', '0|0'],
    ]) {
      const result = sql(`BEGIN; SET LOCAL ROLE authenticated;
        SELECT set_config('app.current_user_id', 'ls1223r2-${who}', true);
        SELECT set_config('app.current_user_role', '${role}', true);
        SELECT (SELECT count(*) FROM "RomanMessageReport") || '|' ||
          (SELECT count(*) FROM "RomanMessage" WHERE id = 'ls1223r2-message');
        ROLLBACK;`);
      expect(result.split('\n')).toContain(expected);
    }
  });

  it('keeps a persisted report and received response when actual alert send rejects', async () => {
    send.mockRejectedValueOnce(new Error('review provider unavailable'));
    const first = await service.report({ id: 'ls1223r2-A', role: 'student' },
      'ls1223r2-failed-alert', { reason: 'harassment' });
    await tick();
    expect(first.status).toBe('received');
    expect(await prisma.romanMessageReport.findUnique({ where: { id: first.reportId } })).not.toBeNull();
    expect(send).toHaveBeenCalledTimes(2);
    expect(await service.report({ id: 'ls1223r2-A', role: 'student' },
      'ls1223r2-failed-alert', { reason: 'other' })).toEqual({ reportId: first.reportId, status: 'already_reported' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('executes the six shipped report RLS cases on the independent main-first chain', () => {
    const output = run(process.execPath, [
      'node_modules/jest/bin/jest.js', '--config', 'jest.rls.config.js', '--runInBand',
      'test/rls/roman-message-report-rls.spec.ts',
    ], { ...env, TEST_DATABASE_URL: URL });
    expect(output).not.toContain('FAIL');
  }, 120_000);

  it('down.sql drops only its table and preserves exact old schema and old row', () => {
    file(path.join(ROOT, 'prisma/migrations', NAME, 'down.sql'));
    expect(sql("SELECT to_regclass('public.\"RomanMessageReport\"') IS NULL")).toBe('t');
    expect(dump()).toBe(oldSchema);
    expect(sql(`SELECT row_to_json(m)::text FROM "RomanMessage" m WHERE id = 'ls1223r2-message'`)).toBe(oldRow);
  });
});
