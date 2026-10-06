/**
 * S-MWB Programs (S-MWB-3, B-640-11 / C-640-5): guards shared by every route
 * that can retire a master program or empty it.
 *
 * Two things depend on a master staying live and non-empty:
 *   - a live package that delivers it (`CoachPackageContent`), and
 *   - an active clinic consultation set (`ClinicProgramSet`, #607): onboarding
 *     completion matches each new client to one of the set's masters and
 *     refuses an archived one (`clinic_not_configured`), so archiving or
 *     emptying a set master would stop every new client of that coach from
 *     finishing the consultation.
 *
 * Serialisation: every path that archives a master, empties it, or attaches it
 * to a package takes the master's row lock (`lockProgramMaster`) before it
 * reads the guards, so a package attach and a last-day removal can never both
 * pass on the same master. Clinic sets need no lock of their own: a set is
 * only ever published (scripts/seed-clinic-programs.ts) together with brand
 * new masters inside the same transaction, so a set can never start pointing
 * at a master that already exists.
 */
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export const PROGRAM_IN_CLINIC_SET = 'program_in_clinic_set';
export const PROGRAM_IN_CLINIC_SET_NEEDS_A_DAY = 'program_in_clinic_set_needs_a_day';
export const PROGRAM_IN_PACKAGE_NEEDS_A_DAY = 'program_in_package_needs_a_day';

export const CLINIC_SET_ARCHIVE_MESSAGE =
  'Your consultation matches new clients to this program, so it stays in your library. To retire it, contact support to change the programs your consultation uses.';
export const CLINIC_SET_LAST_DAY_MESSAGE =
  'This is the last workout in a program your consultation gives new clients. Add another day first. To retire the program, contact support to change the programs your consultation uses.';
export const PACKAGE_LAST_DAY_MESSAGE =
  'This is the last workout in a program that a package delivers. Add another day first, or remove the program from the package.';

type Db = Pick<Prisma.TransactionClient, '$queryRaw' | 'clinicProgramSet' | 'coachPackageContent'>;

/** The master's columns the guards need. */
export interface GuardedMaster {
  id: string;
  coach_id: string;
  owner_user_id: string | null;
}

/**
 * Take the master's row lock (SELECT ... FOR UPDATE) and return the columns
 * the guards need, or null when the row does not exist.
 */
export async function lockProgramMaster(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  programId: string,
): Promise<GuardedMaster | null> {
  const rows = await tx.$queryRaw<GuardedMaster[]>`
    SELECT "id", "coach_id", "owner_user_id" FROM "WorkoutProgram"
    WHERE "id" = ${programId}
    FOR UPDATE`;
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/** Every program_id named in a ClinicProgramSet.programs JSON value. */
export function programIdsInClinicSet(programs: unknown): string[] {
  if (!programs || typeof programs !== 'object' || Array.isArray(programs)) return [];
  const ids: string[] = [];
  for (const entry of Object.values(programs as Record<string, unknown>)) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const id = (entry as Record<string, unknown>).program_id;
      if (typeof id === 'string' && id.length > 0) ids.push(id);
    }
  }
  return ids;
}

/**
 * True when an ACTIVE clinic set of the master's coach (owner or tenant head)
 * references this master. Onboarding reads only the attached coach's active
 * set, so those are the sets that can be broken.
 */
export async function isProgramInActiveClinicSet(
  db: Pick<Prisma.TransactionClient, 'clinicProgramSet'>,
  master: GuardedMaster,
): Promise<boolean> {
  const coachIds = Array.from(
    new Set([master.coach_id, master.owner_user_id].filter((v): v is string => !!v)),
  );
  if (coachIds.length === 0) return false;
  const sets = await db.clinicProgramSet.findMany({
    where: { coach_id: { in: coachIds }, active: true },
    select: { programs: true },
  });
  return sets.some((s) => programIdsInClinicSet(s.programs).includes(master.id));
}

/** Refuse to archive a master an active clinic set uses (typed 409). */
export async function assertNotInActiveClinicSet(
  db: Pick<Prisma.TransactionClient, 'clinicProgramSet'>,
  master: GuardedMaster,
): Promise<void> {
  if (await isProgramInActiveClinicSet(db, master)) {
    throw new ConflictException({
      code: PROGRAM_IN_CLINIC_SET,
      message: CLINIC_SET_ARCHIVE_MESSAGE,
    });
  }
}

/**
 * Refuse to remove the last live day of a master that a live package delivers
 * or an active clinic set uses. Call only when the removal WOULD leave the
 * master with no live day, under the master's row lock.
 */
export async function assertLastDayMayGo(db: Db, master: GuardedMaster): Promise<void> {
  const inPackage = await db.coachPackageContent.count({
    where: {
      asset_type: 'workout_program',
      asset_id: master.id,
      removed_at: null,
      package: { archived_at: null },
    },
  });
  if (inPackage > 0) {
    throw new ConflictException({
      code: PROGRAM_IN_PACKAGE_NEEDS_A_DAY,
      message: PACKAGE_LAST_DAY_MESSAGE,
    });
  }
  if (await isProgramInActiveClinicSet(db, master)) {
    throw new ConflictException({
      code: PROGRAM_IN_CLINIC_SET_NEEDS_A_DAY,
      message: CLINIC_SET_LAST_DAY_MESSAGE,
    });
  }
}
