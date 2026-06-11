/**
 * reset-public-schema.ts — MWB-3 live-spec isolation helper.
 *
 * Why this exists: the MWB-3 default jest lane runs FOUR live integration spec
 * files (autosave.service, autosave.controller, undo, revision-prune.cron),
 * each of which materialises the full Prisma schema in its own `beforeAll` via
 * `bootstrapTestSchema`. Those files share a single throwaway database and run
 * sequentially under `--runInBand`. `bootstrapTestSchema` is a `--from-empty`
 * DDL apply (CREATE TYPE / CREATE TABLE ...): it assumes a pristine `public`
 * schema and (correctly) aborts on a non-tolerated DDL failure such as
 * `type "Role" already exists`. So the SECOND spec to run would collide with
 * the objects the FIRST spec created.
 *
 * Rather than make the shared MWB-2 bootstrap helper idempotent (out of PR
 * scope — that file is unchanged from base), each MWB-3 live spec resets the
 * `public` schema to empty here first, guaranteeing every spec bootstraps onto
 * a clean slate regardless of run order. `DROP SCHEMA ... CASCADE` is the same
 * teardown `prisma migrate reset` uses, and is safe because the target is a
 * dedicated throwaway DB selected exclusively via MWB3_TEST_DATABASE_URL (never
 * the app DATABASE_URL — the specs gate on that env var).
 *
 * App roles (app_authenticated, service_role) are NOT schema-owned objects, so
 * dropping `public` leaves them intact; we only re-grant USAGE so the RLS-bound
 * roles can still resolve relations the bootstrap re-creates.
 */

import type { PrismaClient } from '@prisma/client';

/**
 * Drop and recreate the `public` schema so a subsequent `bootstrapTestSchema`
 * call applies its `--from-empty` DDL onto a pristine schema. Idempotent.
 */
export async function resetPublicSchema(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
  await prisma.$executeRawUnsafe('CREATE SCHEMA public');
  // Re-grant so the connection role and the RLS-bound roles can use relations
  // that bootstrapTestSchema is about to (re)create. CURRENT_USER is the
  // connection's superuser (postgres); the two app roles are pre-provisioned,
  // NOLOGIN, and referenced by the RLS lane.
  await prisma.$executeRawUnsafe('GRANT ALL ON SCHEMA public TO CURRENT_USER');
  await prisma.$executeRawUnsafe('GRANT ALL ON SCHEMA public TO public');
}
