import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { CoachExercise, User } from '@prisma/client';
import {
  COACH_EXERCISE_MIME_ALLOWLIST,
  CoachExerciseListResponseSchema,
  type CoachExerciseListResponse,
  type CoachExerciseMediaKind,
  type CoachExerciseResponse,
  CoachExerciseResponseSchema,
  type CoachExerciseView,
  CreateCoachExerciseDto,
  IssueMediaUploadDto,
  MAX_MEDIA_BYTES,
  type MediaUploadTarget,
  MediaUploadTargetSchema,
} from './coach-exercise.dto';
import {
  CoachExerciseRepository,
  type CoachExerciseSeed,
} from './coach-exercise.repository';
import { CoachExerciseUploadProvider } from './coach-exercise-upload.provider';

/**
 * Coach custom-exercise library (FEATURE_CUSTOM_EXERCISE, default OFF).
 *
 * A coach authors a brand-new move NOT in the fixed catalog: a free-text name,
 * written instructions, and an optional image/video they upload. The row is the
 * durable, reusable, coach-OWNED library entry.
 *
 * TENANCY (repo doctrine): the app runs as service_role (BYPASSRLS), so every
 * read/write is scoped to coach_id in the repository; the migration's
 * coach_exercises_owner_all policy is defence-in-depth. Only coaches/owners
 * reach these routes (the controller's @Roles + flag guards), and the library
 * is the caller's own — coach_id is taken from the authenticated user, never the
 * body, so one coach can never author into or read another's library.
 *
 * PRESIGN → DIRECT PUT → DURABLE CREATE (mirrors community voice notes): the
 * client first calls media/upload-url to get a signed PUT URL + storage key,
 * uploads the bytes to Supabase Storage, THEN calls create() to durably record
 * the row. The row is only written on that second call — never speculatively at
 * URL-issue time.
 *
 * BUCKET BINDING: the storage key is minted SERVER-SIDE, namespaced by the coach
 * id, and on create() the service re-asserts the `${coachId}/` prefix so a
 * client cannot persist a key for another principal's path.
 */
@Injectable()
export class CoachExerciseService {
  constructor(
    private readonly repo: CoachExerciseRepository,
    private readonly upload: CoachExerciseUploadProvider,
  ) {}

  // ── Config ─────────────────────────────────────────────────────────────────

  private maxBytes(): number {
    const raw = parseInt(process.env.COACH_EXERCISE_MAX_BYTES ?? '', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : MAX_MEDIA_BYTES;
  }

  // ── Validation ───────────────────────────────────────────────────────────────

  /**
   * Re-validate mime + size against the server limits. The DTO already enforces
   * these, but the service is the authoritative gate so an internal caller can
   * never bypass them. MIME is checked against the exact allowlist —
   * declared-type spoofing past the allowlist is rejected here before any
   * storage interaction.
   */
  private assertMediaWithinLimits(input: {
    bytes: number;
    mime_type: string;
  }): void {
    if (
      !(COACH_EXERCISE_MIME_ALLOWLIST as readonly string[]).includes(
        input.mime_type,
      )
    ) {
      throw new BadRequestException({
        error: 'bad_request',
        code: 'coach_exercise.mime_rejected',
        allowed: [...COACH_EXERCISE_MIME_ALLOWLIST],
      });
    }
    const maxBytes = this.maxBytes();
    if (input.bytes <= 0 || input.bytes > maxBytes) {
      throw new BadRequestException({
        error: 'bad_request',
        code: 'coach_exercise.size_out_of_range',
        max_bytes: maxBytes,
      });
    }
  }

  /**
   * Coaches and owners author the library; a student must never reach the write
   * surface. The controller's @Roles gates this too, but the service re-asserts
   * so an internal caller can never bypass the role check.
   */
  private assertCoach(user: User): void {
    if (user.role !== 'coach' && user.role !== 'owner') {
      throw new ForbiddenException({
        error: 'forbidden',
        code: 'coach_exercise.coach_only',
      });
    }
  }

  // ── Views ──────────────────────────────────────────────────────────────────

  private async view(row: CoachExercise): Promise<CoachExerciseView> {
    const mediaUrl =
      row.media_kind === 'none' || !row.storage_key
        ? null
        : await this.upload.createSignedDownload(row.storage_key);
    return {
      id: row.id,
      coach_id: row.coach_id,
      name: row.name,
      instructions: row.instructions,
      media_kind: row.media_kind as CoachExerciseMediaKind,
      media_url: mediaUrl,
      media_mime: row.media_mime,
      created_at: row.created_at.toISOString(),
      archived_at: row.archived_at ? row.archived_at.toISOString() : null,
    };
  }

  // ── Upload URL issuance ──────────────────────────────────────────────────────

  /**
   * Presign a media upload URL. Validates mime + size BEFORE minting the URL (no
   * URL for a payload we'd reject), then returns the server-minted storage key
   * the client echoes back on create(). The bucket name is server-authoritative
   * and returned for assertion, never trusted from the client.
   */
  async issueUploadUrl(
    user: User,
    dto: IssueMediaUploadDto,
  ): Promise<MediaUploadTarget> {
    this.assertCoach(user);
    this.assertMediaWithinLimits(dto);

    const signed = await this.upload.createSignedUpload(user.id, {
      size_bytes: dto.bytes,
      content_type: dto.mime_type,
    });
    const storageKey = this.upload.deriveStorageKey(signed.public_url, user.id);

    return MediaUploadTargetSchema.parse({
      upload_url: signed.upload_url,
      storage_key: storageKey,
      expires_at: signed.expires_at,
      expires_in_seconds: this.upload.ttlSeconds(),
      bucket: this.upload.bucket(),
    });
  }

  // ── Create (durable insert after upload confirmed) ───────────────────────────

  async create(
    user: User,
    dto: CreateCoachExerciseDto,
  ): Promise<CoachExerciseResponse> {
    this.assertCoach(user);

    let storageKey: string | null = null;
    let mediaMime: string | null = null;
    if (dto.media_kind !== 'none') {
      // media_kind image/video requires a confirmed upload. ValidateIf in the
      // DTO already requires both fields, but we re-assert so an internal caller
      // can never persist a media row without its key.
      if (!dto.storage_key || !dto.media_mime) {
        throw new BadRequestException({
          error: 'bad_request',
          code: 'coach_exercise.media_required',
        });
      }
      this.assertMediaWithinLimits({ bytes: 1, mime_type: dto.media_mime });
      this.assertMediaKindMatchesMime(dto.media_kind, dto.media_mime);
      // Bucket binding: the storage key MUST live in the caller's namespace. A
      // forged key for another principal's path is rejected.
      if (!dto.storage_key.startsWith(`${user.id}/`)) {
        throw new BadRequestException({
          error: 'bad_request',
          code: 'coach_exercise.storage_key_rejected',
        });
      }
      storageKey = dto.storage_key;
      mediaMime = dto.media_mime;
    }

    const seed: CoachExerciseSeed = {
      coachId: user.id,
      name: dto.name,
      instructions: dto.instructions,
      mediaKind: dto.media_kind,
      storageKey,
      mediaMime,
    };
    const row = await this.repo.create(seed);
    return CoachExerciseResponseSchema.parse({
      coach_exercise: await this.view(row),
    });
  }

  /**
   * Reject a media_kind/mime mismatch (e.g. media_kind='image' with a video
   * mime). image/* must pair with media_kind='image'; video/* with 'video'.
   */
  private assertMediaKindMatchesMime(
    kind: CoachExerciseMediaKind,
    mime: string,
  ): void {
    const expected = mime.startsWith('image/') ? 'image' : 'video';
    if (kind !== expected) {
      throw new BadRequestException({
        error: 'bad_request',
        code: 'coach_exercise.media_kind_mismatch',
      });
    }
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  async list(user: User): Promise<CoachExerciseListResponse> {
    this.assertCoach(user);
    const rows = await this.repo.listForCoach(user.id);
    const coachExercises = await Promise.all(rows.map((row) => this.view(row)));
    return CoachExerciseListResponseSchema.parse({
      coach_exercises: coachExercises,
    });
  }
}
