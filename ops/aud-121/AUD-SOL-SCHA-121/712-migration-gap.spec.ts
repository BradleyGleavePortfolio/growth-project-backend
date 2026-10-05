import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const MIGRATION = '20270222000000_scheduling_lifecycle_integrity';
const NEWER = '20270301000000_notification_zone_provenance_reminder_generation';
const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.DATABASE_URL;

function command(bin: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(bin, args, { cwd: ROOT, env, encoding: 'utf8', timeout: 180000 });
  if (result.status !== 0) {
    throw new Error(`${bin} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function sql(url: string, statement: string): string {
  return command('psql', [url, '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', statement]);
}

function dbUrl(name: string): string {
  if (!BASE) throw new Error('Disposable CI DATABASE_URL required; this probe never skips.');
  const url = new URL(BASE);
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('Refusing any database outside disposable CI localhost.');
  }
  url.pathname = `/${name}`;
  return url.toString();
}

function deploy(schema: string, url: string): string {
  return command(process.execPath, [
    path.join(ROOT, 'node_modules/prisma/build/index.js'),
    'migrate', 'deploy', '--schema', schema,
  ], { ...process.env, DATABASE_URL: url, DIRECT_URL: url });
}

function contract(url: string): string {
  return sql(url, `
    SELECT 'column|' || table_name || '|' || column_name || '|' || data_type || '|' ||
      is_nullable || '|' || coalesce(column_default, '')
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN
      ('NotificationDeliveryLog', 'NotificationPreferences', 'SessionType', 'CoachingSession')
    UNION ALL
    SELECT 'constraint|' || c.conname || '|' || pg_get_constraintdef(c.oid)
    FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE n.nspname = 'public' AND r.relname IN
      ('NotificationDeliveryLog', 'NotificationPreferences', 'SessionType', 'CoachingSession')
    UNION ALL
    SELECT 'index|' || indexname || '|' || indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND tablename IN
      ('NotificationDeliveryLog', 'NotificationPreferences', 'SessionType', 'CoachingSession')
    ORDER BY 1`);
}

describe('AUD-SOL-SCHA-121: out-of-order migration deploy on applied newer history', () => {
  it('applies the older gap, preserves every newer migration receipt and commutes with in-order replay', () => {
    const gap = dbUrl('audsol121gap');
    const ordered = dbUrl('audsol121ordered');
    if (!BASE) throw new Error('Missing localhost CI URL');
    sql(BASE, 'CREATE DATABASE audsol121gap');
    sql(BASE, 'CREATE DATABASE audsol121ordered');
    for (const url of [gap, ordered]) {
      command('psql', [url, '-v', 'ON_ERROR_STOP=1', '-f',
        path.join(ROOT, 'prisma/migrations/_supabase_bootstrap.sql')]);
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audsol121-migration-history-'));
    fs.cpSync(path.join(ROOT, 'prisma'), path.join(dir, 'prisma'), { recursive: true });
    const schema = path.join(dir, 'prisma/schema.prisma');
    const migrationDir = path.join(dir, 'prisma/migrations', MIGRATION);
    const held = path.join(dir, MIGRATION);
    fs.renameSync(migrationDir, held);
    deploy(schema, gap);
    expect(sql(gap, `SELECT count(*) FROM "_prisma_migrations"
      WHERE migration_name = '${NEWER}' AND finished_at IS NOT NULL`)).toBe('1');
    expect(sql(gap, `SELECT count(*) FROM "_prisma_migrations"
      WHERE migration_name = '${MIGRATION}'`)).toBe('0');
    const receiptsBefore = sql(gap, `SELECT migration_name || '|' || checksum || '|' ||
      finished_at::text FROM "_prisma_migrations" ORDER BY migration_name`);
    expect(sql(gap, `SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'NotificationDeliveryLog'
      AND column_name = 'start_at'`)).toBe('NO');
    fs.renameSync(held, migrationDir);
    const output = deploy(schema, gap);
    expect(output).toContain(MIGRATION);
    expect(sql(gap, `SELECT count(*) FROM "_prisma_migrations"
      WHERE migration_name = '${MIGRATION}' AND finished_at IS NOT NULL`)).toBe('1');
    expect(sql(gap, `SELECT migration_name || '|' || checksum || '|' ||
      finished_at::text FROM "_prisma_migrations"
      WHERE migration_name <> '${MIGRATION}' ORDER BY migration_name`)).toBe(receiptsBefore);
    expect(sql(gap, `SELECT count(*) FROM "_prisma_migrations" older
      JOIN "_prisma_migrations" newer ON newer.migration_name = '${NEWER}'
      WHERE older.migration_name = '${MIGRATION}' AND older.finished_at > newer.finished_at`)).toBe('1');
    deploy(schema, ordered);
    expect(contract(gap)).toBe(contract(ordered));
    expect(sql(gap, `SELECT column_default FROM information_schema.columns
      WHERE table_name = 'NotificationDeliveryLog' AND column_name = 'status'`)).toBe("'sent'::text");
    expect(sql(gap, `SELECT column_default FROM information_schema.columns
      WHERE table_name = 'NotificationDeliveryLog' AND column_name = 'attempts'`)).toBe('1');
    expect(contract(gap)).toContain('CoachingSession_no_overlapping_active_booking');
    expect(contract(gap)).toContain('NotificationDeliveryLog_session_id_user_id_kind_start_at_key');
    console.log('PASS: older 20270222 filled after applied 20270301; receipt preservation and exact scheduling DB contract equality');
  }, 600000);
});
