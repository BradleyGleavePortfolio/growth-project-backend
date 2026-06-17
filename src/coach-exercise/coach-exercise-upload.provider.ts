import { Injectable, Logger, NotImplementedException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { SupabaseService } from '../supabase/supabase.service';

/**
 * coach-exercise-upload.provider.ts — Supabase signed-upload / signed-download
 * helper for coach custom-exercise media. Mirrors voice-upload.provider.ts
 * (the community voice-notes media idiom) verbatim, coach-owned instead of
 * workspace-owned.
 *
 * WHY THE NAMED INTERFACE + RUNTIME GUARD (carried from voice-upload.provider):
 *  - The structural shape of the Supabase Storage bucket handle is expressed as
 *    the named interface `SupabaseStorageWithSignedUpload` and the call site
 *    references the interface name, so NO forbidden double-cast through unknown
 *    is needed.
 *  - The DELIBERATE `typeof fn !== 'function'` runtime guard is PRESERVED: the
 *    Supabase JS SDK's createSignedUploadUrl signature varies across minor
 *    versions, so we narrow to a structural type AND keep the runtime check to
 *    tolerate SDK version skew.
 *
 * Configuration-driven and clamped: bucket name + TTL come from env with the
 * same defaults as the voice provider.
 */

/** Default signed-upload TTL — matches Supabase's signed-upload default. */
export const COACH_EXERCISE_UPLOAD_TTL_SEC = 600; // 10 minutes.
/** Clamp the configurable TTL so a misconfigured env can't issue a dead/forever URL. */
const TTL_CLAMP = { min: 60, max: 24 * 60 * 60 } as const;
/** Default bucket the coach-exercise media objects land in. */
export const COACH_EXERCISE_DEFAULT_BUCKET = 'coach-exercises';

export interface SignedMediaUploadRequest {
  size_bytes: number;
  content_type: string;
}

export interface SignedMediaUploadResponse {
  upload_url: string;
  public_url: string;
  expires_at: string;
}

/**
 * The narrow structural shape of the Supabase Storage bucket handle we depend
 * on. Named (not an inline double-cast) so the call site is typed without any
 * forbidden type-assertion form. createSignedUploadUrl is optional because the
 * SDK version-skew guard below tolerates an SDK build that does not expose it.
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
export class CoachExerciseUploadProvider {
  private readonly logger = new Logger(CoachExerciseUploadProvider.name);

  constructor(private readonly supabase: SupabaseService) {}

  /** Bucket name — env override (`SUPABASE_COACH_EXERCISE_BUCKET`) or default. */
  bucket(): string {
    return (
      (process.env.SUPABASE_COACH_EXERCISE_BUCKET ?? '').trim() ||
      COACH_EXERCISE_DEFAULT_BUCKET
    );
  }

  /** Signed-upload TTL in seconds — env (`COACH_EXERCISE_SIGNED_URL_TTL_SEC`), clamped. */
  ttlSeconds(): number {
    const raw = parseInt(
      process.env.COACH_EXERCISE_SIGNED_URL_TTL_SEC ?? '',
      10,
    );
    if (!Number.isFinite(raw)) return COACH_EXERCISE_UPLOAD_TTL_SEC;
    return Math.min(Math.max(raw, TTL_CLAMP.min), TTL_CLAMP.max);
  }

  /**
   * Map a whitelisted content_type to a file extension for the storage object
   * path. Anything outside the allowlist has already been rejected by the
   * caller's limit check.
   */
  contentTypeToExt(contentType: string): string {
    switch (contentType) {
      case 'image/jpeg':
        return 'jpg';
      case 'image/png':
        return 'png';
      case 'image/webp':
        return 'webp';
      case 'video/mp4':
        return 'mp4';
      case 'video/quicktime':
        return 'mov';
      default:
        return 'bin';
    }
  }

  /**
   * Build the storage object path for a media upload. Namespaced by the owning
   * coach id (`${ownerId}/`) so a signed URL minted for one principal can never
   * be replayed against another's object key. A random hex token + timestamp
   * prevents collision and key-guessing.
   */
  buildObjectPath(ownerId: string, contentType: string): string {
    const ext = this.contentTypeToExt(contentType);
    return `${ownerId}/${Date.now()}-${randomToken(8)}.${ext}`;
  }

  /**
   * Narrow the SDK bucket handle to the named structural interface — typed, no
   * forbidden double-cast through unknown. Returns null when SupabaseService is
   * unconfigured (test/CI) so callers degrade gracefully instead of throwing.
   */
  private bucketHandle(): SupabaseStorageWithSignedUpload | null {
    try {
      return this.supabase.getClient().storage.from(this.bucket());
    } catch {
      return null;
    }
  }

  /**
   * Issue a Supabase Storage signed-upload URL for coach-exercise media. The
   * caller validates size + content_type up-front so a signed URL is never
   * issued for a payload that would be rejected later. Returns both a signed
   * upload URL and a deterministic public URL.
   */
  async createSignedUpload(
    ownerId: string,
    request: SignedMediaUploadRequest,
  ): Promise<SignedMediaUploadResponse> {
    const bucket = this.bucket();
    const objectPath = this.buildObjectPath(ownerId, request.content_type);
    const storage = this.bucketHandle();
    const fn = storage?.createSignedUploadUrl;

    let signedUrl: string;
    try {
      // SDK version-skew guard (DELIBERATE — preserved from the voice provider):
      // an older/newer SDK build may not expose createSignedUploadUrl at all.
      if (!storage || typeof fn !== 'function') {
        throw new NotImplementedException({
          error: 'COACH_EXERCISE_STORAGE_UNAVAILABLE',
          reason:
            'Supabase JS SDK in this build does not expose createSignedUploadUrl. Set SUPABASE_COACH_EXERCISE_BUCKET and upgrade @supabase/supabase-js to >=2.30.',
        });
      }
      const result = await fn.call(storage, objectPath);
      if (result.error || !result.data) {
        throw new NotImplementedException({
          error: 'COACH_EXERCISE_STORAGE_UNAVAILABLE',
          reason: result.error?.message ?? 'No signed URL returned',
        });
      }
      signedUrl = result.data.signedUrl;
    } catch (err) {
      if (err instanceof NotImplementedException) throw err;
      this.logger.warn(
        `coach-exercise signed-upload failed: ${(err as Error).message}`,
      );
      throw new NotImplementedException({
        error: 'COACH_EXERCISE_STORAGE_UNAVAILABLE',
        reason: (err as Error).message,
      });
    }

    // Public URL is deterministic when the bucket is public; for private buckets
    // the render path issues a short-lived download URL on demand.
    const publicUrlFn = storage.getPublicUrl;
    const publicUrl =
      (typeof publicUrlFn === 'function'
        ? publicUrlFn.call(storage, objectPath).data?.publicUrl
        : undefined) ??
      `${process.env.SUPABASE_URL ?? ''}/storage/v1/object/public/${bucket}/${objectPath}`;

    return {
      upload_url: signedUrl,
      public_url: publicUrl,
      expires_at: new Date(Date.now() + this.ttlSeconds() * 1000).toISOString(),
    };
  }

  /**
   * Extract the bucket-relative storage key from the provider's public URL,
   * asserting the owner-id namespace prefix (bucket-binding). The public URL
   * shape is `.../object/public/<bucket>/<ownerId>/<file>`; we take everything
   * after the bucket segment. Falls back to a namespaced key if the URL shape is
   * unexpected so we never return a key outside the owner's namespace.
   */
  deriveStorageKey(publicUrl: string, ownerId: string): string {
    const bucket = this.bucket();
    const marker = `/${bucket}/`;
    const idx = publicUrl.indexOf(marker);
    if (idx >= 0) {
      const key = publicUrl.slice(idx + marker.length);
      if (key.startsWith(`${ownerId}/`)) return key;
    }
    return `${ownerId}/${Date.now()}-fallback`;
  }

  /**
   * Mint a short-lived signed DOWNLOAD URL for a stored media object, or null
   * when storage is unconfigured (the client renders a disabled media state,
   * never a 500). Same named-interface narrowing + runtime version-skew guard
   * as the upload path. Returns null on any signing failure so one bad key never
   * blanks an entire library list.
   */
  async createSignedDownload(
    storageKey: string,
    expiresInSeconds?: number,
  ): Promise<string | null> {
    const storage = this.bucketHandle();
    const fn = storage?.createSignedUrl;
    // Version-skew / unconfigured guard: an SDK build without createSignedUrl
    // (or absent env in test/CI) degrades to a disabled media state, not a 500.
    if (!storage || typeof fn !== 'function') return null;
    try {
      const result = await fn.call(
        storage,
        storageKey,
        expiresInSeconds ?? this.ttlSeconds(),
      );
      if (result.error || !result.data?.signedUrl) return null;
      return result.data.signedUrl;
    } catch (err) {
      this.logger.warn(
        `coach-exercise signed-download failed: key=${storageKey}: ${(err as Error).message}`,
      );
      return null;
    }
  }
}
