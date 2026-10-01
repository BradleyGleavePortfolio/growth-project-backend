/**
 * B-608-9: the #622 AI consent ledger (`AiProcessingConsentEvent`) is erased
 * with the account, only for that user, with DELETE only (the ledger rejects
 * UPDATE and the fix must not weaken that).
 * B-608-3: a data export still running when the account is finalized can no
 * longer leave an archive behind.
 */
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { Prisma } from '@prisma/client';
import {
  OPTIONAL_USER_TABLES,
  purgeOptionalUserTables,
} from '../../src/account-deletion/account-deletion.manifest';
import { DataExportService } from '../../src/data-export/data-export.service';
import { exportArchivePath } from '../../src/data-export/data-export.paths';
import type { PrismaService } from '../../src/prisma.service';

function stub<T>(value: unknown): T {
  return value as T;
}

const A = '3f0c7a52-6a51-4c55-9a0e-0c9d6f1b2a10';
const B = '9b1e2d3c-4a5b-4c6d-8e7f-0a1b2c3d4e5f';

/** A tiny ledger: the #622 table with rows for A and B, append-only for UPDATE. */
function ledgerTx(present: ReadonlySet<string>) {
  const tables: Record<string, Array<{ user_id: string; seq: number }>> = {
    AiProcessingConsentEvent: [
      { user_id: A, seq: 1 },
      { user_id: A, seq: 2 },
      { user_id: B, seq: 1 },
    ],
  };
  const statements: string[] = [];
  const tx = stub<Prisma.TransactionClient>({
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = Prisma.sql(strings, ...values);
      const name = String(q.values[0]).replace(/^public\."|"$/g, '');
      return [{ present: present.has(name) }];
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = Prisma.sql(strings, ...values);
      statements.push(q.sql.trim().replace(/\s+/g, ' '));
      if (/^\s*UPDATE "AiProcessingConsentEvent"/.test(q.sql)) {
        throw new Error('AiProcessingConsentEvent is append-only');
      }
      const m = /DELETE FROM "(\w+)" WHERE "(\w+)" = \?/.exec(q.sql.replace(/\s+/g, ' '));
      if (!m) throw new Error(`unexpected SQL: ${q.sql}`);
      const rows = tables[m[1]] ?? [];
      const before = rows.length;
      tables[m[1]] = rows.filter((r) => r.user_id !== q.values[0]);
      return before - (tables[m[1]]?.length ?? 0);
    },
  });
  return { tx, tables, statements };
}

describe('B-608-9 AI consent ledger erasure', () => {
  it('lists the #622 ledger table and keeps the older table name', () => {
    expect(OPTIONAL_USER_TABLES).toEqual(
      expect.arrayContaining([
        { table: 'AiProcessingConsentEvent', column: 'user_id' },
        { table: 'AiProcessingConsent', column: 'user_id' },
      ]),
    );
  });

  it('deletes only the deleted user ledger rows, with DELETE only, when #622 is present', async () => {
    const h = ledgerTx(new Set(['AiProcessingConsentEvent']));
    const results = await purgeOptionalUserTables(h.tx, A);
    expect(h.tables.AiProcessingConsentEvent).toEqual([{ user_id: B, seq: 1 }]);
    expect(results).toEqual([
      { model: 'AiProcessingConsentEvent', field: 'user_id', op: 'delete', count: 2 },
    ]);
    expect(h.statements).toEqual(['DELETE FROM "AiProcessingConsentEvent" WHERE "user_id" = ?']);
  });

  it('is a no-op when the ledger table is not deployed yet', async () => {
    const h = ledgerTx(new Set());
    await expect(purgeOptionalUserTables(h.tx, A)).resolves.toEqual([]);
    expect(h.statements).toEqual([]);
    expect(h.tables.AiProcessingConsentEvent).toHaveLength(3);
  });
});

describe('B-608-3 export archive cannot outlive the account', () => {
  // A private directory under this test folder (not the shared OS temp dir).
  const root = join(__dirname, '.tmp');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(root, 'export-fence-'));
  const prevDir = process.env.DATA_EXPORT_FS_DIR;
  beforeAll(() => {
    process.env.DATA_EXPORT_FS_DIR = dir;
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    if (prevDir === undefined) delete process.env.DATA_EXPORT_FS_DIR;
    else process.env.DATA_EXPORT_FS_DIR = prevDir;
  });

  function harness(opts: { readyCount: number; failReady?: boolean; rows?: string[] }) {
    let releaseUpload: () => void = () => undefined;
    const uploadGate = new Promise<void>((r) => {
      releaseUpload = r;
    });
    const calls: string[] = [];
    const prisma = {
      dataExportRequest: {
        update: jest.fn(async () => ({})),
        updateMany: jest.fn(async (args: { data: { status: string } }) => {
          calls.push(`updateMany:${args.data.status}`);
          if (args.data.status === 'READY' && opts.failReady) throw new Error('db blip');
          return { count: args.data.status === 'READY' ? opts.readyCount : 1 };
        }),
        findMany: jest.fn(async () => (opts.rows ?? []).map((id) => ({ id }))),
      },
    };
    const svc = new DataExportService(stub<PrismaService>(prisma));
    Object.assign(svc, {
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      _buildArchive: async () => {
        // The archive build is paused here while account deletion commits.
        await uploadGate;
        return { buffer: Buffer.from('{"private":true}'), sha256: 'a'.repeat(64) };
      },
      _tryAudit: jest.fn(),
      _mintDownloadToken: jest.fn(async () => 'tok'),
      _logReadyNotification: jest.fn(),
    });
    const run = (id: string): Promise<void> => {
      const fn: unknown = Reflect.get(svc, '_runExport');
      if (typeof fn !== 'function') throw new Error('no _runExport');
      return fn.call(svc, id, A);
    };
    return { svc, run, releaseUpload, calls, prisma };
  }

  it('an export that finishes after its request row was erased deletes its archive', async () => {
    const h = harness({ readyCount: 0 });
    const running = h.run('exp-late');
    // Account deletion commits here: the request row is gone.
    h.releaseUpload();
    await running;
    expect(existsSync(exportArchivePath('exp-late'))).toBe(false);
    expect(h.calls).toEqual(['updateMany:READY']);
  });

  it('a failure after the archive was written removes the archive and marks FAILED without throwing on a missing row', async () => {
    const h = harness({ readyCount: 1, failReady: true });
    const running = h.run('exp-error');
    h.releaseUpload();
    await expect(running).rejects.toThrow('db blip');
    expect(existsSync(exportArchivePath('exp-error'))).toBe(false);
    expect(h.calls).toEqual(['updateMany:READY', 'updateMany:FAILED']);
  });

  it('a normal export keeps its archive', async () => {
    const h = harness({ readyCount: 1 });
    const running = h.run('exp-ok');
    h.releaseUpload();
    await running;
    expect(existsSync(exportArchivePath('exp-ok'))).toBe(true);
  });

  it('the nightly sweep removes old archives no row points to, and keeps known or fresh ones', async () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const id of ['orphan-old', 'known-old', 'orphan-fresh']) {
      writeFileSync(exportArchivePath(id), '{}', { mode: 0o600 });
    }
    utimesSync(exportArchivePath('orphan-old'), old, old);
    utimesSync(exportArchivePath('known-old'), old, old);
    const h = harness({ readyCount: 1, rows: ['known-old', 'exp-ok'] });
    const removed = await h.svc.sweepOrphanArchives();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(existsSync(exportArchivePath('orphan-old'))).toBe(false);
    expect(existsSync(exportArchivePath('known-old'))).toBe(true);
    expect(existsSync(exportArchivePath('orphan-fresh'))).toBe(true);
  });
});
