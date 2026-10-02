/**
 * Seed helpers for the DB-backed community suites (CI job community-live-tests).
 *
 * The live suites run against a database migrated with the real chain
 * (`prisma migrate deploy`), so "User" is the full production table:
 * `supabase_id` and `email` are NOT NULL + UNIQUE and `role` is the "Role"
 * enum. The suites were first written against a hand-made minimal "User"
 * table (id/role/name/coach_id only) and seeded it with raw SQL that the real
 * table rejects (42804 role text vs "Role", 23502 null supabase_id/email;
 * CI run 36975979563). Seeding through the typed client keeps every suite in
 * step with schema.prisma instead of a second, drifting copy of the table.
 */
import { PrismaClient, Role } from '@prisma/client';

export interface LiveUserSeed {
  id: string;
  role: Role;
  name: string;
  coachId: string | null;
}

/**
 * Insert one live-suite user. `supabase_id` and `email` are derived from the
 * id, so they are unique per row and recognisable as test data.
 */
export async function insertLiveUser(prisma: PrismaClient, seed: LiveUserSeed): Promise<void> {
  await prisma.user.create({
    data: {
      id: seed.id,
      supabase_id: `community-live-${seed.id}`,
      email: `community-live-${seed.id}@example.test`,
      role: seed.role,
      name: seed.name,
      coach_id: seed.coachId,
    },
  });
}

/** Insert users in order (coaches before the clients that reference them). */
export async function insertLiveUsers(
  prisma: PrismaClient,
  users: ReadonlyArray<readonly [string, Role, string, string | null]>,
): Promise<void> {
  for (const [id, role, name, coachId] of users) {
    await insertLiveUser(prisma, { id, role, name, coachId });
  }
}
