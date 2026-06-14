import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import type {
  CommunityClassroomMediaAsset,
  CommunityClassroomPost,
  User,
} from '@prisma/client';
import { CommunityAccessService } from '../community-access.service';
import {
  STORAGE_PROVIDER,
  StorageNotConfiguredError,
  type StorageProvider,
} from '../../coach-media/storage-provider';
import {
  CommunityClassroomRepository,
  type ClassroomMediaSeed,
  type ClassroomPostWithMedia,
} from './community-classroom.repository';
import {
  isReleaseLocked,
  isStudentVisible,
  statusForPublish,
} from './community-classroom-release.feature';
import {
  CLASSROOM_MEDIA_MAX_BYTES,
  ClassroomFeedResponse,
  ClassroomFeedResponseSchema,
  type ClassroomMediaInputDto,
  type ClassroomMediaKind,
  ClassroomMediaView,
  ClassroomPostResponse,
  ClassroomPostResponseSchema,
  ClassroomPostView,
  type ClassroomUploadTarget,
} from './community-classroom.dto';

const NOT_FOUND = {
  error: 'not_found',
  code: 'community.classroom.not_found',
} as const;

/** Default signed-URL TTL when MEDIA_SIGNED_URL_TTL_SEC is unset (brief: 900s). */
const DEFAULT_SIGNED_URL_TTL_SEC = 900;
const MIN_SIGNED_URL_TTL_SEC = 60;
const MAX_SIGNED_URL_TTL_SEC = 60 * 60 * 24;

/**
 * Community classroom posts: coach-authored, media-backed lessons (v3-2).
 *
 * TENANCY (v1-2 / v3-1 doctrine): the app runs as service_role (BYPASSRLS), so
 * a non-member read resolves to 404 (never leaking existence) and an
 * unauthorised write resolves to 403. Cohort-scoped lessons are visible only to
 * that cohort's active members; the migration's RLS policies are
 * defence-in-depth for any non-service-role connection.
 *
 * MEDIA SIGNING: object access is ALWAYS a time-limited signed URL minted at
 * read time through the @Global coach-media StorageProvider — never a public or
 * permanent URL (paid content). The storage key embeds the workspace id so a
 * key minted for one workspace cannot be replayed against another bucket path;
 * the per-kind size cap is enforced BEFORE a signed upload URL is issued so we
 * never hand out a URL for an upload the bucket policy would reject.
 *
 * RELEASE LOCK: visibility is decided by the pure release.feature module
 * (isStudentVisible / isReleaseLocked), the SAME predicate the repository feed
 * filter and the RLS member-select policy use, so the three never drift.
 */
@Injectable()
export class CommunityClassroomService {
  private readonly logger = new Logger(CommunityClassroomService.name);

  constructor(
    private readonly access: CommunityAccessService,
    private readonly repo: CommunityClassroomRepository,
    private readonly config: ConfigService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  // ── Config ───────────────────────────────────────────────────────────────

  /**
   * Configurable signed-URL TTL (brief: MEDIA_SIGNED_URL_TTL_SEC, default 900).
   * Clamped to [60s, 24h] so a misconfigured env can neither issue a 0-second
   * (instantly-dead) URL nor an effectively-permanent one.
   */
  private signedUrlTtlSeconds(): number {
    const raw = this.config.get<string>('MEDIA_SIGNED_URL_TTL_SEC');
    const parsed = raw === undefined ? NaN : Number(raw);
    const ttl = Number.isFinite(parsed) ? Math.trunc(parsed) : DEFAULT_SIGNED_URL_TTL_SEC;
    return Math.max(MIN_SIGNED_URL_TTL_SEC, Math.min(MAX_SIGNED_URL_TTL_SEC, ttl));
  }

  // ── Views ────────────────────────────────────────────────────────────────

  /**
   * Build a media view, minting a time-limited signed download URL for the
   * object. If storage is not configured (test/CI without Supabase) the URL is
   * null and the client renders a disabled tile rather than a broken link — the
   * lesson metadata is still returned. Signing failures are isolated per asset
   * so one bad key never blanks an entire feed.
   */
  private async mediaView(
    asset: CommunityClassroomMediaAsset,
  ): Promise<ClassroomMediaView> {
    let url: string | null = null;
    if (this.storage.isConfigured()) {
      try {
        url = await this.storage.createSignedDownloadUrl(asset.storage_key, {
          expiresInSeconds: this.signedUrlTtlSeconds(),
        });
      } catch (err: unknown) {
        // A signing failure for one asset must not blank the whole feed. We log
        // and surface url=null (disabled tile) rather than swallowing silently:
        // the lesson row, and every sibling asset, still render.
        const message = err instanceof Error ? err.message : 'unknown';
        this.logger.warn(
          `classroom media sign failed: asset=${asset.id} kind=${asset.kind}: ${message}`,
        );
        url = null;
      }
    }
    return {
      id: asset.id,
      post_id: asset.post_id,
      kind: asset.kind as ClassroomMediaKind,
      url,
      duration_sec: asset.duration_sec,
      bytes: asset.bytes === null ? null : Number(asset.bytes),
      mime_type: asset.mime_type,
      width: asset.width,
      height: asset.height,
      created_at: asset.created_at.toISOString(),
    };
  }

  private async postView(
    post: ClassroomPostWithMedia,
    now: Date,
  ): Promise<ClassroomPostView> {
    const media = await Promise.all(
      post.media_assets.map((a) => this.mediaView(a)),
    );
    return {
      id: post.id,
      workspace_id: post.workspace_id,
      cohort_id: post.cohort_id,
      coach_id: post.coach_id,
      title: post.title,
      body_markdown: post.body_markdown,
      status: post.status,
      pinned: post.pinned,
      pinned_order: post.pinned_order,
      release_at: post.release_at?.toISOString() ?? null,
      release_locked: isReleaseLocked(post.status, post.release_at, now),
      published_at: post.published_at?.toISOString() ?? null,
      created_at: post.created_at.toISOString(),
      updated_at: post.updated_at.toISOString(),
      media,
    };
  }

  // ── Authorization helpers ──────────────────────────────────────────────────

  private async assertCoach(workspaceId: string, user: User): Promise<void> {
    if (user.role === 'owner') return;
    if (await this.access.isWorkspaceCoach(workspaceId, user.id)) return;
    throw new ForbiddenException({
      error: 'forbidden',
      code: 'community.classroom.not_coach',
    });
  }

  /** True when the caller is the workspace coach or platform owner. */
  private async isCoach(workspaceId: string, user: User): Promise<boolean> {
    return (
      user.role === 'owner' ||
      (await this.access.isWorkspaceCoach(workspaceId, user.id))
    );
  }

  /**
   * Resolve a lesson the caller may READ, or throw 404. A coach/owner reads any
   * non-deleted lesson in their workspace; a student reads only a published,
   * released lesson in a cohort/workspace they belong to. Cross-tenant or
   * release-locked access resolves to 404 so a lesson's existence never leaks.
   */
  private async readablePost(
    user: User,
    postId: string,
    now: Date,
  ): Promise<ClassroomPostWithMedia> {
    const post = await this.repo.findPostById(postId);
    if (!post || post.soft_deleted_at !== null) {
      throw new NotFoundException(NOT_FOUND);
    }
    const coach = await this.isCoach(post.workspace_id, user);
    if (coach) return post;

    // Student path: must be a member of the lesson's scope AND the lesson must
    // be student-visible (published + released). Either failure → identical 404.
    const visible = isStudentVisible(
      {
        status: post.status,
        releaseAt: post.release_at,
        softDeletedAt: post.soft_deleted_at,
      },
      now,
    );
    if (!visible) throw new NotFoundException(NOT_FOUND);

    if (post.cohort_id) {
      const cohort = await this.access.findCohort(post.cohort_id);
      if (!cohort || !(await this.access.canAccessCohort(cohort, user))) {
        throw new NotFoundException(NOT_FOUND);
      }
    } else if (!(await this.access.canAccessWorkspace(post.workspace_id, user))) {
      throw new NotFoundException(NOT_FOUND);
    }
    return post;
  }

  // ── Media seeding (size-cap + signed upload) ──────────────────────────────

  /**
   * Validate declared media against per-kind caps, then build a storage key for
   * each. The key embeds the workspace id and a random component (no path
   * traversal, no cross-workspace replay) so a signed URL minted for this upload
   * is intrinsically scoped to this workspace + lesson. Oversized declarations
   * are rejected BEFORE any URL is minted.
   */
  private buildMediaSeeds(
    workspaceId: string,
    postId: string,
    media: ClassroomMediaInputDto[],
  ): ClassroomMediaSeed[] {
    return media.map((m) => {
      const cap = CLASSROOM_MEDIA_MAX_BYTES[m.kind];
      if (m.bytes > cap) {
        throw new BadRequestException({
          error: 'bad_request',
          code: 'community.classroom.media_too_large',
          kind: m.kind,
          max_bytes: cap,
        });
      }
      // workspace/post/kind/random — the workspace prefix is what binds a signed
      // URL to this tenant; randomUUID prevents key guessing / collision.
      const storageKey = `community-classroom/${workspaceId}/${postId}/${m.kind}/${randomUUID()}`;
      return {
        kind: m.kind,
        storageKey,
        bytes: m.bytes,
        mimeType: m.mime_type ?? null,
        durationSec: m.duration_sec ?? null,
        width: m.width ?? null,
        height: m.height ?? null,
      };
    });
  }

  /**
   * Mint a signed upload URL for each persisted media asset. Storage-not-
   * configured is a clean 503 (BadGateway-style) surfaced to the coach, never a
   * 500: a deploy without Supabase storage cannot author media but the rest of
   * the API stays up.
   */
  private async buildUploadTargets(
    assets: CommunityClassroomMediaAsset[],
  ): Promise<ClassroomUploadTarget[]> {
    if (assets.length === 0) return [];
    if (!this.storage.isConfigured()) {
      throw new BadRequestException({
        error: 'bad_request',
        code: 'community.classroom.storage_not_configured',
      });
    }
    const ttl = this.signedUrlTtlSeconds();
    const targets: ClassroomUploadTarget[] = [];
    for (const asset of assets) {
      try {
        const signed = await this.storage.createSignedUploadUrl({
          storageKey: asset.storage_key,
          contentType: asset.mime_type ?? undefined,
        });
        targets.push({
          media_id: asset.id,
          kind: asset.kind as ClassroomMediaKind,
          upload_url: signed.signedUrl,
          storage_key: asset.storage_key,
          expires_in_seconds: ttl,
        });
      } catch (err: unknown) {
        if (err instanceof StorageNotConfiguredError) {
          throw new BadRequestException({
            error: 'bad_request',
            code: 'community.classroom.storage_not_configured',
          });
        }
        throw err;
      }
    }
    return targets;
  }

  // ── Coach CRUD ──────────────────────────────────────────────────────────────

  async create(
    user: User,
    workspaceId: string,
    input: {
      title: string;
      body_markdown: string;
      cohort_id?: string;
      release_at?: string;
      pinned?: boolean;
      pinned_order?: number;
      media?: ClassroomMediaInputDto[];
    },
  ): Promise<ClassroomPostResponse> {
    const now = new Date();
    const workspace = await this.access.findWorkspace(workspaceId);
    if (!workspace || !(await this.access.canAccessWorkspace(workspaceId, user))) {
      throw new NotFoundException(NOT_FOUND);
    }
    await this.assertCoach(workspaceId, user);

    let cohortId: string | null = null;
    if (input.cohort_id) {
      const cohort = await this.access.findCohort(input.cohort_id);
      if (!cohort || cohort.workspace_id !== workspaceId) {
        throw new NotFoundException(NOT_FOUND);
      }
      cohortId = cohort.id;
    }

    const releaseAt = this.parseDate(input.release_at);
    // A lesson is created as a DRAFT; the coach publishes explicitly. Media is
    // declared at create so the post + its asset rows are one atomic write.
    const seeds =
      input.media && input.media.length > 0
        ? this.buildMediaSeeds(workspaceId, randomUUID(), input.media)
        : [];

    const created = await this.repo.createPostWithMedia({
      workspaceId,
      cohortId,
      coachId: user.id,
      title: input.title,
      bodyMarkdown: input.body_markdown,
      status: 'draft',
      pinned: input.pinned ?? false,
      pinnedOrder: input.pinned_order ?? null,
      releaseAt,
      publishedAt: null,
      media: seeds,
    });

    const uploadTargets = await this.buildUploadTargets(created.media_assets);
    return ClassroomPostResponseSchema.parse({
      post: await this.postView(created, now),
      upload_targets: uploadTargets,
    });
  }

  async update(
    user: User,
    postId: string,
    input: {
      title?: string;
      body_markdown?: string;
      release_at?: string;
      pinned?: boolean;
      pinned_order?: number;
    },
  ): Promise<ClassroomPostResponse> {
    const now = new Date();
    const post = await this.coachOwnedPost(user, postId);

    const updated = await this.repo.updatePost(postId, {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.body_markdown !== undefined
        ? { body_markdown: input.body_markdown }
        : {}),
      ...(input.release_at !== undefined
        ? { release_at: this.parseDate(input.release_at) }
        : {}),
      ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
      ...(input.pinned_order !== undefined
        ? { pinned_order: input.pinned_order }
        : {}),
    });
    void post;
    return ClassroomPostResponseSchema.parse({
      post: await this.postView(updated, now),
      upload_targets: [],
    });
  }

  /**
   * Publish a lesson. The persisted status is decided by statusForPublish: a
   * future release_at yields `scheduled` (release-locked, invisible to students
   * until then); otherwise `published` (immediately visible). published_at is
   * stamped once, on the first publish, so the feed's published_at DESC ordering
   * is stable across re-publishes.
   */
  async publish(
    user: User,
    postId: string,
    input: { release_at?: string },
  ): Promise<ClassroomPostResponse> {
    const now = new Date();
    const post = await this.coachOwnedPost(user, postId);

    const releaseAt =
      input.release_at !== undefined
        ? this.parseDate(input.release_at)
        : post.release_at;
    const status = statusForPublish(releaseAt, now);

    const updated = await this.repo.updatePost(postId, {
      status,
      release_at: releaseAt,
      // Stamp published_at once so ordering is stable across re-publishes.
      published_at: post.published_at ?? now,
    });
    return ClassroomPostResponseSchema.parse({
      post: await this.postView(updated, now),
      upload_targets: [],
    });
  }

  async archive(user: User, postId: string): Promise<{ archived: true }> {
    await this.coachOwnedPost(user, postId);
    await this.repo.softDeletePost(postId, new Date());
    return { archived: true };
  }

  /**
   * Attach more media to an owned lesson, returning fresh signed upload URLs.
   * Size caps enforced before any URL is minted (same as create).
   */
  async attachMedia(
    user: User,
    postId: string,
    media: ClassroomMediaInputDto[],
  ): Promise<ClassroomPostResponse> {
    const now = new Date();
    const post = await this.coachOwnedPost(user, postId);
    if (media.length === 0) {
      throw new BadRequestException({
        error: 'bad_request',
        code: 'community.classroom.no_media',
      });
    }
    const seeds = this.buildMediaSeeds(post.workspace_id, post.id, media);
    const assets = await this.repo.attachMedia({
      postId: post.id,
      workspaceId: post.workspace_id,
      media: seeds,
    });
    const uploadTargets = await this.buildUploadTargets(assets);
    const refreshed = await this.repo.findPostById(postId);
    if (!refreshed) throw new NotFoundException(NOT_FOUND);
    return ClassroomPostResponseSchema.parse({
      post: await this.postView(refreshed, now),
      upload_targets: uploadTargets,
    });
  }

  /**
   * Resolve a lesson the caller OWNS as coach (or platform owner), or throw. A
   * non-coach who can otherwise read the lesson still gets 403 here; a lesson in
   * another tenant resolves to 404 (existence never leaks).
   */
  private async coachOwnedPost(
    user: User,
    postId: string,
  ): Promise<ClassroomPostWithMedia> {
    const post = await this.repo.findPostById(postId);
    if (!post || post.soft_deleted_at !== null) {
      throw new NotFoundException(NOT_FOUND);
    }
    if (!(await this.isCoach(post.workspace_id, user))) {
      // A member who is not the coach should not even learn the lesson exists
      // through this write path, so a non-published lesson is a 404 and a
      // visible-but-not-owned one is a 403.
      const visible = isStudentVisible(
        {
          status: post.status,
          releaseAt: post.release_at,
          softDeletedAt: post.soft_deleted_at,
        },
        new Date(),
      );
      if (!visible) throw new NotFoundException(NOT_FOUND);
      throw new ForbiddenException({
        error: 'forbidden',
        code: 'community.classroom.not_coach',
      });
    }
    return post;
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async getOne(user: User, postId: string): Promise<ClassroomPostResponse> {
    const now = new Date();
    const post = await this.readablePost(user, postId, now);
    return ClassroomPostResponseSchema.parse({
      post: await this.postView(post, now),
      upload_targets: [],
    });
  }

  /**
   * The classroom feed. A coach/owner sees every non-deleted lesson (drafts +
   * scheduled + published) in the workspace/cohort; a student sees only
   * published, released lessons in scopes they belong to. Visibility is pushed
   * INTO the repository query so the page and its cursor are consistent.
   */
  async listFeed(
    user: User,
    workspaceId: string,
    query: { cohort_id?: string; limit?: number; cursor?: string },
  ): Promise<ClassroomFeedResponse> {
    const now = new Date();
    const workspace = await this.access.findWorkspace(workspaceId);
    if (!workspace || !(await this.access.canAccessWorkspace(workspaceId, user))) {
      throw new NotFoundException(NOT_FOUND);
    }

    let cohortFilter: string | null = null;
    if (query.cohort_id) {
      const cohort = await this.access.findCohort(query.cohort_id);
      if (
        !cohort ||
        cohort.workspace_id !== workspaceId ||
        !(await this.access.canAccessCohort(cohort, user))
      ) {
        throw new NotFoundException(NOT_FOUND);
      }
      cohortFilter = cohort.id;
    }

    const page = (await this.isCoach(workspaceId, user))
      ? await this.repo.listForCoach({
          workspaceId,
          cohortId: cohortFilter,
          limit: query.limit,
          cursor: query.cursor,
        })
      : await this.repo.listForStudent({
          workspaceId,
          visibleCohortIds: await this.access.listAccessibleCohortIds(
            workspaceId,
            user.id,
          ),
          cohortFilter,
          now,
          limit: query.limit,
          cursor: query.cursor,
        });

    const posts = await Promise.all(
      page.items.map((p) => this.postView(p, now)),
    );
    return ClassroomFeedResponseSchema.parse({
      posts,
      next_cursor: page.nextCursor,
    });
  }

  // ── Parsing helpers ──────────────────────────────────────────────────────────

  private parseDate(value: string | undefined): Date | null {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
}

// Re-export so the controller's @ApiTags grouping and tests can reference the
// post type without importing Prisma directly.
export type { CommunityClassroomPost };
