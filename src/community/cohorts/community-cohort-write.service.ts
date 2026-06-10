import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { CommunityCohort, User } from '@prisma/client';
import { CommunityAccessService } from '../community-access.service';
import { CommunityCohortWriteRepository } from './community-cohort-write.repository';
import {
  CommunityCohortAdminResponse,
  CommunityCohortAdminResponseSchema,
  CommunityCohortAdminView,
  CreateCohortDto,
  UpdateCohortDto,
} from './community-cohort.dto';

const NOT_FOUND = {
  error: 'not_found',
  code: 'community.cohort.not_found',
} as const;

const FORBIDDEN = {
  error: 'forbidden',
  code: 'community.cohort.not_coach',
} as const;

const NAME_CONFLICT = {
  error: 'conflict',
  code: 'community.cohort.name_taken',
} as const;

const BAD_DATES = {
  error: 'bad_request',
  code: 'community.cohort.invalid_date_range',
} as const;

/**
 * Cohort write operations (create / update / archive) — coach-owner only.
 *
 * Authorization doctrine (matches CommunityModerationService.assertModerator):
 *  - The platform owner (user.role === 'owner') bypasses workspace ownership.
 *  - Otherwise the caller MUST own the workspace (CommunityAccessService
 *    .isWorkspaceCoach) — derived from the JWT user id, NEVER from the body.
 *  - A foreign workspace / cohort id resolves to 404 (canonical create) or
 *    403 once existence is established for a workspace the caller can read;
 *    cohort writes throw 403 not_coach because the cohort/workspace existence
 *    is already known to the caller via the URL they hold. Cross-workspace and
 *    cross-cohort attacks are both blocked here regardless of URL manipulation.
 */
@Injectable()
export class CommunityCohortWriteService {
  constructor(
    private readonly access: CommunityAccessService,
    private readonly repo: CommunityCohortWriteRepository,
  ) {}

  private view(c: CommunityCohort): CommunityCohortAdminView {
    return {
      id: c.id,
      workspace_id: c.workspace_id,
      name: c.name,
      description: c.description,
      status: c.status,
      capacity: c.capacity,
      starts_at: c.starts_at?.toISOString() ?? null,
      ends_at: c.ends_at?.toISOString() ?? null,
      sort_order: c.sort_order,
      created_at: c.created_at.toISOString(),
      updated_at: c.updated_at.toISOString(),
      archived_at: c.archived_at?.toISOString() ?? null,
    };
  }

  private response(c: CommunityCohort): CommunityCohortAdminResponse {
    return CommunityCohortAdminResponseSchema.parse({ cohort: this.view(c) });
  }

  /** Platform owner OR the owning coach of the workspace. */
  private async assertWorkspaceCoach(
    workspaceId: string,
    user: User,
  ): Promise<void> {
    if (user.role === 'owner') return;
    if (await this.access.isWorkspaceCoach(workspaceId, user.id)) return;
    throw new ForbiddenException(FORBIDDEN);
  }

  private parseDate(value: string | undefined): Date | null | undefined {
    if (value === undefined) return undefined;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new BadRequestException(BAD_DATES);
    return d;
  }

  private assertDateOrder(start: Date | null, end: Date | null): void {
    if (start && end && end.getTime() < start.getTime()) {
      throw new BadRequestException(BAD_DATES);
    }
  }

  async create(
    user: User,
    workspaceId: string,
    body: CreateCohortDto,
  ): Promise<CommunityCohortAdminResponse> {
    // A non-existent workspace and a workspace the caller does not own are
    // BOTH rejected before any write. Existence is resolved first so a foreign
    // workspace id never produces a phantom cohort.
    const workspace = await this.access.findWorkspace(workspaceId);
    if (!workspace) throw new NotFoundException(NOT_FOUND);
    await this.assertWorkspaceCoach(workspaceId, user);

    const startsAt = this.parseDate(body.starts_at) ?? null;
    const endsAt = this.parseDate(body.ends_at) ?? null;
    this.assertDateOrder(startsAt, endsAt);

    if (await this.repo.nameTakenInWorkspace(workspaceId, body.name, null)) {
      throw new ConflictException(NAME_CONFLICT);
    }

    const created = await this.repo.create({
      workspaceId,
      name: body.name,
      description: body.description ?? null,
      capacity: body.capacity ?? null,
      startsAt,
      endsAt,
    });
    return this.response(created);
  }

  async update(
    user: User,
    cohortId: string,
    body: UpdateCohortDto,
  ): Promise<CommunityCohortAdminResponse> {
    const cohort = await this.repo.findById(cohortId);
    if (!cohort) throw new NotFoundException(NOT_FOUND);
    // Cross-workspace / cross-cohort attack gate: the caller must own THIS
    // cohort's workspace, resolved from the persisted row (never the URL or
    // body), so a coach of workspace A cannot mutate a cohort of workspace B.
    await this.assertWorkspaceCoach(cohort.workspace_id, user);

    const startsAt = this.parseDate(body.starts_at);
    const endsAt = this.parseDate(body.ends_at);
    // Validate the resulting date window against existing values when only one
    // side is supplied.
    const effectiveStart = startsAt !== undefined ? startsAt : cohort.starts_at;
    const effectiveEnd = endsAt !== undefined ? endsAt : cohort.ends_at;
    this.assertDateOrder(effectiveStart, effectiveEnd);

    if (
      body.name !== undefined &&
      body.name !== cohort.name &&
      (await this.repo.nameTakenInWorkspace(
        cohort.workspace_id,
        body.name,
        cohort.id,
      ))
    ) {
      throw new ConflictException(NAME_CONFLICT);
    }

    const updated = await this.repo.update(cohortId, {
      name: body.name,
      description:
        body.description !== undefined ? body.description : undefined,
      capacity: body.capacity,
      startsAt,
      endsAt,
      status: body.status,
    });
    return this.response(updated);
  }

  async archive(
    user: User,
    cohortId: string,
  ): Promise<CommunityCohortAdminResponse> {
    const cohort = await this.repo.findById(cohortId);
    if (!cohort) throw new NotFoundException(NOT_FOUND);
    await this.assertWorkspaceCoach(cohort.workspace_id, user);

    // Idempotent: archiving an already-archived cohort is a no-op success.
    if (cohort.status === 'archived' && cohort.archived_at) {
      return this.response(cohort);
    }
    const archived = await this.repo.archive(cohortId);
    return this.response(archived);
  }
}
