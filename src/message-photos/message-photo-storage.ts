import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { SupabaseService } from '../supabase/supabase.service';
import {
  EMPTY_FOLDER_MARKER,
  isObjectNotFound,
  type VoiceStorageError,
} from '../community/voice/voice-upload.provider';

/**
 * Private storage for message photos (A6-PHOTOS).
 *
 * One PRIVATE Supabase Storage bucket, `message-photos`, created and fenced by
 * prisma/migrations/20270306000000_message_photos (public = false, size and
 * type limits, a RESTRICTIVE policy that keeps every RLS-bound role out of
 * it; verify.sql fails the release otherwise). The name is a constant, not an
 * env override, so the bucket the code writes to is always the one the
 * migration fenced.
 *
 * Nothing here ever builds a public URL. Bytes are reached only through:
 *   - a signed UPLOAD URL for the exact staging key the server minted;
 *   - service-role download/upload/remove calls made by the backend itself;
 *   - signed READ URLs (5 minutes) minted per request for a thread party.
 *
 * Keys are minted by the server and stored in message_photos; a client never
 * supplies one. Every key is still re-checked against a strict allowlist
 * before any storage call (defence in depth, same posture as A-610-1).
 *
 *   staging (raw upload):  <ownerId>/staging/<photoId>-<16 hex>
 *   final (sanitized):     <ownerId>/<photoId>-<16 hex>.<jpg|png|webp>
 */

export const MESSAGE_PHOTOS_BUCKET = 'message-photos';
/** Signed read URL lifetime. Short: the viewer refreshes through the API. */
export const PHOTO_READ_URL_TTL_SEC = 300;
/** Lifetime of a moderation review link (same as the community queue's 15-minute link). */
export const PHOTO_REVIEW_URL_TTL_SEC = 900;

const OWNER = '[A-Za-z0-9-]{1,64}';
const PHOTO = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const STAGING_RE = new RegExp(`^(${OWNER})/staging/(${PHOTO})-[0-9a-f]{16}$`);
const FINAL_RE = new RegExp(`^(${OWNER})/(${PHOTO})-[0-9a-f]{16}\\.(jpg|png|webp)$`);
const OWNER_RE = new RegExp(`^${OWNER}$`);

export function mintStagingKey(ownerId: string, photoId: string): string {
  const key = `${ownerId}/staging/${photoId}-${randomBytes(8).toString('hex')}`;
  if (!STAGING_RE.test(key)) throw new Error('message photo: unsupported owner or photo id');
  return key;
}

export function mintFinalKey(
  ownerId: string,
  photoId: string,
  ext: 'jpg' | 'png' | 'webp',
): string {
  const key = `${ownerId}/${photoId}-${randomBytes(8).toString('hex')}.${ext}`;
  if (!FINAL_RE.test(key)) throw new Error('message photo: unsupported owner or photo id');
  return key;
}

/** True only for a key the server could have minted (staging or final shape). */
export function isCanonicalPhotoKey(key: unknown, ownerId?: string): key is string {
  if (typeof key !== 'string' || key.length > 200) return false;
  const m = STAGING_RE.exec(key) ?? FINAL_RE.exec(key);
  if (!m) return false;
  return ownerId === undefined || m[1] === ownerId;
}

export function isCanonicalOwner(ownerId: unknown): ownerId is string {
  return typeof ownerId === 'string' && OWNER_RE.test(ownerId);
}

type StorageErr = { message: string; statusCode?: string; status?: number };

/** The narrow structural shape of the SDK bucket handle (typed, no casts). */
interface PhotoBucketApi {
  createSignedUploadUrl?: (path: string) => Promise<{
    data: { signedUrl: string; token?: string } | null;
    error: StorageErr | null;
  }>;
  createSignedUrls?: (
    paths: string[],
    expiresIn: number,
  ) => Promise<{
    data: Array<{ path: string | null; signedUrl: string | null; error: string | null }> | null;
    error: StorageErr | null;
  }>;
  download?: (path: string) => Promise<{ data: Blob | null; error: StorageErr | null }>;
  upload?: (
    path: string,
    body: Buffer,
    options: { contentType: string; upsert: boolean; cacheControl: string },
  ) => Promise<{ data: { path?: string } | null; error: StorageErr | null }>;
  info?: (path: string) => Promise<{
    data: { size?: number | null; contentType?: string | null } | null;
    error: StorageErr | null;
  }>;
  remove?: (
    paths: string[],
  ) => Promise<{ data: Array<{ name?: string }> | null; error: StorageErr | null }>;
  list?: (
    path: string,
    options?: { limit?: number; offset?: number },
  ) => Promise<{
    data: Array<{ name: string; id?: string | null }> | null;
    error: StorageErr | null;
  }>;
}

interface PhotoBucketsApi {
  getBucket?: (id: string) => Promise<{
    data: { id?: string | null; name?: string | null } | null;
    error: { message: string } | null;
  }>;
}

export type PhotoObjectStat =
  { state: 'present'; size: number | null } | { state: 'missing' } | { state: 'unavailable' };

export type PhotoDownload =
  | { state: 'ok'; bytes: Buffer }
  | { state: 'missing' }
  | { state: 'too_large' }
  | { state: 'unavailable' };

/** Storage operations the photo service needs (a fake implements them in tests). */
export interface MessagePhotoStorageApi {
  createSignedUpload(key: string): Promise<{ uploadUrl: string; token: string | null } | null>;
  stat(key: string): Promise<PhotoObjectStat>;
  download(key: string, maxBytes: number): Promise<PhotoDownload>;
  /** 'ok' after a verified write, 'failed' otherwise. Never overwrites (upsert false). */
  put(key: string, bytes: Buffer, contentType: string): Promise<'ok' | 'failed'>;
  /** Signed READ URLs for canonical final keys; keys that could not be signed are absent. */
  signRead(keys: string[], ttlSec: number): Promise<Map<string, string>>;
  removeObjects(keys: string[]): Promise<{ removed: number; failed: boolean }>;
  /** true = verified missing, false = still present, null = could not check. */
  objectGone(key: string): Promise<boolean | null>;
  removeOwnerFolder(ownerId: string): Promise<{ removed: number; failed: boolean }>;
  /** true = verified empty, false = files remain, null = could not check. */
  ownerFolderEmpty(ownerId: string): Promise<boolean | null>;
}

@Injectable()
export class MessagePhotoStorage implements MessagePhotoStorageApi {
  private readonly logger = new Logger(MessagePhotoStorage.name);

  constructor(private readonly supabase: SupabaseService) {}

  private bucketApi(): PhotoBucketApi | null {
    try {
      return this.supabase.getClient().storage.from(MESSAGE_PHOTOS_BUCKET);
    } catch {
      return null; // storage not configured (tests / local dev)
    }
  }

  async createSignedUpload(
    key: string,
  ): Promise<{ uploadUrl: string; token: string | null } | null> {
    if (!STAGING_RE.test(key)) return null;
    const api = this.bucketApi();
    const fn = api?.createSignedUploadUrl;
    if (!api || typeof fn !== 'function') return null;
    try {
      const res = await fn.call(api, key);
      if (res.error || !res.data?.signedUrl) {
        this.logger.warn(`photo signed-upload failed: ${res.error?.message ?? 'no url'}`);
        return null;
      }
      return { uploadUrl: res.data.signedUrl, token: res.data.token ?? null };
    } catch (err) {
      this.logger.warn(`photo signed-upload failed: ${(err as Error).message}`);
      return null;
    }
  }

  async stat(key: string): Promise<PhotoObjectStat> {
    if (!isCanonicalPhotoKey(key)) return { state: 'missing' };
    const api = this.bucketApi();
    const fn = api?.info;
    if (!api || typeof fn !== 'function') return { state: 'unavailable' };
    try {
      const res = await fn.call(api, key);
      if (res.error)
        return isObjectNotFound(res.error) ? { state: 'missing' } : { state: 'unavailable' };
      if (!res.data) return { state: 'missing' };
      return { state: 'present', size: typeof res.data.size === 'number' ? res.data.size : null };
    } catch {
      return { state: 'unavailable' };
    }
  }

  async download(key: string, maxBytes: number): Promise<PhotoDownload> {
    if (!STAGING_RE.test(key)) return { state: 'missing' };
    const api = this.bucketApi();
    const fn = api?.download;
    if (!api || typeof fn !== 'function') return { state: 'unavailable' };
    try {
      const res = await fn.call(api, key);
      if (res.error)
        return isObjectNotFound(res.error) ? { state: 'missing' } : { state: 'unavailable' };
      if (!res.data) return { state: 'missing' };
      if (res.data.size > maxBytes) return { state: 'too_large' };
      const bytes = Buffer.from(await res.data.arrayBuffer());
      if (bytes.length > maxBytes) return { state: 'too_large' };
      return { state: 'ok', bytes };
    } catch (err) {
      this.logger.warn(`photo download failed: ${(err as Error).message}`);
      return { state: 'unavailable' };
    }
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<'ok' | 'failed'> {
    if (!FINAL_RE.test(key)) return 'failed';
    const api = this.bucketApi();
    const fn = api?.upload;
    if (!api || typeof fn !== 'function') return 'failed';
    try {
      const res = await fn.call(api, key, bytes, {
        contentType,
        upsert: false,
        cacheControl: 'private, max-age=300',
      });
      return res.error ? 'failed' : 'ok';
    } catch (err) {
      this.logger.warn(`photo upload failed: ${(err as Error).message}`);
      return 'failed';
    }
  }

  async signRead(keys: string[], ttlSec: number): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const canonical = [...new Set(keys)].filter((k) => FINAL_RE.test(k));
    if (canonical.length === 0) return out;
    const api = this.bucketApi();
    const fn = api?.createSignedUrls;
    if (!api || typeof fn !== 'function') return out;
    try {
      const res = await fn.call(api, canonical, ttlSec);
      if (res.error || !res.data) return out;
      for (const row of res.data) {
        if (row.path && row.signedUrl && !row.error && canonical.includes(row.path)) {
          out.set(row.path, row.signedUrl);
        }
      }
    } catch (err) {
      this.logger.warn(`photo signed-read failed: ${(err as Error).message}`);
    }
    return out;
  }

  async removeObjects(keys: string[]): Promise<{ removed: number; failed: boolean }> {
    const canonical = [...new Set(keys)].filter((k) => isCanonicalPhotoKey(k));
    if (canonical.length === 0) return { removed: 0, failed: false };
    const api = this.bucketApi();
    const fn = api?.remove;
    if (!api || typeof fn !== 'function') return { removed: 0, failed: true };
    let removed = 0;
    let failed = false;
    for (let i = 0; i < canonical.length; i += 100) {
      try {
        const res = await fn.call(api, canonical.slice(i, i + 100));
        if (res.error) failed = true;
        else removed += res.data?.length ?? 0;
      } catch {
        failed = true;
      }
    }
    return { removed, failed };
  }

  async objectGone(key: string): Promise<boolean | null> {
    if (!isCanonicalPhotoKey(key)) return null;
    const api = this.bucketApi();
    const fn = api?.info;
    if (!api || typeof fn !== 'function') return null;
    try {
      const res = await fn.call(api, key);
      if (!res.error) return res.data ? false : null;
      if (!isObjectNotFound(res.error as VoiceStorageError)) return null;
    } catch {
      return null;
    }
    return this.bucketConfirmed();
  }

  /** Owner folder plus its staging sub-folder (raw uploads that never finished). */
  private ownerPrefixes(ownerId: string): string[] {
    return [`${ownerId}/staging`, ownerId];
  }

  async removeOwnerFolder(ownerId: string): Promise<{ removed: number; failed: boolean }> {
    if (!isCanonicalOwner(ownerId)) return { removed: 0, failed: false };
    const api = this.bucketApi();
    const list = api?.list;
    if (!api || typeof list !== 'function') return { removed: 0, failed: true };
    let removed = 0;
    let failed = false;
    for (const prefix of this.ownerPrefixes(ownerId)) {
      for (let pass = 0; pass < 50; pass += 1) {
        let names: string[];
        try {
          const page = await list.call(api, prefix, { limit: 100, offset: 0 });
          if (page.error) return { removed, failed: true };
          // Folder entries (id null) are not objects; the staging folder is
          // emptied by its own prefix pass.
          names = (page.data ?? [])
            .filter(
              (o) =>
                !!o.name && o.name !== EMPTY_FOLDER_MARKER && o.id !== null && o.id !== undefined,
            )
            .map((o) => `${prefix}/${o.name}`);
        } catch {
          return { removed, failed: true };
        }
        if (names.length === 0) break;
        const res = await this.removeObjects(names);
        removed += res.removed;
        if (res.failed || res.removed === 0) {
          failed = true;
          break;
        }
      }
    }
    return { removed, failed };
  }

  async ownerFolderEmpty(ownerId: string): Promise<boolean | null> {
    if (!isCanonicalOwner(ownerId)) return true;
    const api = this.bucketApi();
    const list = api?.list;
    if (!api || typeof list !== 'function') return null;
    for (const prefix of this.ownerPrefixes(ownerId)) {
      try {
        const page = await list.call(api, prefix, { limit: 10, offset: 0 });
        if (page.error) return null;
        const files = (page.data ?? []).filter(
          (o) => !!o.name && o.name !== EMPTY_FOLDER_MARKER && o.id !== null && o.id !== undefined,
        );
        if (files.length > 0) return false;
      } catch {
        return null;
      }
    }
    return this.bucketConfirmed();
  }

  /** A missing bucket answers "not found" and lists empty too (B-610-8), so confirm it exists. */
  private async bucketConfirmed(): Promise<boolean | null> {
    try {
      const buckets: PhotoBucketsApi = this.supabase.getClient().storage;
      const fn = buckets.getBucket;
      if (typeof fn !== 'function') return null;
      const res = await fn.call(buckets, MESSAGE_PHOTOS_BUCKET);
      if (res.error || !res.data) return null;
      return res.data.id === MESSAGE_PHOTOS_BUCKET || res.data.name === MESSAGE_PHOTOS_BUCKET
        ? true
        : null;
    } catch {
      return null;
    }
  }
}
