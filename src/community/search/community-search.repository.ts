import { Injectable } from '@nestjs/common';
import { CommunitySearchKind, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { SEARCH_QUERY_TIMEOUT_MS } from './community-search.dto';

/**
 * v3-4 community-search repository — the ONLY place that talks to the
 * community_search_entries table. Two responsibilities:
 *
 *   1. WRITE (indexer): idempotent upsert of one search row per target, keyed
 *      by the @@unique([workspaceId, kind, targetId]) constraint. Re-indexing
 *      the same target is a no-op-equivalent UPDATE (brief test 7).
 *   2. READ (search): a full-text query over the tsvector GIN index, scoped
 *      DB-side to the caller's visible cohorts + role (brief test 1 RLS), with
 *      `softDeletedAt IS NULL` on EVERY path (brief test 2). The query is
 *      timeout-bounded via a statement_timeout wrapped transaction (brief).
 *
 * The app connects as service_role (BYPASSRLS) — tenancy is enforced HERE in
 * the SQL predicates; the migration's RLS policies are defence-in-depth.
 */
@Injectable()
export class CommunitySearchRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Idempotent index write. The unique key makes a re-index an UPDATE of the
   * excerpt / roles / cohort / soft-delete state, never a duplicate row.
   */
  async upsertEntry(input: {
    workspaceId: string;
    cohortId: string | null;
    kind: CommunitySearchKind;
    targetId: string;
    authorId: string | null;
    excerpt: string;
    visibleToRoles: string[];
    softDeletedAt: Date | null;
  }): Promise<{ id: string; created: boolean }> {
    // Detect create-vs-update so the indexer can fire the right telemetry and
    // tests can assert idempotency without a second DB round-trip.
    const existing = await this.prisma.communitySearchEntry.findUnique({
      where: {
        workspaceId_kind_targetId: {
          workspaceId: input.workspaceId,
          kind: input.kind,
          targetId: input.targetId,
        },
      },
      select: { id: true },
    });

    const row = await this.prisma.communitySearchEntry.upsert({
      where: {
        workspaceId_kind_targetId: {
          workspaceId: input.workspaceId,
          kind: input.kind,
          targetId: input.targetId,
        },
      },
      create: {
        workspaceId: input.workspaceId,
        cohortId: input.cohortId,
        kind: input.kind,
        targetId: input.targetId,
        authorId: input.authorId,
        excerpt: input.excerpt,
        visibleToRoles: input.visibleToRoles,
        softDeletedAt: input.softDeletedAt,
      },
      update: {
        cohortId: input.cohortId,
        authorId: input.authorId,
        excerpt: input.excerpt,
        visibleToRoles: input.visibleToRoles,
        softDeletedAt: input.softDeletedAt,
      },
      select: { id: true },
    });

    return { id: row.id, created: existing === null };
  }

  /** Mark a target's search row soft-deleted (search must not return it). */
  async softDeleteEntry(
    workspaceId: string,
    kind: CommunitySearchKind,
    targetId: string,
    at: Date,
  ): Promise<void> {
    await this.prisma.communitySearchEntry.updateMany({
      where: { workspaceId, kind, targetId },
      data: { softDeletedAt: at },
    });
  }

  /**
   * Full-text search. ALL of: workspace scope, role allowlist (`role = ANY
   * visible_to_roles`), cohort visibility (row.cohort_id IS NULL = workspace
   * hall, visible to any workspace member; else the cohort must be in
   * `accessibleCohortIds`), soft-delete filter, optional kind filter, and a
   * keyset cursor are pushed DB-side. The match uses websearch_to_tsquery so a
   * user term can never inject tsquery operators.
   *
   * Ranking: ts_rank desc, then createdAt desc, then id desc (stable cursor).
   */
  async search(params: {
    workspaceId: string;
    role: string;
    isCoach: boolean;
    accessibleCohortIds: string[];
    term: string;
    kind?: CommunitySearchKind;
    cohortId?: string;
    limit: number;
    cursor?: { rank: number; createdAt: Date; id: string };
  }): Promise<
    Array<{
      id: string;
      kind: CommunitySearchKind;
      target_id: string;
      cohort_id: string | null;
      author_id: string | null;
      excerpt: string;
      created_at: Date;
      rank: number;
    }>
  > {
    const {
      workspaceId,
      role,
      isCoach,
      accessibleCohortIds,
      term,
      kind,
      cohortId,
      limit,
    } = params;

    // A coach who owns the workspace sees every cohort; a member sees the hall
    // (cohort_id IS NULL) plus only their accessible cohorts.
    const cohortVisibility = isCoach
      ? Prisma.sql`TRUE`
      : Prisma.sql`(
          "cohortId" IS NULL
          OR "cohortId" = ANY(${accessibleCohortIds}::uuid[])
        )`;

    const kindFilter = kind
      ? Prisma.sql`AND "kind" = ${kind}::"CommunitySearchKind"`
      : Prisma.empty;

    const cohortFilter = cohortId
      ? Prisma.sql`AND "cohortId" = ${cohortId}::uuid`
      : Prisma.empty;

    // Keyset cursor: (rank, createdAt, id) strictly after the previous page.
    const cursorFilter = params.cursor
      ? Prisma.sql`AND (
          ts_rank(search_tsv, websearch_to_tsquery('english', ${term})),
          "createdAt",
          "id"
        ) < (
          ${params.cursor.rank}::real,
          ${params.cursor.createdAt}::timestamptz,
          ${params.cursor.id}
        )`
      : Prisma.empty;

    const rows = await this.prisma.$transaction(
      async (tx) => {
        // Bound the statement so a pathological query cannot exceed the budget
        // (brief: AbortSignal.timeout(5000) equivalent, enforced server-side).
        await tx.$executeRawUnsafe(
          `SET LOCAL statement_timeout = ${SEARCH_QUERY_TIMEOUT_MS}`,
        );
        return tx.$queryRaw<
          Array<{
            id: string;
            kind: CommunitySearchKind;
            target_id: string;
            cohort_id: string | null;
            author_id: string | null;
            excerpt: string;
            created_at: Date;
            rank: number;
          }>
        >(Prisma.sql`
          SELECT
            "id",
            "kind",
            "targetId"  AS target_id,
            "cohortId"  AS cohort_id,
            "authorId"  AS author_id,
            "excerpt",
            "createdAt" AS created_at,
            ts_rank(search_tsv, websearch_to_tsquery('english', ${term})) AS rank
          FROM "community_search_entries"
          WHERE "workspaceId" = ${workspaceId}::uuid
            AND "softDeletedAt" IS NULL
            AND ${role} = ANY("visibleToRoles")
            AND ${cohortVisibility}
            AND search_tsv @@ websearch_to_tsquery('english', ${term})
            ${kindFilter}
            ${cohortFilter}
            ${cursorFilter}
          ORDER BY rank DESC, "createdAt" DESC, "id" DESC
          LIMIT ${limit}
        `);
      },
      { timeout: SEARCH_QUERY_TIMEOUT_MS + 1_000 },
    );

    return rows;
  }
}
