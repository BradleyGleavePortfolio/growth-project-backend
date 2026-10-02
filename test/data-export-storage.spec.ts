/**
 * B-608-12 / lane B-EXPORT: data exports are stored durably in the private
 * Supabase bucket `data-exports` and can actually be downloaded.
 *
 * Covered here (fake Supabase Storage + in-memory Prisma, no network):
 *   - store contract: private-bucket check, upsert + size check before READY,
 *     derived keys only, retries on transient errors, no retry on permanent;
 *   - request -> ready -> download round trip across independent API,
 *     worker and download instances sharing only the database and the bucket;
 *   - link scoping: token bound to user + export, cross-user / forged /
 *     tampered / wrong-audience / over-long / deleted-owner tokens refused;
 *   - expiry: 5-minute link, 7-day archive (lazy + nightly delete);
 *   - account deletion removes the archive (and fails closed on Storage errors);
 *   - late write after erasure and failed runs remove their archive, with the
 *     B-608-11 durable cleanup record drained by another machine;
 *   - supersede, stale-run reaping, legacy rows, browser error page.
 */
import { execFileSync } from 'child_process';
import { join } from 'path';
import { Writable } from 'stream';
import { ConfigService } from '@nestjs/config';
import { HttpException, UnauthorizedException } from '@nestjs/common';
import { DataExportStatus, Prisma } from '@prisma/client';
import { SignJWT } from 'jose';
import type { Request, Response } from 'express';
import {
  ArchiveStorageError,
  DATA_EXPORT_BUCKET,
  SupabaseArchiveStore,
  archiveStoreKind,
  classifyStorageError,
  selectArchiveStore,
  withStorageRetry,
} from '../src/data-export/data-export-archive.store';
import {
  DataExportArchiveCleanupError,
  DataExportService,
  downloadLinkTtlSeconds,
} from '../src/data-export/data-export.service';
import {
  DataExportController,
  renderDownloadErrorPage,
} from '../src/data-export/data-export.controller';
import { AccountDeletionStorageService } from '../src/account-deletion/account-deletion.storage';
import { AccountService } from '../src/users/account.service';
import type { AuditService } from '../src/audit/audit.service';
import type { PrismaService } from '../src/prisma.service';
import type { SupabaseService } from '../src/supabase/supabase.service';
import type { MuxService } from '../src/video/mux.service';

// jest maps `jose` (ESM-only) to an inert stub. These tests need real HS256
// signing and verification, so this file swaps in a small double built on
// node:crypto with jose's semantics for the calls the service makes; the
// test "matches the real jose library" below checks the double against the
// real package in a child process.
jest.mock('jose', () => {
  const nodeCrypto: typeof import('crypto') = jest.requireActual('crypto');
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const fail = (code: string, message: string) => Object.assign(new Error(message), { code });
  class SignJWT {
    private header: Record<string, unknown> = {};
    private readonly claims: Record<string, unknown>;
    constructor(claims: Record<string, unknown>) {
      this.claims = { ...claims };
    }
    setProtectedHeader(h: Record<string, unknown>) {
      this.header = h;
      return this;
    }
    setSubject(v: string) {
      this.claims.sub = v;
      return this;
    }
    setAudience(v: string) {
      this.claims.aud = v;
      return this;
    }
    setJti(v: string) {
      this.claims.jti = v;
      return this;
    }
    setIssuedAt(v?: number) {
      this.claims.iat = v ?? Math.floor(new Date().getTime() / 1000);
      return this;
    }
    setExpirationTime(v: number | string) {
      const minutes = typeof v === 'string' ? Number(/^(\d+)m$/.exec(v)?.[1] ?? 0) : 0;
      this.claims.exp =
        typeof v === 'number' ? v : Math.floor(new Date().getTime() / 1000) + minutes * 60;
      return this;
    }
    async sign(key: Uint8Array) {
      const input = `${enc(this.header)}.${enc(this.claims)}`;
      return `${input}.${nodeCrypto.createHmac('sha256', key).update(input).digest('base64url')}`;
    }
  }
  async function jwtVerify(
    token: string,
    key: Uint8Array,
    opts: { algorithms: string[]; audience?: string; requiredClaims?: string[] },
  ) {
    const parts = String(token).split('.');
    if (parts.length !== 3) throw fail('ERR_JWS_INVALID', 'Invalid Compact JWS');
    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    } catch {
      throw fail('ERR_JWS_INVALID', 'Invalid Compact JWS');
    }
    if (!opts.algorithms.includes(String(header.alg))) {
      throw fail('ERR_JOSE_ALG_NOT_ALLOWED', 'alg not allowed');
    }
    const want = nodeCrypto.createHmac('sha256', key).update(`${parts[0]}.${parts[1]}`).digest();
    const got = Buffer.from(parts[2], 'base64url');
    if (got.length !== want.length || !nodeCrypto.timingSafeEqual(got, want)) {
      throw fail('ERR_JWS_SIGNATURE_VERIFICATION_FAILED', 'signature verification failed');
    }
    for (const c of opts.requiredClaims ?? []) {
      if (!(c in payload)) throw fail('ERR_JWT_CLAIM_VALIDATION_FAILED', `missing ${c}`);
    }
    if (opts.audience !== undefined && payload.aud !== opts.audience) {
      throw fail('ERR_JWT_CLAIM_VALIDATION_FAILED', 'unexpected "aud" claim value');
    }
    if (typeof payload.exp === 'number' && payload.exp <= Math.floor(new Date().getTime() / 1000)) {
      throw fail('ERR_JWT_EXPIRED', '"exp" claim timestamp check failed');
    }
    return { payload, protectedHeader: header };
  }
  return { SignJWT, jwtVerify, errors: {} };
});

const mockCaptureMessage = jest.fn();
jest.mock('@sentry/node', () => ({
  ...jest.requireActual('@sentry/node'),
  captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
}));

function stub<T>(value: unknown): T {
  return value as T;
}

const A = '3f0c7a52-6a51-4c55-9a0e-0c9d6f1b2a10';
const B = '9a1d2c3b-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const SECRET = process.env.DATA_EXPORT_TOKEN_SECRET ?? 'change-me-in-production-min32chars!';
const ARCHIVE = Buffer.from('{"manifest":{"export_id":"x"},"user":{"name":"A"}}');

// ─── Fake Supabase Storage (one shared bucket) ──────────────────────────────

type Fault = { status?: number; message: string; land?: boolean };

function storageErr(f: Fault): Error {
  return Object.assign(new Error(f.message), f.status === undefined ? {} : { status: f.status });
}

function fakeStorage() {
  const objects = new Map<string, { body: Buffer; created_at: string }>();
  const bucket = { exists: true, public: false };
  const faults: Record<'upload' | 'info' | 'remove' | 'sign' | 'list', Fault[]> = {
    upload: [],
    info: [],
    remove: [],
    sign: [],
    list: [],
  };
  const calls: string[] = [];
  const bucketsUsed = new Set<string>();
  const api = {
    upload: async (key: string, body: Buffer, opts: { upsert?: boolean; contentType?: string }) => {
      calls.push(`upload:${key}:upsert=${String(opts.upsert)}:${opts.contentType}`);
      const f = faults.upload.shift();
      if (f?.land)
        objects.set(key, { body: Buffer.from(body), created_at: new Date().toISOString() });
      if (f) return { data: null, error: storageErr(f) };
      objects.set(key, { body: Buffer.from(body), created_at: new Date().toISOString() });
      return { data: { path: key }, error: null };
    },
    info: async (key: string) => {
      calls.push(`info:${key}`);
      const f = faults.info.shift();
      if (f) return { data: null, error: storageErr(f) };
      const o = objects.get(key);
      if (!o)
        return { data: null, error: storageErr({ status: 404, message: 'Object not found' }) };
      return { data: { size: o.body.length }, error: null };
    },
    remove: async (keys: string[]) => {
      calls.push(`remove:${keys.join(',')}`);
      const f = faults.remove.shift();
      if (f) return { data: null, error: storageErr(f) };
      const deleted = keys.filter((k) => objects.delete(k));
      return { data: deleted.map((name) => ({ name })), error: null };
    },
    createSignedUrl: async (key: string, ttl: number) => {
      calls.push(`sign:${key}:${ttl}`);
      const f = faults.sign.shift();
      if (f) return { data: null, error: storageErr(f) };
      if (!objects.has(key)) {
        return { data: null, error: storageErr({ status: 400, message: 'Object not found' }) };
      }
      return { data: { signedUrl: `https://storage.test/sign/${key}?token=t` }, error: null };
    },
    list: async (prefix: string, opts: { limit: number; offset: number }) => {
      calls.push(`list:${prefix}:${opts.offset}`);
      const f = faults.list.shift();
      if (f) return { data: null, error: storageErr(f) };
      if (prefix !== '') return { data: [], error: null };
      const all = [...objects.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, o]) => ({ name, id: `obj-${name}`, created_at: o.created_at }));
      return { data: all.slice(opts.offset, opts.offset + opts.limit), error: null };
    },
  };
  const client = {
    storage: {
      from: (b: string) => {
        bucketsUsed.add(b);
        return api;
      },
      getBucket: async (id: string) => {
        calls.push(`getBucket:${id}`);
        return bucket.exists
          ? { data: { id, name: id, public: bucket.public }, error: null }
          : { data: null, error: storageErr({ status: 404, message: 'Bucket not found' }) };
      },
    },
  };
  const fetchImpl = jest.fn(async (url: string) => {
    const key = decodeURIComponent(url.split('/sign/')[1].split('?')[0]);
    const o = objects.get(key);
    if (!o) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(o.body), {
      status: 200,
      headers: { 'content-length': String(o.body.length) },
    });
  });
  const supabase = stub<SupabaseService>({ getClient: () => client });
  const store = () =>
    new SupabaseArchiveStore(supabase, {
      sleep: async () => undefined,
      fetchImpl: stub<typeof fetch>(fetchImpl),
    });
  return { objects, bucket, faults, calls, bucketsUsed, fetchImpl, supabase, store };
}

// ─── In-memory Prisma (shared by every service instance) ─────────────────────

type Row = {
  id: string;
  user_id: string;
  status: DataExportStatus;
  file_url: string | null;
  created_at: Date;
  completed_at: Date | null;
  expires_at: Date | null;
  file_size_bytes: number | null;
  sha256: string | null;
};

type Where = Record<string, unknown>;

function matches(row: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>;
      if ('in' in c && !(c.in as unknown[]).includes(v)) return false;
      if ('not' in c && v === c.not) return false;
      if ('lt' in c && !(v instanceof Date && v < (c.lt as Date))) return false;
      if ('lte' in c && !(v instanceof Date && v <= (c.lte as Date))) return false;
      if ('gte' in c && !(v instanceof Date && v >= (c.gte as Date))) return false;
      return true;
    }
    return v === cond;
  });
}

function fakeDb() {
  const rows = new Map<string, Row>();
  const users = new Map<string, { id: string; deleted_at: Date | null }>([
    [A, { id: A, deleted_at: null }],
    [B, { id: B, deleted_at: null }],
  ]);
  const cleanup = new Map<string, Record<string, unknown>>();
  const audits: string[] = [];
  let seq = 0;
  const sorted = (list: Row[]) =>
    [...list].sort((x, y) => y.created_at.getTime() - x.created_at.getTime());
  const prisma = {
    dataExportRequest: {
      findFirst: async (args: { where: Where }) =>
        sorted([...rows.values()].filter((r) => matches(r, args.where)))[0] ?? null,
      findMany: async (args: { where: Where; take?: number }) =>
        sorted([...rows.values()].filter((r) => matches(r, args.where)))
          .slice(0, args.take ?? 10_000)
          .map((r) => ({ ...r })),
      findUnique: async (args: { where: { id: string } }) => {
        const r = rows.get(args.where.id);
        return r ? { ...r } : null;
      },
      create: async (args: { data: { user_id: string; status: DataExportStatus } }) => {
        const active = [...rows.values()].some(
          (r) =>
            r.user_id === args.data.user_id && ['PENDING', 'RUNNING', 'READY'].includes(r.status),
        );
        if (active) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        seq += 1;
        const row: Row = {
          id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
          user_id: args.data.user_id,
          status: args.data.status,
          file_url: null,
          created_at: new Date(),
          completed_at: null,
          expires_at: null,
          file_size_bytes: null,
          sha256: null,
        };
        rows.set(row.id, row);
        return { ...row };
      },
      update: async (args: { where: { id: string }; data: Partial<Row> }) => {
        const r = rows.get(args.where.id);
        if (!r) throw new Error('P2025');
        Object.assign(r, args.data);
        return { ...r };
      },
      updateMany: async (args: { where: Where; data: Partial<Row> }) => {
        let count = 0;
        for (const r of rows.values()) {
          if (matches(r, args.where)) {
            Object.assign(r, args.data);
            count += 1;
          }
        }
        return { count };
      },
    },
    user: {
      findUnique: async (args: { where: { id: string } }) => users.get(args.where.id) ?? null,
    },
    dataExportArchiveCleanup: {
      upsert: async (args: { where: { export_id: string }; create: Record<string, unknown> }) => {
        const prev = cleanup.get(args.where.export_id);
        cleanup.set(args.where.export_id, {
          attempts: 1,
          created_at: new Date(),
          ...(prev ?? {}),
          ...args.create,
          ...(prev ? { attempts: Number(prev.attempts) + 1 } : {}),
        });
        return {};
      },
      findMany: async (args: { where: { machine: string } }) =>
        [...cleanup.values()].filter((c) => c.machine === args.where.machine),
      update: async (args: { where: { export_id: string } }) => {
        const c = cleanup.get(args.where.export_id);
        if (c) c.attempts = Number(c.attempts) + 1;
        return c;
      },
      deleteMany: async (args: { where: { export_id: string; machine: string } }) => {
        const c = cleanup.get(args.where.export_id);
        if (!c || c.machine !== args.where.machine) return { count: 0 };
        cleanup.delete(args.where.export_id);
        return { count: 1 };
      },
      count: async () => 0,
    },
    auditLog: {
      create: async (args: { data: { event_type: string } }) => {
        audits.push(args.data.event_type);
        return {};
      },
    },
  };
  return { prisma: stub<PrismaService>(prisma), rows, users, cleanup, audits };
}

/** One service instance (an API machine or a worker machine). */
function instance(db: ReturnType<typeof fakeDb>, storage: ReturnType<typeof fakeStorage>) {
  const svc = new DataExportService(db.prisma, storage.store());
  Object.assign(svc, {
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    _buildArchive: async () => ({ buffer: ARCHIVE, sha256: 'a'.repeat(64) }),
  });
  return svc;
}

/** Request on the API instance without running the job there. */
async function requestOnly(svc: DataExportService, userId: string) {
  Object.assign(svc, { _runExport: async () => undefined });
  return svc.requestExport(userId);
}

function runOn(svc: DataExportService, exportId: string, userId: string): Promise<void> {
  const fn: unknown = Reflect.get(svc, '_runExport');
  if (typeof fn !== 'function') throw new Error('no _runExport');
  return fn.call(svc, exportId, userId);
}

async function readAll(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of chunks) parts.push(Buffer.from(c));
  return Buffer.concat(parts);
}

function tokenFrom(path: string): string {
  return decodeURIComponent(path.split('token=')[1]);
}

async function forge(claims: Record<string, unknown>, opts: { ttl?: number; aud?: string } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(opts.aud ?? 'tgp:data-export-download')
    .setJti('j')
    .setIssuedAt(now)
    .setExpirationTime(now + (opts.ttl ?? 300))
    .sign(new TextEncoder().encode(SECRET));
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  const err: unknown = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (err instanceof HttpException) {
    const body = err.getResponse();
    return typeof body === 'object' && body !== null
      ? String(Reflect.get(body, 'code'))
      : undefined;
  }
  if (err && typeof err === 'object' && 'code' in err) return String(Reflect.get(err, 'code'));
  return err === null ? 'RESOLVED' : 'UNKNOWN_ERROR';
}

/** Ready export for `user` (request on API, run on worker). */
async function readyExport(
  db: ReturnType<typeof fakeDb>,
  st: ReturnType<typeof fakeStorage>,
  user = A,
) {
  const api = instance(db, st);
  const rec = await requestOnly(api, user);
  await runOn(instance(db, st), rec.id, user);
  return rec.id;
}

const prevEnv = { ...process.env };
beforeEach(() => {
  mockCaptureMessage.mockClear();
  delete process.env.DATA_EXPORT_STORAGE;
  delete process.env.DATA_EXPORT_DOWNLOAD_LINK_TTL_SECONDS;
});
afterAll(() => {
  process.env = prevEnv;
});

// ─── Store contract ─────────────────────────────────────────────────────────

describe('SupabaseArchiveStore', () => {
  const ID = '00000000-0000-4000-8000-0000000000aa';

  it('writes <id>.json to the private data-exports bucket with upsert, then checks the stored size', async () => {
    const st = fakeStorage();
    await st.store().put(ID, ARCHIVE);
    expect([...st.bucketsUsed]).toEqual([DATA_EXPORT_BUCKET]);
    expect(st.calls).toEqual([
      `getBucket:${DATA_EXPORT_BUCKET}`,
      `upload:${ID}.json:upsert=true:application/json`,
      `info:${ID}.json`,
    ]);
    expect(st.store().urlFor(ID)).toBe(`supabase-storage://data-exports/${ID}.json`);
  });

  it('refuses to write while the bucket is public, and when it is missing', async () => {
    const st = fakeStorage();
    st.bucket.public = true;
    expect(await codeOf(st.store().put(ID, ARCHIVE))).toBe('STORAGE_BUCKET_PUBLIC');
    st.bucket.public = false;
    st.bucket.exists = false;
    expect(await codeOf(st.store().put(ID, ARCHIVE))).toBe('STORAGE_NOT_FOUND');
    expect(st.calls.some((c) => c.startsWith('upload:'))).toBe(false);
  });

  it('retries transient upload failures (503, network) and succeeds', async () => {
    const st = fakeStorage();
    st.faults.upload.push({ status: 503, message: 'busy' }, { message: 'fetch failed' });
    await st.store().put(ID, ARCHIVE);
    expect(st.calls.filter((c) => c.startsWith('upload:'))).toHaveLength(3);
    expect(st.objects.get(`${ID}.json`)?.body.equals(ARCHIVE)).toBe(true);
  });

  it('does not retry permanent failures (403, 413) and gives up after three transient ones', async () => {
    const st = fakeStorage();
    st.faults.upload.push({ status: 403, message: 'denied' });
    expect(await codeOf(st.store().put(ID, ARCHIVE))).toBe('STORAGE_FORBIDDEN');
    expect(st.calls.filter((c) => c.startsWith('upload:'))).toHaveLength(1);
    st.faults.upload.push({ status: 413, message: 'too big' });
    expect(await codeOf(st.store().put(ID, ARCHIVE))).toBe('STORAGE_TOO_LARGE');
    st.calls.length = 0;
    st.faults.remove.push(
      { status: 500, message: 'x' },
      { status: 502, message: 'x' },
      { status: 503, message: 'x' },
    );
    expect(await codeOf(st.store().remove(ID))).toBe('STORAGE_HTTP_503');
    expect(st.calls.filter((c) => c.startsWith('remove:'))).toHaveLength(3);
  });

  it('a stored size that differs from the archive is an error (never READY)', async () => {
    const st = fakeStorage();
    const store = st.store();
    const realInfo = st.supabase.getClient().storage.from(DATA_EXPORT_BUCKET).info;
    Object.assign(st.supabase.getClient().storage.from(DATA_EXPORT_BUCKET), {
      info: async () => ({ data: { size: 3 }, error: null }),
    });
    expect(await codeOf(store.put(ID, ARCHIVE))).toBe('STORAGE_SIZE_MISMATCH');
    Object.assign(st.supabase.getClient().storage.from(DATA_EXPORT_BUCKET), { info: realInfo });
  });

  it('remove of an archive that is already gone succeeds; keys are derived, unsafe ids refused', async () => {
    const st = fakeStorage();
    await st.store().remove(ID);
    expect(await codeOf(st.store().remove('../escape'))).toBe('INVALID_EXPORT_ID');
    expect(await codeOf(st.store().put('a/b', ARCHIVE))).toBe('INVALID_EXPORT_ID');
    expect(st.calls).toEqual([`remove:${ID}.json`]);
    expect(st.store().owns(`supabase-storage://data-exports/${ID}.json`, ID)).toBe(true);
    expect(st.store().owns('supabase-storage://data-exports/other.json', ID)).toBe(false);
    expect(st.store().owns(`supabase-storage://coach-media/${ID}.json`, ID)).toBe(false);
  });

  it('reads through a 60-second signed URL used only server-side; missing archive is STORAGE_NOT_FOUND', async () => {
    const st = fakeStorage();
    await st.store().put(ID, ARCHIVE);
    const read = await st.store().read(ID);
    expect(read.size).toBe(ARCHIVE.length);
    expect((await readAll(read.chunks)).equals(ARCHIVE)).toBe(true);
    expect(st.calls).toContain(`sign:${ID}.json:60`);
    expect(await codeOf(st.store().read('00000000-0000-4000-8000-0000000000bb'))).toBe(
      'STORAGE_NOT_FOUND',
    );
  });

  it('lists only <id>.json archives', async () => {
    const st = fakeStorage();
    await st.store().put(ID, ARCHIVE);
    st.objects.set('notes.txt', { body: Buffer.from('x'), created_at: new Date().toISOString() });
    const listed = await st.store().list();
    expect(listed.map((l) => l.exportId)).toEqual([ID]);
    expect(listed[0].createdAt).toBeInstanceOf(Date);
  });

  it('classifies storage errors with stable codes', () => {
    expect(classifyStorageError({ status: 429, message: 'slow' }, 'op')).toMatchObject({
      code: 'STORAGE_HTTP_429',
      retryable: true,
    });
    expect(classifyStorageError(new Error('socket hang up'), 'op')).toMatchObject({
      code: 'STORAGE_NETWORK',
      retryable: true,
    });
    expect(classifyStorageError({ status: 400, message: 'bad' }, 'op')).toMatchObject({
      code: 'STORAGE_HTTP_400',
      retryable: false,
    });
  });

  it('withStorageRetry waits between attempts (250 ms, 1 s)', async () => {
    const waits: number[] = [];
    let n = 0;
    const out = await withStorageRetry(
      'op',
      async () => {
        n += 1;
        if (n < 3) throw new ArchiveStorageError('STORAGE_HTTP_503', 'x', true);
        return 'ok';
      },
      { sleep: async (ms) => void waits.push(ms) },
    );
    expect(out).toBe('ok');
    expect(waits).toEqual([250, 1000]);
  });
});

describe('store selection', () => {
  it('production always uses the private bucket; local is refused there', () => {
    const st = fakeStorage();
    expect(archiveStoreKind({ NODE_ENV: 'production' })).toBe('supabase');
    expect(selectArchiveStore(st.supabase, { NODE_ENV: 'production' }).kind).toBe('supabase');
    expect(() =>
      archiveStoreKind({ NODE_ENV: 'production', DATA_EXPORT_STORAGE: 'local' }),
    ).toThrow(/not allowed in production/);
    expect(() => archiveStoreKind({ DATA_EXPORT_STORAGE: 's3' })).toThrow(
      /must be "supabase" or "local"/,
    );
    expect(archiveStoreKind({ NODE_ENV: 'test' })).toBe('local');
    expect(archiveStoreKind({ NODE_ENV: 'test', DATA_EXPORT_STORAGE: 'supabase' })).toBe(
      'supabase',
    );
  });

  it('the service refuses to start in production without the Supabase store', () => {
    const prev = { ...process.env };
    process.env.NODE_ENV = 'production';
    process.env.DATA_EXPORT_TOKEN_SECRET = 'x'.repeat(40);
    try {
      expect(() => new DataExportService(fakeDb().prisma)).toThrow(/private Supabase bucket/);
      expect(() => new DataExportService(fakeDb().prisma, fakeStorage().store())).not.toThrow();
    } finally {
      process.env = prev;
    }
  });
});

// ─── Round trip across instances ────────────────────────────────────────────

describe('request -> ready -> download across independent API, worker and download instances', () => {
  it('the archive the worker stored is the archive the user downloads', async () => {
    const db = fakeDb();
    const st = fakeStorage();
    const api = instance(db, st);
    const worker = instance(db, st);
    const downloader = instance(db, st);

    const rec = await requestOnly(api, A);
    expect((await api.getLatestStatus(A)).download_available).toBe(false);
    await runOn(worker, rec.id, A);

    const row = db.rows.get(rec.id);
    expect(row?.status).toBe(DataExportStatus.READY);
    expect(row?.file_url).toBe(`supabase-storage://data-exports/${rec.id}.json`);
    expect(row?.file_size_bytes).toBe(ARCHIVE.length);

    const status = await api.getLatestStatus(A);
    expect(status).toMatchObject({ status: 'READY', download_available: true });
    expect(JSON.stringify(status)).not.toMatch(/supabase-storage|storage\.test|file_url/);

    const link = await api.createDownloadLink(A);
    expect(link.download_path).toMatch(/^\/v1\/me\/data-export\/download\?token=/);
    expect(link.file_name).toMatch(/^tgp-data-export-\d{4}-\d{2}-\d{2}\.json$/);
    expect(link.expires_at.getTime() - Date.now()).toBeLessThanOrEqual(300_000);
    expect(JSON.stringify(link)).not.toMatch(/supabase|storage\.test/);

    const dl = await downloader.openDownload(tokenFrom(link.download_path));
    expect((await readAll(dl.chunks)).equals(ARCHIVE)).toBe(true);
    expect(dl.size).toBe(ARCHIVE.length);
    expect(db.audits).toEqual(
      expect.arrayContaining(['data_export_link_issued', 'data_export_downloaded']),
    );
  });

  it('link tokens match the real jose library (child process, real package)', async () => {
    const db = fakeDb();
    const st = fakeStorage();
    const id = await readyExport(db, st);
    const svc = instance(db, st);
    const token = tokenFrom((await svc.createDownloadLink(A)).download_path);
    const script = [
      "import { SignJWT, jwtVerify } from 'jose';",
      'const key = new TextEncoder().encode(process.env.T_SECRET);',
      "const opts = { algorithms: ['HS256'], audience: 'tgp:data-export-download', requiredClaims: ['sub', 'exp', 'iat', 'jti'] };",
      'const minted = (await jwtVerify(process.env.T_TOKEN, key, opts)).payload;',
      'const now = Math.floor(Date.now() / 1000);',
      "const sign = (iat, exp) => new SignJWT({ eid: process.env.T_EID, type: 'data_export_download' }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setSubject(process.env.T_SUB).setAudience('tgp:data-export-download').setJti('j1').setIssuedAt(iat).setExpirationTime(exp).sign(key);",
      'const fresh = await sign(now, now + 300);',
      'let expiredCode = null;',
      'try { await jwtVerify(await sign(now - 600, now - 300), key, opts); } catch (e) { expiredCode = e.code; }',
      'process.stdout.write(JSON.stringify({ minted, fresh, expiredCode }));',
    ].join('\n');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: join(__dirname, '..'),
      env: { ...process.env, T_SECRET: SECRET, T_TOKEN: token, T_EID: id, T_SUB: A },
      encoding: 'utf8',
    });
    const real = JSON.parse(out);
    expect(real.minted).toMatchObject({ sub: A, eid: id, type: 'data_export_download' });
    expect(real.minted.exp - real.minted.iat).toBe(300);
    expect(real.expiredCode).toBe('ERR_JWT_EXPIRED');
    const dl = await svc.openDownload(real.fresh);
    expect((await readAll(dl.chunks)).equals(ARCHIVE)).toBe(true);
  });

  it('the status token (older app builds) also downloads, and is short-lived', async () => {
    const db = fakeDb();
    const st = fakeStorage();
    await readyExport(db, st);
    const status = await instance(db, st).getLatestStatus(A);
    expect(status.download_token).toEqual(expect.any(String));
    const dl = await instance(db, st).openDownload(status.download_token ?? '');
    expect((await readAll(dl.chunks)).equals(ARCHIVE)).toBe(true);
  });
});

// ─── Link scoping and cross-user denial ─────────────────────────────────────

describe('download links are bound to the user and the export', () => {
  it("a token naming user A cannot open user B's export (same 401 as an unknown export)", async () => {
    const db = fakeDb();
    const st = fakeStorage();
    const bExport = await readyExport(db, st, B);
    const svc = instance(db, st);
    const crossUser = await forge({ type: 'data_export_download', eid: bExport, sub: A });
    expect(await codeOf(svc.openDownload(crossUser))).toBe('DATA_EXPORT_LINK_INVALID');
    const unknown = await forge({
      type: 'data_export_download',
      eid: '00000000-0000-4000-8000-00000000dead',
      sub: A,
    });
    expect(await codeOf(svc.openDownload(unknown))).toBe('DATA_EXPORT_LINK_INVALID');
    expect(st.calls.some((c) => c.startsWith('sign:'))).toBe(false);
  });

  it("a user with no export of their own cannot obtain a link to anyone else's", async () => {
    const db = fakeDb();
    const st = fakeStorage();
    await readyExport(db, st, B);
    expect(await codeOf(instance(db, st).createDownloadLink(A))).toBe('DATA_EXPORT_NOT_FOUND');
  });

  it('tampered, wrong-type, wrong-audience, over-long, missing and foreign-secret tokens are refused', async () => {
    const db = fakeDb();
    const st = fakeStorage();
    const id = await readyExport(db, st);
    const svc = instance(db, st);
    const good = tokenFrom((await svc.createDownloadLink(A)).download_path);
    const [h, p, s] = good.split('.');
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    const tampered = [
      h,
      Buffer.from(JSON.stringify({ ...payload, sub: B })).toString('base64url'),
      s,
    ].join('.');
    expect(await codeOf(svc.openDownload(tampered))).toBe('DATA_EXPORT_LINK_INVALID');
    expect(await codeOf(svc.openDownload(await forge({ type: 'other', eid: id, sub: A })))).toBe(
      'DATA_EXPORT_LINK_INVALID',
    );
    expect(
      await codeOf(
        svc.openDownload(
          await forge({ type: 'data_export_download', eid: id, sub: A }, { aud: 'x' }),
        ),
      ),
    ).toBe('DATA_EXPORT_LINK_INVALID');
    expect(
      await codeOf(
        svc.openDownload(
          await forge({ type: 'data_export_download', eid: id, sub: A }, { ttl: 7 * 86_400 }),
        ),
      ),
    ).toBe('DATA_EXPORT_LINK_INVALID');
    expect(await codeOf(svc.openDownload(undefined))).toBe('DATA_EXPORT_LINK_INVALID');
    const foreign = await new SignJWT({ type: 'data_export_download', eid: id })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(A)
      .setAudience('tgp:data-export-download')
      .setJti('j')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('another-secret-another-secret-123456'));
    expect(await codeOf(svc.openDownload(foreign))).toBe('DATA_EXPORT_LINK_INVALID');
  });

  it("a deleted owner's link stops working", async () => {
    const db = fakeDb();
    const st = fakeStorage();
    await readyExport(db, st);
    const svc = instance(db, st);
    const token = tokenFrom((await svc.createDownloadLink(A)).download_path);
    db.users.set(A, { id: A, deleted_at: new Date() });
    expect(await codeOf(svc.openDownload(token))).toBe('DATA_EXPORT_LINK_INVALID');
  });
});

// ─── Expiry ─────────────────────────────────────────────────────────────────

describe('expiry', () => {
  afterEach(() => jest.useRealTimers());

  it('a link expires after 5 minutes (DATA_EXPORT_LINK_EXPIRED); the TTL is clamped to 60..900 s', async () => {
    const db = fakeDb();
    const st = fakeStorage();
    await readyExport(db, st);
    const svc = instance(db, st);
    const token = tokenFrom((await svc.createDownloadLink(A)).download_path);
    jest.useFakeTimers({
      doNotFake: ['setTimeout', 'setImmediate', 'setInterval', 'nextTick', 'queueMicrotask'],
    });
    jest.setSystemTime(Date.now() + 301_000);
    expect(await codeOf(svc.openDownload(token))).toBe('DATA_EXPORT_LINK_EXPIRED');
    expect(downloadLinkTtlSeconds({ DATA_EXPORT_DOWNLOAD_LINK_TTL_SECONDS: '5' })).toBe(60);
    expect(downloadLinkTtlSeconds({ DATA_EXPORT_DOWNLOAD_LINK_TTL_SECONDS: '86400' })).toBe(900);
    expect(downloadLinkTtlSeconds({})).toBe(300);
  });

  it('an archive past its 7 days cannot be linked or downloaded, and the nightly run deletes it first', async () => {
    const db = fakeDb();
    const st = fakeStorage();
    const id = await readyExport(db, st);
    const svc = instance(db, st);
    const token = tokenFrom((await svc.createDownloadLink(A)).download_path);
    const row = db.rows.get(id);
    if (!row) throw new Error('row');
    row.expires_at = new Date(Date.now() - 1000);
    expect(await codeOf(svc.openDownload(token))).toBe('DATA_EXPORT_EXPIRED');
    expect(row.status).toBe(DataExportStatus.EXPIRED); // marked lazily
    expect(await codeOf(svc.createDownloadLink(A))).toBe('DATA_EXPORT_EXPIRED');
    expect(st.objects.has(`${id}.json`)).toBe(true);
    await svc.expireOldExports();
    expect(st.objects.has(`${id}.json`)).toBe(false);
    expect(row).toMatchObject({ status: DataExportStatus.EXPIRED, file_url: null });
  });

  it('a Storage failure during nightly expiry keeps the row and its file reference for the next run', async () => {
    const db = fakeDb();
    const st = fakeStorage();
    const id = await readyExport(db, st);
    const row = db.rows.get(id);
    if (!row) throw new Error('row');
    row.expires_at = new Date(Date.now() - 1000);
    const svc = instance(db, st);
    // Drain + reap + sweep make no remove calls here; the three faults hit the expiry delete.
    st.faults.remove.push(
      { status: 500, message: 'x' },
      { status: 500, message: 'x' },
      { status: 500, message: 'x' },
    );
    await svc.expireOldExports();
    expect(row.file_url).toBe(`supabase-storage://data-exports/${id}.json`);
    expect(st.objects.has(`${id}.json`)).toBe(true);
    await svc.expireOldExports();
    expect(row.file_url).toBeNull();
    expect(st.objects.has(`${id}.json`)).toBe(false);
  });
});

// ─── Account deletion ───────────────────────────────────────────────────────

describe('account deletion removes the archive', () => {
  function deletion(st: ReturnType<typeof fakeStorage>) {
    const svc = new AccountDeletionStorageService(
      stub<ConfigService>({ get: () => undefined }),
      st.supabase,
      stub<MuxService>({ deleteAsset: jest.fn() }),
    );
    Object.assign(svc, { logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() } });
    return svc;
  }
  function tx(exports: Array<{ id: string; file_url: string | null }>): Prisma.TransactionClient {
    const empty = { findMany: async () => [] };
    return stub<Prisma.TransactionClient>({
      communityVoiceNote: empty,
      coachMessage: empty,
      communityMessage: empty,
      coachMediaAsset: empty,
      communityClassroomMediaAsset: empty,
      bloodworkAttachment: empty,
      dataExportRequest: { findMany: async () => exports },
    });
  }

  it('collects the stored archive and the planned archive of a running export, and purge removes them', async () => {
    process.env.DATA_EXPORT_STORAGE = 'supabase';
    const db = fakeDb();
    const st = fakeStorage();
    const ready = await readyExport(db, st);
    const running = '00000000-0000-4000-8000-0000000000cc';
    st.objects.set(`${running}.json`, { body: ARCHIVE, created_at: new Date().toISOString() });
    const svc = deletion(st);
    const objects = await svc.collect(
      tx([
        { id: ready, file_url: `supabase-storage://data-exports/${ready}.json` },
        { id: running, file_url: null },
      ]),
      A,
    );
    expect(objects).toEqual(
      expect.arrayContaining([
        { kind: 'supabase', bucket: DATA_EXPORT_BUCKET, key: `${ready}.json` },
        { kind: 'supabase', bucket: DATA_EXPORT_BUCKET, key: `${running}.json` },
      ]),
    );
    expect(objects.filter((o) => o.kind === 'supabase')).toHaveLength(2);
    await svc.purge(objects);
    expect(st.objects.size).toBe(0);
  });

  it('a Storage failure fails the purge (the finalization transaction rolls back and retries)', async () => {
    process.env.DATA_EXPORT_STORAGE = 'supabase';
    const st = fakeStorage();
    const svc = deletion(st);
    const id = '00000000-0000-4000-8000-0000000000dd';
    const objects = await svc.collect(tx([{ id, file_url: null }]), A);
    st.faults.remove.push({ status: 503, message: 'down' });
    await expect(svc.purge(objects)).rejects.toThrow(/data-exports failed/);
  });

  it('a file_url naming any other object is refused, never deleted', async () => {
    process.env.DATA_EXPORT_STORAGE = 'supabase';
    const st = fakeStorage();
    const id = '00000000-0000-4000-8000-0000000000ee';
    await expect(
      deletion(st).collect(
        tx([{ id, file_url: 'supabase-storage://data-exports/someone-else.json' }]),
        A,
      ),
    ).rejects.toThrow(/unsupported storage URL/);
  });
});

// ─── Late write, failed run, durable cleanup ────────────────────────────────

describe('late write after erasure and failed runs never leave the archive', () => {
  it('an export finishing after its row was erased deletes its own archive from the bucket', async () => {
    const db = fakeDb();
    const st = fakeStorage();
    const rec = await requestOnly(instance(db, st), A);
    const worker = instance(db, st);
    Object.assign(worker, {
      _buildArchive: async () => {
        db.rows.delete(rec.id); // account deletion commits mid-build
        return { buffer: ARCHIVE, sha256: 'a'.repeat(64) };
      },
    });
    await runOn(worker, rec.id, A);
    expect(st.objects.size).toBe(0);
    expect(db.cleanup.size).toBe(0);
  });

  it('when that delete keeps failing the runner rejects, a cleanup record is kept, and another machine drains it', async () => {
    const db = fakeDb();
    const st = fakeStorage();
    const rec = await requestOnly(instance(db, st), A);
    const worker = instance(db, st);
    Object.assign(worker, {
      _buildArchive: async () => {
        db.rows.delete(rec.id);
        return { buffer: ARCHIVE, sha256: 'a'.repeat(64) };
      },
    });
    st.faults.remove.push(
      { status: 503, message: 'x' },
      { status: 503, message: 'x' },
      { status: 503, message: 'x' },
    );
    const err: unknown = await runOn(worker, rec.id, A).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DataExportArchiveCleanupError);
    expect(err).toMatchObject({
      reason: 'request_removed',
      storageCode: 'STORAGE_HTTP_503',
      recorded: true,
    });
    expect(st.objects.has(`${rec.id}.json`)).toBe(true);
    expect(db.cleanup.get(rec.id)).toMatchObject({
      machine: 'supabase-storage:data-exports',
      reason: 'request_removed',
      last_error_code: 'STORAGE_HTTP_503',
    });
    // Any machine can drain a bucket record.
    const other = instance(db, st);
    expect(await other.drainArchiveCleanups()).toEqual({ removed: 1, pending: 0 });
    expect(st.objects.has(`${rec.id}.json`)).toBe(false);
    expect(db.cleanup.size).toBe(0);
  });

  it('a transient upload failure is retried and the export still becomes READY', async () => {
    const db = fakeDb();
    const st = fakeStorage();
    const rec = await requestOnly(instance(db, st), A);
    st.faults.upload.push({ status: 503, message: 'busy' });
    await runOn(instance(db, st), rec.id, A);
    expect(db.rows.get(rec.id)?.status).toBe(DataExportStatus.READY);
  });

  it('an upload whose response is lost every time fails the run and removes the bytes that landed', async () => {
    const db = fakeDb();
    const st = fakeStorage();
    const rec = await requestOnly(instance(db, st), A);
    st.faults.upload.push(
      { status: 504, message: 'gateway', land: true },
      { status: 504, message: 'gateway', land: true },
      { status: 504, message: 'gateway', land: true },
    );
    expect(await codeOf(runOn(instance(db, st), rec.id, A))).toBe('STORAGE_HTTP_504');
    expect(db.rows.get(rec.id)?.status).toBe(DataExportStatus.FAILED);
    expect(st.objects.size).toBe(0);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'data export storage write failed',
      expect.objectContaining({ tags: { code: 'STORAGE_HTTP_504' } }),
    );
  });

  it('a public bucket fails the run before any byte is written', async () => {
    const db = fakeDb();
    const st = fakeStorage();
    st.bucket.public = true;
    const rec = await requestOnly(instance(db, st), A);
    expect(await codeOf(runOn(instance(db, st), rec.id, A))).toBe('STORAGE_BUCKET_PUBLIC');
    expect(st.calls.some((c) => c.startsWith('upload:'))).toBe(false);
    expect(db.rows.get(rec.id)?.status).toBe(DataExportStatus.FAILED);
  });
});

// ─── Lifecycle: supersede, stale runs, legacy rows, orphans ─────────────────

describe('export lifecycle', () => {
  it('a READY export from the last 24 h answers DATA_EXPORT_RATE_LIMITED with nothing changed', async () => {
    const db = fakeDb();
    const st = fakeStorage();
    const id = await readyExport(db, st);
    const svc = instance(db, st);
    expect(await codeOf(requestOnly(svc, A))).toBe('DATA_EXPORT_RATE_LIMITED');
    expect(st.objects.has(`${id}.json`)).toBe(true);
    const status = await svc.getLatestStatus(A);
    expect(status.next_request_at?.getTime()).toBeGreaterThan(Date.now());
  });

  it('after 24 h a new request deletes the old archive first, then retires the row', async () => {
    const db = fakeDb();
    const st = fakeStorage();
    const id = await readyExport(db, st);
    const row = db.rows.get(id);
    if (!row) throw new Error('row');
    row.created_at = new Date(Date.now() - 25 * 3_600_000);
    const svc = instance(db, st);
    const next = await requestOnly(svc, A);
    expect(next.id).not.toBe(id);
    expect(row).toMatchObject({ status: DataExportStatus.EXPIRED, file_url: null });
    expect(st.objects.has(`${id}.json`)).toBe(false);
  });

  it('if the old archive cannot be deleted the request answers 503 and keeps the current file', async () => {
    const db = fakeDb();
    const st = fakeStorage();
    const id = await readyExport(db, st);
    const row = db.rows.get(id);
    if (!row) throw new Error('row');
    row.created_at = new Date(Date.now() - 25 * 3_600_000);
    st.faults.remove.push(
      { status: 503, message: 'x' },
      { status: 503, message: 'x' },
      { status: 503, message: 'x' },
    );
    expect(await codeOf(requestOnly(instance(db, st), A))).toBe('DATA_EXPORT_STORAGE_UNAVAILABLE');
    expect(row.status).toBe(DataExportStatus.READY);
    expect(db.rows.size).toBe(1);
  });

  it('a run stuck past 30 minutes is reported FAILED, its planned archive removed, and a new request is accepted', async () => {
    const db = fakeDb();
    const st = fakeStorage();
    const rec = await requestOnly(instance(db, st), A);
    const row = db.rows.get(rec.id);
    if (!row) throw new Error('row');
    row.status = DataExportStatus.RUNNING;
    row.created_at = new Date(Date.now() - 31 * 60_000);
    st.objects.set(`${rec.id}.json`, { body: ARCHIVE, created_at: new Date().toISOString() });
    const svc = instance(db, st);
    expect((await svc.getLatestStatus(A)).status).toBe(DataExportStatus.FAILED);
    expect(row.status).toBe(DataExportStatus.FAILED);
    expect(st.objects.size).toBe(0);
    const fresh = await requestOnly(svc, A);
    expect(fresh.status).toBe(DataExportStatus.PENDING);
  });

  it('the legacy POST /users/me/data-export answers DATA_EXPORT_IN_PROGRESS (not a 500) while an export is active', async () => {
    const db = fakeDb();
    const st = fakeStorage();
    await requestOnly(instance(db, st), A);
    const legacy = new AccountService(
      stub<PrismaService>({
        user: {
          findUnique: async () => ({ id: A, deleted_at: null, role: 'student', email: 'a@x.test' }),
        },
        dataExportRequest: Reflect.get(db.prisma, 'dataExportRequest'),
      }),
      stub<AuditService>({ write: jest.fn(async () => undefined) }),
    );
    expect(await codeOf(legacy.requestDataExport(A))).toBe('DATA_EXPORT_IN_PROGRESS');
  });

  it('a run inside the window answers DATA_EXPORT_IN_PROGRESS', async () => {
    const db = fakeDb();
    const st = fakeStorage();
    await requestOnly(instance(db, st), A);
    expect(await codeOf(requestOnly(instance(db, st), A))).toBe('DATA_EXPORT_IN_PROGRESS');
  });

  it('legacy READY rows (no archive, or a machine-disk path) are never offered and can be replaced', async () => {
    const db = fakeDb();
    const st = fakeStorage();
    db.rows.set('legacy-1', {
      id: 'legacy-1',
      user_id: A,
      status: DataExportStatus.READY,
      file_url: '/tmp/exports/legacy-1.json'.replace(/^/, 'local://'),
      created_at: new Date(),
      completed_at: new Date(),
      expires_at: new Date(Date.now() + 86_400_000),
      file_size_bytes: 10,
      sha256: null,
    });
    const svc = instance(db, st);
    const status = await svc.getLatestStatus(A);
    expect(status).toMatchObject({ download_available: false, download_token: null });
    expect(await codeOf(svc.createDownloadLink(A))).toBe('DATA_EXPORT_FILE_MISSING');
    const next = await requestOnly(svc, A);
    expect(next.status).toBe(DataExportStatus.PENDING);
    expect(db.rows.get('legacy-1')?.status).toBe(DataExportStatus.EXPIRED);
  });

  it('the orphan sweep removes old archives no row owns and keeps owned, running and fresh ones', async () => {
    const db = fakeDb();
    const st = fakeStorage();
    const owned = await readyExport(db, st);
    const old = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const orphan = '00000000-0000-4000-8000-0000000000f1';
    const fresh = '00000000-0000-4000-8000-0000000000f2';
    st.objects.set(`${orphan}.json`, { body: ARCHIVE, created_at: old });
    st.objects.set(`${fresh}.json`, { body: ARCHIVE, created_at: new Date().toISOString() });
    const ownedObj = st.objects.get(`${owned}.json`);
    if (ownedObj) ownedObj.created_at = old;
    expect(await instance(db, st).sweepOrphanArchives()).toBe(1);
    expect([...st.objects.keys()].sort()).toEqual([`${owned}.json`, `${fresh}.json`].sort());
  });

  it('a READY row whose archive vanished answers DATA_EXPORT_FILE_MISSING and is reported', async () => {
    const db = fakeDb();
    const st = fakeStorage();
    const id = await readyExport(db, st);
    st.objects.delete(`${id}.json`);
    const svc = instance(db, st);
    const token = tokenFrom((await svc.createDownloadLink(A)).download_path);
    expect(await codeOf(svc.openDownload(token))).toBe('DATA_EXPORT_FILE_MISSING');
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'data export archive missing for READY row',
      expect.anything(),
    );
  });

  it('Storage being down during a download answers DATA_EXPORT_STORAGE_UNAVAILABLE', async () => {
    const db = fakeDb();
    const st = fakeStorage();
    await readyExport(db, st);
    const svc = instance(db, st);
    const token = tokenFrom((await svc.createDownloadLink(A)).download_path);
    st.faults.sign.push(
      { status: 502, message: 'x' },
      { status: 502, message: 'x' },
      { status: 502, message: 'x' },
    );
    expect(await codeOf(svc.openDownload(token))).toBe('DATA_EXPORT_STORAGE_UNAVAILABLE');
  });
});

// ─── Controller: streaming and browser error page ───────────────────────────

class FakeRes extends Writable {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = Buffer.alloc(0);
  sent = '';
  status(code: number) {
    this.statusCode = code;
    return this;
  }
  setHeader(k: string, v: string) {
    this.headers[k.toLowerCase()] = v;
  }
  type(t: string) {
    this.headers['content-type'] = t;
    return this;
  }
  send(s: string) {
    this.sent = s;
    return this;
  }
  _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
    this.body = Buffer.concat([this.body, chunk]);
    cb();
  }
}

describe('GET /v1/me/data-export/download (controller)', () => {
  it('streams the archive as a private attachment', async () => {
    const db = fakeDb();
    const st = fakeStorage();
    await readyExport(db, st);
    const svc = instance(db, st);
    const ctrl = new DataExportController(svc);
    const token = tokenFrom((await svc.createDownloadLink(A)).download_path);
    const res = new FakeRes();
    await ctrl.download(token, stub<Request>({ headers: {} }), stub<Response>(res));
    expect(res.statusCode).toBe(200);
    expect(res.body.equals(ARCHIVE)).toBe(true);
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="tgp-data-export-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    expect(res.headers['cache-control']).toBe('no-store, private, max-age=0');
    expect(res.headers['content-length']).toBe(String(ARCHIVE.length));
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('a browser gets a plain page with the next step and the reference; API clients get the JSON error', async () => {
    const db = fakeDb();
    const st = fakeStorage();
    const ctrl = new DataExportController(instance(db, st));
    const res = new FakeRes();
    await ctrl.download(
      'not-a-token',
      stub<Request>({
        headers: { accept: 'text/html,application/xhtml+xml' },
        requestId: 'req-123',
      }),
      stub<Response>(res),
    );
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toBe('html');
    expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(res.sent).toContain('This download link is not valid');
    expect(res.sent).toContain('tap Download file');
    expect(res.sent).toContain('Reference: req-123');
    expect(res.sent.replace(/<[^>]*>/g, '')).not.toMatch(/!/);
    await expect(
      ctrl.download(
        'not-a-token',
        stub<Request>({ headers: { accept: 'application/json' } }),
        stub<Response>(new FakeRes()),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('the error page escapes everything it prints', () => {
    const html = renderDownloadErrorPage(null, '<script>x</script>', '"><img>');
    expect(html).not.toContain('<script>x');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;&gt;&lt;img&gt;');
    expect(html).toContain('We could not start your download');
  });
});
