/**
 * StorageProvider — provider-agnostic object-storage seam (decision #5).
 *
 * The coach-media library currently uses Supabase Storage for PDFs. Per
 * the master plan §1 decision #5, all storage access goes through this
 * interface so we can swap to S3-compatible storage later without
 * scattering SDK calls across services.
 *
 * Scope: this provider abstracts the PDF/document path only. Video goes
 * to Mux (a different kind of provider entirely — adaptive HLS, not raw
 * objects), and that integration lives in src/video/mux.service.ts.
 * Trying to force Mux behind the same interface would either leak Mux-
 * specific concepts (playback policy, upload URL with one-shot semantics)
 * or strip them — both are wrong. We keep the seams separate and the
 * coach-media service composes both.
 *
 * Why not a class hierarchy: the only consumer today is CoachMediaService.
 * A single-method interface (`StorageProvider`) is enough; we can split
 * into multiple impls when a second provider lands. Until then, "ports
 * and adapters" is the spec — one port (the interface), one adapter
 * (SupabaseStorageProvider).
 *
 * Config-not-set: the provider exposes isConfigured() so the coach-media
 * service can return a clean 503 with `error: 'MEDIA_STORAGE_NOT_CONFIGURED'`
 * — mirrors the CONNECT_NOT_CONFIGURED / STRIPE_NOT_CONFIGURED pattern
 * from PR-1 / billing. The provider methods themselves THROW
 * `StorageNotConfiguredError` if a caller bypasses the gate; the service
 * catches and re-throws as ServiceUnavailableException. App never crashes
 * if Supabase storage env vars are absent.
 */

export interface SignedUploadResult {
  /** The signed PUT URL the client uploads to. Time-limited. */
  signedUrl: string;
  /** The opaque storage key (object path within the bucket). */
  storageKey: string;
  /** The provider id ('supabase'); persisted on CoachMediaAsset.provider. */
  provider: string;
  /** Token (when the provider issues one separately from the URL). */
  token?: string;
}

export interface SignedDownloadOptions {
  /** Seconds the signed URL stays valid for. Provider may clamp. */
  expiresInSeconds?: number;
  /** Optional override of Content-Disposition (e.g. force download). */
  download?: boolean | string;
}

export interface PutObjectInput {
  storageKey: string;
  body: Buffer;
  contentType?: string;
}

export interface PutObjectResult {
  storageKey: string;
  provider: string;
}

/**
 * Provider-agnostic object-storage port. PDFs only.
 *
 * NONE of these methods should ever return a public, permanent URL for
 * paid content. The contract is: signed time-limited URLs only.
 */
export interface StorageProvider {
  /** Provider id — persisted on CoachMediaAsset.provider. */
  readonly id: string;

  /** Whether the provider is configured (env vars present). */
  isConfigured(): boolean;

  /**
   * Issue a time-limited PUT URL the client uploads the file to. The
   * service generates the storage key (with the coach id namespace prefix
   * + a random component, no path traversal) and passes it in.
   *
   * Returns the signed URL + the storage key we'll persist on the
   * CoachMediaAsset row.
   */
  createSignedUploadUrl(input: {
    storageKey: string;
    contentType?: string;
  }): Promise<SignedUploadResult>;

  /**
   * Issue a time-limited GET URL. Used to deliver paid content to the
   * granted buyer (ClientAssetGrant) and to let the owning coach preview
   * their own asset.
   *
   * Default expiry is 60 minutes; provider may clamp upward (some signed
   * URL services require a minimum) but not downward. Callers can request
   * a shorter expiry for sensitive contexts.
   */
  createSignedDownloadUrl(
    storageKey: string,
    options?: SignedDownloadOptions,
  ): Promise<string>;

  /**
   * Direct server-side PUT. Used by tests + the (currently unused)
   * server-side ingest path. Production uploads go through
   * createSignedUploadUrl + a confirm endpoint.
   */
  putObject(input: PutObjectInput): Promise<PutObjectResult>;

  /**
   * Delete the underlying object. Called from the soft-delete path only
   * when the asset is not referenced by any ClientAssetGrant — see
   * CoachMediaService.softDelete for the safety rule.
   *
   * Returning true means "object is gone OR was never there"; provider
   * impls should be idempotent (404 on the underlying delete is fine).
   */
  deleteObject(storageKey: string): Promise<boolean>;
}

/** Thrown by provider methods when the underlying provider env is unset. */
export class StorageNotConfiguredError extends Error {
  readonly code = 'MEDIA_STORAGE_NOT_CONFIGURED';
  constructor(reason: string) {
    super(reason);
    this.name = 'StorageNotConfiguredError';
  }
}

/** Thrown when the provider returns an unrecoverable error. */
export class StorageProviderError extends Error {
  constructor(public readonly providerId: string, message: string) {
    super(message);
    this.name = 'StorageProviderError';
  }
}

/** Injection token for the active StorageProvider (DI). */
export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');
