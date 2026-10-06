import {
  Injectable,
  Inject,
  Optional,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
  GoneException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { exportArchivePath, isExportId } from './data-export.paths';
import {
  ArchiveRead,
  ArchiveStorageError,
  DATA_EXPORT_ARCHIVE_STORE,
  DataExportArchiveStore,
  LOCAL_ARCHIVE_SCHEME,
  LocalArchiveStore,
} from './data-export-archive.store';
import { PrismaService } from '../prisma.service';
import { DataExportRequest, DataExportStatus, Prisma } from '@prisma/client';
import * as Sentry from '@sentry/node';
import * as crypto from 'crypto';
import { SignJWT, jwtVerify, JWTPayload } from 'jose';

export { archiveMachine } from './data-export-archive.store';

// ─── Environment variables ──────────────────────────────────────────────────
// DATA_EXPORT_TOKEN_SECRET   — signs the download link token. Required. Min 32 chars.
// DATA_EXPORT_STORAGE        — `supabase` (private bucket `data-exports`; the only
//                              production store) or `local` (DATA_EXPORT_FS_DIR, dev/test).
// DATA_EXPORT_FS_DIR         — local dir for dev/test archives. Defaults to /tmp/exports.
// DATA_EXPORT_EXPIRY_DAYS    — archive lifetime in days. Defaults to 7.
// DATA_EXPORT_RATE_LIMIT_HRS — hours between requests per user. Defaults to 24.
// DATA_EXPORT_DOWNLOAD_LINK_TTL_SECONDS — download link lifetime, clamped to
//                              [60, 900]. Defaults to 300 (5 minutes).
// DATA_EXPORT_STALE_RUN_MINUTES — a PENDING/RUNNING export older than this is
//                              treated as a crashed run. Defaults to 30.

const EXPIRY_DAYS = Number(process.env.DATA_EXPORT_EXPIRY_DAYS ?? '7');
const RATE_LIMIT_HRS = Number(process.env.DATA_EXPORT_RATE_LIMIT_HRS ?? '24');
const TOKEN_SECRET_STR =
  process.env.DATA_EXPORT_TOKEN_SECRET ?? 'change-me-in-production-min32chars!';

/** Download links live 5 minutes by default; never under 1 or over 15 minutes. */
export function downloadLinkTtlSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.DATA_EXPORT_DOWNLOAD_LINK_TTL_SECONDS ?? '300');
  const ttl = Number.isFinite(raw) ? Math.round(raw) : 300;
  return Math.min(900, Math.max(60, ttl));
}

/** A PENDING/RUNNING export older than this is a crashed run (default 30 min). */
export function staleRunMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.DATA_EXPORT_STALE_RUN_MINUTES ?? '30');
  const minutes = Number.isFinite(raw) && raw >= 5 ? raw : 30;
  return minutes * 60 * 1000;
}

/** Token `type` and audience; a token minted for anything else never opens an archive. */
const DOWNLOAD_TOKEN_TYPE = 'data_export_download';
const DOWNLOAD_TOKEN_AUDIENCE = 'tgp:data-export-download';

// jose requires a KeyLike or Uint8Array — derive a symmetric key from the secret string.
function getTokenKey(): Uint8Array {
  return new TextEncoder().encode(TOKEN_SECRET_STR);
}

// Download token additional claims
interface DownloadTokenClaims extends JWTPayload {
  eid: string; // export request id
  type: string; // 'data_export_download'
}

/**
 * Stable machine codes for every data-export failure a client can see. Each
 * is thrown with a human message that says what happened and what to do.
 */
export const DATA_EXPORT_CODES = {
  NOT_FOUND: 'DATA_EXPORT_NOT_FOUND',
  IN_PROGRESS: 'DATA_EXPORT_IN_PROGRESS',
  RATE_LIMITED: 'DATA_EXPORT_RATE_LIMITED',
  NOT_READY: 'DATA_EXPORT_NOT_READY',
  EXPIRED: 'DATA_EXPORT_EXPIRED',
  FILE_MISSING: 'DATA_EXPORT_FILE_MISSING',
  STORAGE_UNAVAILABLE: 'DATA_EXPORT_STORAGE_UNAVAILABLE',
  LINK_INVALID: 'DATA_EXPORT_LINK_INVALID',
  LINK_EXPIRED: 'DATA_EXPORT_LINK_EXPIRED',
} as const;

const C = DATA_EXPORT_CODES;

const EXPIRED_MESSAGE =
  `This export has expired (exports are kept for ${EXPIRY_DAYS} days). ` +
  'Request a new export from the Request my data screen.';
const FILE_MISSING_MESSAGE =
  'This export file is no longer available. Request a new export from the Request my data screen.';
const STORAGE_UNAVAILABLE_MESSAGE =
  'We could not reach file storage just now. Your data is safe. Wait a minute and try again.';
const LINK_INVALID_MESSAGE =
  'This download link is not valid. Go back to the app, open Request my data and tap Download file.';
const LINK_EXPIRED_MESSAGE =
  'This download link has expired. Go back to the app, open Request my data and tap Download file again.';

/** A recorded archive size usable as Content-Length, else null. */
function confirmedFileSize(size: number | null): number | null {
  return size !== null && Number.isSafeInteger(size) && size >= 0 ? size : null;
}

/** Archive order for exported tables whose rows read best oldest first. */
const CHRONOLOGICAL: ReadonlyArray<Record<string, 'asc'>> = [{ created_at: 'asc' }, { id: 'asc' }];

/** Rows read per archive page (keyset pagination on the primary key). */
const EXPORT_PAGE = 500;

/**
 * Statuses that hold the one active export of a user. The partial unique
 * index data_export_request_one_active_per_user allows one such row per user.
 */
const ACTIVE_STATUSES: DataExportStatus[] = [
  DataExportStatus.PENDING,
  DataExportStatus.RUNNING,
  DataExportStatus.READY,
];

/**
 * Newest request first with a total order (F-EXPORT-TIE). created_at has
 * millisecond precision and can repeat; `id` is a random UUID, so it only
 * makes a tie stable (every read picks the same row), it does not say which
 * row is newer. Which row is the latest request is decided by
 * _findLatestRequest, never by this order alone.
 */
const NEWEST_FIRST: Prisma.DataExportRequestOrderByWithRelationInput[] = [
  { created_at: 'desc' },
  { id: 'desc' },
];

/** Compares two column values the way the archive presents them (dates by instant). */
function compareExportValues(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  if (x === y) return 0;
  if (x === null || x === undefined) return -1;
  if (y === null || y === undefined) return 1;
  return (x as string | number) < (y as string | number) ? -1 : 1;
}

/** Recipe columns exported for recipes the user created. */
const RECIPE_EXPORT_SELECT: Record<string, true> = {
  id: true,
  title: true,
  description: true,
  image_url: true,
  prep_time_min: true,
  cook_time_min: true,
  servings: true,
  calories: true,
  protein: true,
  carbs: true,
  fat: true,
  ingredients: true,
  instructions: true,
  tags: true,
  is_public: true,
  created_at: true,
  updated_at: true,
};

/**
 * Roman session columns. `subject_context_json` (an internal context blob
 * that can carry a coach brief about another person) and the voice-budget
 * counters are not personal data of the requester and are left out.
 */
const ROMAN_SESSION_EXPORT_SELECT: Record<string, true> = {
  id: true,
  surface: true,
  day_key: true,
  message_count: true,
  started_at: true,
  last_activity_at: true,
  created_at: true,
};

/** Roman message columns: what was said, by whom, when, and which model replied. */
const ROMAN_MESSAGE_EXPORT_SELECT: Record<string, true> = {
  id: true,
  session_id: true,
  role: true,
  content: true,
  model_id: true,
  interrupted: true,
  created_at: true,
};

/*
 * W3-13 day-1 sections. Each select keeps `id` (archive paging follows it)
 * and leaves out other people's ids and content, storage URLs, credentials
 * and internal rule keys.
 */

/** Community posts the user wrote. */
const COMMUNITY_POST_EXPORT_SELECT: Record<string, true> = {
  id: true,
  workspace_id: true,
  scope: true,
  type: true,
  title: true,
  body: true,
  visibility: true,
  created_at: true,
  updated_at: true,
};

/** Community messages and comments the user sent (no recipient id, no voice URL). */
const COMMUNITY_MESSAGE_EXPORT_SELECT: Record<string, true> = {
  id: true,
  workspace_id: true,
  scope: true,
  kind: true,
  body: true,
  voice_duration_ms: true,
  parent_message_id: true,
  plan_context_type: true,
  visibility: true,
  created_at: true,
  updated_at: true,
};

/** Reactions the user left on posts and messages. */
const COMMUNITY_REACTION_EXPORT_SELECT: Record<string, true> = {
  id: true,
  workspace_id: true,
  target_type: true,
  target_id: true,
  response_kind: true,
  created_at: true,
};

/** Coach broadcasts delivered to the user (the copy itself is in coach_messages). */
const BROADCAST_DELIVERY_EXPORT_SELECT: Record<string, true> = {
  id: true,
  broadcast_id: true,
  message_id: true,
  status: true,
  delivered_at: true,
  created_at: true,
};

/** Coach-code redemption attempts the user made (stored response left out). */
const COACH_CODE_REDEMPTION_EXPORT_SELECT: Record<string, true> = {
  id: true,
  status: true,
  outcome: true,
  coach_id: true,
  created_at: true,
};

/** Invite and QR codes the user redeemed. */
const INVITE_REDEMPTION_EXPORT_SELECT: Record<string, true> = {
  id: true,
  coach_id: true,
  code: true,
  source: true,
  package_id: true,
  redeemed_at: true,
};

/**
 * Roman workout adjustments proposed for the user: the recovery signals they
 * were based on, the change and its outcome. The coach's own dismiss note and
 * the internal rule key are left out.
 */
const WORKOUT_ADJUSTMENT_EXPORT_SELECT: Record<string, true> = {
  id: true,
  coach_id: true,
  assignment_id: true,
  status: true,
  severity: true,
  signals: true,
  proposed_change: true,
  applied_change: true,
  roman_text: true,
  decided_at: true,
  created_at: true,
};

/**
 * Roman v1.1 memory (R11-M1): the notes Roman keeps about the user (live,
 * expired and superseded), with when each was said and when it expires. The
 * internal slot key and the source message id are left out.
 */
const ROMAN_CLIENT_NOTE_EXPORT_SELECT: Record<string, true> = {
  id: true,
  kind: true,
  text: true,
  source_at: true,
  expires_at: true,
  superseded_at: true,
  created_at: true,
};

/**
 * Roman v1.1 memory (R11-M1): the user's day, week and month summaries. The
 * internal facts blob, input digest and model id are left out. The memory job
 * state (RomanMemoryState) is internal bookkeeping and is not exported.
 */
const ROMAN_CLIENT_SUMMARY_EXPORT_SELECT: Record<string, true> = {
  id: true,
  period: true,
  period_start: true,
  text: true,
  generated_at: true,
};

/**
 * Roman v1.1 (R11-P1, owner D5): a head coach's own active playbook, the
 * methods Roman learned from the coach. The source ledger (other people's
 * row ids) and internal digests are left out.
 */
const COACH_PLAYBOOK_EXPORT_SELECT: Record<string, true> = {
  id: true,
  version: true,
  status: true,
  sections: true,
  red_lines: true,
  built_at: true,
};

/** Wearable connections: provider and sync state only, never tokens or secret refs. */
const WEARABLE_CONNECTION_EXPORT_SELECT: Record<string, true> = {
  id: true,
  provider: true,
  status: true,
  scopes: true,
  last_synced_at: true,
  disconnected_at: true,
  created_at: true,
};

/** Wearable health samples (consumer health data). */
const WEARABLE_SAMPLE_EXPORT_SELECT: Record<string, true> = {
  id: true,
  provider: true,
  metric: true,
  bucket: true,
  value: true,
  unit: true,
  start_at: true,
  end_at: true,
  source_tz: true,
  recorded_at: true,
};

/** Why an archive must go although no request row owns it (B-608-11). */
export type ArchiveCleanupReason = 'request_removed' | 'failed_run';

/** Cleanup records drained per machine per nightly run. */
const ARCHIVE_CLEANUP_BATCH = 500;
/** A cleanup record another machine has not drained within this window is reported. */
const ARCHIVE_CLEANUP_STALE_MS = 48 * 60 * 60 * 1000;
/** Stored archives younger than this are never swept (an export may be finishing). */
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

/** A stable, value-free code for a storage error (errno like EACCES / EIO, or STORAGE_*). */
export function storageErrorCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'UNKNOWN';
}

/**
 * Removing an export archive failed with something other than "already gone"
 * (B-608-11). `recorded` says whether a durable cleanup record now owns the
 * retry; when it is false the nightly orphan sweep is the only remaining path.
 */
export class DataExportArchiveCleanupError extends Error {
  readonly code = 'DATA_EXPORT_ARCHIVE_CLEANUP_FAILED';
  constructor(
    readonly exportId: string,
    readonly reason: ArchiveCleanupReason,
    readonly storageCode: string,
    readonly recorded: boolean,
  ) {
    super(
      `Deleting the archive of export ${exportId} failed (${storageCode}); ` +
        (recorded
          ? 'a cleanup record keeps it queued for the nightly data-export cleanup.'
          : 'recording the cleanup also failed, so only the nightly orphan sweep can remove it.'),
    );
    this.name = 'DataExportArchiveCleanupError';
  }
}

/** What a client may know about one export. Never carries a storage URL. */
export interface DataExportStatusView {
  id: string;
  status: DataExportStatus;
  created_at: Date;
  completed_at: Date | null;
  expires_at: Date | null;
  file_size_bytes: number | null;
  /** True only when the archive is stored durably, unexpired and downloadable. */
  download_available: boolean;
  /**
   * Short-lived download token (same lifetime as a download link). Kept for
   * app builds that open `/download?token=` straight from the status; new
   * builds call POST /v1/me/data-export/download-link when the user taps.
   */
  download_token: string | null;
  /** When the user may request a new export (null: now). */
  next_request_at: Date | null;
}

export interface DataExportDownloadLink {
  /** Append to the API base URL (the app's EXPO_PUBLIC_API_URL). */
  download_path: string;
  token: string;
  expires_at: Date;
  file_name: string;
  file_size_bytes: number | null;
}

export interface DataExportDownload {
  exportId: string;
  fileName: string;
  size: number | null;
  chunks: ArchiveRead['chunks'];
}

function archiveFileName(record: Pick<DataExportRequest, 'completed_at' | 'created_at'>): string {
  const day = (record.completed_at ?? record.created_at).toISOString().slice(0, 10);
  return `tgp-data-export-${day}.json`;
}

@Injectable()
export class DataExportService {
  private readonly logger = new Logger(DataExportService.name);
  private readonly store: DataExportArchiveStore;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(DATA_EXPORT_ARCHIVE_STORE) store?: DataExportArchiveStore,
  ) {
    // Fail closed in production: if the secret is missing or is the hardcoded
    // default, the entire service is unusable and we must not silently mint
    // tokens with a known-value secret.
    if (process.env.NODE_ENV === 'production') {
      if (
        !process.env.DATA_EXPORT_TOKEN_SECRET ||
        process.env.DATA_EXPORT_TOKEN_SECRET.length < 32 ||
        process.env.DATA_EXPORT_TOKEN_SECRET === 'change-me-in-production-min32chars!'
      ) {
        throw new Error(
          'DATA_EXPORT_TOKEN_SECRET must be a random 32+ character secret in production. ' +
            'Set this value in Fly secrets before deploying.',
        );
      }
      // The module always binds the private Supabase store in production; a
      // missing binding must never fall back to the machine disk.
      if (!store || store.kind !== 'supabase') {
        throw new Error(
          'Data export storage in production must be the private Supabase bucket (data-exports). ' +
            'Fix: keep DATA_EXPORT_ARCHIVE_STORE bound in DataExportModule and unset DATA_EXPORT_STORAGE.',
        );
      }
    } else if (
      !process.env.DATA_EXPORT_TOKEN_SECRET ||
      process.env.DATA_EXPORT_TOKEN_SECRET === 'change-me-in-production-min32chars!'
    ) {
      this.logger.warn(
        'DATA_EXPORT_TOKEN_SECRET is not set — using the insecure default. ' +
          'Set DATA_EXPORT_TOKEN_SECRET before going to production.',
      );
    }
    this.store = store ?? new LocalArchiveStore();
  }

  /** The archive store in use (supabase in production). */
  archiveStore(): DataExportArchiveStore {
    return this.store;
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * Enqueue a new export for the user. Enforces the per-user rate limit
   * (one export with a downloadable archive within RATE_LIMIT_HRS) and the
   * one-active-export index:
   *   - a PENDING/RUNNING export still within the stale-run window → 409
   *     DATA_EXPORT_IN_PROGRESS; an older one is a crashed run and is failed
   *     (its archive removed) before the new request;
   *   - a READY export created within the window whose archive is stored →
   *     409 DATA_EXPORT_RATE_LIMITED (the user downloads that one);
   *   - any other READY export (older than the window, past expiry, legacy
   *     rows without a stored archive) is superseded: its archive is deleted
   *     first (a storage failure answers 503 and changes nothing), then the
   *     row is marked EXPIRED.
   *
   * The actual file generation runs async via _runExport() after this method
   * returns so the HTTP response comes back immediately (202 Accepted).
   */
  async requestExport(userId: string) {
    const now = new Date();
    const windowStart = new Date(now.getTime() - RATE_LIMIT_HRS * 60 * 60 * 1000);
    // Non-terminal = PENDING | RUNNING | READY (the partial unique index
    // data_export_request_one_active_per_user allows one per user).
    const active = await this.prisma.dataExportRequest.findMany({
      where: {
        user_id: userId,
        status: { in: ACTIVE_STATUSES },
      },
      orderBy: NEWEST_FIRST,
    });

    for (const candidate of active) {
      let existing: DataExportRequest = candidate;
      if (existing.status !== DataExportStatus.READY) {
        if (now.getTime() - existing.created_at.getTime() < staleRunMs()) {
          throw new ConflictException({
            code: C.IN_PROGRESS,
            message:
              'Your export is already being prepared. The Request my data screen updates when it is ready.',
          });
        }
        if (await this._reapStaleRun(existing)) continue;
        // B-636-3: the run finished (or was erased) between our read and the
        // reap. Decide on the row as it is now, never on the stale snapshot.
        const current = await this.prisma.dataExportRequest.findUnique({
          where: { id: existing.id },
        });
        if (!current || current.status !== DataExportStatus.READY) continue;
        existing = current;
      }
      if (this._isDownloadable(existing, now) && existing.created_at >= windowStart) {
        const next = new Date(existing.created_at.getTime() + RATE_LIMIT_HRS * 60 * 60 * 1000);
        throw new ConflictException({
          code: C.RATE_LIMITED,
          message:
            `You already have an export from the last ${RATE_LIMIT_HRS} hours. Download it from the ` +
            `Request my data screen, or request a new one after ${next.toISOString()}.`,
        });
      }
      await this._supersede(existing);
    }

    // Authoritative DB-level duplicate guard (A1-C5-P1-2): even if two
    // parallel requests both pass the checks above (TOCTOU window), the
    // partial unique index `data_export_request_one_active_per_user` ensures
    // at most one non-terminal row per user. The second concurrent create
    // gets a Prisma P2002 and is converted to a 409 here.
    let record: Awaited<ReturnType<typeof this.prisma.dataExportRequest.create>>;
    try {
      record = await this.prisma.dataExportRequest.create({
        data: {
          user_id: userId,
          status: DataExportStatus.PENDING,
        },
      });
    } catch (e: unknown) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({
          code: C.IN_PROGRESS,
          message:
            'Your export is already being prepared. The Request my data screen updates when it is ready.',
        });
      }
      throw e;
    }

    // Fire-and-forget — do not await so the HTTP response returns immediately.
    this._runExport(record.id, userId).catch((err: Error) => {
      this.logger.error(`Export ${record.id} for user ${userId} failed: ${err.message}`, err.stack);
    });

    // Audit: wrap in try/catch so a missing audit module never breaks the export.
    this._tryAudit(userId, userId, 'data_export_requested', {
      export_id: record.id,
    });

    return record;
  }

  /**
   * Return the most recent export request for the user. Used for status
   * polling from the mobile app. Returns 404 if no export has ever been
   * requested. A crashed run (PENDING/RUNNING past the stale window) is
   * reported FAILED so the app never polls forever.
   */
  async getLatestStatus(userId: string): Promise<DataExportStatusView> {
    let record = await this._findLatestRequest(userId);

    if (!record) {
      throw new NotFoundException({
        code: C.NOT_FOUND,
        message: 'No data export has been requested yet. Tap Request my data to start one.',
      });
    }

    const now = new Date();
    if (
      (record.status === DataExportStatus.PENDING || record.status === DataExportStatus.RUNNING) &&
      now.getTime() - record.created_at.getTime() >= staleRunMs()
    ) {
      await this._reapStaleRun(record);
      // B-636-3: report the row as the database now holds it. When the worker
      // committed READY between our read and the reap, the reap lost its
      // conditional update and the export is READY, not FAILED.
      const current = await this.prisma.dataExportRequest.findUnique({ where: { id: record.id } });
      if (!current) {
        // Erased concurrently (account deletion): there is no export to report.
        throw new NotFoundException({
          code: C.NOT_FOUND,
          message: 'No data export has been requested yet. Tap Request my data to start one.',
        });
      }
      record = current;
    }

    const downloadable = this._isDownloadable(record, now);
    let nextRequestAt: Date | null = null;
    if (record.status === DataExportStatus.PENDING || record.status === DataExportStatus.RUNNING) {
      nextRequestAt = new Date(record.created_at.getTime() + staleRunMs());
    } else if (downloadable) {
      const next = new Date(record.created_at.getTime() + RATE_LIMIT_HRS * 60 * 60 * 1000);
      nextRequestAt = next > now ? next : null;
    }

    return {
      id: record.id,
      status: record.status,
      created_at: record.created_at,
      completed_at: record.completed_at,
      expires_at: record.expires_at,
      file_size_bytes: record.file_size_bytes,
      download_available: downloadable,
      // Never return the raw file_url. The token is short-lived and bound to
      // this user and this export; see createDownloadLink.
      download_token: downloadable
        ? (await this._mintDownloadToken(record.user_id, record.id)).token
        : null,
      next_request_at: nextRequestAt,
    };
  }

  /**
   * Mint a short-lived download link for the caller's latest export. Only
   * the authenticated owner reaches this (the export is looked up by
   * `user_id`, never by a client-supplied id), so a link can only ever be
   * issued for the caller's own archive.
   */
  async createDownloadLink(userId: string): Promise<DataExportDownloadLink> {
    const record = await this._findLatestRequest(userId);
    if (!record) {
      throw new NotFoundException({
        code: C.NOT_FOUND,
        message: 'No data export has been requested yet. Tap Request my data to start one.',
      });
    }
    const ready = await this._assertDownloadable(record);
    // Confirm the archive is really stored before handing out a link, so a
    // lost file shows in the app (with the replacement action) instead of on
    // a browser error page.
    try {
      await this.store.stat(ready.id);
    } catch (err) {
      throw await this._storageFailure(err, ready, 'download-link');
    }
    const { token, expiresAt } = await this._mintDownloadToken(userId, ready.id);
    this._tryAudit(userId, userId, 'data_export_link_issued', { export_id: ready.id });
    return {
      download_path: `/v1/me/data-export/download?token=${encodeURIComponent(token)}`,
      token,
      expires_at: expiresAt,
      file_name: archiveFileName(ready),
      file_size_bytes: ready.file_size_bytes,
    };
  }

  /**
   * Validate a download token and open the archive for streaming. The token
   * must be ours (HS256, audience, type), unexpired, and its subject must own
   * the export; the export must be READY, unexpired and stored in this
   * service's store. Bytes are read only after every check passes.
   */
  async openDownload(token: string | undefined): Promise<DataExportDownload> {
    const claims = await this._verifyDownloadToken(token);
    const record = await this.prisma.dataExportRequest.findUnique({
      where: { id: claims.eid },
    });
    // Same answer for "no such export" and "not yours": no existence oracle.
    if (!record || record.user_id !== claims.sub) {
      throw new UnauthorizedException({ code: C.LINK_INVALID, message: LINK_INVALID_MESSAGE });
    }
    const owner = await this.prisma.user.findUnique({
      where: { id: record.user_id },
      select: { deleted_at: true },
    });
    if (!owner || owner.deleted_at) {
      throw new UnauthorizedException({ code: C.LINK_INVALID, message: LINK_INVALID_MESSAGE });
    }
    const ready = await this._assertDownloadable(record);
    let read: ArchiveRead;
    try {
      read = await this.store.read(ready.id);
    } catch (err) {
      throw await this._storageFailure(err, ready, 'download');
    }
    this._tryAudit(ready.user_id, ready.user_id, 'data_export_downloaded', {
      export_id: ready.id,
    });
    return {
      exportId: ready.id,
      fileName: archiveFileName(ready),
      // C-636-3: the stored size (proven equal to the archive at put) wins
      // over whatever length header storage or a CDN sent.
      size: confirmedFileSize(ready.file_size_bytes) ?? read.size,
      chunks: read.chunks,
    };
  }

  /**
   * Nightly cleanup: drain archive cleanup records, fail crashed runs, sweep
   * orphan archives, then delete expired archives and mark their rows
   * EXPIRED (file first, row second).
   */
  async expireOldExports(now: Date = new Date()): Promise<void> {
    // B-608-11: archives whose deletion failed earlier come first. A drain
    // failure is reported and never blocks the rest of the cleanup.
    try {
      await this.drainArchiveCleanups(now);
    } catch (err) {
      this.logger.error(
        `Data export archive cleanup drain failed (${storageErrorCode(err)}): ${(err as Error).message}. ` +
          'Every pending cleanup record stays queued for the next nightly run.',
      );
      Sentry.captureMessage('data export archive cleanup drain failed', {
        level: 'error',
        tags: { code: storageErrorCode(err) },
      });
    }
    try {
      await this.reapStaleRuns(now);
    } catch (err) {
      this.logger.error(
        `Data export stale-run reaping failed (${storageErrorCode(err)}): ${(err as Error).message}.`,
      );
    }
    try {
      await this.sweepOrphanArchives(now);
    } catch (err) {
      this.logger.error(
        `Data export orphan sweep failed (${storageErrorCode(err)}): ${(err as Error).message}. ` +
          'The next nightly run retries.',
      );
      Sentry.captureMessage('data export orphan sweep failed', {
        level: 'error',
        tags: { code: storageErrorCode(err) },
      });
    }
    // READY rows past expiry, plus rows already marked EXPIRED lazily by a
    // download attempt that still carry a file (their bytes must go too).
    const expired = await this.prisma.dataExportRequest.findMany({
      where: {
        status: { in: [DataExportStatus.READY, DataExportStatus.EXPIRED] },
        file_url: { not: null },
        expires_at: { lte: now },
      },
    });

    for (const record of expired) {
      try {
        // Throws on anything but "already gone"; the row then stays as it is
        // and the next nightly run retries (B-608-11).
        await this._deleteArchiveOf(record);
        await this.prisma.dataExportRequest.update({
          where: { id: record.id },
          data: { status: DataExportStatus.EXPIRED, file_url: null },
        });
        this.logger.log(`Expired export ${record.id} for user ${record.user_id}`);
      } catch (err) {
        this.logger.error(
          `Failed to expire export ${record.id} (${storageErrorCode(err)}): ${(err as Error).message}. ` +
            'The row keeps its file reference and the next nightly run retries.',
        );
      }
    }
  }

  /**
   * Fail every PENDING/RUNNING export older than the stale-run window (the
   * worker is fire-and-forget, so a machine restart can leave a row RUNNING
   * forever and block the user's next export), and remove whatever archive
   * that run may have written.
   */
  async reapStaleRuns(now: Date = new Date()): Promise<number> {
    const stale = await this.prisma.dataExportRequest.findMany({
      where: {
        status: { in: [DataExportStatus.PENDING, DataExportStatus.RUNNING] },
        created_at: { lt: new Date(now.getTime() - staleRunMs()) },
      },
      take: ARCHIVE_CLEANUP_BATCH,
    });
    let reaped = 0;
    for (const row of stale) {
      try {
        if (await this._reapStaleRun(row)) reaped += 1;
      } catch (err) {
        this.logger.error(
          `Failing stale export ${row.id} left its archive queued (${storageErrorCode(err)}).`,
        );
      }
    }
    if (reaped > 0) this.logger.warn(`Failed ${reaped} stale data export run(s)`);
    return reaped;
  }

  /**
   * B-608-11: retry every archive cleanup recorded for this store's authority
   * (the bucket for Supabase, so any machine drains it; the machine for local
   * disk). A record is deleted only once its archive is confirmed gone; any
   * other error bumps `attempts` and keeps it queued. The key is always
   * derived from the export id, so a record can never point the delete at
   * another object. Records of other authorities older than 48 h are reported.
   */
  async drainArchiveCleanups(
    now: Date = new Date(),
  ): Promise<{ removed: number; pending: number }> {
    const machine = this.store.authority();
    const records = await this.prisma.dataExportArchiveCleanup.findMany({
      where: { machine },
      orderBy: { created_at: 'asc' },
      take: ARCHIVE_CLEANUP_BATCH,
    });
    let removed = 0;
    let pending = 0;
    for (const r of records) {
      if (!isExportId(r.export_id)) {
        // The table CHECK constraint makes this unreachable; never delete it.
        this.logger.error(
          'Data export archive cleanup skipped a record whose export id is not a safe file name.',
        );
        pending += 1;
        continue;
      }
      // A request row that still records this archive as its READY file owns
      // it (download, expiry, erasure): the record is stale, the file stays.
      const owner = await this.prisma.dataExportRequest.findFirst({
        where: {
          id: r.export_id,
          status: DataExportStatus.READY,
          file_url: this.store.urlFor(r.export_id),
        },
        select: { id: true },
      });
      if (!owner) {
        try {
          await this.store.remove(r.export_id);
        } catch (err) {
          const code = storageErrorCode(err);
          await this.prisma.dataExportArchiveCleanup.update({
            where: { export_id: r.export_id },
            data: { attempts: { increment: 1 }, last_error_code: code, last_attempt_at: now },
          });
          this.logger.error(
            `Deleting the archive of export ${r.export_id} failed again (${code}, attempt ${r.attempts + 1}); ` +
              `it stays queued for the next nightly run. Fix: ${
                this.store.kind === 'supabase'
                  ? 'check Supabase Storage health and the service-role key for the data-exports bucket.'
                  : `check the permissions and disk health of DATA_EXPORT_FS_DIR on machine ${machine}.`
              }`,
          );
          Sentry.captureMessage('data export archive cleanup failed', {
            level: 'error',
            tags: { code, reason: r.reason, stage: 'drain' },
            extra: { export_id: r.export_id, attempts: r.attempts + 1 },
          });
          pending += 1;
          continue;
        }
      }
      await this.prisma.dataExportArchiveCleanup.deleteMany({
        where: { export_id: r.export_id, machine },
      });
      if (owner) {
        this.logger.warn(
          `Dropped the cleanup record of export ${r.export_id}: a READY request row owns the archive.`,
        );
      } else {
        this.logger.log(
          `Export ${r.export_id}: archive deleted by the nightly cleanup (attempt ${r.attempts + 1}).`,
        );
        removed += 1;
      }
    }
    const stale = await this.prisma.dataExportArchiveCleanup.count({
      where: {
        machine: { not: machine },
        created_at: { lt: new Date(now.getTime() - ARCHIVE_CLEANUP_STALE_MS) },
      },
    });
    if (stale > 0) {
      this.logger.error(
        `${stale} data export archive cleanup record(s) from other machines are older than 48 hours. ` +
          'Fix: list them in data_export_archive_cleanup, remove <DATA_EXPORT_FS_DIR>/<export_id>.json on each ' +
          'listed machine (or confirm the machine and its disk are gone), then delete the record.',
      );
      Sentry.captureMessage('data export archive cleanup records stale on other machines', {
        level: 'error',
        tags: { stage: 'stale' },
        extra: { count: stale },
      });
    }
    return { removed, pending };
  }

  /**
   * Remove stored archives that no request row owns (B-608-3): an export
   * that finished after its account was deleted, a worker that stopped
   * between writing the archive and recording it, or a superseded/expired
   * row whose delete was lost. An archive is kept when its row is still
   * PENDING/RUNNING or READY with exactly this archive. Archives younger
   * than an hour are left alone so an export in progress is never touched.
   */
  async sweepOrphanArchives(now: Date = new Date()): Promise<number> {
    const stored = await this.store.list();
    if (stored.length === 0) return 0;
    const ids = stored.map((s) => s.exportId);
    const known = await this.prisma.dataExportRequest.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true, file_url: true },
    });
    const rows = new Map(known.map((k) => [k.id, k]));
    let removed = 0;
    for (const s of stored) {
      const row = rows.get(s.exportId);
      if (
        row &&
        (row.status === DataExportStatus.PENDING ||
          row.status === DataExportStatus.RUNNING ||
          (row.status === DataExportStatus.READY && this.store.owns(row.file_url, s.exportId)))
      ) {
        continue;
      }
      if (!s.createdAt || now.getTime() - s.createdAt.getTime() < ORPHAN_MIN_AGE_MS) continue;
      try {
        await this.store.remove(s.exportId);
        removed += 1;
      } catch (err) {
        this.logger.error(
          `Orphan export sweep failed for ${s.exportId} (${storageErrorCode(err)}): ${(err as Error).message}`,
        );
      }
    }
    if (removed > 0) this.logger.log(`Removed ${removed} orphan export archive(s)`);
    return removed;
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  /**
   * The user's latest export request (F-EXPORT-TIE). A request row is only
   * created when the user has no active row (requestExport reaps or
   * supersedes every active row first; the partial unique index rejects a
   * second one), and no path writes FAILED or EXPIRED back to an active
   * status (the worker's one RUNNING write follows the create at once, while
   * a reap needs the stale-run window of at least 5 minutes). So the active
   * row, when there is one, is the newest request even when its created_at
   * equals or (after a database clock step) precedes an older row's. With no
   * active row every request is terminal: the newest created_at wins and the
   * id makes an equal-millisecond tie stable, so the status screen and the
   * download link always describe the same row.
   */
  private async _findLatestRequest(userId: string): Promise<DataExportRequest | null> {
    const active = await this.prisma.dataExportRequest.findFirst({
      where: { user_id: userId, status: { in: ACTIVE_STATUSES } },
      orderBy: NEWEST_FIRST,
    });
    if (active) return active;
    return this.prisma.dataExportRequest.findFirst({
      where: { user_id: userId },
      orderBy: NEWEST_FIRST,
    });
  }

  /** READY, unexpired, and stored in this service's store. */
  private _isDownloadable(record: DataExportRequest, now: Date = new Date()): boolean {
    return (
      record.status === DataExportStatus.READY &&
      this.store.owns(record.file_url, record.id) &&
      (!record.expires_at || record.expires_at > now)
    );
  }

  /** Throws the specific error a client sees when the export cannot be downloaded. */
  private async _assertDownloadable(record: DataExportRequest): Promise<DataExportRequest> {
    const now = new Date();
    if (record.status === DataExportStatus.PENDING || record.status === DataExportStatus.RUNNING) {
      throw new ConflictException({
        code: C.NOT_READY,
        message:
          'Your export is still being prepared. The Request my data screen updates when it is ready.',
      });
    }
    if (record.status === DataExportStatus.FAILED) {
      // FAILED covers a run that did not finish and an archive storage
      // confirmed lost (B-636-1); either way there is no file to give.
      throw new GoneException({ code: C.FILE_MISSING, message: FILE_MISSING_MESSAGE });
    }
    if (record.status === DataExportStatus.EXPIRED) {
      throw new GoneException({ code: C.EXPIRED, message: EXPIRED_MESSAGE });
    }
    if (record.expires_at && record.expires_at <= now) {
      // Mark expired lazily; the nightly cleanup deletes the archive.
      await this.prisma.dataExportRequest.updateMany({
        where: { id: record.id, status: DataExportStatus.READY },
        data: { status: DataExportStatus.EXPIRED },
      });
      throw new GoneException({ code: C.EXPIRED, message: EXPIRED_MESSAGE });
    }
    if (!this.store.owns(record.file_url, record.id)) {
      // Legacy rows without an archive, or archives written to a machine
      // disk before durable storage (gone with that machine).
      throw new GoneException({ code: C.FILE_MISSING, message: FILE_MISSING_MESSAGE });
    }
    return record;
  }

  /**
   * A storage failure while serving a READY export. A confirmed permanent
   * not-found (B-636-1) retires exactly that READY row first, so status stops
   * offering a download and the 24 h limit no longer blocks a replacement.
   * A transient failure changes nothing.
   */
  private async _storageFailure(
    err: unknown,
    record: DataExportRequest,
    stage: string,
  ): Promise<Error> {
    if (storageErrorCode(err) === 'STORAGE_NOT_FOUND') {
      if (!(await this._retireLostArchive(record))) {
        // B-636-5: the row still says READY, so "request a new export" would
        // hit the 24 h limit. Answer the retryable 503 instead; the next tap
        // re-runs stat() and retries this same conditional retirement.
        return this._retirementFailedError(record.id, stage);
      }
    }
    return this._storageHttpError(err, record.id, stage);
  }

  private _retirementFailedError(exportId: string, stage: string): Error {
    this.logger.error(
      `Export ${exportId}: archive missing but still READY (${stage}); answered 503.`,
    );
    Sentry.captureMessage('data export missing-archive retirement failed', {
      level: 'error',
      tags: { code: 'DATA_EXPORT_RETIRE_FAILED', stage },
    });
    return new ServiceUnavailableException({
      code: C.STORAGE_UNAVAILABLE,
      message: STORAGE_UNAVAILABLE_MESSAGE,
    });
  }

  /**
   * Mark a READY export whose archive storage confirmed gone as FAILED with
   * no file. Conditional on the row still being READY with exactly this
   * archive, so a concurrent supersede, expiry or erasure is never undone.
   */
  /**
   * Returns true when the row no longer offers this archive (retired now, or
   * already moved on by a supersede, expiry or erasure), false when the
   * retirement write itself failed and the row may still say READY.
   */
  private async _retireLostArchive(record: DataExportRequest): Promise<boolean> {
    try {
      const done = await this.prisma.dataExportRequest.updateMany({
        where: { id: record.id, status: DataExportStatus.READY, file_url: record.file_url },
        data: { status: DataExportStatus.FAILED, file_url: null },
      });
      if (done.count > 0) {
        this.logger.warn(
          `Export ${record.id}: archive confirmed missing; marked FAILED so the user can request a new export.`,
        );
      }
      return true;
    } catch (dbErr) {
      // Not retired: the caller answers a retryable 503, never the
      // "request a new export" advice (B-636-5).
      this.logger.error(
        `Export ${record.id}: retiring the missing archive failed: ${(dbErr as Error).message}`,
      );
      return false;
    }
  }

  /** Map a storage failure during a user request to a specific HTTP error. */
  private _storageHttpError(err: unknown, exportId: string, stage: string): Error {
    const code = storageErrorCode(err);
    if (code === 'STORAGE_NOT_FOUND') {
      this.logger.error(`Export ${exportId}: READY row but no stored archive (${stage}).`);
      Sentry.captureMessage('data export archive missing for READY row', {
        level: 'error',
        tags: { stage },
        extra: { export_id: exportId },
      });
      return new GoneException({ code: C.FILE_MISSING, message: FILE_MISSING_MESSAGE });
    }
    this.logger.error(`Export ${exportId}: storage failed during ${stage} (${code}).`);
    Sentry.captureMessage('data export storage unavailable', {
      level: 'error',
      tags: { code, stage },
      extra: { export_id: exportId },
    });
    return new ServiceUnavailableException({
      code: C.STORAGE_UNAVAILABLE,
      message: STORAGE_UNAVAILABLE_MESSAGE,
    });
  }

  /**
   * Fail one crashed run (conditional on it still being PENDING/RUNNING, so a
   * run that just finished keeps its READY state) and remove the archive it
   * may have written. Returns false when the row had already moved on.
   */
  private async _reapStaleRun(row: DataExportRequest): Promise<boolean> {
    const done = await this.prisma.dataExportRequest.updateMany({
      where: {
        id: row.id,
        status: { in: [DataExportStatus.PENDING, DataExportStatus.RUNNING] },
      },
      data: { status: DataExportStatus.FAILED, file_url: null },
    });
    if (done.count === 0) return false;
    this.logger.warn(`Export ${row.id} did not finish within the stale-run window; marked FAILED.`);
    try {
      await this._discardArchive(row.id, 'failed_run');
    } catch (err) {
      // A durable cleanup record (or the orphan sweep) owns the retry.
      this.logger.error((err as Error).message);
    }
    return true;
  }

  /**
   * Retire a READY export before a new request: delete its archive first,
   * then mark it EXPIRED. A storage failure answers 503 and leaves the row
   * (and the user's current file) as it was.
   */
  private async _supersede(row: DataExportRequest): Promise<void> {
    try {
      await this._deleteArchiveOf(row);
    } catch (err) {
      throw this._storageHttpError(err, row.id, 'supersede');
    }
    await this.prisma.dataExportRequest.updateMany({
      where: { id: row.id, status: DataExportStatus.READY },
      data: { status: DataExportStatus.EXPIRED, file_url: null },
    });
    this.logger.log(`Export ${row.id} superseded by a new request; archive deleted.`);
  }

  /**
   * Build the full JSON archive for a user, store it durably, and update the
   * database row. READY is recorded only after the store confirmed the
   * archive is retrievable at the expected size.
   */
  private async _runExport(exportId: string, userId: string): Promise<void> {
    // Mark RUNNING
    await this.prisma.dataExportRequest.update({
      where: { id: exportId },
      data: { status: DataExportStatus.RUNNING },
    });

    // True from the moment a write was attempted: a failed or timed-out
    // upload may still have landed, so the failure path must remove it.
    let mayHaveArchive = false;
    try {
      const { buffer, sha256 } = await this._buildArchive(userId, exportId);

      const expiresAt = new Date(Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000);
      mayHaveArchive = true;
      const fileUrl = await this._uploadFile(exportId, buffer);

      // B-608-3: the account may have been deleted while the archive was
      // built. The request row goes in the same erasure transaction, so a
      // READY update that matches nothing means the bytes must not stay.
      const done = await this.prisma.dataExportRequest.updateMany({
        where: { id: exportId, status: DataExportStatus.RUNNING },
        data: {
          status: DataExportStatus.READY,
          file_url: fileUrl,
          completed_at: new Date(),
          expires_at: expiresAt,
          file_size_bytes: buffer.length,
          sha256,
        },
      });
      if (done.count === 0) {
        // From here this path owns the cleanup; the catch below must not
        // retry it. _discardArchive throws (after recording a durable cleanup)
        // on anything but "already gone", so the runner rejects instead of
        // claiming the archive is gone (B-608-11).
        mayHaveArchive = false;
        await this._discardArchive(exportId, 'request_removed');
        this.logger.warn(
          `Export ${exportId} finished after its request was removed; archive deleted`,
        );
        return;
      }
      // Recorded: from here the row owns the archive (download, expiry, erasure).
      mayHaveArchive = false;

      this._tryAudit(userId, userId, 'data_export_completed', {
        export_id: exportId,
        file_size_bytes: buffer.length,
        sha256,
      });

      this._logReadyNotification(userId, exportId, expiresAt);
    } catch (err) {
      this.logger.error(
        `Export ${exportId} failed (${storageErrorCode(err)}): ${(err as Error).message}`,
        (err as Error).stack,
      );
      if (err instanceof ArchiveStorageError) {
        Sentry.captureMessage('data export storage write failed', {
          level: 'error',
          tags: { code: err.code },
          extra: { export_id: exportId },
        });
      }
      // Never leave an archive behind on a failed run (B-608-3). If deleting
      // it fails, _discardArchive has recorded a durable cleanup; the run
      // still rejects with its original error (B-608-11).
      if (mayHaveArchive) {
        try {
          await this._discardArchive(exportId, 'failed_run');
        } catch (cleanupErr) {
          this.logger.error((cleanupErr as Error).message);
        }
      }
      await this.prisma.dataExportRequest.updateMany({
        where: { id: exportId },
        data: { status: DataExportStatus.FAILED },
      });
      throw err;
    }
  }

  /**
   * Assemble the full JSON archive. Each top-level key maps to one Prisma
   * model. Streams 500 rows at a time per model to avoid loading the entire
   * dataset into memory at once.
   */
  private async _buildArchive(
    userId: string,
    exportId: string,
  ): Promise<{ buffer: Buffer; sha256: string }> {
    const startedAt = new Date();

    const [
      user,
      profile,
      preferences,
      notificationPrefs,
      weightLogs,
      loggedEntries,
      workouts,
      fastingWindows,
      waterLogs,
      habits,
      lessonCompletions,
      checkIns,
      savedRecipes,
      listItems,
      coachMessages,
      coachNudges,
      messageDrafts,
      mealPlans,
      communityWins,
      coachGuidelines,
      buildWeekEnrollment,
      buildWeekCompletions,
      inviteCodes,
      diagnosticSubmissions,
      ptmSignals,
      ptmPredictions,
      auditLogs,
      dataExportRequests,
      createdRecipes,
      romanSessions,
      romanMessages,
      aiConsentEvents,
      communityPosts,
      communityMessages,
      communityReactions,
      broadcastDeliveries,
      coachCodeRedemptions,
      inviteRedemptions,
      workoutAdjustments,
      romanClientNotes,
      romanClientSummaries,
      coachPlaybook,
      wearableConnections,
      wearableSamples,
    ] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          name: true,
          phone: true,
          role: true,
          created_at: true,
          archived_at: true,
          deletion_scheduled_at: true,
          expo_push_token: true,
        },
      }),
      this._streamAll('userProfile', { user_id: userId }),
      this._streamAll('userPreferences', { user_id: userId }),
      this._streamAll('notificationPreferences', { user_id: userId }),
      this._streamAll('weightLog', { user_id: userId }),
      this._streamAll('loggedFoodEntry', { user_id: userId }),
      this._streamAll('workoutSession', { user_id: userId }),
      this._streamAll('fastingWindow', { user_id: userId }),
      this._streamAll('waterLog', { user_id: userId }),
      this._streamAll('habit', { user_id: userId }),
      this._streamAll('lessonCompletion', { user_id: userId }),
      this._streamAll('checkIn', { user_id: userId }),
      this._streamAll('savedRecipe', { user_id: userId }),
      this._streamAll('listItem', { user_id: userId }),
      this._streamCoachMessages(userId),
      this._streamAll('coachNudge', {
        OR: [{ coach_id: userId }, { client_id: userId }],
      }),
      this._streamAll('messageDraft', {
        OR: [{ coach_id: userId }, { client_id: userId }],
      }),
      this._streamAll('mealPlan', {
        OR: [{ coach_id: userId }, { client_id: userId }],
      }),
      this._streamAll('communityWin', { user_id: userId }),
      this._streamAll('coachGuideline', {
        OR: [{ coach_id: userId }, { client_id: userId }],
      }),
      this.prisma.buildWeekEnrollment.findUnique({ where: { user_id: userId } }),
      this._streamBuildWeekCompletions(userId),
      this._streamAll('inviteCode', { coach_id: userId }),
      this._streamAll('diagnosticSubmission', { user_id: userId }),
      this._streamAll('clientSignal', { user_id: userId }),
      this._streamAll('ptmPrediction', { user_id: userId }),
      this._streamAuditLogs(userId),
      this._streamAll('dataExportRequest', { user_id: userId }),
      // C-636-2: recipes the user wrote (not only the ids of saved ones).
      this._streamAll(
        'recipe',
        { created_by_id: userId },
        { select: RECIPE_EXPORT_SELECT, orderBy: CHRONOLOGICAL },
      ),
      // C-636-2: Roman/AI chats are kept until the person deletes them, so
      // they are part of "download my data". Only the user's own sessions
      // that are not deleted; an erased chat is never exported.
      this._streamAll(
        'romanSession',
        { user_id: userId, deleted_at: null },
        { select: ROMAN_SESSION_EXPORT_SELECT, orderBy: CHRONOLOGICAL },
      ),
      this._streamAll(
        'romanMessage',
        { user_id: userId, session: { user_id: userId, deleted_at: null } },
        { select: ROMAN_MESSAGE_EXPORT_SELECT, orderBy: CHRONOLOGICAL },
      ),
      // C-636-2: the AI-processing consent ledger (every grant and withdrawal).
      this._streamAll('aiProcessingConsentEvent', { user_id: userId }, { orderBy: CHRONOLOGICAL }),
      // W3-13: day-1 data. Posts and messages the user deleted are left out,
      // like a deleted Roman chat.
      this._streamAll(
        'communityPost',
        { author_id: userId, deleted_at: null },
        { select: COMMUNITY_POST_EXPORT_SELECT, orderBy: CHRONOLOGICAL },
      ),
      this._streamAll(
        'communityMessage',
        { sender_id: userId, deleted_at: null },
        { select: COMMUNITY_MESSAGE_EXPORT_SELECT, orderBy: CHRONOLOGICAL },
      ),
      this._streamAll(
        'communityResponse',
        { user_id: userId },
        { select: COMMUNITY_REACTION_EXPORT_SELECT, orderBy: CHRONOLOGICAL },
      ),
      this._streamAll(
        'coachBroadcastDelivery',
        { recipient_id: userId },
        { select: BROADCAST_DELIVERY_EXPORT_SELECT, orderBy: CHRONOLOGICAL },
      ),
      this._streamAll(
        'coachCodeRedemption',
        { user_id: userId },
        { select: COACH_CODE_REDEMPTION_EXPORT_SELECT, orderBy: CHRONOLOGICAL },
      ),
      this._streamAll(
        'inviteRedemption',
        { client_user_id: userId },
        {
          select: INVITE_REDEMPTION_EXPORT_SELECT,
          orderBy: [{ redeemed_at: 'asc' }, { id: 'asc' }],
        },
      ),
      this._streamAll(
        'workoutAdjustmentProposal',
        { client_id: userId },
        { select: WORKOUT_ADJUSTMENT_EXPORT_SELECT, orderBy: CHRONOLOGICAL },
      ),
      // R11-M1: Roman's notes and summaries about the user (their own rows only).
      this._streamAll(
        'romanClientNote',
        { client_id: userId },
        { select: ROMAN_CLIENT_NOTE_EXPORT_SELECT, orderBy: CHRONOLOGICAL },
      ),
      this._streamAll(
        'romanClientSummary',
        { client_id: userId },
        {
          select: ROMAN_CLIENT_SUMMARY_EXPORT_SELECT,
          orderBy: [{ period_start: 'asc' }, { id: 'asc' }],
        },
      ),
      this._streamAll(
        'coachPlaybook',
        { coach_id: userId, status: 'active' },
        { select: COACH_PLAYBOOK_EXPORT_SELECT, orderBy: [{ version: 'asc' }, { id: 'asc' }] },
      ),
      this._streamAll(
        'wearableConnection',
        { user_id: userId },
        { select: WEARABLE_CONNECTION_EXPORT_SELECT, orderBy: CHRONOLOGICAL },
      ),
      this._streamAll(
        'wearableSample',
        { user_id: userId },
        { select: WEARABLE_SAMPLE_EXPORT_SELECT, orderBy: [{ start_at: 'asc' }, { id: 'asc' }] },
      ),
    ]);

    // The push token is a send credential for the user's phone: the archive
    // says whether one is registered, never the token itself.
    let exportedUser: Record<string, unknown> | null = null;
    if (user) {
      const { expo_push_token: pushToken, ...fields } = user;
      exportedUser = { ...fields, push_token_registered: Boolean(pushToken) };
    }

    const completedAt = new Date();

    // Build with placeholder sha256 first, then replace
    const archive: Record<string, unknown> = {
      manifest: {
        export_id: exportId,
        user_id: userId,
        schema_version: '1.0',
        requested_at: startedAt.toISOString(),
        completed_at: completedAt.toISOString(),
        sha256: null,
      },
      user: exportedUser,
      profile,
      preferences,
      notification_preferences: notificationPrefs,
      weight_logs: weightLogs,
      food_entries: loggedEntries,
      workout_sessions: workouts,
      fasting_windows: fastingWindows,
      water_logs: waterLogs,
      habits,
      lesson_completions: lessonCompletions,
      check_ins: checkIns,
      saved_recipes: savedRecipes,
      list_items: listItems,
      // Messages: own messages verbatim; third-party messages redacted.
      // See README for the redaction contract.
      coach_messages: coachMessages,
      coach_nudges: coachNudges,
      message_drafts: messageDrafts,
      meal_plans: mealPlans,
      community_wins: communityWins,
      coach_guidelines: coachGuidelines,
      build_week_enrollment: buildWeekEnrollment,
      build_week_completions: buildWeekCompletions,
      invite_codes: inviteCodes,
      diagnostic_submissions: diagnosticSubmissions,
      ptm_signals: ptmSignals,
      ptm_predictions: ptmPredictions,
      // AuditLog: only entries where the user is the target.
      audit_log_entries_about_user: auditLogs,
      data_export_requests: dataExportRequests,
      created_recipes: createdRecipes,
      roman_sessions: romanSessions,
      roman_messages: romanMessages,
      ai_processing_consent_events: aiConsentEvents,
      community_posts: communityPosts,
      community_messages: communityMessages,
      community_reactions: communityReactions,
      broadcasts_received: broadcastDeliveries,
      coach_code_redemptions: coachCodeRedemptions,
      invite_redemptions: inviteRedemptions,
      workout_adjustments: workoutAdjustments,
      roman_notes: romanClientNotes,
      roman_summaries: romanClientSummaries,
      coach_playbook: coachPlaybook,
      wearable_connections: wearableConnections,
      wearable_samples: wearableSamples,
    };

    const jsonForHash = JSON.stringify(archive);
    const sha256 = crypto.createHash('sha256').update(jsonForHash).digest('hex');
    (archive.manifest as Record<string, unknown>).sha256 = sha256;

    const finalJson = JSON.stringify(archive, null, 2);
    const buffer = Buffer.from(finalJson, 'utf-8');

    return { buffer, sha256 };
  }

  /**
   * Generic helper: read every row of a model that matches `where`, 500 at a
   * time. Pages follow the primary key (keyset: `id > last id`, ordered by
   * id), never OFFSET over an unordered query: without an ORDER BY the
   * database may return pages in different orders, so an archive could miss
   * or repeat rows of a user with more than one page (F-EXPORT-TIE). A row
   * inserted or deleted during the export cannot shift a later page either.
   * `shape.orderBy` is the order the archive presents the rows in; it is
   * applied once all pages are read.
   */
  private async _streamAll(
    model: string,
    where: Record<string, unknown>,
    shape: { select?: Record<string, true>; orderBy?: ReadonlyArray<Record<string, 'asc'>> } = {},
  ): Promise<unknown[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const delegate = (this.prisma as any)[model];

    if (!delegate) {
      return [];
    }

    const results = await this._readAllById(model, (after) =>
      delegate.findMany({
        where: after === null ? where : { AND: [where, { id: { gt: after } }] },
        ...(shape.select ? { select: shape.select } : {}),
        orderBy: [{ id: 'asc' }],
        take: EXPORT_PAGE,
      }),
    );
    const order = shape.orderBy;
    if (order) {
      results.sort((a, b) => {
        for (const key of order) {
          const [column] = Object.keys(key);
          const c = compareExportValues(
            (a as Record<string, unknown>)[column],
            (b as Record<string, unknown>)[column],
          );
          if (c !== 0) return c;
        }
        return 0;
      });
    }
    return results;
  }

  /**
   * Runs `readPage` until a short page: each call gets the id of the last
   * row read so far (null for the first page). A full page whose last row has
   * no string id, or the same id as the page before, would make the next
   * read repeat a page, so it fails the export with the model name instead
   * of looping or writing a partial archive. Ids are compared by the
   * database's own collation (`id > last`), never by JavaScript order.
   * `mapRow` shapes each row as its page arrives.
   */
  private async _readAllById(
    model: string,
    readPage: (after: string | null) => Promise<unknown[]>,
    mapRow: (row: unknown) => unknown = (row) => row,
  ): Promise<unknown[]> {
    const results: unknown[] = [];
    let after: string | null = null;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const page = await readPage(after);
      for (const row of page) results.push(mapRow(row));
      if (page.length < EXPORT_PAGE) break;
      const last = (page[page.length - 1] as Record<string, unknown>).id;
      if (typeof last !== 'string' || last === after) {
        throw new Error(
          `Data export paging stopped on ${model}: a page did not end on a newer row id.`,
        );
      }
      after = last;
    }
    return results;
  }

  /**
   * CoachMessage export. Messages sent by the requesting user are returned
   * verbatim. Messages sent by a third party that are visible to the user
   * are redacted to protect the other party's privacy rights under GDPR.
   * Pages follow the primary key like _streamAll.
   */
  private async _streamCoachMessages(userId: string): Promise<unknown[]> {
    const where = {
      OR: [{ sender_id: userId }, { coach_id: userId }, { client_id: userId }],
    };
    return this._readAllById(
      'coachMessage',
      (after) =>
        this.prisma.coachMessage.findMany({
          where: after === null ? where : { AND: [where, { id: { gt: after } }] },
          orderBy: [{ id: 'asc' }],
          take: EXPORT_PAGE,
        }),
      (row) => {
        const msg = row as Record<string, unknown>;
        if (msg.sender_id === userId) return msg;
        return {
          id: msg.id,
          sent_at: msg.sent_at ?? msg.created_at,
          redacted: true,
          note: 'This message was sent by another party. Its content is redacted to protect their privacy.',
        };
      },
    );
  }

  private async _streamBuildWeekCompletions(userId: string): Promise<unknown[]> {
    const enrollment = await this.prisma.buildWeekEnrollment.findUnique({
      where: { user_id: userId },
    });
    if (!enrollment) return [];
    return this._streamAll('buildWeekDayCompletion', {
      enrollment_id: enrollment.id,
    });
  }

  private async _streamAuditLogs(userId: string): Promise<unknown[]> {
    try {
      // AuditLog uses target_user_id (FK to User) not target_id (free-form resource id)
      return this._streamAll('auditLog', { target_user_id: userId });
    } catch {
      return [];
    }
  }

  /**
   * Store the export archive in this service's store (the private Supabase
   * bucket in production) and return the `file_url` to record. The store
   * confirms the archive is readable before this resolves.
   */
  private async _uploadFile(exportId: string, buffer: Buffer): Promise<string> {
    await this.store.put(exportId, buffer);
    this.logger.log(`Export ${exportId} stored (${this.store.kind}, ${buffer.length} bytes).`);
    return this.store.urlFor(exportId);
  }

  /**
   * Delete the archive a row points at. "Already gone" counts as deleted;
   * every other failure propagates (B-608-11). The object is always derived
   * from the export id: a `file_url` this store does not own is either the
   * legacy machine-disk path of the same export or an error, never a
   * delete of some other object.
   */
  private async _deleteArchiveOf(
    record: Pick<DataExportRequest, 'id' | 'file_url'>,
  ): Promise<void> {
    const url = record.file_url;
    if (url === null || this.store.owns(url, record.id)) {
      await this.store.remove(record.id);
      return;
    }
    if (isExportId(record.id) && url === `${LOCAL_ARCHIVE_SCHEME}${exportArchivePath(record.id)}`) {
      // Written to a machine disk before durable storage (or by the dev
      // store while another store is active).
      const { unlink } = await import('fs/promises');
      try {
        await unlink(exportArchivePath(record.id));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      return;
    }
    throw Object.assign(
      new Error('The export archive has a storage URL this server cannot delete.'),
      { code: 'UNSUPPORTED_STORAGE_URL' },
    );
  }

  /**
   * Remove the archive of an export that no request row owns (B-608-11).
   * Resolves only when the archive is confirmed gone. On any other error it
   * writes (or bumps) a durable cleanup record for this store's authority,
   * reports to Sentry, and throws DataExportArchiveCleanupError.
   */
  private async _discardArchive(exportId: string, reason: ArchiveCleanupReason): Promise<void> {
    try {
      await this.store.remove(exportId);
      return;
    } catch (err) {
      const code = storageErrorCode(err);
      let recorded = false;
      if (isExportId(exportId)) {
        try {
          const machine = this.store.authority();
          await this.prisma.dataExportArchiveCleanup.upsert({
            where: { export_id: exportId },
            create: { export_id: exportId, machine, reason, last_error_code: code },
            update: {
              machine,
              reason,
              attempts: { increment: 1 },
              last_error_code: code,
              last_attempt_at: new Date(),
            },
          });
          recorded = true;
        } catch (recordErr) {
          this.logger.error(
            `Recording the archive cleanup of export ${exportId} failed: ${(recordErr as Error).message}`,
          );
        }
      }
      Sentry.captureMessage('data export archive cleanup failed', {
        level: 'error',
        tags: { code, reason, stage: 'discard', recorded: String(recorded) },
        extra: { export_id: exportId },
      });
      throw new DataExportArchiveCleanupError(exportId, reason, code, recorded);
    }
  }

  /**
   * Mint a short-lived download token bound to the user (`sub`) and the
   * export (`eid`), with its own audience and type, a random `jti`, and a
   * lifetime of DATA_EXPORT_DOWNLOAD_LINK_TTL_SECONDS (5 minutes by default).
   */
  private async _mintDownloadToken(
    userId: string,
    exportId: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const ttl = downloadLinkTtlSeconds();
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ eid: exportId, type: DOWNLOAD_TOKEN_TYPE })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(userId)
      .setAudience(DOWNLOAD_TOKEN_AUDIENCE)
      .setJti(crypto.randomUUID())
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ttl)
      .sign(getTokenKey());
    return { token, expiresAt: new Date((issuedAt + ttl) * 1000) };
  }

  private async _verifyDownloadToken(
    token: string | undefined,
  ): Promise<{ sub: string; eid: string }> {
    if (!token || typeof token !== 'string') {
      throw new UnauthorizedException({ code: C.LINK_INVALID, message: LINK_INVALID_MESSAGE });
    }
    let payload: DownloadTokenClaims;
    try {
      const result = await jwtVerify<DownloadTokenClaims>(token, getTokenKey(), {
        algorithms: ['HS256'],
        audience: DOWNLOAD_TOKEN_AUDIENCE,
        requiredClaims: ['sub', 'exp', 'iat', 'jti'],
      });
      payload = result.payload;
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === 'ERR_JWT_EXPIRED') {
        throw new UnauthorizedException({ code: C.LINK_EXPIRED, message: LINK_EXPIRED_MESSAGE });
      }
      throw new UnauthorizedException({ code: C.LINK_INVALID, message: LINK_INVALID_MESSAGE });
    }
    // A token can never outlive the configured link lifetime, whatever its exp says.
    const lifetime = (payload.exp ?? 0) - (payload.iat ?? 0);
    if (
      payload.type !== DOWNLOAD_TOKEN_TYPE ||
      typeof payload.eid !== 'string' ||
      !isExportId(payload.eid) ||
      typeof payload.sub !== 'string' ||
      lifetime <= 0 ||
      lifetime > 900
    ) {
      throw new UnauthorizedException({ code: C.LINK_INVALID, message: LINK_INVALID_MESSAGE });
    }
    return { sub: payload.sub, eid: payload.eid };
  }

  /**
   * Log that an export is ready — without logging any token or storage URL.
   * The app polls /status and asks for a short-lived download link when the
   * user taps Download file.
   */
  private _logReadyNotification(userId: string, exportId: string, expiresAt: Date): void {
    this.logger.log(
      `[Export ready] exportId=${exportId} userId=${userId} expires=${expiresAt.toISOString()}. ` +
        'The app requests a short-lived link via POST /v1/me/data-export/download-link.',
    );
  }

  /**
   * Best-effort audit log. Silently swallowed if the AuditLog model is absent
   * or if the audit service throws — audit must never block the export flow.
   */
  private _tryAudit(
    actorId: string,
    targetId: string,
    eventType: string,
    metadata: Record<string, unknown>,
  ): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const auditDelegate = (this.prisma as any).auditLog;
    if (!auditDelegate) return;

    auditDelegate
      .create({
        data: {
          actor_id: actorId,
          target_id: targetId,
          event_type: eventType,
          metadata,
        },
      })
      .catch((_err: Error) => {
        // Intentionally swallowed.
      });
  }
}
