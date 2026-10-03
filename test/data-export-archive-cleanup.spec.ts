/**
 * B-608-11: an export archive whose request row is gone (the account was
 * erased while the archive was being built) or no longer owns it (the run
 * failed) must never be reported as deleted unless it really is.
 *
 *   - `_deleteStoredFile` treats only ENOENT as success; EACCES / EIO / any
 *     other error propagates.
 *   - The late-write fence rejects the runner, never logs "archive deleted",
 *     and leaves a durable cleanup record (data_export_archive_cleanup) for
 *     this machine.
 *   - The nightly cleanup drains that record: it retries the unlink, keeps the
 *     record (attempts + 1) while the error persists, and deletes the record
 *     only once the archive is gone.
 *   - Foreign-file isolation: the cleanup only ever unlinks
 *     `<DATA_EXPORT_FS_DIR>/<export id>.json` of the export it is about, never
 *     another export's archive, a foreign file, or a path outside the dir.
 *
 * Real files in a private directory; only `fs.promises.unlink` is wrapped to
 * inject errno failures for one chosen path.
 */
import * as fs from 'fs';
import { hostname } from 'os';
import { join } from 'path';
import { DataExportStatus } from '@prisma/client';
import {
  DataExportArchiveCleanupError,
  DataExportService,
} from '../src/data-export/data-export.service';
import { exportArchivePath, isExportId } from '../src/data-export/data-export.paths';
import type { PrismaService } from '../src/prisma.service';

const mockCaptureMessage = jest.fn();
jest.mock('@sentry/node', () => ({
  ...jest.requireActual('@sentry/node'),
  captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
}));

function stub<T>(value: unknown): T {
  return value as T;
}

const USER = '3f0c7a52-6a51-4c55-9a0e-0c9d6f1b2a10';
const LATE = 'c0ffee00-0000-4000-8000-00000000late';
const OTHER = 'c0ffee00-0000-4000-8000-0000000other';
const MACHINE = hostname();

interface CleanupRow {
  export_id: string;
  machine: string;
  reason: string;
  attempts: number;
  last_error_code: string;
  created_at: Date;
  last_attempt_at: Date;
}

const root = join(__dirname, '.tmp-archive-cleanup');
let dir = '';
const prevDir = process.env.DATA_EXPORT_FS_DIR;
const realUnlink = fs.promises.unlink;
/** Every path the code under test asked to unlink. */
let unlinked: string[] = [];
/** path -> errno code the wrapped unlink fails with. */
let failures = new Map<string, string>();

beforeAll(() => {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (prevDir === undefined) delete process.env.DATA_EXPORT_FS_DIR;
  else process.env.DATA_EXPORT_FS_DIR = prevDir;
});
beforeEach(() => {
  dir = fs.mkdtempSync(join(root, 'run-'));
  process.env.DATA_EXPORT_FS_DIR = dir;
  unlinked = [];
  failures = new Map();
  mockCaptureMessage.mockClear();
  jest.spyOn(fs.promises, 'unlink').mockImplementation(async (p: fs.PathLike) => {
    const path = String(p);
    unlinked.push(path);
    const code = failures.get(path);
    if (code) throw Object.assign(new Error(`${code}: injected unlink failure`), { code });
    return realUnlink(path);
  });
});
afterEach(() => {
  jest.restoreAllMocks();
});

function harness(
  opts: {
    readyCount?: number;
    failReady?: boolean;
    /** Request rows that exist (findFirst owner check). */
    rows?: Array<{ id: string; status: DataExportStatus; file_url: string | null }>;
    failRecord?: boolean;
    cleanup?: CleanupRow[];
    /** What dataExportRequest.findMany returns (sweep known ids and the expiry query). */
    listed?: unknown[];
  } = {},
) {
  const cleanup = new Map<string, CleanupRow>((opts.cleanup ?? []).map((r) => [r.export_id, r]));
  const rows = opts.rows ?? [];
  const calls: string[] = [];
  const prisma = {
    dataExportRequest: {
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async (args: { data: { status: string } }) => {
        calls.push(`updateMany:${args.data.status}`);
        if (args.data.status === 'READY' && opts.failReady) throw new Error('db blip');
        return { count: args.data.status === 'READY' ? (opts.readyCount ?? 0) : 0 };
      }),
      findMany: jest.fn(async (): Promise<unknown[]> => opts.listed ?? []),
      findFirst: jest.fn(
        async (args: { where: { id: string; status: DataExportStatus; file_url: string } }) => {
          const r = rows.find(
            (x) =>
              x.id === args.where.id &&
              x.status === args.where.status &&
              x.file_url === args.where.file_url,
          );
          return r ? { id: r.id } : null;
        },
      ),
    },
    dataExportArchiveCleanup: {
      upsert: jest.fn(
        async (args: {
          where: { export_id: string };
          create: { export_id: string; machine: string; reason: string; last_error_code: string };
          update: { machine: string; reason: string; last_error_code: string };
        }) => {
          if (opts.failRecord) throw new Error('database unavailable');
          const cur = cleanup.get(args.where.export_id);
          if (cur) {
            Object.assign(cur, {
              machine: args.update.machine,
              reason: args.update.reason,
              last_error_code: args.update.last_error_code,
              attempts: cur.attempts + 1,
              last_attempt_at: new Date(),
            });
          } else {
            cleanup.set(args.where.export_id, {
              ...args.create,
              attempts: 1,
              created_at: new Date(),
              last_attempt_at: new Date(),
            });
          }
          return {};
        },
      ),
      findMany: jest.fn(async (args: { where: { machine: string }; take: number }) =>
        [...cleanup.values()]
          .filter((r) => r.machine === args.where.machine)
          .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
          .slice(0, args.take)
          .map((r) => ({ ...r })),
      ),
      update: jest.fn(
        async (args: {
          where: { export_id: string };
          data: { last_error_code: string; last_attempt_at: Date };
        }) => {
          const r = cleanup.get(args.where.export_id);
          if (!r) throw new Error('record vanished');
          r.attempts += 1;
          r.last_error_code = args.data.last_error_code;
          r.last_attempt_at = args.data.last_attempt_at;
          return { ...r };
        },
      ),
      deleteMany: jest.fn(async (args: { where: { export_id: string; machine: string } }) => {
        const r = cleanup.get(args.where.export_id);
        if (!r || r.machine !== args.where.machine) return { count: 0 };
        cleanup.delete(args.where.export_id);
        return { count: 1 };
      }),
      count: jest.fn(
        async (args: { where: { machine: { not: string }; created_at: { lt: Date } } }) =>
          [...cleanup.values()].filter(
            (r) => r.machine !== args.where.machine.not && r.created_at < args.where.created_at.lt,
          ).length,
      ),
    },
  };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const svc = new DataExportService(stub<PrismaService>(prisma));
  Object.assign(svc, {
    logger,
    _buildArchive: async () => ({
      buffer: Buffer.from('{"private":true}'),
      sha256: 'a'.repeat(64),
    }),
    _tryAudit: jest.fn(),
    _mintDownloadToken: jest.fn(async () => 'tok'),
    _logReadyNotification: jest.fn(),
  });
  const run = (id: string): Promise<void> => {
    const fn: unknown = Reflect.get(svc, '_runExport');
    if (typeof fn !== 'function') throw new Error('no _runExport');
    return fn.call(svc, id, USER);
  };
  const logged = (): string =>
    [...logger.log.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls]
      .map((c) => String(c[0]))
      .join('\n');
  return { svc, run, prisma, cleanup, calls, logger, logged };
}

function write(path: string): void {
  fs.writeFileSync(path, '{"private":true}', { mode: 0o600 });
}

describe('B-608-11 late export cleanup: only ENOENT is success', () => {
  it.each(['EACCES', 'EIO'])(
    'late write + %s: the runner rejects, no "archive deleted", a cleanup record is retained for this machine',
    async (code) => {
      const h = harness({ readyCount: 0 });
      failures.set(exportArchivePath(LATE), code);
      const err: unknown = await h.run(LATE).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(DataExportArchiveCleanupError);
      expect(err).toMatchObject({
        code: 'DATA_EXPORT_ARCHIVE_CLEANUP_FAILED',
        exportId: LATE,
        reason: 'request_removed',
        storageCode: code,
        recorded: true,
      });
      // The archive is still there and nothing claims otherwise.
      expect(fs.existsSync(exportArchivePath(LATE))).toBe(true);
      expect(h.logged()).not.toMatch(/archive deleted/);
      expect(h.cleanup.get(LATE)).toMatchObject({
        export_id: LATE,
        machine: MACHINE,
        reason: 'request_removed',
        attempts: 1,
        last_error_code: code,
      });
      expect(h.calls).toEqual(['updateMany:READY', 'updateMany:FAILED']);
      expect(mockCaptureMessage).toHaveBeenCalledWith(
        'data export archive cleanup failed',
        expect.objectContaining({
          level: 'error',
          tags: expect.objectContaining({ code, reason: 'request_removed', recorded: 'true' }),
        }),
      );
      // Only the late export's own archive path was ever touched.
      expect(unlinked).toEqual([exportArchivePath(LATE)]);
    },
  );

  it('the nightly cleanup keeps the record while the error persists, then deletes the archive and the record', async () => {
    const h = harness({ readyCount: 0 });
    failures.set(exportArchivePath(LATE), 'EIO');
    await expect(h.run(LATE)).rejects.toBeInstanceOf(DataExportArchiveCleanupError);

    // Night 1: disk still failing -> record retained, attempts 2, nothing claimed.
    const night1 = await h.svc.drainArchiveCleanups();
    expect(night1).toEqual({ removed: 0, pending: 1 });
    expect(h.cleanup.get(LATE)).toMatchObject({ attempts: 2, last_error_code: 'EIO' });
    expect(fs.existsSync(exportArchivePath(LATE))).toBe(true);
    expect(h.logged()).not.toMatch(/archive deleted/);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'data export archive cleanup failed',
      expect.objectContaining({ tags: expect.objectContaining({ code: 'EIO', stage: 'drain' }) }),
    );

    // Night 2: the disk recovered -> archive gone, record gone.
    failures.clear();
    const night2 = await h.svc.drainArchiveCleanups();
    expect(night2).toEqual({ removed: 1, pending: 0 });
    expect(fs.existsSync(exportArchivePath(LATE))).toBe(false);
    expect(h.cleanup.has(LATE)).toBe(false);
    expect(h.logged()).toMatch(
      new RegExp(`Export ${LATE}: archive deleted by the nightly cleanup`),
    );
  });

  it('the nightly data-export cleanup (expireOldExports) drains the record', async () => {
    const h = harness({ readyCount: 0 });
    failures.set(exportArchivePath(LATE), 'EACCES');
    await expect(h.run(LATE)).rejects.toBeInstanceOf(DataExportArchiveCleanupError);
    failures.clear();
    await h.svc.expireOldExports();
    expect(fs.existsSync(exportArchivePath(LATE))).toBe(false);
    expect(h.cleanup.size).toBe(0);
  });

  it('ENOENT control: an archive that is already gone counts as deleted, with no record', async () => {
    const h = harness({ readyCount: 0 });
    failures.set(exportArchivePath(LATE), 'ENOENT');
    await expect(h.run(LATE)).resolves.toBeUndefined();
    expect(h.cleanup.size).toBe(0);
    expect(h.logged()).toMatch(/finished after its request was removed; archive deleted/);
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it('success control: the late archive is unlinked, logged as deleted, with no record', async () => {
    const h = harness({ readyCount: 0 });
    await expect(h.run(LATE)).resolves.toBeUndefined();
    expect(fs.existsSync(exportArchivePath(LATE))).toBe(false);
    expect(h.cleanup.size).toBe(0);
    expect(h.logged()).toMatch(/finished after its request was removed; archive deleted/);
    expect(unlinked).toEqual([exportArchivePath(LATE)]);
  });

  it('a failed run whose archive cannot be removed rejects with its own error and records a failed_run cleanup', async () => {
    const h = harness({ readyCount: 1, failReady: true });
    failures.set(exportArchivePath(LATE), 'EACCES');
    await expect(h.run(LATE)).rejects.toThrow('db blip');
    expect(h.cleanup.get(LATE)).toMatchObject({ reason: 'failed_run', last_error_code: 'EACCES' });
    expect(fs.existsSync(exportArchivePath(LATE))).toBe(true);
    // A FAILED row does not own the archive, so the drain removes it.
    failures.clear();
    expect(await h.svc.drainArchiveCleanups()).toEqual({ removed: 1, pending: 0 });
    expect(fs.existsSync(exportArchivePath(LATE))).toBe(false);
  });

  it('when even the cleanup record cannot be written, the runner still rejects and says so', async () => {
    const h = harness({ readyCount: 0, failRecord: true });
    failures.set(exportArchivePath(LATE), 'EIO');
    await expect(h.run(LATE)).rejects.toMatchObject({ storageCode: 'EIO', recorded: false });
    expect(h.logged()).not.toMatch(/archive deleted/);
    expect(h.logged()).toMatch(
      new RegExp(`Recording the archive cleanup of export ${LATE} failed`),
    );
  });

  it('a normal export keeps its archive and writes no record', async () => {
    const h = harness({ readyCount: 1 });
    await expect(h.run(LATE)).resolves.toBeUndefined();
    expect(fs.existsSync(exportArchivePath(LATE))).toBe(true);
    expect(h.cleanup.size).toBe(0);
    expect(unlinked).toEqual([]);
  });
});

describe('B-608-11 foreign-file isolation', () => {
  it('late failure + drain touch only the late export archive: another export, a foreign file and a file outside the dir survive', async () => {
    const outside = join(root, `outside-${Date.now()}.json`);
    write(exportArchivePath(OTHER));
    write(join(dir, 'notes.txt'));
    write(outside);
    const h = harness({
      readyCount: 0,
      rows: [
        {
          id: OTHER,
          status: DataExportStatus.READY,
          file_url: `local://${exportArchivePath(OTHER)}`,
        },
      ],
    });
    failures.set(exportArchivePath(LATE), 'EACCES');
    await expect(h.run(LATE)).rejects.toBeInstanceOf(DataExportArchiveCleanupError);
    failures.clear();
    await h.svc.drainArchiveCleanups();
    expect(fs.existsSync(exportArchivePath(LATE))).toBe(false);
    expect(fs.existsSync(exportArchivePath(OTHER))).toBe(true);
    expect(fs.existsSync(join(dir, 'notes.txt'))).toBe(true);
    expect(fs.existsSync(outside)).toBe(true);
    expect(unlinked.every((p) => p === exportArchivePath(LATE))).toBe(true);
  });

  it('a record for an archive a READY row still owns is dropped and the archive is kept', async () => {
    write(exportArchivePath(OTHER));
    const h = harness({
      rows: [
        {
          id: OTHER,
          status: DataExportStatus.READY,
          file_url: `local://${exportArchivePath(OTHER)}`,
        },
      ],
      cleanup: [
        {
          export_id: OTHER,
          machine: MACHINE,
          reason: 'failed_run',
          attempts: 1,
          last_error_code: 'EIO',
          created_at: new Date(),
          last_attempt_at: new Date(),
        },
      ],
    });
    expect(await h.svc.drainArchiveCleanups()).toEqual({ removed: 0, pending: 0 });
    expect(fs.existsSync(exportArchivePath(OTHER))).toBe(true);
    expect(h.cleanup.size).toBe(0);
    expect(unlinked).toEqual([]);
  });

  it('a record whose export id is not a safe file name is never unlinked', async () => {
    const outside = join(root, 'escape.json');
    write(outside);
    const hostile = '../escape';
    expect(isExportId(hostile)).toBe(false);
    const h = harness({
      cleanup: [
        {
          export_id: hostile,
          machine: MACHINE,
          reason: 'request_removed',
          attempts: 1,
          last_error_code: 'EIO',
          created_at: new Date(),
          last_attempt_at: new Date(),
        },
      ],
    });
    expect(await h.svc.drainArchiveCleanups()).toEqual({ removed: 0, pending: 1 });
    expect(fs.existsSync(outside)).toBe(true);
    expect(unlinked).toEqual([]);
  });

  it('records from another machine are left to it; ones older than 48 hours are reported', async () => {
    const old = new Date(Date.now() - 49 * 60 * 60 * 1000);
    write(exportArchivePath(OTHER));
    const h = harness({
      cleanup: [
        {
          export_id: OTHER,
          machine: `${MACHINE}-elsewhere`,
          reason: 'request_removed',
          attempts: 1,
          last_error_code: 'EIO',
          created_at: old,
          last_attempt_at: old,
        },
      ],
    });
    expect(await h.svc.drainArchiveCleanups()).toEqual({ removed: 0, pending: 0 });
    expect(fs.existsSync(exportArchivePath(OTHER))).toBe(true);
    expect(h.cleanup.size).toBe(1);
    expect(unlinked).toEqual([]);
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        '1 data export archive cleanup record(s) from other machines are older than 48 hours',
      ),
    );
  });
});

describe('B-608-11 expiry: a failed delete is retried, never reported as expired', () => {
  function expiringHarness(status: DataExportStatus) {
    const row = {
      id: OTHER,
      user_id: USER,
      status,
      file_url: `local://${exportArchivePath(OTHER)}`,
      expires_at: new Date(Date.now() - 1000),
    };
    return harness({ listed: [row] });
  }

  it('EACCES on an expired archive: the row is not marked EXPIRED and keeps its file reference', async () => {
    write(exportArchivePath(OTHER));
    const h = expiringHarness(DataExportStatus.READY);
    failures.set(exportArchivePath(OTHER), 'EACCES');
    await h.svc.expireOldExports();
    expect(h.prisma.dataExportRequest.update).not.toHaveBeenCalled();
    expect(fs.existsSync(exportArchivePath(OTHER))).toBe(true);
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringContaining(`Failed to expire export ${OTHER} (EACCES)`),
    );
  });

  it.each([DataExportStatus.READY, DataExportStatus.EXPIRED])(
    'a %s row past expiry with a file: archive deleted, row EXPIRED with file_url cleared',
    async (status) => {
      write(exportArchivePath(OTHER));
      const h = expiringHarness(status);
      await h.svc.expireOldExports();
      expect(fs.existsSync(exportArchivePath(OTHER))).toBe(false);
      expect(h.prisma.dataExportRequest.update).toHaveBeenCalledWith({
        where: { id: OTHER },
        data: { status: DataExportStatus.EXPIRED, file_url: null },
      });
      expect(h.prisma.dataExportRequest.findMany).toHaveBeenCalledWith({
        where: {
          status: { in: [DataExportStatus.READY, DataExportStatus.EXPIRED] },
          file_url: { not: null },
          expires_at: { lte: expect.any(Date) },
        },
      });
    },
  );

  it('ENOENT on an expired archive counts as deleted', async () => {
    const h = expiringHarness(DataExportStatus.READY);
    await h.svc.expireOldExports();
    expect(h.prisma.dataExportRequest.update).toHaveBeenCalledWith({
      where: { id: OTHER },
      data: { status: DataExportStatus.EXPIRED, file_url: null },
    });
  });
});
