/**
 * SupabaseStorageProvider — the concrete StorageProvider implementation
 * for the coach-media PDF library.
 *
 * Re-uses the existing @Global SupabaseService (src/supabase/supabase.service.ts)
 * — no second Supabase client, no parallel SDK init. The bucket name is
 * configurable via SUPABASE_MEDIA_BUCKET (defaults to 'coach-media'); the
 * service-role credentials come from SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 * which are 'hard' tier in env-validation so they're already required at
 * boot for the rest of the app.
 *
 * isConfigured() is the gate: if SupabaseService can't be constructed (in
 * a test or a deploy without storage), every method short-circuits with
 * StorageNotConfiguredError and the coach-media service translates that
 * into a clean 503. The app never crashes.
 *
 * Why one provider, not many: today there is exactly one prod storage
 * backend (Supabase). When a second lands (S3-compatible, decision #5)
 * we'll add an S3StorageProvider and switch the binding in
 * CoachMediaModule. The interface stays the same.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';
import {
  PutObjectInput,
  PutObjectResult,
  SignedDownloadOptions,
  SignedUploadResult,
  StorageNotConfiguredError,
  StorageProvider,
  StorageProviderError,
} from './storage-provider';

const DEFAULT_BUCKET = 'coach-media';
const DEFAULT_DOWNLOAD_TTL_SECONDS = 60 * 60; // 1 hour
const MIN_DOWNLOAD_TTL_SECONDS = 60; // 1 minute
const MAX_DOWNLOAD_TTL_SECONDS = 60 * 60 * 24; // 24 hours

@Injectable()
export class SupabaseStorageProvider implements StorageProvider {
  readonly id = 'supabase';
  private readonly logger = new Logger(SupabaseStorageProvider.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
  ) {}

  isConfigured(): boolean {
    // SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are 'hard' tier in
    // env-validation, so if the SupabaseService got constructed at all,
    // they were present at boot. We still check explicitly so a deploy
    // running with intentionally-stubbed Supabase (a CI smoke env)
    // surfaces a clear 503 instead of a 500.
    const url = this.config.get<string>('SUPABASE_URL');
    const key = this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    return !!(url && key);
  }

  bucketName(): string {
    return (
      this.config.get<string>('SUPABASE_MEDIA_BUCKET') ?? DEFAULT_BUCKET
    );
  }

  async createSignedUploadUrl(input: {
    storageKey: string;
    contentType?: string;
  }): Promise<SignedUploadResult> {
    this.assertConfigured('createSignedUploadUrl');
    const client = this.supabase.getClient();
    const bucket = this.bucketName();

    // The Supabase JS SDK exposes createSignedUploadUrl() since v2.30. The
    // method signature varies across minor versions; cast to a narrow shape
    // so a schema bump elsewhere does not break this call site — mirrors
    // the pattern already used in messaging.service.ts for voice notes.
    const storage = client.storage.from(bucket);
    const fn = (
      storage as unknown as {
        createSignedUploadUrl?: (
          path: string,
        ) => Promise<{
          data: { signedUrl: string; token?: string; path?: string } | null;
          error: { message: string } | null;
        }>;
      }
    ).createSignedUploadUrl;
    if (typeof fn !== 'function') {
      throw new StorageNotConfiguredError(
        'Supabase JS SDK in this build does not expose createSignedUploadUrl. Upgrade @supabase/supabase-js to >=2.30.',
      );
    }
    let result;
    try {
      result = await fn.call(storage, input.storageKey);
    } catch (err) {
      throw new StorageProviderError(this.id, (err as Error).message);
    }
    if (result.error || !result.data?.signedUrl) {
      throw new StorageProviderError(
        this.id,
        result.error?.message ?? 'No signed URL returned',
      );
    }
    return {
      signedUrl: result.data.signedUrl,
      storageKey: input.storageKey,
      provider: this.id,
      token: result.data.token,
    };
  }

  async createSignedDownloadUrl(
    storageKey: string,
    options?: SignedDownloadOptions,
  ): Promise<string> {
    this.assertConfigured('createSignedDownloadUrl');
    const client = this.supabase.getClient();
    const bucket = this.bucketName();
    const requested =
      options?.expiresInSeconds ?? DEFAULT_DOWNLOAD_TTL_SECONDS;
    const expires = Math.max(
      MIN_DOWNLOAD_TTL_SECONDS,
      Math.min(MAX_DOWNLOAD_TTL_SECONDS, requested),
    );

    const storage = client.storage.from(bucket);
    const fn = (
      storage as unknown as {
        createSignedUrl?: (
          path: string,
          expiresIn: number,
          opts?: { download?: boolean | string },
        ) => Promise<{
          data: { signedUrl: string } | null;
          error: { message: string } | null;
        }>;
      }
    ).createSignedUrl;
    if (typeof fn !== 'function') {
      throw new StorageNotConfiguredError(
        'Supabase JS SDK in this build does not expose createSignedUrl.',
      );
    }
    let result;
    try {
      result = await fn.call(
        storage,
        storageKey,
        expires,
        options?.download !== undefined
          ? { download: options.download }
          : undefined,
      );
    } catch (err) {
      throw new StorageProviderError(this.id, (err as Error).message);
    }
    if (result.error || !result.data?.signedUrl) {
      throw new StorageProviderError(
        this.id,
        result.error?.message ?? 'No signed URL returned',
      );
    }
    return result.data.signedUrl;
  }

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    this.assertConfigured('putObject');
    const client = this.supabase.getClient();
    const bucket = this.bucketName();
    const storage = client.storage.from(bucket);
    const fn = (
      storage as unknown as {
        upload?: (
          path: string,
          body: Buffer,
          opts?: { contentType?: string; upsert?: boolean },
        ) => Promise<{
          data: { path: string } | null;
          error: { message: string } | null;
        }>;
      }
    ).upload;
    if (typeof fn !== 'function') {
      throw new StorageNotConfiguredError(
        'Supabase JS SDK in this build does not expose storage.upload().',
      );
    }
    let result;
    try {
      result = await fn.call(storage, input.storageKey, input.body, {
        contentType: input.contentType,
        upsert: false,
      });
    } catch (err) {
      throw new StorageProviderError(this.id, (err as Error).message);
    }
    if (result.error) {
      throw new StorageProviderError(this.id, result.error.message);
    }
    return { storageKey: input.storageKey, provider: this.id };
  }

  async deleteObject(storageKey: string): Promise<boolean> {
    this.assertConfigured('deleteObject');
    const client = this.supabase.getClient();
    const bucket = this.bucketName();
    const storage = client.storage.from(bucket);
    const fn = (
      storage as unknown as {
        remove?: (paths: string[]) => Promise<{
          data: unknown;
          error: { message: string } | null;
        }>;
      }
    ).remove;
    if (typeof fn !== 'function') {
      // Treat as idempotent success — the row will still be archived even
      // if the underlying object can't be removed by this SDK build.
      this.logger.warn(
        'Supabase JS SDK in this build does not expose storage.remove(); skipping object delete',
      );
      return true;
    }
    let result;
    try {
      result = await fn.call(storage, [storageKey]);
    } catch (err) {
      // Idempotent — we want soft-delete to succeed even if the object
      // is already gone or the provider hiccups; the row archive is the
      // source of truth.
      this.logger.warn(
        `Supabase deleteObject(${storageKey}) failed: ${(err as Error).message}`,
      );
      return false;
    }
    if (result.error) {
      this.logger.warn(
        `Supabase deleteObject(${storageKey}) error: ${result.error.message}`,
      );
      return false;
    }
    return true;
  }

  private assertConfigured(method: string): void {
    if (!this.isConfigured()) {
      throw new StorageNotConfiguredError(
        `Supabase storage is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY unset) — cannot ${method}().`,
      );
    }
  }
}
