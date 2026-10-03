import { Logger } from '@nestjs/common';
import { hostname } from 'os';
import { SupabaseService } from '../supabase/supabase.service';
import {
  exportArchiveDir,
  exportArchivePath,
  EXPORT_ARCHIVE_NAME,
  isExportId,
} from './data-export.paths';

/**
 * Where data-export archives live (B-608-12 / lane B-EXPORT).
 *
 * Production: one PRIVATE Supabase Storage bucket, `data-exports`, created by
 * migration 20270221000000_data_export_storage_bucket and checked on every
 * release by its verify.sql. Objects are `<export id>.json` at the bucket
 * root. The key is derived from the export id only, never from a stored URL,
 * so no row can point a read or a delete at another object, and the
 * B-608-11 cleanup records (which hold no user id) can always derive it.
 * The service-role key is the only credential that can read the bucket; no
 * Storage URL ever leaves the server. Users download through the API
 * (`GET /v1/me/data-export/download?token=`), which checks a short-lived
 * token bound to the user and the export and then streams the bytes.
 *
 * Development and tests: the machine-local directory DATA_EXPORT_FS_DIR
 * (default /tmp/exports). Production refuses it, because Fly machines are
 * ephemeral and a request can land on any machine.
 */

export const DATA_EXPORT_BUCKET = 'data-exports';
export const SUPABASE_ARCHIVE_SCHEME = 'supabase-storage://';
export const LOCAL_ARCHIVE_SCHEME = 'local://';

/** Attempts per storage call (1 + 2 retries) for transient failures. */
export const STORAGE_ATTEMPTS = 3;

/**
 * Deadline for one storage call attempt (C-636-1). A provider that never
 * answers fails the attempt with the retryable STORAGE_TIMEOUT instead of
 * holding a request, a worker or the nightly cleanup open. The signal handed
 * to the call is aborted at the deadline, so calls that accept a signal (our
 * own read fetch, list) are really cancelled; for the SDK calls that take no
 * signal the wait is bounded and the late result is ignored.
 */
export const STORAGE_CALL_TIMEOUT_MS = 30_000;

export type ArchiveStoreKind = 'supabase' | 'local';

/**
 * A storage failure with a stable, value-free code (`STORAGE_HTTP_503`,
 * `STORAGE_NETWORK`, `ENOENT`, ...). `retryable` marks transient failures
 * (network, 408, 429, 5xx) that a later attempt can fix.
 */
export class ArchiveStorageError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ArchiveStorageError';
  }
}

export interface StoredArchive {
  exportId: string;
  /** When the object was written; null when the store cannot tell. */
  createdAt: Date | null;
}

export interface ArchiveRead {
  /** Byte length when known (Content-Length). */
  size: number | null;
  chunks: AsyncIterable<Uint8Array>;
}

/** What the store confirmed about a stored archive. */
export interface ArchiveStat {
  size: number;
}

export interface DataExportArchiveStore {
  readonly kind: ArchiveStoreKind;
  /**
   * Who can drain a B-608-11 cleanup record for this store (the record's
   * `machine` column): the Fly machine for local disk, the bucket for
   * Supabase (any machine can reach it).
   */
  authority(): string;
  /** The `file_url` value recorded for an archive of this store. */
  urlFor(exportId: string): string;
  /** True when `fileUrl` is exactly the archive of `exportId` in this store. */
  owns(fileUrl: string | null, exportId: string): boolean;
  /** Write the archive and confirm it is readable at the expected size. */
  put(exportId: string, body: Buffer): Promise<void>;
  /** Delete the archive. An archive that is already gone counts as deleted. */
  remove(exportId: string): Promise<void>;
  /**
   * Confirm the archive is stored and report its size. Throws
   * `STORAGE_NOT_FOUND` when it is confirmed gone, a retryable code on a
   * transient failure, and `STORAGE_SIZE_UNCONFIRMED` when the provider
   * answers without a usable size (never treated as present).
   */
  stat(exportId: string): Promise<ArchiveStat>;
  /** Read the archive for a download. Throws `STORAGE_NOT_FOUND` when gone. */
  read(exportId: string): Promise<ArchiveRead>;
  /** Every archive currently stored (for the orphan sweep). */
  list(): Promise<StoredArchive[]>;
}

/** The machine whose local disk holds an archive (Fly machine id on Fly). */
export function archiveMachine(): string {
  return hostname().slice(0, 255) || 'unknown-host';
}

function assertExportId(exportId: string): void {
  if (!isExportId(exportId)) {
    throw new ArchiveStorageError(
      'INVALID_EXPORT_ID',
      'Refusing to touch an archive for an unsafe export id.',
      false,
    );
  }
}

export function archiveObjectKey(exportId: string): string {
  assertExportId(exportId);
  return `${exportId}.json`;
}

/** The `file_url` of an export archive in the private bucket. */
export function supabaseArchiveUrl(exportId: string): string {
  return `${SUPABASE_ARCHIVE_SCHEME}${DATA_EXPORT_BUCKET}/${archiveObjectKey(exportId)}`;
}

type Sleep = (ms: number) => Promise<void>;
const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A finite, non-negative whole byte count; anything else is not a confirmed size. */
export function confirmedSize(info: unknown): number | null {
  if (typeof info !== 'object' || info === null) return null;
  const size: unknown = Reflect.get(info, 'size');
  return typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? size : null;
}

const deadlineLogger = new Logger('DataExportStorageDeadline');

/**
 * Record what an abandoned or cancelled storage operation did after we
 * stopped waiting for it. It cannot change the outcome any more (the caller
 * already has its answer), so it is logged for diagnosis, not rethrown.
 */
function noteLateSettle(op: string, err: unknown): void {
  deadlineLogger.debug(
    `${op}: settled after it was abandoned or cancelled: ${err instanceof Error ? err.message : String(err)}`,
  );
}

/** Cancel a response body we will not read; a failure to cancel is only logged. */
async function cancelBody(
  op: string,
  body: { cancel(): Promise<void> } | null | undefined,
): Promise<void> {
  if (!body) return;
  try {
    await body.cancel();
  } catch (err) {
    noteLateSettle(op, err);
  }
}

/**
 * Run one attempt with a deadline. Resolves or rejects with the call, or
 * rejects with a retryable STORAGE_TIMEOUT when the deadline passes first; the
 * signal is aborted then so a signal-aware call stops its network work.
 */
export async function withDeadline<T>(
  op: string,
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ArchiveStorageError('STORAGE_TIMEOUT', `${op}: no answer within ${ms} ms`, true));
    }, ms);
    timer.unref?.();
  });
  // async wrapper: a synchronous throw becomes a rejection of this attempt.
  const call = (async () => fn(controller.signal))();
  // A call abandoned at the deadline may still settle later; never let that
  // late rejection surface as an unhandled rejection.
  call.catch((lateErr: unknown) => {
    // Before the deadline the race below reports this failure to the caller.
    if (controller.signal.aborted) noteLateSettle(op, lateErr);
  });
  try {
    return await Promise.race([call, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 250 ms, 1 s between the three attempts. */
export function storageBackoffMs(attempt: number): number {
  return 250 * 4 ** (attempt - 1);
}

function statusOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null || !('status' in err)) return undefined;
  const status: unknown = Reflect.get(err, 'status');
  return typeof status === 'number' ? status : undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown error';
}

/** Map any Supabase Storage error (returned or thrown) to an ArchiveStorageError. */
export function classifyStorageError(err: unknown, op: string): ArchiveStorageError {
  if (err instanceof ArchiveStorageError) return err;
  const status = statusOf(err);
  const message = messageOf(err);
  if (status === 404 || (status === 400 && /not.?found/i.test(message))) {
    return new ArchiveStorageError('STORAGE_NOT_FOUND', `${op}: object not found`, false);
  }
  if (status === undefined) {
    return new ArchiveStorageError('STORAGE_NETWORK', `${op}: ${message}`, true);
  }
  if (status === 401 || status === 403) {
    return new ArchiveStorageError('STORAGE_FORBIDDEN', `${op}: ${message}`, false);
  }
  if (status === 413) {
    return new ArchiveStorageError('STORAGE_TOO_LARGE', `${op}: ${message}`, false);
  }
  const retryable = status === 408 || status === 429 || status >= 500;
  return new ArchiveStorageError(`STORAGE_HTTP_${status}`, `${op}: ${message}`, retryable);
}

/**
 * Run a storage call, retrying transient failures (network, 408, 429, 5xx)
 * up to STORAGE_ATTEMPTS times with backoff. Permanent failures throw at once.
 */
export async function withStorageRetry<T>(
  op: string,
  fn: (signal: AbortSignal) => Promise<T>,
  opts: { attempts?: number; sleep?: Sleep; logger?: Logger; timeoutMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? STORAGE_ATTEMPTS;
  const sleep = opts.sleep ?? defaultSleep;
  const timeoutMs = opts.timeoutMs ?? STORAGE_CALL_TIMEOUT_MS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await withDeadline(op, timeoutMs, fn);
    } catch (err) {
      const e = classifyStorageError(err, op);
      if (!e.retryable || attempt >= attempts) throw e;
      opts.logger?.warn(`${op} failed (${e.code}), attempt ${attempt} of ${attempts}; retrying.`);
      await sleep(storageBackoffMs(attempt));
    }
  }
}

/** Private Supabase Storage bucket `data-exports` (production). */
export class SupabaseArchiveStore implements DataExportArchiveStore {
  readonly kind = 'supabase' as const;
  private readonly logger = new Logger(SupabaseArchiveStore.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly opts: {
      attempts?: number;
      sleep?: Sleep;
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
    } = {},
  ) {}

  authority(): string {
    return `supabase-storage:${DATA_EXPORT_BUCKET}`;
  }

  urlFor(exportId: string): string {
    return supabaseArchiveUrl(exportId);
  }

  owns(fileUrl: string | null, exportId: string): boolean {
    return isExportId(exportId) && fileUrl === this.urlFor(exportId);
  }

  private bucket() {
    return this.supabase.getClient().storage.from(DATA_EXPORT_BUCKET);
  }

  private retry<T>(op: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return withStorageRetry(op, fn, { ...this.opts, logger: this.logger });
  }

  /**
   * The bucket must exist and be private. Checked before every write, so a
   * bucket made public by hand stops new archives from landing in it.
   */
  private async assertPrivateBucket(): Promise<void> {
    const bucket = await this.retry('data export bucket check', async () => {
      const { data, error } = await this.supabase.getClient().storage.getBucket(DATA_EXPORT_BUCKET);
      if (error) throw error;
      return data;
    });
    // B-636-4: only an explicit `public: false` counts as private. A public
    // bucket, or an answer that does not say, refuses the write.
    const isPublic: unknown =
      typeof bucket === 'object' && bucket !== null ? Reflect.get(bucket, 'public') : undefined;
    if (isPublic === true) {
      throw new ArchiveStorageError(
        'STORAGE_BUCKET_PUBLIC',
        `The ${DATA_EXPORT_BUCKET} bucket is public. Data exports are refused until it is private again.`,
        false,
      );
    }
    if (isPublic !== false) {
      throw new ArchiveStorageError(
        'STORAGE_BUCKET_UNCONFIRMED',
        `Storage did not confirm that the ${DATA_EXPORT_BUCKET} bucket is private. Data exports are refused until it does.`,
        false,
      );
    }
  }

  async put(exportId: string, body: Buffer): Promise<void> {
    const key = archiveObjectKey(exportId);
    await this.assertPrivateBucket();
    await this.retry('data export upload', async () => {
      // upsert: a retried upload whose first response was lost must not fail
      // on "already exists"; the bytes are the same archive.
      const { error } = await this.bucket().upload(key, body, {
        contentType: 'application/json',
        cacheControl: '0',
        upsert: true,
      });
      if (error) throw error;
    });
    // READY only when the archive is really retrievable at the right size:
    // a missing, non-numeric or fractional size is not a confirmation (B-636-4).
    const { size } = await this.stat(exportId);
    if (size !== body.length) {
      throw new ArchiveStorageError(
        'STORAGE_SIZE_MISMATCH',
        `data export upload check: stored ${size} bytes, expected ${body.length}`,
        false,
      );
    }
  }

  async stat(exportId: string): Promise<ArchiveStat> {
    const key = archiveObjectKey(exportId);
    const info = await this.retry('data export archive check', async () => {
      const { data, error } = await this.bucket().info(key);
      if (error) throw error;
      return data;
    });
    const size = confirmedSize(info);
    if (size === null) {
      throw new ArchiveStorageError(
        'STORAGE_SIZE_UNCONFIRMED',
        'data export archive check: storage answered without a usable object size',
        false,
      );
    }
    return { size };
  }

  async remove(exportId: string): Promise<void> {
    const key = archiveObjectKey(exportId);
    // A key that is already gone is not an error: remove() reports only the
    // objects it deleted.
    await this.retry('data export archive delete', async () => {
      const { error } = await this.bucket().remove([key]);
      if (error) throw error;
    });
  }

  async read(exportId: string): Promise<ArchiveRead> {
    const key = archiveObjectKey(exportId);
    // A 60-second signed URL used only server-side: it never leaves this
    // process, and the response body is streamed to the caller.
    const signedUrl = await this.retry('data export read link', async () => {
      const { data, error } = await this.bucket().createSignedUrl(key, 60);
      if (error) throw error;
      return data.signedUrl;
    });
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    // The body stream outlives the attempt deadline (a large archive to a slow
    // phone takes as long as it takes), so it gets its own controller: the
    // deadline covers the wait for response headers, and the stream is
    // cancelled when the download ends early (C-636-1).
    let stream = new AbortController();
    const res = await this.retry('data export read', async (signal) => {
      const attempt = new AbortController();
      const onDeadline = () => attempt.abort();
      signal.addEventListener('abort', onDeadline, { once: true });
      try {
        const r = await fetchImpl(signedUrl, {
          headers: { 'cache-control': 'no-store' },
          signal: attempt.signal,
        });
        if (!r.ok) {
          await cancelBody('data export read', r.body);
          throw Object.assign(new Error(`storage answered ${r.status}`), { status: r.status });
        }
        stream = attempt;
        return r;
      } finally {
        signal.removeEventListener('abort', onDeadline);
      }
    });
    // C-636-3: with a content-encoding the header is the encoded length, not
    // the bytes fetch hands us (it decodes transparently); report no size.
    const encoded = (res.headers.get('content-encoding') ?? 'identity').trim().toLowerCase();
    const length = encoded === 'identity' ? Number(res.headers.get('content-length')) : NaN;
    const reader = res.body?.getReader();
    async function* chunks(): AsyncIterable<Uint8Array> {
      if (!reader) return;
      let finished = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            finished = true;
            return;
          }
          if (value) yield value;
        }
      } finally {
        // The browser went away or the pipe failed: stop the upstream
        // transfer and release the connection instead of draining it.
        if (!finished) {
          stream.abort();
          await cancelBody('data export read', reader);
        }
        reader.releaseLock();
      }
    }
    return { size: Number.isFinite(length) && length > 0 ? length : null, chunks: chunks() };
  }

  async list(): Promise<StoredArchive[]> {
    const PAGE = 1000;
    const out: StoredArchive[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await this.retry('data export archive list', async (signal) => {
        const { data, error } = await this.bucket().list(
          '',
          { limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } },
          { signal },
        );
        if (error) throw error;
        return data ?? [];
      });
      for (const item of page) {
        // Folders have no id; only `<export id>.json` objects are archives.
        const id = item.id ? EXPORT_ARCHIVE_NAME.exec(item.name)?.[1] : undefined;
        if (!id) continue;
        const created = item.created_at ? new Date(item.created_at) : null;
        out.push({
          exportId: id,
          createdAt: created && !Number.isNaN(created.getTime()) ? created : null,
        });
      }
      if (page.length < PAGE) return out;
    }
  }
}

/** Machine-local directory (development and tests only). */
export class LocalArchiveStore implements DataExportArchiveStore {
  readonly kind = 'local' as const;

  authority(): string {
    return archiveMachine();
  }

  urlFor(exportId: string): string {
    assertExportId(exportId);
    return `${LOCAL_ARCHIVE_SCHEME}${exportArchivePath(exportId)}`;
  }

  owns(fileUrl: string | null, exportId: string): boolean {
    return isExportId(exportId) && fileUrl === this.urlFor(exportId);
  }

  async put(exportId: string, body: Buffer): Promise<void> {
    assertExportId(exportId);
    const { mkdir, writeFile } = await import('fs/promises');
    // Owner-only permissions: the archive holds the person's full data.
    await mkdir(exportArchiveDir(), { recursive: true, mode: 0o700 });
    await writeFile(exportArchivePath(exportId), body, { mode: 0o600 });
  }

  /** Only ENOENT counts as deleted; every other errno propagates (B-608-11). */
  async remove(exportId: string): Promise<void> {
    assertExportId(exportId);
    const { unlink } = await import('fs/promises');
    try {
      await unlink(exportArchivePath(exportId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async stat(exportId: string): Promise<ArchiveStat> {
    assertExportId(exportId);
    const { stat } = await import('fs/promises');
    try {
      return { size: (await stat(exportArchivePath(exportId))).size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ArchiveStorageError(
          'STORAGE_NOT_FOUND',
          'data export archive check: archive not found',
          false,
        );
      }
      throw err;
    }
  }

  async read(exportId: string): Promise<ArchiveRead> {
    assertExportId(exportId);
    const { stat } = await import('fs/promises');
    const { createReadStream } = await import('fs');
    const path = exportArchivePath(exportId);
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ArchiveStorageError(
          'STORAGE_NOT_FOUND',
          'data export read: archive not found',
          false,
        );
      }
      throw err;
    }
    return { size, chunks: createReadStream(path) };
  }

  async list(): Promise<StoredArchive[]> {
    const { readdir, stat } = await import('fs/promises');
    let names: string[];
    try {
      names = await readdir(exportArchiveDir());
    } catch {
      return [];
    }
    const out: StoredArchive[] = [];
    for (const name of names) {
      const id = EXPORT_ARCHIVE_NAME.exec(name)?.[1];
      if (!id) continue;
      try {
        const info = await stat(exportArchivePath(id));
        out.push({ exportId: id, createdAt: new Date(info.mtimeMs) });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    return out;
  }
}

/**
 * Which store archives go to. Production always uses the private Supabase
 * bucket; `DATA_EXPORT_STORAGE=local` there is a boot error. Elsewhere the
 * default is the local directory unless DATA_EXPORT_STORAGE=supabase.
 * Account deletion uses the same answer for the planned archive of every
 * export, so both always agree on where an archive may be.
 */
export function archiveStoreKind(env: NodeJS.ProcessEnv = process.env): ArchiveStoreKind {
  const requested = (env.DATA_EXPORT_STORAGE ?? '').trim().toLowerCase();
  const production = env.NODE_ENV === 'production';
  if (requested && requested !== 'supabase' && requested !== 'local') {
    throw new Error(
      `DATA_EXPORT_STORAGE must be "supabase" or "local" (got "${requested}"). ` +
        'Fix: unset it in production; the private Supabase bucket is the only production store.',
    );
  }
  if (production && requested === 'local') {
    throw new Error(
      'DATA_EXPORT_STORAGE=local is not allowed in production: archives on a machine disk cannot be ' +
        'downloaded from another machine and are lost on redeploy. Fix: unset DATA_EXPORT_STORAGE.',
    );
  }
  return production || requested === 'supabase' ? 'supabase' : 'local';
}

export function selectArchiveStore(
  supabase: SupabaseService | null,
  env: NodeJS.ProcessEnv = process.env,
): DataExportArchiveStore {
  if (archiveStoreKind(env) === 'local') return new LocalArchiveStore();
  if (!supabase) {
    throw new Error(
      'Data export storage needs SupabaseService (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY).',
    );
  }
  return new SupabaseArchiveStore(supabase);
}

export const DATA_EXPORT_ARCHIVE_STORE = Symbol('DATA_EXPORT_ARCHIVE_STORE');
