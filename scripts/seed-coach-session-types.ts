/**
 * scripts/seed-coach-session-types.ts
 *
 * S-SCHED: idempotent seed of a coach's day-1 appointment types, including
 * the welcome type (SessionType.is_welcome) that Roman's tutorial offers at
 * the end. Operator-run after the coach has signed up.
 *
 * Dry run by default (prints the plan, writes nothing). Pass --apply to write.
 *
 *   npx ts-node scripts/seed-coach-session-types.ts --coach-email <email>
 *   npx ts-node scripts/seed-coach-session-types.ts --coach-email <email> --apply
 *   npx ts-node scripts/seed-coach-session-types.ts --coach-id <uuid> --apply
 *   ... --apply --reset   (also rewrite matched types back to the day-1 values)
 *
 * Idempotency rules (re-running converges, never duplicates):
 *  - The welcome entry matches the coach's active is_welcome type if one
 *    exists, otherwise an active type with exactly the same name.
 *  - Every other entry matches an active, non-welcome type with exactly the
 *    same name. (Name matching is used only to keep this seed idempotent;
 *    the app never infers the welcome type from a name.)
 *  - Unmatched entries are created. A matched row that differs from the
 *    list is reported as drift and LEFT AS THE COACH EDITED IT, unless
 *    --reset is passed (then only the differing fields are rewritten).
 *    Types not in the list are never touched or archived.
 *  - All writes run in one transaction; the welcome flag is cleared on any
 *    other type first so the partial unique index is never violated.
 *
 * Equivalent API sequence (as the coach, no script): for each entry
 * POST /scheduling/session-types {name, description, duration_minutes,
 * auto_approve, default_video_provider: 'manual', is_welcome}; to change one
 * later PATCH /scheduling/session-types/:id. Availability is set separately
 * (POST /scheduling/coaches/:coachId/availability) or in the app.
 */
import { PrismaClient } from '@prisma/client';

export interface SeedTypeSpec {
  name: string;
  description: string | null;
  duration_minutes: number;
  auto_approve: boolean;
  is_welcome: boolean;
}

// Owner-approved 2026-10-01 day-1 set.
export const DAY1_SESSION_TYPES: SeedTypeSpec[] = [
  {
    name: 'Quick initialization',
    description: 'A short first call to say hello and get you set up.',
    duration_minutes: 15,
    auto_approve: true,
    is_welcome: true,
  },
  {
    name: 'Quick Q/A Call',
    description: 'A short call for questions about your plan.',
    duration_minutes: 20,
    auto_approve: true,
    is_welcome: false,
  },
  {
    name: 'Tele-Health Dietary/Fitness Check-in',
    description: 'A longer check-in on your nutrition and training. Your coach confirms the time.',
    duration_minutes: 45,
    auto_approve: false,
    is_welcome: false,
  },
];

export interface ExistingType {
  id: string;
  name: string;
  description: string | null;
  duration_minutes: number;
  auto_approve: boolean;
  is_welcome: boolean;
  archived_at: Date | null;
}

export type SeedAction =
  | { kind: 'create'; spec: SeedTypeSpec }
  | { kind: 'update'; id: string; spec: SeedTypeSpec; changed: string[] }
  | { kind: 'unchanged'; id: string; spec: SeedTypeSpec };

/** Pure planner, unit-tested in test/seed-coach-session-types.spec.ts. */
export function planSeed(existing: ExistingType[], specs: SeedTypeSpec[]): SeedAction[] {
  const active = existing.filter((t) => t.archived_at === null);
  const claimed = new Set<string>();
  const actions: SeedAction[] = [];
  for (const spec of specs) {
    let match: ExistingType | undefined;
    if (spec.is_welcome) {
      match = active.find((t) => t.is_welcome && !claimed.has(t.id));
    }
    if (!match) {
      match = active.find(
        (t) => t.name === spec.name && !claimed.has(t.id) && (spec.is_welcome || !t.is_welcome),
      );
    }
    if (!match) {
      actions.push({ kind: 'create', spec });
      continue;
    }
    claimed.add(match.id);
    const changed: string[] = [];
    if (match.name !== spec.name) changed.push('name');
    if (match.description !== spec.description) changed.push('description');
    if (match.duration_minutes !== spec.duration_minutes) changed.push('duration_minutes');
    if (match.auto_approve !== spec.auto_approve) changed.push('auto_approve');
    if (match.is_welcome !== spec.is_welcome) changed.push('is_welcome');
    actions.push(
      changed.length
        ? { kind: 'update', id: match.id, spec, changed }
        : { kind: 'unchanged', id: match.id, spec },
    );
  }
  return actions;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const email = arg('--coach-email');
  const id = arg('--coach-id');
  const apply = process.argv.includes('--apply');
  const reset = process.argv.includes('--reset');
  if (!email && !id) {
    process.stderr.write('Usage: --coach-email <email> | --coach-id <uuid> [--apply]\n');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  try {
    const coach = await prisma.user.findFirst({
      where: id ? { id } : { email: { equals: email, mode: 'insensitive' } },
      select: { id: true, role: true },
    });
    if (!coach) throw new Error('coach not found');
    if (coach.role !== 'coach') throw new Error(`user ${coach.id} is not a coach (role=${coach.role})`);

    const existing = await prisma.sessionType.findMany({
      where: { coach_id: coach.id },
      select: {
        id: true,
        name: true,
        description: true,
        duration_minutes: true,
        auto_approve: true,
        is_welcome: true,
        archived_at: true,
      },
    });
    const plan = planSeed(existing, DAY1_SESSION_TYPES);
    for (const a of plan) {
      const detail =
        a.kind === 'update'
          ? ` (${a.changed.join(', ')})${reset ? '' : ' -> kept as the coach edited it; pass --reset to rewrite'}`
          : '';
      process.stdout.write(`${a.kind === 'update' && !reset ? 'drift' : a.kind}: ${a.spec.name}${detail}\n`);
    }
    if (!apply) {
      process.stdout.write('Dry run. Re-run with --apply to write.\n');
      return;
    }
    const welcomeTarget = plan.find((a) => a.spec.is_welcome);
    await prisma.$transaction(async (tx) => {
      // Clear the flag on every other type first (partial unique index).
      // A matched welcome type keeps its flag; with no active welcome type the
      // created one takes it (only archived rows can still carry the flag).
      const keepId = welcomeTarget && welcomeTarget.kind !== 'create' ? welcomeTarget.id : null;
      await tx.sessionType.updateMany({
        where: { coach_id: coach.id, is_welcome: true, ...(keepId ? { id: { not: keepId } } : {}) },
        data: { is_welcome: false },
      });
      for (const a of plan) {
        const data = {
          name: a.spec.name,
          description: a.spec.description,
          duration_minutes: a.spec.duration_minutes,
          auto_approve: a.spec.auto_approve,
          is_welcome: a.spec.is_welcome,
        };
        if (a.kind === 'create') {
          await tx.sessionType.create({
            data: { ...data, coach_id: coach.id, default_video_provider: 'manual' },
          });
        } else if (a.kind === 'update' && reset) {
          await tx.sessionType.update({ where: { id: a.id }, data });
        } else if (a.kind === 'update' && a.spec.is_welcome && a.changed.includes('is_welcome')) {
          // The welcome marker is the one field the tour depends on; set it
          // even without --reset, leaving the coach's other edits alone.
          await tx.sessionType.update({ where: { id: a.id }, data: { is_welcome: true } });
        }
      }
    });
    process.stdout.write('Applied.\n');
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
