import { Injectable, Logger, NotImplementedException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { SupabaseService } from '../../supabase/supabase.service';

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
}

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
    return (
      (process.env.SUPABASE_VOICE_BUCKET ?? '').trim() || VOICE_DEFAULT_BUCKET
    );
  }

  /** Signed-upload TTL in seconds — env (`VOICE_SIGNED_URL_TTL_SEC`), clamped. */
  ttlSeconds(): number {
    const raw = parseInt(process.env.VOICE_SIGNED_URL_TTL_SEC ?? '', 10);
    if (!Number.isFinite(raw)) return VOICE_UPLOAD_TTL_SEC;
    return Math.min(
      Math.max(raw, VOICE_UPLOAD_TTL_CLAMP.min),
      VOICE_UPLOAD_TTL_CLAMP.max,
    );
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
    return `${ownerId}/${Date.now()}-${randomToken(8)}.${ext}`;
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
    const supabase = this.supabase.getClient();
    const bucket = this.bucket();
    const objectPath = this.buildObjectPath(ownerId, request.content_type);

    let signedUrl: string;
    try {
      // Narrow the SDK bucket handle to the structural interface — typed, no
      // forbidden double-cast. The SDK exposes createSignedUploadUrl() since
      // v2.30; the method signature varies across minor versions, so we narrow
      // to a small shape rather than rely on the SDK's typed export.
      const storage: SupabaseStorageWithSignedUpload =
        supabase.storage.from(bucket);
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
      this.logger.warn(
        `Supabase voice signed-upload failed: ${(err as Error).message}`,
      );
      throw new NotImplementedException({
        error: 'VOICE_STORAGE_UNAVAILABLE',
        reason: (err as Error).message,
      });
    }

    // Public URL is deterministic when the bucket is public; for private
    // buckets the render path issues a short-lived download URL on demand. We
    // return both so the deployment can persist whichever it uses.
    const storageForPublic: SupabaseStorageWithSignedUpload =
      supabase.storage.from(bucket);
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
  ): Promise<string | null> {
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
      const storage: SupabaseStorageWithSignedUpload =
        supabase.storage.from(bucket);
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
}
