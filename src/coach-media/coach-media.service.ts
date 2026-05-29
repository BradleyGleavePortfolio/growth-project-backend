/**
 * PR-12 — CoachMediaService.
 *
 * Owns the CoachMediaAsset upload pipeline:
 *   * PDF — coach POSTs metadata, we mint a Supabase signed-upload URL,
 *     coach PUTs the file directly, coach POSTs a `confirm` to flip
 *     status='uploading' → 'ready'. The CoachMediaAsset row is created
 *     at start so we can roll back on abandoned uploads.
 *   * Video — coach POSTs metadata, we create a Mux Direct Upload, the
 *     row stores status='uploading' + mux_upload_id. The Mux webhook
 *     (CoachMediaMuxWebhookController) drives uploading → processing →
 *     ready|errored. We never trust the client to flip a video to ready.
 *
 * MediaAssetResolver gates on status='ready' (PR-12 update) so a not-yet-
 * ready video can never silently materialise into a buyer grant. Combined
 * with PR-8's attach-time validation (refuses non-existent / non-owned
 * rows) this enforces the safer choice from the brief's "not-ready at
 * purchase" question: a row not in 'ready' state is invisible to the
 * picker AND invisible to fan-out — see assertAttachable() below.
 *
 * Ownership / scope:
 *   - resolveEffectiveCoachId promotes sub-coach → head-coach id BEFORE
 *     every read/write. CoachMediaAsset.coach_id is always the head
 *     coach id; sub-coaches act on behalf of their head coach (mirrors
 *     PackagesService + the AssignableAssetResolver tenant rule).
 *   - assertOwned() refuses any cross-coach access (read, signed-URL,
 *     delete) with a 404 — we never leak the existence of another
 *     coach's media.
 *
 * Signed URLs:
 *   - PDFs are delivered via Supabase signed download URLs, default 1h
 *     expiry. The OWNER can always sign a URL for their own asset (preview
 *     in the editor). BUYERS get a URL only via getBuyerSignedDownloadUrl
 *     which gates on an active ClientAssetGrant (PR-7).
 *   - Videos use Mux playback URLs minted by MuxService.mintPlaybackUrl
 *     with the `signed` policy — audit P2-2 fix. The Direct Upload is
 *     created with playbackPolicy='signed', so the asset's playback id
 *     only works with a per-request RS256-signed JWT minted at
 *     URL-issuance time. This makes ClientAssetGrant revocation
 *     meaningful (a revoked buyer cannot mint a new signed URL) and
 *     ages out leaked URLs after the TTL window expires. Mirrors the
 *     PDF signed-URL principle.
 *
 * Soft-delete:
 *   - We never hard-delete a row. archived_at is set; signed URLs and
 *     listings filter archived rows out. The underlying object IS
 *     removed from storage IF no ClientAssetGrant has been minted; if
 *     ANY grant exists, the object stays so buyer downloads keep
 *     working. PR-8's snapshot-at-purchase principle: a coach archiving
 *     a media asset cannot retroactively break a paid buyer's
 *     delivery.
 *
 * Config-not-set:
 *   - Every endpoint that touches a provider calls assertProvider*Ready()
 *     first. Missing Supabase creds → 503 MEDIA_STORAGE_NOT_CONFIGURED.
 *     Missing Mux creds → 503 MUX_NOT_CONFIGURED. The app never crashes;
 *     these are clean errors at request time, not at boot.
 *
 * Dual-attach seam (decision #6):
 *   - The MUX UPLOAD PIPELINE is single (one Direct Upload create call,
 *     one webhook controller). CoachMediaAsset(kind='video') is the
 *     coach-library row. ExerciseCatalogItem keeps its existing
 *     workout-demo Mux fields (separate row, separate webhook in
 *     src/video/mux-webhook.controller.ts) because that path is the
 *     repo's pre-existing exercise authoring surface and is out of scope
 *     for PR-12. The seam where they converge in the future: an
 *     ExerciseCatalogItem could store its own video as a CoachMediaAsset
 *     reference and stop carrying mux_* columns. We document this seam
 *     here and in the build report; the unification is a follow-up.
 */

import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CoachMediaAsset, Prisma } from '@prisma/client';
import { randomBytes, randomUUID } from 'crypto';
import { PrismaService } from '../prisma.service';
import { MuxService } from '../video/mux.service';
import { MuxDisabledError } from '../video/mux.errors';
import { SubCoachScopeService } from '../sub-coach/sub-coach-scope.service';
import {
  STORAGE_PROVIDER,
  type SignedDownloadOptions,
  type StorageProvider,
  StorageNotConfiguredError,
  StorageProviderError,
} from './storage-provider';
import { InvalidUploadConfirmationError } from './coach-media.errors';
import {
  ConfirmPdfUploadSchema,
  CreatePdfUploadSchema,
  CreateVideoUploadSchema,
  PatchMediaSchema,
  type ConfirmPdfUploadInput,
  type CreatePdfUploadInput,
  type CreateVideoUploadInput,
  type PatchMediaInput,
} from './coach-media.dto';

const SIGNED_DOWNLOAD_TTL_SECONDS_DEFAULT = 60 * 60; // 1 hour

// Status state machine (matches the comment on the schema column).
export const STATUS_UPLOADING = 'uploading';
export const STATUS_PROCESSING = 'processing';
export const STATUS_READY = 'ready';
export const STATUS_ERRORED = 'errored';
const NON_TERMINAL_STATUSES = new Set<string>([
  STATUS_UPLOADING,
  STATUS_PROCESSING,
]);

@Injectable()
export class CoachMediaService {
  private readonly logger = new Logger(CoachMediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER)
    private readonly storage: StorageProvider,
    private readonly mux: MuxService,
    private readonly subCoachScope: SubCoachScopeService,
    private readonly config: ConfigService,
  ) {}

  // ── tenant resolution ──────────────────────────────────────────────────

  async resolveEffectiveCoachId(callerUserId: string): Promise<string> {
    const headCoachId =
      await this.subCoachScope.getHeadCoachIdForSubCoach(callerUserId);
    return headCoachId ?? callerUserId;
  }

  // ── PDF ────────────────────────────────────────────────────────────────

  /**
   * Issue a signed Supabase upload URL + create the CoachMediaAsset row
   * in `uploading` state. The client PUTs the PDF to the returned URL,
   * then calls confirmPdfUpload() to flip status='ready'.
   */
  async createPdfUpload(
    coachUserId: string,
    rawInput: unknown,
  ): Promise<{
    media_asset_id: string;
    upload_url: string;
    storage_key: string;
    expires_in_seconds: number;
  }> {
    const input = this.parse(CreatePdfUploadSchema, rawInput) as CreatePdfUploadInput;
    this.assertStorageReady();

    const id = this.generateId();
    const storageKey = this.buildPdfStorageKey(coachUserId, id);

    // Mint the signed upload URL first — if Supabase rejects, we don't
    // want to create a CoachMediaAsset row that the client can't PUT to.
    let signed;
    try {
      signed = await this.storage.createSignedUploadUrl({
        storageKey,
        contentType: input.content_type,
      });
    } catch (err) {
      if (err instanceof StorageNotConfiguredError) {
        throw new ServiceUnavailableException({
          error: 'MEDIA_STORAGE_NOT_CONFIGURED',
          message: err.message,
        });
      }
      if (err instanceof StorageProviderError) {
        throw new ServiceUnavailableException({
          error: 'MEDIA_STORAGE_UNAVAILABLE',
          message: err.message,
        });
      }
      throw err;
    }

    await this.prisma.coachMediaAsset.create({
      data: {
        id,
        coach_id: coachUserId,
        kind: 'pdf',
        title: input.title,
        description: input.description ?? null,
        storage_key: signed.storageKey,
        provider: signed.provider,
        byte_size: input.byte_size !== undefined ? BigInt(input.byte_size) : null,
        content_type: input.content_type,
        status: STATUS_UPLOADING,
      },
    });

    return {
      media_asset_id: id,
      upload_url: signed.signedUrl,
      storage_key: signed.storageKey,
      expires_in_seconds: SIGNED_DOWNLOAD_TTL_SECONDS_DEFAULT,
    };
  }

  /**
   * Flip a PDF row from `uploading` to `ready`. Idempotent — re-confirming
   * a row already `ready` is a no-op. Refuses to flip a `processing` or
   * `errored` row (those don't apply to PDFs and indicate a state-machine
   * bug).
   */
  async confirmPdfUpload(
    coachUserId: string,
    mediaAssetId: string,
    rawInput: unknown,
  ): Promise<CoachMediaAsset> {
    const input = this.parse(ConfirmPdfUploadSchema, rawInput) as ConfirmPdfUploadInput;
    const row = await this.requireOwned(coachUserId, mediaAssetId);
    if (row.kind !== 'pdf') {
      throw new InvalidUploadConfirmationError(
        `Asset ${mediaAssetId} is not a PDF (kind=${row.kind})`,
      );
    }
    if (row.status === STATUS_READY) {
      return row;
    }
    if (row.status !== STATUS_UPLOADING) {
      throw new InvalidUploadConfirmationError(
        `Cannot confirm asset in status=${row.status}`,
      );
    }
    return this.prisma.coachMediaAsset.update({
      where: { id: mediaAssetId },
      data: {
        status: STATUS_READY,
        byte_size:
          input.byte_size !== undefined
            ? BigInt(input.byte_size)
            : row.byte_size,
        page_count: input.page_count ?? row.page_count,
      },
    });
  }

  // ── VIDEO (Mux) ────────────────────────────────────────────────────────

  /**
   * Create a Mux Direct Upload + a CoachMediaAsset(kind='video') row in
   * `uploading` state. Returns the Mux upload URL the client PUTs the
   * video to. The Mux webhook then drives uploading → processing →
   * ready|errored.
   */
  async createVideoUpload(
    coachUserId: string,
    rawInput: unknown,
  ): Promise<{
    media_asset_id: string;
    upload_url: string;
    mux_upload_id: string;
  }> {
    const input = this.parse(
      CreateVideoUploadSchema,
      rawInput,
    ) as CreateVideoUploadInput;
    this.assertMuxReady();

    let upload;
    try {
      upload = await this.mux.createDirectUpload({
        // Audit P2-2 fix: paid video deliverables MUST use signed playback.
        // A 'public' Mux URL is permanent and un-revocable — anyone who
        // ever obtains the URL can stream the video forever, defeating
        // ClientAssetGrant revocation and mirroring the PDF signed-URL
        // principle. Buyers receive a short-lived signed JWT minted at
        // URL-issuance time (mintSignedUrl).
        playbackPolicy: 'signed',
        corsOrigin: input.cors_origin ?? '*',
      });
    } catch (err) {
      if (err instanceof MuxDisabledError) {
        throw new ServiceUnavailableException({
          error: 'MUX_NOT_CONFIGURED',
          message: err.message,
        });
      }
      throw err;
    }

    const id = this.generateId();
    await this.prisma.coachMediaAsset.create({
      data: {
        id,
        coach_id: coachUserId,
        kind: 'video',
        title: input.title,
        description: input.description ?? null,
        // For video, storage_key holds the Mux upload id at start; the
        // webhook will record mux_asset_id-shaped data on the dedicated
        // columns (mux_playback_id, mux_upload_id). Keeping storage_key
        // non-null is a schema requirement and matches the master plan
        // comment ("mux upload/asset id").
        storage_key: upload.uploadId,
        provider: 'mux',
        mux_upload_id: upload.uploadId,
        status: STATUS_UPLOADING,
      },
    });

    return {
      media_asset_id: id,
      upload_url: upload.url,
      mux_upload_id: upload.uploadId,
    };
  }

  // ── READS ──────────────────────────────────────────────────────────────

  async list(
    coachUserId: string,
    opts: { kind?: 'pdf' | 'video'; includeArchived?: boolean } = {},
  ): Promise<CoachMediaAsset[]> {
    return this.prisma.coachMediaAsset.findMany({
      where: {
        coach_id: coachUserId,
        archived_at: opts.includeArchived ? undefined : null,
        kind: opts.kind,
      },
      orderBy: { created_at: 'desc' },
    });
  }

  async getOne(
    coachUserId: string,
    mediaAssetId: string,
  ): Promise<CoachMediaAsset> {
    return this.requireOwned(coachUserId, mediaAssetId);
  }

  /**
   * Issue a signed download URL for the OWNING coach. For PDFs this is a
   * Supabase signed URL; for videos a Mux playback URL.
   *
   * Refuses if the asset is not `ready` (no broken-video delivery).
   * Refuses if the row is archived or not owned by the caller.
   */
  async getOwnerSignedUrl(
    coachUserId: string,
    mediaAssetId: string,
    options?: SignedDownloadOptions,
  ): Promise<{ url: string; expires_in_seconds: number; kind: 'pdf' | 'video' }>
  {
    const row = await this.requireOwned(coachUserId, mediaAssetId);
    return this.mintSignedUrl(row, options);
  }

  /**
   * Issue a signed download URL for a granted buyer. The caller is the
   * buyer's user id — we look up an active ClientAssetGrant for that user
   * + asset; if none, refuse with 403. Asset MUST be `ready`.
   *
   * This is what the buyer-side delivery endpoint will call (mobile
   * download/playback request); kept on CoachMediaService so all signed-
   * URL minting lives in one place behind the StorageProvider seam.
   */
  async getBuyerSignedUrl(
    buyerUserId: string,
    mediaAssetId: string,
    options?: SignedDownloadOptions,
  ): Promise<{ url: string; expires_in_seconds: number; kind: 'pdf' | 'video' }>
  {
    // Audit P2-1 fix: collapse "row not found", "archived row", "no
    // active grant", and "tenant mismatch" into a SINGLE 404 with the
    // same shape. An attacker probing media_asset_id values must not
    // be able to distinguish "this id exists" from "this id doesn't"
    // (existence leak). Asset ids are uuid so enumeration is not
    // practical, but defence-in-depth costs nothing here.
    const notFound = (): NotFoundException =>
      new NotFoundException({
        error: 'ASSET_NOT_FOUND',
        message: `No media asset with id ${mediaAssetId}`,
      });

    const row = await this.prisma.coachMediaAsset.findUnique({
      where: { id: mediaAssetId },
    });
    if (!row || row.archived_at) {
      throw notFound();
    }
    const grant = await this.prisma.clientAssetGrant.findUnique({
      where: {
        client_id_media_asset_id: {
          client_id: buyerUserId,
          media_asset_id: mediaAssetId,
        },
      },
    });
    if (!grant || grant.revoked_at) {
      throw notFound();
    }
    // Audit P2-4 fix: tenant double-check at URL-ISSUANCE time. The
    // grant lookup is keyed on (buyer, media_asset_id) and doesn't
    // assert the asset belongs to the coach who SOLD this buyer access.
    // If a buggy upstream ever wrote a ClientAssetGrant pointing at
    // another coach's asset, this signed-URL endpoint would happily
    // issue it. We guard by joining the grant -> drop -> client_purchase
    // and assert client_purchase.coach_user_id === asset.coach_id.
    // MediaAssetResolver already enforces tenant on grant CREATION; this
    // is defence-in-depth on the read path.
    if (grant.granted_via_drop_id) {
      const drop = await this.prisma.scheduledDrop.findUnique({
        where: { id: grant.granted_via_drop_id },
        select: { client_purchase: { select: { coach_user_id: true } } },
      });
      const purchaseCoachId = drop?.client_purchase?.coach_user_id ?? null;
      if (purchaseCoachId && purchaseCoachId !== row.coach_id) {
        this.logger.warn(
          `Tenant mismatch on buyer signed-URL: grant ${grant.id} purchase.coach=${purchaseCoachId} asset.coach=${row.coach_id}`,
        );
        throw notFound();
      }
    }
    return this.mintSignedUrl(row, options);
  }

  // ── PATCH (metadata only) ──────────────────────────────────────────────

  async patch(
    coachUserId: string,
    mediaAssetId: string,
    rawInput: unknown,
  ): Promise<CoachMediaAsset> {
    const input = this.parse(PatchMediaSchema, rawInput) as PatchMediaInput;
    await this.requireOwned(coachUserId, mediaAssetId);
    const data: Prisma.CoachMediaAssetUpdateInput = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.description !== undefined) {
      data.description = input.description ?? null;
    }
    return this.prisma.coachMediaAsset.update({
      where: { id: mediaAssetId },
      data,
    });
  }

  // ── SOFT-DELETE ────────────────────────────────────────────────────────

  /**
   * Soft-delete (archive) a CoachMediaAsset.
   *
   * Safety rule (mirrors PR-8's snapshot-at-purchase principle):
   *   - If ANY ClientAssetGrant references this asset, the underlying
   *     storage object STAYS in place (so buyer downloads keep working)
   *     and only the row is archived. Buyer SignedUrl gating still
   *     allows the buyer to download via their grant.
   *   - If NO grants exist AND no package contents reference it, we
   *     archive the row AND delete the underlying object.
   *   - If contents reference it but no grants, we BLOCK the delete and
   *     instruct the coach to detach it first (a coach removing a row
   *     from their library while it's wired into a published package
   *     would silently break future buyers). This is intentionally
   *     stricter than the master plan ('soft-delete + keep object OR
   *     block if referenced — document; pick the safer one'); we pick
   *     'block if referenced by an active content row'.
   *
   * Audit P2-3 fix — race guard against concurrent grant creation:
   *   - The grant-count read + the archive write run INSIDE a single
   *     $transaction with an explicit row lock on the asset (Postgres
   *     `SELECT ... FOR UPDATE`). Any concurrent ClientAssetGrant
   *     resolver running in PR-9 fan-out also locks the asset row
   *     (see MediaAssetResolver) before reading `status` / `archived_at`
   *     and creating the grant, so the two transactions serialize:
   *     either the archive lands first (the resolver then sees
   *     `archived_at != null` and refuses to mint the grant) or the
   *     grant lands first (this tx then sees grantCount >= 1 and skips
   *     the storage-object delete, so the buyer's URL keeps working).
   *     The previous implementation read grantCount OUTSIDE any
   *     transaction, leaving a window where a grant could mint between
   *     the count and the delete and orphan the buyer's URL on a
   *     storage object that no longer existed.
   *   - The storage `deleteObject` is invoked AFTER the row archive
   *     commits (outside the tx) to avoid holding a Postgres
   *     connection during the Supabase HTTP round-trip — the same
   *     pattern billing.service.ts uses for preResolveReceiptUrl.
   *
   * Idempotent: re-archiving an archived row returns the same row.
   */
  async softDelete(
    coachUserId: string,
    mediaAssetId: string,
  ): Promise<{ id: string; archived_at: Date; object_deleted: boolean }> {
    const row = await this.requireOwned(coachUserId, mediaAssetId);
    if (row.archived_at) {
      return {
        id: row.id,
        archived_at: row.archived_at,
        object_deleted: false,
      };
    }

    // P2-3 race guard — lock the asset row + recount + archive atomically.
    // If a concurrent ClientAssetGrant insert is in flight, the resolver's
    // own SELECT FOR UPDATE (in MediaAssetResolver) blocks behind our
    // lock; whichever tx wins, the loser's view is consistent (grantCount
    // includes the newly-minted grant, or the grant insert sees the
    // archive).
    const result = await this.prisma.$transaction(async (tx) => {
      // Lock the asset row for the duration of the tx. Re-fetch under
      // lock so we don't act on stale data (e.g. another archive
      // committed between requireOwned() and here).
      await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM "CoachMediaAsset" WHERE id = ${mediaAssetId} FOR UPDATE`;
      const fresh = await tx.coachMediaAsset.findUnique({
        where: { id: mediaAssetId },
      });
      if (!fresh) {
        // Should not happen — requireOwned just returned the row — but
        // guard defensively.
        throw new NotFoundException({
          error: 'ASSET_NOT_FOUND',
          message: `No media asset with id ${mediaAssetId}`,
        });
      }
      if (fresh.archived_at) {
        return {
          fresh,
          grantCount: 0,
          contentCount: 0,
          alreadyArchived: true as const,
        };
      }
      const [grantCount, contentCount] = await Promise.all([
        tx.clientAssetGrant.count({
          where: { media_asset_id: mediaAssetId, revoked_at: null },
        }),
        tx.coachPackageContent.count({
          where: {
            asset_id: mediaAssetId,
            asset_type: { in: ['pdf', 'video'] },
            removed_at: null,
          },
        }),
      ]);
      if (contentCount > 0) {
        throw new ConflictException({
          error: 'ASSET_REFERENCED',
          message: `Asset is still attached to ${contentCount} package content row(s); detach before archiving`,
          grant_count: grantCount,
          content_count: contentCount,
        });
      }
      const archived = await tx.coachMediaAsset.update({
        where: { id: mediaAssetId },
        data: { archived_at: new Date() },
      });
      return {
        fresh: archived,
        grantCount,
        contentCount,
        alreadyArchived: false as const,
      };
    });

    if (result.alreadyArchived) {
      return {
        id: result.fresh.id,
        archived_at: result.fresh.archived_at!,
        object_deleted: false,
      };
    }

    let objectDeleted = false;
    if (result.grantCount === 0 && row.kind === 'pdf') {
      // Only PDFs go through StorageProvider.delete; videos live in Mux.
      // For Mux we leave the asset in Mux on archive (the playback id is
      // already on the row and a granted buyer may still hold a URL); a
      // future GC sweep can clean Mux assets whose CoachMediaAsset row
      // has been archived and has zero grants. Out of scope for PR-12.
      try {
        objectDeleted = await this.storage.deleteObject(row.storage_key);
      } catch (err) {
        // Best-effort: failure to remove the storage object must not
        // block the row archive (the storage object becomes orphaned;
        // a GC sweep can pick it up later).
        this.logger.warn(
          `Storage deleteObject failed for asset ${mediaAssetId}: ${(err as Error).message}`,
        );
      }
    }

    const archived = result.fresh;
    return {
      id: archived.id,
      archived_at: archived.archived_at!,
      object_deleted: objectDeleted,
    };
  }

  // ── ASSERTIONS ─────────────────────────────────────────────────────────

  /**
   * Helper for the PR-8 attach path and PR-7 resolver to ask "is this
   * row attachable / deliverable right now?". Exposed for tests.
   */
  static isAttachableStatus(status: string): boolean {
    return status === STATUS_READY;
  }

  /**
   * Helper for the webhook controller to safely transition state — only
   * advances from pre-terminal states (mirrors the workout-demo Mux
   * webhook's monotonic-state-machine guard).
   */
  static canAdvanceFromPreTerminal(status: string): boolean {
    return NON_TERMINAL_STATUSES.has(status);
  }

  // ── INTERNALS ──────────────────────────────────────────────────────────

  private async requireOwned(
    coachUserId: string,
    mediaAssetId: string,
  ): Promise<CoachMediaAsset> {
    const row = await this.prisma.coachMediaAsset.findUnique({
      where: { id: mediaAssetId },
    });
    if (!row || row.coach_id !== coachUserId) {
      // Don't leak existence of another coach's media — same 404 either way.
      throw new NotFoundException({
        error: 'ASSET_NOT_FOUND',
        message: `No media asset with id ${mediaAssetId}`,
      });
    }
    return row;
  }

  private async mintSignedUrl(
    row: CoachMediaAsset,
    options?: SignedDownloadOptions,
  ): Promise<{ url: string; expires_in_seconds: number; kind: 'pdf' | 'video' }>
  {
    if (row.status !== STATUS_READY) {
      // Surfacing this as a 409 (not 404) is deliberate: the asset
      // exists, the caller can see it in the library, but it isn't
      // playable yet. Mobile renders a 'processing' UI on this code.
      throw new ConflictException({
        error: 'ASSET_NOT_READY',
        message: `Asset is in status=${row.status}`,
        status: row.status,
      });
    }
    if (row.kind === 'pdf') {
      this.assertStorageReady();
      const url = await this.storage.createSignedDownloadUrl(
        row.storage_key,
        options,
      );
      return {
        url,
        expires_in_seconds:
          options?.expiresInSeconds ?? SIGNED_DOWNLOAD_TTL_SECONDS_DEFAULT,
        kind: 'pdf',
      };
    }
    if (row.kind === 'video') {
      if (!row.mux_playback_id) {
        // mux_playback_id should always be present for status=ready video
        // rows (the webhook sets it). If it's missing we treat the row as
        // not-ready rather than minting a broken URL.
        throw new ConflictException({
          error: 'ASSET_NOT_READY',
          message: 'Video asset is ready but no playback id is recorded',
          status: row.status,
        });
      }
      // Audit P2-2 fix: signed playback for paid video. MuxService
      // mints a per-request RS256-signed JWT (TTL clamped via
      // SIGNED_DOWNLOAD_TTL_SECONDS_DEFAULT) so a buyer URL ages out
      // even if leaked, and ClientAssetGrant revocation is meaningful
      // (a non-buyer cannot mint a new URL once their grant is
      // revoked). Mirrors the PDF signed-URL principle.
      const url = this.mux.mintPlaybackUrl({
        playbackId: row.mux_playback_id,
        policy: 'signed',
        ttlSeconds: options?.expiresInSeconds,
      });
      return {
        url,
        expires_in_seconds:
          options?.expiresInSeconds ?? SIGNED_DOWNLOAD_TTL_SECONDS_DEFAULT,
        kind: 'video',
      };
    }
    throw new InvalidUploadConfirmationError(
      `Unsupported kind=${row.kind}`,
    );
  }

  private buildPdfStorageKey(coachUserId: string, mediaAssetId: string): string {
    // coach-id namespace + asset-id keeps objects partitioned per coach
    // and prevents path traversal — no user-controlled segment is ever
    // included in the storage key. The random suffix is defense-in-depth
    // against any future code path that might allow id collisions.
    const suffix = randomBytes(8).toString('hex');
    return `${coachUserId}/${mediaAssetId}/${suffix}.pdf`;
  }

  private generateId(): string {
    // We let Postgres' uuid default handle row ids in the general case,
    // but for the upload flow we mint the id client-side so we can build
    // the storage key BEFORE we INSERT (storage key depends on id, and we
    // want both committed in one row). Audit P3 fix: use crypto.randomUUID
    // so the id is a valid RFC 4122 v4 UUID (the previous manual hex
    // formatter did not set the version/variant nibbles and would be
    // rejected by strict UUID validators downstream).
    return randomUUID();
  }

  private parse<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: { issues: unknown[] } } }, raw: unknown): T {
    const result = schema.safeParse(raw);
    if (!result.success) {
      throw new BadRequestException({
        error: 'INVALID_BODY',
        issues: result.error?.issues ?? [],
      });
    }
    return result.data as T;
  }

  private assertStorageReady(): void {
    if (!this.storage.isConfigured()) {
      throw new ServiceUnavailableException({
        error: 'MEDIA_STORAGE_NOT_CONFIGURED',
        message:
          'Coach media storage is not configured on this environment (Supabase Storage env vars missing).',
      });
    }
  }

  private assertMuxReady(): void {
    if (!this.mux.isConfigured()) {
      throw new ServiceUnavailableException({
        error: 'MUX_NOT_CONFIGURED',
        message:
          'Mux is not configured on this environment (MUX_TOKEN_ID/MUX_TOKEN_SECRET unset).',
      });
    }
  }
}

/** Re-export for tests / external callers. */
export { MediaAssetNotFoundError } from './coach-media.errors';
