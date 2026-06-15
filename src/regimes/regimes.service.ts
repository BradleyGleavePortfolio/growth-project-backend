/**
 * RegimesService — named-regime layer on top of WorkoutProgram (F2).
 *
 * A "named regime" is a WorkoutProgram with `is_regime=true`. There is NO
 * parallel Regime table (F2 brief): the regime concept is three additive
 * columns on WorkoutProgram (`is_regime`, `regime_display_name`,
 * `revision_retention_count`) plus this orchestration service.
 *
 * Ownership: every read/write is scoped to `coach_id = req.user.id`, mirroring
 * WorkoutBuilderService. assertCoach() re-checks the caller's role as
 * defence-in-depth even though the controller's RolesGuard already gates it.
 */

import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { RegimeRevisionRetentionService } from './regime-revision-retention.service';

export interface RegimeListItem {
  id: string;
  name: string;
  regime_display_name: string | null;
  weeks: number;
  days_per_week: number;
  head_revision_id: string | null;
  archived_at: Date | null;
  package_attachments_count: number;
}

export interface RegimeRevisionItem {
  revision_index: number;
  created_at: Date;
  cause: string;
}

/**
 * Hard ceiling on rows returned by getRegimeRevisions (R81 F5).
 *
 * The effective bound is the per-program rolling eviction window
 * (`WorkoutProgram.revision_retention_count`, default 3) enforced by
 * RegimeRevisionRetentionService, so a healthy program never has more than a
 * handful of revisions. This query-level cap is defence-in-depth: it bounds the
 * read even for an operator-configured high-retention regime (or a transient
 * window before eviction runs), so the "last N versions" drawer can never pull
 * an unbounded result set. 20 is generous headroom above the default retention
 * of 3 while keeping the response payload small.
 */
export const REGIME_REVISIONS_HARD_CAP = 20;

@Injectable()
export class RegimesService {
  private readonly logger = new Logger(RegimesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly retention: RegimeRevisionRetentionService,
  ) {}

  /** Server-authoritative coach gate (defence-in-depth, mirrors WorkoutBuilder). */
  private async assertCoach(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (!user) throw new ForbiddenException('User not found');
    if (user.role !== 'coach' && user.role !== 'owner') {
      throw new ForbiddenException('Coach role required');
    }
  }

  /**
   * Resolve a regime the calling coach owns, or throw 404. We deliberately
   * 404 (not 403) on a regime owned by another coach so the existence of
   * another coach's regime is never leaked.
   */
  private async requireOwnedRegime(coachId: string, id: string) {
    const program = await this.prisma.workoutProgram.findFirst({
      where: { id, coach_id: coachId, is_regime: true },
      select: {
        id: true,
        name: true,
        regime_display_name: true,
        weeks: true,
        days_per_week: true,
        head_revision_id: true,
        archived_at: true,
        owner_user_id: true,
      },
    });
    if (!program) {
      throw new NotFoundException('Regime not found');
    }
    return program;
  }

  /**
   * List the calling coach's active named regimes (is_regime=true,
   * archived_at IS NULL), each annotated with how many packages currently
   * attach it (CoachPackageContent rows with asset_type='workout_program',
   * asset_id=program.id, removed_at IS NULL).
   */
  async listRegimes(coachId: string): Promise<RegimeListItem[]> {
    await this.assertCoach(coachId);

    const programs = await this.prisma.workoutProgram.findMany({
      where: { coach_id: coachId, is_regime: true, archived_at: null },
      orderBy: { updated_at: 'desc' },
      select: {
        id: true,
        name: true,
        regime_display_name: true,
        weeks: true,
        days_per_week: true,
        head_revision_id: true,
        archived_at: true,
      },
    });
    if (programs.length === 0) return [];

    // Batch the attachment counts in a single grouped query keyed on asset_id.
    const grouped = await this.prisma.coachPackageContent.groupBy({
      by: ['asset_id'],
      where: {
        asset_type: 'workout_program',
        asset_id: { in: programs.map((p) => p.id) },
        removed_at: null,
      },
      _count: { _all: true },
    });
    const countByAsset = new Map<string, number>(
      grouped.map((g) => [g.asset_id, g._count._all]),
    );

    return programs.map((p) => ({
      ...p,
      package_attachments_count: countByAsset.get(p.id) ?? 0,
    }));
  }

  /**
   * Read-only revision history for a regime, newest first, capped at the
   * regime's retention window. Surfaces revision_index + created_at + cause
   * for the mobile "last 3 versions" drawer.
   */
  async getRegimeRevisions(
    coachId: string,
    id: string,
  ): Promise<RegimeRevisionItem[]> {
    await this.assertCoach(coachId);
    await this.requireOwnedRegime(coachId, id);

    const revisions = await this.prisma.workoutProgramRevision.findMany({
      where: { program_id: id },
      orderBy: { revision_index: 'desc' },
      take: REGIME_REVISIONS_HARD_CAP,
      select: { revision_index: true, created_at: true, cause: true },
    });
    return revisions;
  }

  /**
   * Promote an existing WorkoutProgram to a named regime by flipping
   * is_regime=true (and optionally setting regime_display_name). Validates the
   * program belongs to the calling coach. Idempotent: re-promoting a program
   * that is already a regime is a no-op flip that returns the current row.
   */
  async promoteFromProgram(
    coachId: string,
    programId: string,
    regimeDisplayName?: string,
  ): Promise<RegimeListItem> {
    await this.assertCoach(coachId);

    const program = await this.prisma.workoutProgram.findFirst({
      where: { id: programId, coach_id: coachId },
      select: { id: true },
    });
    if (!program) {
      throw new NotFoundException('Program not found');
    }

    // updateMany with a coach_id guard keeps the write owner-scoped and the
    // flip idempotent under retry (a second promote sets the same values).
    await this.prisma.workoutProgram.updateMany({
      where: { id: programId, coach_id: coachId },
      data: {
        is_regime: true,
        ...(regimeDisplayName !== undefined
          ? { regime_display_name: regimeDisplayName }
          : {}),
      },
    });

    this.logger.log(
      `promoteFromProgram: program=${programId} promoted to regime by coach=${coachId}`,
    );

    const updated = await this.requireOwnedRegime(coachId, programId);
    const attachments = await this.prisma.coachPackageContent.count({
      where: {
        asset_type: 'workout_program',
        asset_id: programId,
        removed_at: null,
      },
    });
    return {
      id: updated.id,
      name: updated.name,
      regime_display_name: updated.regime_display_name,
      weeks: updated.weeks,
      days_per_week: updated.days_per_week,
      head_revision_id: updated.head_revision_id,
      archived_at: updated.archived_at,
      package_attachments_count: attachments,
    };
  }

  /**
   * Update a regime's display name only. Other WorkoutProgram fields edit via
   * the existing workout-builder routes — we do NOT duplicate them. After the
   * save we append a WorkoutProgramRevision (cause='manual_edit') and trigger
   * rolling-history eviction. We deliberately do NOT auto-push to existing
   * buyers — that is the operator's manual button (F1's endpoint).
   */
  async updateRegime(
    coachId: string,
    id: string,
    regimeDisplayName: string,
  ): Promise<RegimeListItem> {
    await this.assertCoach(coachId);
    const existing = await this.requireOwnedRegime(coachId, id);

    await this.prisma.$transaction(async (tx) => {
      await tx.workoutProgram.updateMany({
        where: { id, coach_id: coachId, is_regime: true },
        data: { regime_display_name: regimeDisplayName },
      });

      // Append a new structure revision so the edit is auditable + appears in
      // the "last 3 versions" drawer. Next index = current max + 1.
      const head = await tx.workoutProgramRevision.findFirst({
        where: { program_id: id },
        orderBy: { revision_index: 'desc' },
        select: { revision_index: true },
      });
      const nextIndex = head ? head.revision_index + 1 : 0;
      await tx.workoutProgramRevision.create({
        data: {
          program_id: id,
          revision_index: nextIndex,
          structure_json: { regime_display_name: regimeDisplayName },
          author_id: coachId,
          author_kind: 'coach',
          cause: 'manual_edit',
        },
      });

      await this.retention.evictForRegime(id, tx);
    });

    const attachments = await this.prisma.coachPackageContent.count({
      where: {
        asset_type: 'workout_program',
        asset_id: id,
        removed_at: null,
      },
    });
    return {
      id: existing.id,
      name: existing.name,
      regime_display_name: regimeDisplayName,
      weeks: existing.weeks,
      days_per_week: existing.days_per_week,
      head_revision_id: existing.head_revision_id,
      archived_at: existing.archived_at,
      package_attachments_count: attachments,
    };
  }

  /**
   * Archive a regime: set archived_at=now(). Active clients KEEP receiving
   * their dripped content (we leave existing ScheduledDrops alone — no drop
   * cancellation), but new CoachPackageContent attachments referencing this
   * program are blocked at the package-authoring endpoint (422). Idempotent:
   * re-archiving keeps the original archived_at.
   */
  async archiveRegime(
    coachId: string,
    id: string,
  ): Promise<{ id: string; archived_at: Date }> {
    await this.assertCoach(coachId);
    await this.requireOwnedRegime(coachId, id);

    const now = new Date();
    // WHERE-guard on archived_at=null keeps this idempotent: a second archive
    // matches zero rows and the original timestamp is preserved.
    await this.prisma.workoutProgram.updateMany({
      where: { id, coach_id: coachId, is_regime: true, archived_at: null },
      data: { archived_at: now },
    });

    const row = await this.prisma.workoutProgram.findFirst({
      where: { id, coach_id: coachId },
      select: { archived_at: true },
    });
    this.logger.log(`archiveRegime: regime=${id} archived by coach=${coachId}`);
    return { id, archived_at: row?.archived_at ?? now };
  }
}
