/**
 * C04 operator-only seed. Dry run by default. Never runs at app startup.
 * npx ts-node scripts/seed-coach-session-types.ts --coach-id <uuid> [--apply]
 *
 * Reuses the existing SessionType contract. Existing active or archived
 * matching names are preserved, including coach edits; no reset/delete.
 */
import { Prisma, PrismaClient } from '@prisma/client';

export const DAY1_SESSION_TYPES = [
  {
    name: 'Quick initialization',
    description: 'A short first call to say hello and get you set up.',
    duration_minutes: 15,
    auto_approve: true,
  },
  {
    name: 'Quick Q/A Call',
    description: 'A short call for questions about your plan.',
    duration_minutes: 20,
    auto_approve: true,
  },
  {
    name: 'Tele-Health Dietary/Fitness Check-in',
    description:
      'A personal-training check-in on nutrition and fitness, not medical care. Your coach confirms the time.',
    duration_minutes: 45,
    auto_approve: false,
  },
] as const;

type SeedSpec = (typeof DAY1_SESSION_TYPES)[number];
export interface ExistingType {
  id: string;
  name: string;
  description: string | null;
  duration_minutes: number;
  auto_approve: boolean;
  archived_at: Date | null;
}
export type SeedAction =
  | { kind: 'create'; spec: SeedSpec }
  | { kind: 'keep'; id: string; spec: SeedSpec; drift: boolean; archived: boolean };

export function planSeed(existing: ExistingType[]): SeedAction[] {
  return DAY1_SESSION_TYPES.map((spec) => {
    const matches = existing.filter((row) => row.name === spec.name);
    if (matches.length > 1) {
      throw new Error(
        `Multiple appointment types match "${spec.name}". Resolve them in the coach app before seeding.`,
      );
    }
    const match = matches[0];
    if (!match) return { kind: 'create', spec };
    return {
      kind: 'keep',
      id: match.id,
      spec,
      archived: match.archived_at !== null,
      drift:
        match.description !== spec.description ||
        match.duration_minutes !== spec.duration_minutes ||
        match.auto_approve !== spec.auto_approve,
    };
  });
}

export function parseSeedArgs(args: string[]): { coachId: string; apply: boolean } {
  const usage = 'Use --coach-id <uuid> [--apply]. Dry run is the default.';
  const idIndex = args.indexOf('--coach-id');
  if (
    idIndex < 0 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      args[idIndex + 1] ?? '',
    ) ||
    args.filter((a) => a === '--coach-id').length !== 1 ||
    args.filter((a) => a === '--apply').length > 1 ||
    args.some((a, i) => a !== '--coach-id' && a !== '--apply' && i !== idIndex + 1)
  ) {
    throw new Error(usage);
  }
  return { coachId: args[idIndex + 1], apply: args.includes('--apply') };
}

export async function seedCoachTypes(
  prisma: PrismaClient,
  coachId: string,
  apply: boolean,
): Promise<SeedAction[]> {
  // Read + create in one serializable transaction: concurrent operator
  // invocations cannot both observe an empty set and commit duplicates.
  return prisma.$transaction(
    async (tx) => {
      const coach = await tx.user.findUnique({
        where: { id: coachId },
        select: { role: true },
      });
      if (!coach || coach.role !== 'coach') {
        throw new Error('Coach account not found. Complete coach signup and check --coach-id.');
      }
      const existing = await tx.sessionType.findMany({ where: { coach_id: coachId } });
      const plan = planSeed(existing);
      if (apply) {
        for (const action of plan) {
          if (action.kind === 'create') {
            await tx.sessionType.create({
              data: { ...action.spec, coach_id: coachId, default_video_provider: 'manual' },
            });
          }
        }
      }
      return plan;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

async function main(): Promise<void> {
  const { coachId, apply } = parseSeedArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const plan = await seedCoachTypes(prisma, coachId, apply);
    for (const action of plan) {
      const detail =
        action.kind === 'keep'
          ? action.archived
            ? ' (archived by coach; not restored)'
            : action.drift
              ? ' (coach edits preserved)'
              : ''
          : '';
      process.stdout.write(`${action.kind}: ${action.spec.name}${detail}\n`);
    }
    process.stdout.write(
      apply
        ? 'Applied. Set weekly availability in the coach app before inviting clients.\n'
        : 'Dry run: no writes. Re-run with --apply after reviewing this plan.\n',
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : null;
    process.stderr.write(
      code === 'P2034'
        ? 'Another scheduling edit overlapped this seed. Run the dry run again before applying.\n'
        : `${err instanceof Error ? err.message : 'Seed failed. Check database access and run the dry run again.'}\n`,
    );
    process.exitCode = 1;
  });
}
