import { Injectable } from '@nestjs/common';
import type {
  CommunityCohort,
  CommunityPostingPolicy,
  CommunitySpaceKind,
  CommunitySpaceVisibility,
} from '@prisma/client';
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
/** C6-BVIS: a space with the packages that open it (package visibility only). */
export type CohortWithPackages = CommunityCohort & { packages: { package_id: string }[] };
const PACKAGES = { packages: { select: { package_id: true } } } as const;

/** Who the space opens to; the links are replaced whole. */
export interface SpaceAccessInput {
  visibility: CommunitySpaceVisibility;
  packageIds: string[];
}
const links = (a: SpaceAccessInput) => a.packageIds.map((package_id) => ({ package_id }));

export interface CreateCohortInput {
  workspaceId: string;
  name: string;
  description: string | null;
  capacity: number | null;
  startsAt: Date | null;
  endsAt: Date | null;
  kind: CommunitySpaceKind;
  postingPolicy: CommunityPostingPolicy;
  access: SpaceAccessInput;
}

export interface UpdateCohortInput {
  name?: string;
  description?: string | null;
  capacity?: number | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  status?: 'draft' | 'active' | 'archived';
  postingPolicy?: CommunityPostingPolicy;
  access?: SpaceAccessInput;
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

  async create(input: CreateCohortInput): Promise<CohortWithPackages> {
    return this.prisma.communityCohort.create({
      data: {
        workspace_id: input.workspaceId,
        name: input.name,
        description: input.description,
        capacity: input.capacity,
        starts_at: input.startsAt,
        ends_at: input.endsAt,
        status: 'active',
        kind: input.kind,
        posting_policy: input.postingPolicy,
        visibility: input.access.visibility,
        packages: { create: links(input.access) },
        sort_order: await this.nextSortOrder(input.workspaceId),
      },
      include: PACKAGES,
    });
  }

  async findById(cohortId: string): Promise<CohortWithPackages | null> {
    return this.prisma.communityCohort.findUnique({ where: { id: cohortId }, include: PACKAGES });
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
  ): Promise<CohortWithPackages> {
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
        ...(input.postingPolicy !== undefined ? { posting_policy: input.postingPolicy } : {}),
        ...(input.access
          ? { visibility: input.access.visibility, packages: { deleteMany: {}, create: links(input.access) } }
          : {}),
      },
      include: PACKAGES,
    });
  }

  /**
   * Soft-archive a cohort and cascade its memberships to `removed`. Done in a
   * single transaction so a cohort is never left half-archived with live
   * members. Messages and posts are intentionally left intact (still readable);
   * only membership status changes. Sets archived_at + status='archived'.
   */
  /** How many of `ids` are packages of this coach. */
  async coachPackageCount(coachId: string, ids: string[]): Promise<number> {
    return this.prisma.coachPackage.count({ where: { coach_id: coachId, id: { in: ids } } });
  }

  async archive(cohortId: string): Promise<CohortWithPackages> {
    const now = new Date();
    const [cohort] = await this.prisma.$transaction([
      this.prisma.communityCohort.update({
        where: { id: cohortId },
        data: { status: 'archived', archived_at: now },
        include: PACKAGES,
      }),
      this.prisma.communityMembership.updateMany({
        where: { cohort_id: cohortId, status: { not: 'removed' } },
        data: { status: 'removed', removed_at: now },
      }),
    ]);
    return cohort;
  }
}
