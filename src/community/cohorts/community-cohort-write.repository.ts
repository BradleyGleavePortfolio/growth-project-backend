import { Injectable } from '@nestjs/common';
import type { CommunityCohort } from '@prisma/client';
import { PrismaService } from '../../prisma.service';

/**
 * Data access for cohort write operations (create / update / archive).
 *
 * Tenant scoping follows the v1-2 doctrine (community.repository.ts): the app
 * connects as the Supabase service_role (BYPASSRLS), so isolation is enforced
 * at the SERVICE layer via CommunityAccessService (workspace-coach checks),
 * never assumed from Postgres RLS. The methods below take an already-authorised
 * workspace/cohort id; they perform no auth of their own. Postgres RLS
 * (community_cohorts_coach_all, community_memberships_coach_all) remains as
 * defence-in-depth for any non-service-role connection.
 */
export interface CreateCohortInput {
  workspaceId: string;
  name: string;
  description: string | null;
  capacity: number | null;
  startsAt: Date | null;
  endsAt: Date | null;
}

export interface UpdateCohortInput {
  name?: string;
  description?: string | null;
  capacity?: number | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  status?: 'draft' | 'active' | 'archived';
}

@Injectable()
export class CommunityCohortWriteRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Next sort_order for a workspace's cohorts: append after the current max so
   * a new cohort sorts last in the coach's list. A workspace with no cohorts
   * yet starts at 0.
   */
  private async nextSortOrder(workspaceId: string): Promise<number> {
    const top = await this.prisma.communityCohort.findFirst({
      where: { workspace_id: workspaceId },
      orderBy: { sort_order: 'desc' },
      select: { sort_order: true },
    });
    return top ? top.sort_order + 1 : 0;
  }

  async create(input: CreateCohortInput): Promise<CommunityCohort> {
    return this.prisma.communityCohort.create({
      data: {
        workspace_id: input.workspaceId,
        name: input.name,
        description: input.description,
        capacity: input.capacity,
        starts_at: input.startsAt,
        ends_at: input.endsAt,
        status: 'active',
        sort_order: await this.nextSortOrder(input.workspaceId),
      },
    });
  }

  async findById(cohortId: string): Promise<CommunityCohort | null> {
    return this.prisma.communityCohort.findUnique({ where: { id: cohortId } });
  }

  /** True when another cohort in the same workspace already uses `name`. */
  async nameTakenInWorkspace(
    workspaceId: string,
    name: string,
    excludeCohortId: string | null,
  ): Promise<boolean> {
    const existing = await this.prisma.communityCohort.findFirst({
      where: {
        workspace_id: workspaceId,
        name,
        ...(excludeCohortId ? { id: { not: excludeCohortId } } : {}),
      },
      select: { id: true },
    });
    return existing !== null;
  }

  async update(
    cohortId: string,
    input: UpdateCohortInput,
  ): Promise<CommunityCohort> {
    return this.prisma.communityCohort.update({
      where: { id: cohortId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
        ...(input.startsAt !== undefined ? { starts_at: input.startsAt } : {}),
        ...(input.endsAt !== undefined ? { ends_at: input.endsAt } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
    });
  }

  /**
   * Soft-archive a cohort and cascade its memberships to `removed`. Done in a
   * single transaction so a cohort is never left half-archived with live
   * members. Messages and posts are intentionally left intact (still readable);
   * only membership status changes. Sets archived_at + status='archived'.
   */
  async archive(cohortId: string): Promise<CommunityCohort> {
    const now = new Date();
    const [cohort] = await this.prisma.$transaction([
      this.prisma.communityCohort.update({
        where: { id: cohortId },
        data: { status: 'archived', archived_at: now },
      }),
      this.prisma.communityMembership.updateMany({
        where: { cohort_id: cohortId, status: { not: 'removed' } },
        data: { status: 'removed', removed_at: now },
      }),
    ]);
    return cohort;
  }
}
