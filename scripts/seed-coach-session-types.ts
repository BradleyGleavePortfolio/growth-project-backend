/**
 * C04 operator-only seed. Dry run by default. Never runs at app startup.
 * npx ts-node scripts/seed-coach-session-types.ts --coach-id <uuid> [--apply]
 *
 * Reuses the existing SessionType contract. Existing active or archived
 * matching names are preserved, including coach edits; no reset/delete.
 *
 * S-SCHED-4: "Quick initialization" is created as the coach's welcome type
 * (is_welcome, the type the onboarding tutorial's "Book your welcome call"
 * opens), unless the coach already has an active welcome type; the partial
 * unique index SessionType_one_active_welcome_per_coach allows one.
 */
import { Prisma, PrismaClient } from '@prisma/client';

export const DAY1_SESSION_TYPES = [
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
    description:
      'A personal-training check-in on nutrition and fitness, not medical care. Your coach confirms the time.',
    duration_minutes: 45,
    auto_approve: false,
    is_welcome: false,
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
  is_welcome?: boolean;
}
export type SeedAction =
  | { kind: 'create'; spec: SeedSpec }
  | {
      kind: 'keep';
      id: string;
      spec: SeedSpec;
      drift: boolean;
      archived: boolean;
      /**
       * C-634-5: the kept welcome type has no welcome marker and the coach
       * has no other active welcome type, so --apply marks it.
       */
      welcomeMissing: boolean;
    };

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
    const otherActiveWelcome = existing.some(
      (row) => row.id !== match.id && row.is_welcome === true && row.archived_at === null,
    );
    return {
      kind: 'keep',
      id: match.id,
      spec,
      archived: match.archived_at !== null,
      welcomeMissing:
        spec.is_welcome &&
        match.archived_at === null &&
        match.is_welcome !== true &&
        !otherActiveWelcome,
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
        // A coach-chosen active welcome type is kept; the seed never moves it.
        let welcomeTaken = existing.some(
          (row) => row.is_welcome === true && row.archived_at === null,
        );
        for (const action of plan) {
          if (action.kind === 'keep' && action.welcomeMissing && !welcomeTaken) {
            // C-634-5: a type seeded before the welcome marker existed.
            // Only when the coach has no active welcome type of their own.
            welcomeTaken = true;
            await tx.sessionType.update({
              where: { id: action.id },
              data: { is_welcome: true },
            });
          }
          if (action.kind === 'create') {
            const isWelcome = action.spec.is_welcome && !welcomeTaken;
            if (isWelcome) welcomeTaken = true;
            await tx.sessionType.create({
              data: {
                name: action.spec.name,
                description: action.spec.description,
                duration_minutes: action.spec.duration_minutes,
                auto_approve: action.spec.auto_approve,
                is_welcome: isWelcome,
                coach_id: coachId,
                default_video_provider: 'manual',
              },
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
            : `${action.drift ? ' (coach edits preserved)' : ''}${
                action.welcomeMissing
                  ? apply
                    ? ' (marked as the welcome call type)'
                    : ' (welcome call marker missing; --apply marks it)'
                  : ''
              }`
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
