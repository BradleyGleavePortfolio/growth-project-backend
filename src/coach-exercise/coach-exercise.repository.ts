import { Injectable } from '@nestjs/common';
import type { CoachExercise } from '@prisma/client';
import { PrismaService } from '../prisma.service';

/**
 * coach-exercise.repository.ts — data access for the coach custom-exercise
 * library.
 *
 * Tenant scoping follows repo doctrine: the app connects as the Supabase
 * service_role (BYPASSRLS), so isolation is enforced HERE in explicit WHERE
 * clauses scoping every row to coach_id (and again at the DB by the migration's
 * coach_exercises_owner_all RLS policy as defence-in-depth). The list read is
 * implicitly bounded by being scoped to a single coach's own library.
 */

/** Fields needed to durably insert a library exercise after upload confirmation. */
export interface CoachExerciseSeed {
  coachId: string;
  name: string;
  instructions: string;
  mediaKind: string;
  storageKey: string | null;
  mediaMime: string | null;
}

@Injectable()
export class CoachExerciseRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Insert a library exercise row inside a transaction (call-site-consistent). */
  async create(seed: CoachExerciseSeed): Promise<CoachExercise> {
    const [created] = await this.prisma.$transaction([
      this.prisma.coachExercise.create({
        data: {
          coach_id: seed.coachId,
          name: seed.name,
          instructions: seed.instructions,
          media_kind: seed.mediaKind,
          storage_key: seed.storageKey,
          media_mime: seed.mediaMime,
        },
      }),
    ]);
    return created;
  }

  /**
   * List a coach's own non-archived library exercises, most-recent-first. Scoped
   * to coach_id so a coach only ever sees their own authored moves.
   */
  async listForCoach(coachId: string): Promise<CoachExercise[]> {
    return this.prisma.coachExercise.findMany({
      where: { coach_id: coachId, archived_at: null },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    });
  }
}
