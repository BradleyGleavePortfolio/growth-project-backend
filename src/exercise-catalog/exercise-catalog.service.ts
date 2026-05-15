/**
 * ExerciseCatalogService — owner-curated exercise catalog reads + owner
 * attach/upload writes.
 *
 * Read path (mobile contract — see exercise-catalog.dto.ts):
 *   list(query)        → { items, nextCursor, total }
 *   getByIdOrSlug(key) → ExerciseCatalogDetailDto incl. playbackUrl
 *
 * Owner attach path:
 *   createUpload(itemId)             → Mux Direct Upload (Mux required)
 *   attachAsset(itemId, muxAssetId)  → bind a pre-existing Mux asset
 *
 * No fake URLs: when an item has no `mux_playback_id`, the detail
 * response carries `playbackUrl: null`. When Mux is unconfigured the
 * owner attach + upload endpoints reach into MuxService and throw
 * MuxDisabledError — controllers translate to 503 with
 *   { error: 'mux_disabled', action: '...' }.
 * The plain read endpoints (list + detail) intentionally tolerate Mux
 * being absent: they just return `playbackUrl: null` so the client can
 * still render the catalog while the platform is mid-rollout.
 */

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { MuxService } from '../video/mux.service';
import {
  CreateCatalogItemDto,
  ExerciseCatalogDetailDto,
  ExerciseCatalogItemDto,
  ExerciseCatalogListQueryDto,
  ExerciseCatalogListResponse,
} from './exercise-catalog.dto';

@Injectable()
export class ExerciseCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mux: MuxService,
  ) {}

  // ── reads ────────────────────────────────────────────────────────────────

  async list(query: ExerciseCatalogListQueryDto): Promise<ExerciseCatalogListResponse> {
    const limit = Math.min(query.limit ?? 20, 100);
    const offset = query.cursor ? this.decodeCursor(query.cursor) : 0;

    const where: Prisma.ExerciseCatalogItemWhereInput = {};
    if (query.q) {
      where.name = { contains: query.q, mode: 'insensitive' };
    }
    if (query.category) {
      where.category = { equals: query.category, mode: 'insensitive' };
    }
    if (query.primaryMuscle) {
      where.primary_muscle = { equals: query.primaryMuscle, mode: 'insensitive' };
    }
    if (query.equipment) {
      // Postgres array contains — match if any element equals (case-insensitive)
      // the requested equipment. Prisma's `has` is case-sensitive, so we
      // narrow with a raw lowercase comparison via `hasSome` on a single
      // synthesized value list.
      where.equipment = { hasSome: [query.equipment, query.equipment.toLowerCase()] };
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.exerciseCatalogItem.findMany({
        where,
        orderBy: [{ name: 'asc' }],
        skip: offset,
        take: limit,
      }),
      this.prisma.exerciseCatalogItem.count({ where }),
    ]);

    const items = rows.map((r) => this.toListItemDto(r));
    const nextCursor =
      offset + items.length < total ? this.encodeCursor(offset + limit) : null;
    return { items, nextCursor, total };
  }

  async getByIdOrSlug(
    idOrSlug: string,
    caller?: { userId: string; role: string },
  ): Promise<ExerciseCatalogDetailDto> {
    const row = await this.prisma.exerciseCatalogItem.findFirst({
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
    });
    if (!row) throw new NotFoundException(`Exercise "${idOrSlug}" not found`);
    return this.toDetailDto(row, caller ? await this.canMintForRow(row, caller) : true);
  }

  /**
   * Authorize playback-URL minting for a caller against a catalog row.
   *
   * Doctrine (P0 fix): a signed HLS URL is a transferable bearer token —
   * anyone with the link can stream for ~1h. Mint only when the caller
   * has a product-visible reason for the video:
   *   - owner / coach: always allowed (catalog is the coach surface)
   *   - student (client): only when at least one of their visible workout
   *     assignments references this catalog row, OR the row is `public`
   *     playback policy (public HLS is by definition unauthenticated)
   *
   * Public-policy rows always pass — Mux serves them without a token, so
   * gating here would not add security and would break the marketplace
   * preview flow.
   *
   * Returns false → caller sees playbackUrl: null in the detail payload.
   * No 4xx so the catalog stays browsable.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async canMintForRow(row: any, caller: { userId: string; role: string }): Promise<boolean> {
    if (!row.mux_playback_id || row.mux_asset_status !== 'ready') return false;
    if (row.mux_playback_policy !== 'signed') return true;
    if (caller.role === 'owner' || caller.role === 'coach') return true;
    // Students: require an active workout assignment whose plan references
    // this catalog row via WorkoutPlanExercise.exercise_external_id
    // (which stores either the catalog item id or the slug — both shapes
    // are produced by the workout-builder seed/AI paths).
    try {
      const hit = await this.prisma.clientWorkoutAssignment.findFirst({
        where: {
          client_id: caller.userId,
          workout_plan: {
            exercises: {
              some: {
                exercise_external_id: { in: [row.id, row.slug].filter(Boolean) },
              },
            },
          },
        },
        select: { id: true },
      });
      return !!hit;
    } catch {
      // If the schema relation isn't present (older deploy mid-migration),
      // fail closed — student gets no signed URL until coach assigns it.
      return false;
    }
  }

  // ── owner writes ─────────────────────────────────────────────────────────

  async createItem(dto: CreateCatalogItemDto) {
    return this.prisma.exerciseCatalogItem.create({
      data: {
        slug: dto.slug,
        name: dto.name,
        category: dto.category,
        primary_muscle: dto.primaryMuscle,
        secondary_muscles: dto.secondaryMuscles ?? [],
        equipment: dto.equipment ?? [],
        difficulty: dto.difficulty ?? 'beginner',
        instructions: dto.instructions ?? [],
        source_ref: dto.sourceRef ?? null,
      },
    });
  }

  async createUpload(idOrSlug: string, playbackPolicy: 'public' | 'signed' = 'public', corsOrigin?: string) {
    const row = await this.requireItem(idOrSlug);
    // Reaches into Mux — throws MuxDisabledError if MUX_TOKEN_* are unset.
    const upload = await this.mux.createDirectUpload({ playbackPolicy, corsOrigin });
    const updated = await this.prisma.exerciseCatalogItem.update({
      where: { id: row.id },
      data: {
        mux_upload_id: upload.uploadId,
        mux_asset_status: 'uploading',
        mux_playback_policy: playbackPolicy,
        mux_error_message: null,
      },
    });
    return {
      uploadId: upload.uploadId,
      uploadUrl: upload.url,
      item: this.toListItemDto(updated),
    };
  }

  async attachAsset(idOrSlug: string, muxAssetId: string) {
    const row = await this.requireItem(idOrSlug);
    // Verify the asset exists on Mux before persisting.
    const asset = await this.mux.getAsset(muxAssetId);
    const first = asset.playbackIds[0];
    if (!first && asset.status === 'ready') {
      throw new BadRequestException(
        'Mux asset is ready but has no playback id — recreate it with a playback policy set.',
      );
    }
    const updated = await this.prisma.exerciseCatalogItem.update({
      where: { id: row.id },
      data: {
        mux_asset_id: asset.id,
        mux_playback_id: first?.id ?? null,
        mux_playback_policy: first?.policy ?? 'public',
        mux_asset_status:
          asset.status === 'ready' ? 'ready' : asset.status === 'errored' ? 'errored' : 'processing',
        mux_duration_seconds: asset.duration ?? null,
        mux_error_message:
          asset.status === 'errored'
            ? asset.errors?.messages?.join('; ') ?? asset.errors?.type ?? 'Mux asset error'
            : null,
      },
    });
    return this.toDetailDto(updated);
  }

  async detachAsset(idOrSlug: string) {
    const row = await this.requireItem(idOrSlug);
    const updated = await this.prisma.exerciseCatalogItem.update({
      where: { id: row.id },
      data: {
        mux_asset_id: null,
        mux_playback_id: null,
        mux_asset_status: 'none',
        mux_duration_seconds: null,
        mux_error_message: null,
        mux_upload_id: null,
      },
    });
    return this.toDetailDto(updated);
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /**
   * Public helper used by other modules (workout-builder, etc.) to enrich
   * an exercise row reference with playback data. Returns null when the
   * id/slug doesn't exist in this catalog — caller decides how to render.
   */
  async getPlaybackInfo(idOrSlug: string): Promise<{
    item: ExerciseCatalogItemDto;
    playbackUrl: string | null;
  } | null> {
    const row = await this.prisma.exerciseCatalogItem.findFirst({
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
    });
    if (!row) return null;
    return this.playbackInfoFromRow(row);
  }

  /**
   * Same as getPlaybackInfo() but operates on a row the caller already
   * holds — used by workout-builder.attachPlaybackUrls() to avoid an
   * extra DB round-trip per exercise.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  playbackInfoFromRow(row: any): {
    item: ExerciseCatalogItemDto;
    playbackUrl: string | null;
  } {
    const detail = this.toDetailDto(row);
    return { item: this.toListItemDto(row), playbackUrl: detail.playbackUrl };
  }

  private async requireItem(idOrSlug: string) {
    const row = await this.prisma.exerciseCatalogItem.findFirst({
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
    });
    if (!row) throw new NotFoundException(`Exercise "${idOrSlug}" not found`);
    return row;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toListItemDto(row: any): ExerciseCatalogItemDto {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      category: row.category,
      primaryMuscle: row.primary_muscle,
      secondaryMuscles: row.secondary_muscles ?? [],
      equipment: row.equipment ?? [],
      difficulty: row.difficulty,
      instructions: row.instructions ?? [],
      muxPlaybackId: row.mux_playback_id ?? null,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toDetailDto(row: any, allowPlayback = true): ExerciseCatalogDetailDto {
    const base = this.toListItemDto(row);
    let playbackUrl: string | null = null;
    if (allowPlayback && row.mux_playback_id && row.mux_asset_status === 'ready') {
      try {
        playbackUrl = this.mux.mintPlaybackUrl({
          playbackId: row.mux_playback_id,
          policy: row.mux_playback_policy === 'signed' ? 'signed' : 'public',
        });
      } catch {
        // Signing-key not configured for a signed policy — degrade to null.
        // The mobile contract treats null as "no video yet".
        playbackUrl = null;
      }
    }
    return { ...base, playbackUrl };
  }

  private encodeCursor(offset: number): string {
    return Buffer.from(String(offset)).toString('base64url');
  }

  private decodeCursor(cursor: string): number {
    try {
      const n = parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch {
      return 0;
    }
  }
}
