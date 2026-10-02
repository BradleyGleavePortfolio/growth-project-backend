import { Injectable, Logger, NotImplementedException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { SupabaseService } from '../../supabase/supabase.service';
import { isSignableVoiceKey, mintVoiceKey, voiceOwnerFolder } from './voice-storage-key';

/**
 * voice-upload.provider.ts — typed extraction of the Supabase signed-upload
 * helper that previously lived inline in MessagingService.createVoiceUpload
 * (src/messaging/messaging.service.ts, pre-v3-3).
 *
 * WHY THIS EXTRACTION (v3-3 brief + V3_3_PREFLIGHT_NOTES §3-§4):
 *  - The signed-upload code path is now SHARED by two callers: the existing
 *    messaging DM controllers AND the new community voice-notes service. A
 *    single @Injectable() provider is the one place the Supabase Storage
 *    signed-upload contract is expressed, typed, and tested.
 *  - The pre-extraction call site used a structural double-cast through the
 *    unknown type to reshape the storage handle. That pattern is on the R0 ban
 *    list and is REMOVED here: the structural shape is expressed as the named
 *    interface `SupabaseStorageWithSignedUpload` and the call site references
 *    the interface name, so no forbidden type-assertion form remains.
 *  - The DELIBERATE runtime guard is PRESERVED. The Supabase JS SDK's
 *    `createSignedUploadUrl` signature varies across minor versions, so we
 *    still narrow to a structural type AND keep the
 *    `typeof fn !== 'function'` check at runtime. Removing the runtime check
 *    would regress the SDK version-skew behaviour the original guarded against
 *    (V3_3_PREFLIGHT_NOTES §4: "Do NOT remove the runtime check just because
 *    the type narrowed.").
 *
 * The provider is configuration-driven and clamped exactly as the original:
 * bucket name, TTL, allowlist, duration/size limits all come from env with the
 * same defaults, so the extraction changes NO runtime behaviour.
 */

/** Default signed-upload TTL — matches Supabase's signed-upload default. */
export const VOICE_UPLOAD_TTL_SEC = 600; // 10 minutes (brief: VOICE_SIGNED_URL_TTL_SEC).
/** Clamp the configurable TTL so a misconfigured env can't issue a dead/forever URL. */
const VOICE_UPLOAD_TTL_CLAMP = { min: 60, max: 24 * 60 * 60 } as const;
/** Default bucket the voice objects land in. */
export const VOICE_DEFAULT_BUCKET = 'voice-notes';

export interface SignedVoiceUploadRequest {
  duration_sec: number;
  size_bytes: number;
  content_type: string;
}

export interface SignedVoiceUploadResponse {
  upload_url: string;
  public_url: string;
  expires_at: string;
}

/**
 * The narrow structural shape of the Supabase Storage bucket handle we depend
 * on. Named (not an inline double-cast through the unknown type) so the call
 * site is typed without any forbidden type-assertion form.
 * `createSignedUploadUrl` is optional because
 * the SDK version-skew guard below tolerates an SDK build that does not expose
 * it (see the runtime `typeof fn !== 'function'` check).
 */
interface SupabaseStorageWithSignedUpload {
  createSignedUploadUrl?: (path: string) => Promise<{
    data: { signedUrl: string; token?: string } | null;
    error: { message: string } | null;
  }>;
  createSignedUrl?: (
    path: string,
    expiresIn: number,
  ) => Promise<{
    data: { signedUrl: string } | null;
    error: { message: string } | null;
  }>;
  getPublicUrl?: (path: string) => { data: { publicUrl?: string } | null };
  info?: (path: string) => Promise<{
    data: { size?: number | null; contentType?: string | null } | null;
    error: { message: string; statusCode?: string; status?: number } | null;
  }>;
  remove?: (paths: string[]) => Promise<{
    data: Array<{ name?: string }> | null;
    error: { message: string } | null;
  }>;
  list?: (
    path: string,
    options?: { limit?: number; offset?: number },
  ) => Promise<{
    data: Array<{ name: string; id?: string | null }> | null;
    error: { message: string } | null;
  }>;
}

/** Result of a stat on an uploaded voice object (publish-time verification). */
export type VoiceObjectStat =
  | { state: 'present'; size: number | null; contentType: string | null }
  | { state: 'missing' }
  | { state: 'unavailable' };

/** Cryptographic random token for storage object paths (hex, URL-safe). */
function randomToken(bytes = 8): string {
  return randomBytes(bytes).toString('hex');
}

@Injectable()
export class VoiceUploadProvider {
  private readonly logger = new Logger(VoiceUploadProvider.name);

  constructor(private readonly supabase: SupabaseService) {}

  /** Bucket name — env override (`SUPABASE_VOICE_BUCKET`) or default. */
  bucket(): string {
    return (process.env.SUPABASE_VOICE_BUCKET ?? '').trim() || VOICE_DEFAULT_BUCKET;
  }

  /** Signed-upload TTL in seconds — env (`VOICE_SIGNED_URL_TTL_SEC`), clamped. */
  ttlSeconds(): number {
    const raw = parseInt(process.env.VOICE_SIGNED_URL_TTL_SEC ?? '', 10);
    if (!Number.isFinite(raw)) return VOICE_UPLOAD_TTL_SEC;
    return Math.min(Math.max(raw, VOICE_UPLOAD_TTL_CLAMP.min), VOICE_UPLOAD_TTL_CLAMP.max);
  }

  /**
   * Map a whitelisted content_type to a file extension for the storage object
   * path. Keep this small and exact — anything outside the allowlist has
   * already been rejected by the caller's limit check.
   */
  contentTypeToExt(contentType: string): string {
    switch (contentType) {
      case 'audio/mp4':
      case 'audio/m4a':
        return 'm4a';
      case 'audio/aac':
        return 'aac';
      case 'audio/mpeg':
        return 'mp3';
      case 'audio/webm':
        return 'webm';
      case 'audio/wav':
        return 'wav';
      case 'audio/ogg':
        return 'ogg';
      default:
        return 'bin';
    }
  }

  /**
   * Build the storage object path for a voice upload. The path is namespaced by
   * the owning principal id (`${ownerId}/`) so a signed URL minted for one
   * principal can never be replayed against another's object key — the same
   * ownership prefix the message-send URL check (QA P0-V1) relies on. A random
   * hex token + timestamp prevents collision and key-guessing.
   */
  buildObjectPath(ownerId: string, contentType: string): string {
    const ext = this.contentTypeToExt(contentType);
    try {
      // A-610-1: the file name carries an issuance MAC (voice-storage-key.ts)
      // so a community publish can prove the server minted this exact key for
      // this caller. Letters, digits and dashes only: normalization-stable.
      return mintVoiceKey(ownerId, ext);
    } catch {
      // Unmintable (no signing secret, unusual owner id or extension): the
      // legacy shape still works for DM uploads, and a community publish
      // refuses it (no MAC), so nothing unsafe can be published from it.
      return `${ownerId}/${Date.now()}-${randomToken(8)}.${ext}`;
    }
  }

  /**
   * Issue a Supabase Storage signed-upload URL for a voice attachment. The
   * caller validates duration/size/content_type up-front so a signed URL is
   * never issued for a payload that would be rejected later. Returns both a
   * signed upload URL and a deterministic public URL.
   *
   * SECURITY NOTE (carried verbatim from the original call site): the signed
   * URL lets the client upload any content to this path within the validity
   * window. We validate the client-claimed MIME type and size BEFORE issuing,
   * but do not verify the actual uploaded object's content-type/size after
   * upload — full remediation requires a pending-upload tracking table + a
   * post-upload verification step (tracked as R7 Finding 4.1).
   */
  async createSignedUpload(
    ownerId: string,
    request: SignedVoiceUploadRequest,
  ): Promise<SignedVoiceUploadResponse> {
    const { upload_url, public_url, expires_at } = await this.createSignedUploadWithKey(
      ownerId,
      request,
    );
    return { upload_url, public_url, expires_at };
  }

  /**
   * Same as createSignedUpload, plus the exact bucket-relative storage key the
   * server minted (community voice persists that key, never one re-derived
   * from a URL).
   */
  async createSignedUploadWithKey(
    ownerId: string,
    request: SignedVoiceUploadRequest,
  ): Promise<SignedVoiceUploadResponse & { storage_key: string }> {
    const supabase = this.supabase.getClient();
    const bucket = this.bucket();
    const objectPath = this.buildObjectPath(ownerId, request.content_type);

    let signedUrl: string;
    try {
      // Narrow the SDK bucket handle to the structural interface — typed, no
      // forbidden double-cast. The SDK exposes createSignedUploadUrl() since
      // v2.30; the method signature varies across minor versions, so we narrow
      // to a small shape rather than rely on the SDK's typed export.
      const storage: SupabaseStorageWithSignedUpload = supabase.storage.from(bucket);
      const fn = storage.createSignedUploadUrl;
      // SDK version-skew guard (DELIBERATE — preserved from the original): an
      // older/newer SDK build may not expose createSignedUploadUrl at all. The
      // runtime check stays even though the type narrowed (V3_3_PREFLIGHT §4).
      if (typeof fn !== 'function') {
        throw new NotImplementedException({
          error: 'VOICE_STORAGE_UNAVAILABLE',
          reason:
            'Supabase JS SDK in this build does not expose createSignedUploadUrl. Set SUPABASE_VOICE_BUCKET and upgrade @supabase/supabase-js to >=2.30.',
        });
      }
      const result = await fn.call(storage, objectPath);
      if (result.error || !result.data) {
        throw new NotImplementedException({
          error: 'VOICE_STORAGE_UNAVAILABLE',
          reason: result.error?.message ?? 'No signed URL returned',
        });
      }
      signedUrl = result.data.signedUrl;
    } catch (err) {
      if (err instanceof NotImplementedException) throw err;
      this.logger.warn(`Supabase voice signed-upload failed: ${(err as Error).message}`);
      throw new NotImplementedException({
        error: 'VOICE_STORAGE_UNAVAILABLE',
        reason: (err as Error).message,
      });
    }

    // Public URL is deterministic when the bucket is public; for private
    // buckets the render path issues a short-lived download URL on demand. We
    // return both so the deployment can persist whichever it uses.
    const storageForPublic: SupabaseStorageWithSignedUpload = supabase.storage.from(bucket);
    const publicUrlFn = storageForPublic.getPublicUrl;
    const publicUrl =
      (typeof publicUrlFn === 'function'
        ? publicUrlFn.call(storageForPublic, objectPath).data?.publicUrl
        : undefined) ??
      `${process.env.SUPABASE_URL ?? ''}/storage/v1/object/public/${bucket}/${objectPath}`;

    const expiresAt = new Date(Date.now() + this.ttlSeconds() * 1000);
    return {
      upload_url: signedUrl,
      public_url: publicUrl,
      expires_at: expiresAt.toISOString(),
      storage_key: objectPath,
    };
  }

  /** Expose the object-path's storage key for a caller that persists it. */
  storageKeyFor(ownerId: string, contentType: string): string {
    return this.buildObjectPath(ownerId, contentType);
  }

  /**
   * Mint a short-lived signed DOWNLOAD URL for a stored voice object, or null
   * when storage is unconfigured (the player renders a disabled state, never a
   * 500). Same named-interface narrowing + runtime version-skew guard as the
   * upload path — no forbidden double-cast. Returns null on any signing
   * failure so one bad key never blanks an entire voice-note feed.
   */
  async createSignedDownload(
    storageKey: string,
    expiresInSeconds?: number,
    ownerId?: string,
  ): Promise<string | null> {
    const bucketName = this.bucket();
    // A-610-1: re-check the key before EVERY sign, after the same
    // normalization the SDK + fetch apply. A dot segment, encoded or foreign
    // key never reaches the privileged signer (no request, no URL).
    if (!isSignableVoiceKey(bucketName, storageKey, ownerId)) {
      this.logger.warn('voice signed-download refused: key failed the canonical check');
      return null;
    }
    let supabase: ReturnType<SupabaseService['getClient']>;
    try {
      supabase = this.supabase.getClient();
    } catch {
      // SupabaseService throws when env vars are absent (test/CI). Treat as
      // unconfigured — the caller renders a disabled player, not an error.
      return null;
    }
    const bucket = this.bucket();
    const ttl = expiresInSeconds ?? this.ttlSeconds();
    try {
      const storage: SupabaseStorageWithSignedUpload = supabase.storage.from(bucket);
      const fn = storage.createSignedUrl;
      // Version-skew guard preserved: an SDK build without createSignedUrl
      // degrades to a disabled player rather than throwing.
      if (typeof fn !== 'function') return null;
      const result = await fn.call(storage, storageKey, ttl);
      if (result.error || !result.data?.signedUrl) return null;
      return result.data.signedUrl;
    } catch (err) {
      this.logger.warn(
        `voice signed-download failed: key=${storageKey}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Publish-time verification (A-610-1): the object the client says it
   * uploaded must exist at the exact minted key; its stored size and type are
   * returned so the caller can compare them with the declared metadata.
   */
  async statObject(storageKey: string, ownerId: string): Promise<VoiceObjectStat> {
    const bucketName = this.bucket();
    if (!isSignableVoiceKey(bucketName, storageKey, ownerId)) return { state: 'missing' };
    let storage: SupabaseStorageWithSignedUpload;
    try {
      storage = this.supabase.getClient().storage.from(bucketName);
    } catch {
      return { state: 'unavailable' };
    }
    const fn = storage.info;
    if (typeof fn !== 'function') return { state: 'unavailable' };
    try {
      const result = await fn.call(storage, storageKey);
      if (result.error) {
        const status = Number(result.error.statusCode ?? result.error.status ?? NaN);
        if (status === 404 || status === 400 || /not.?found/i.test(result.error.message)) {
          return { state: 'missing' };
        }
        return { state: 'unavailable' };
      }
      if (!result.data) return { state: 'missing' };
      const size = typeof result.data.size === 'number' ? result.data.size : null;
      const contentType =
        typeof result.data.contentType === 'string' ? result.data.contentType : null;
      return { state: 'present', size, contentType };
    } catch (err) {
      this.logger.warn(`voice stat failed: ${(err as Error).message}`);
      return { state: 'unavailable' };
    }
  }

  /**
   * Erase voice objects (B-610-5): author delete, moderation hide/ban and
   * account deletion. Only canonical keys are sent to storage. Returns how
   * many were removed and whether any storage call failed (callers log it;
   * the row is already soft-deleted, so nothing is ever signed again).
   */
  async removeObjects(storageKeys: string[]): Promise<{ removed: number; failed: boolean }> {
    const bucketName = this.bucket();
    const keys = [...new Set(storageKeys)].filter((k) => isSignableVoiceKey(bucketName, k));
    if (keys.length === 0) return { removed: 0, failed: false };
    let storage: SupabaseStorageWithSignedUpload;
    try {
      storage = this.supabase.getClient().storage.from(bucketName);
    } catch {
      return { removed: 0, failed: true };
    }
    const fn = storage.remove;
    if (typeof fn !== 'function') return { removed: 0, failed: true };
    let removed = 0;
    let failed = false;
    for (let i = 0; i < keys.length; i += 100) {
      try {
        const result = await fn.call(storage, keys.slice(i, i + 100));
        if (result.error) failed = true;
        else removed += result.data?.length ?? 0;
      } catch (err) {
        failed = true;
        this.logger.warn(`voice remove failed: ${(err as Error).message}`);
      }
    }
    return { removed, failed };
  }

  /**
   * Erasure verification (B-610-5 round 5): true when the exact object reads
   * back missing, false while it is still present, null when storage could not
   * answer (the erasure stays open and is retried).
   */
  async objectGone(storageKey: string): Promise<boolean | null> {
    const owner = storageKey.split('/')[0] ?? '';
    const stat = await this.statObject(storageKey, owner);
    if (stat.state === 'missing') return true;
    if (stat.state === 'present') return false;
    return null;
  }

  /**
   * Erasure verification for an owner folder: true when `<bucket>/<ownerId>/`
   * lists empty, false while files remain, null when storage could not answer.
   */
  async ownerFolderEmpty(ownerId: string): Promise<boolean | null> {
    const folder = voiceOwnerFolder(ownerId);
    if (!folder) return true;
    let storage: SupabaseStorageWithSignedUpload;
    try {
      storage = this.supabase.getClient().storage.from(this.bucket());
    } catch {
      return null;
    }
    const list = storage.list;
    if (typeof list !== 'function') return null;
    try {
      const page = await list.call(storage, folder, { limit: 1, offset: 0 });
      if (page.error) return null;
      return (page.data ?? []).filter((o) => !!o.name).length === 0;
    } catch {
      return null;
    }
  }

  /**
   * Erase every object in `<bucket>/<ownerId>/` (account deletion, B-610-5):
   * published, unpublished and DM uploads alike.
   */
  async removeOwnerFolder(ownerId: string): Promise<{ removed: number; failed: boolean }> {
    const folder = voiceOwnerFolder(ownerId);
    if (!folder) return { removed: 0, failed: false };
    let storage: SupabaseStorageWithSignedUpload;
    try {
      storage = this.supabase.getClient().storage.from(this.bucket());
    } catch {
      return { removed: 0, failed: true };
    }
    const list = storage.list;
    if (typeof list !== 'function') return { removed: 0, failed: true };
    let removed = 0;
    let failed = false;
    // Each pass lists the first page and removes it; bounded so a storage
    // fault can never loop forever.
    for (let pass = 0; pass < 50; pass += 1) {
      let names: string[];
      try {
        const page = await list.call(storage, folder, { limit: 100, offset: 0 });
        if (page.error) return { removed, failed: true };
        names = (page.data ?? []).map((o) => o.name).filter((n) => !!n);
      } catch {
        return { removed, failed: true };
      }
      if (names.length === 0) break;
      const result = await this.removeObjects(names.map((n) => `${folder}/${n}`));
      removed += result.removed;
      if (result.failed || result.removed === 0) {
        failed = failed || result.failed || result.removed === 0;
        break;
      }
    }
    return { removed, failed };
  }
}
