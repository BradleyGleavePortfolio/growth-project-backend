/**
 * AccountDeletionService regression tests — A1-C5-P1-4
 *
 * Verifies that finalizeUserDeletion aborts (skips) when the user cancels
 * their deletion request between the cron's candidate snapshot and the
 * actual finalization call. No destructive writes must occur.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { AccountDeletionService } from '../src/account-deletion/account-deletion.service';
import { PrismaService } from '../src/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../src/supabase/supabase.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

type UserRowOverrides = Partial<{
  id: string;
  deletion_confirmed_at: Date | null;
  deleted_at: Date | null;
  email: string;
  name: string;
  role: string;
  supabase_id: string | null;
}>;

const DEFAULT_USER_ROW = {
  id: 'user-1',
  deletion_confirmed_at: new Date(Date.now() - 15 * 86400 * 1000) as Date | null,
  deleted_at: null as Date | null,
  email: 'user@example.com',
  name: 'Test User',
  role: 'student',
  supabase_id: 'supa-1' as string | null,
};

// Use spread (NOT ??) so explicit `null` in overrides is preserved.
// Nullish coalescing falls through for both `null` and `undefined`, which
// silently substituted defaults for tests passing `deletion_confirmed_at: null`.
function buildUserRow(overrides: UserRowOverrides = {}) {
  return { ...DEFAULT_USER_ROW, ...overrides };
}

/** Minimal prisma mock that tracks whether any destructive calls are made. */
function buildPrismaMock(userRow: ReturnType<typeof buildUserRow>) {
  const destructiveMethods = {
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    update: jest.fn().mockResolvedValue({}),
    create: jest.fn().mockResolvedValue({}),
  };

  const txProxy = {
    user: {
      findUnique: jest.fn().mockResolvedValue(userRow),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn().mockResolvedValue({}),
    },
    message: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    loggedFoodEntry: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    workoutSession: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    workoutProgram: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    fastingWindow: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    weightLog: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    waterLog: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    checkIn: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    habit: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    lessonCompletion: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    communityWin: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    savedRecipe: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    listItem: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    clientSignal: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    clientOutcome: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    ptmPrediction: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    coachEffectivenessScore: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    coachOnboardingProgress: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    coachProfile: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    coachSubscription: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    paymentFailure: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    inviteCode: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    buildWeekEnrollment: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    dataExportRequest: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    clientCoachConsent: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    notificationPreferences: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    userPreferences: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    userProfile: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };

  return {
    txProxy,
    destructiveMethods,
    prisma: {
      user: {
        findUnique: jest.fn().mockResolvedValue(userRow),
        findMany: jest.fn().mockResolvedValue([userRow]),
      },
      coachMessage: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      auditLog: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      mealPlan: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      diagnosticSubmission: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      recipe: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      lesson: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      workoutRoutine: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      coachGuideline: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      coachNudge: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      coachAlert: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      activityEvent: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      messageDraft: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      communityWin: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      // Step 10b (B-610-5 round 5): the voice erasure is recorded durably
      // before anything else, so finalization reads the user's voice notes
      // and records the owner-folder erasure even when they have none.
      communityVoiceNote: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      communitySearchEntry: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      communityVoiceErasure: {
        upsert: jest.fn().mockImplementation(
          async (args: { create: { kind: string; target: string } }) => ({
            id: `erasure-${args.create.target}`,
            kind: args.create.kind,
            target: args.create.target,
            attempts: 0,
          }),
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $executeRaw: jest.fn().mockResolvedValue(1),
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        return fn(txProxy);
      }),
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AccountDeletionService.finalizeUserDeletion — cancel-mid-cron race (A1-C5-P1-4)', () => {
  const auditStub = {
    write: jest.fn().mockResolvedValue(undefined),
  };

  const configStub = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'DELETION_GRACE_DAYS') return '14';
      if (key === 'DELETION_TOKEN_TTL_HOURS') return '24';
      return undefined;
    }),
  };

  const supabaseStub = {
    getClient: jest.fn().mockReturnValue({
      auth: {
        admin: {
          deleteUser: jest.fn().mockResolvedValue({ error: null }),
        },
      },
    }),
  };

  async function buildService(userRow: ReturnType<typeof buildUserRow>) {
    const { prisma, txProxy } = buildPrismaMock(userRow);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountDeletionService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: auditStub },
        { provide: ConfigService, useValue: configStub },
        { provide: SupabaseService, useValue: supabaseStub },
      ],
    }).compile();

    return {
      service: module.get<AccountDeletionService>(AccountDeletionService),
      prisma,
      txProxy,
    };
  }

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('skips finalization when user has cancelled (deletion_confirmed_at=null) — returns skipped:cancelled', async () => {
    // Simulates: user cancelled AFTER cron snapshot but BEFORE finalizeUserDeletion runs.
    const cancelledUser = buildUserRow({ deletion_confirmed_at: null });
    const { service: svc, prisma } = await buildService(cancelledUser);

    // Call finalizeUserDeletion via runFinalizeCron so we test the full path.
    // We spy on the private method indirectly — the cron should NOT write
    // a deletion_audit row when skipped.
    const executeRawSpy = jest.spyOn(prisma, '$executeRaw');

    // Drive the cron (it uses findMany to get candidates, then calls finalize)
    // We can also test the private method directly via type-cast:
    const result = await (svc as unknown as {
      finalizeUserDeletion: (
        id: string,
        opts: { isAdminForced: boolean },
      ) => Promise<{ skipped?: string } | void>;
    }).finalizeUserDeletion('user-1', { isAdminForced: false });

    expect(result).toEqual({ skipped: 'cancelled' });

    // The transaction must NOT have been entered — no destructive writes
    expect(prisma.$transaction).not.toHaveBeenCalled();
    // No deletion_audit row written
    expect(executeRawSpy).not.toHaveBeenCalled();
  });

  it('skips finalization when user is already deleted (deleted_at set)', async () => {
    const alreadyDeletedUser = buildUserRow({ deleted_at: new Date() });
    const { service: svc, prisma } = await buildService(alreadyDeletedUser);

    const result = await (svc as unknown as {
      finalizeUserDeletion: (
        id: string,
        opts: { isAdminForced: boolean },
      ) => Promise<{ skipped?: string } | void>;
    }).finalizeUserDeletion('user-1', { isAdminForced: false });

    expect(result).toEqual({ skipped: 'already-deleted' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('proceeds with finalization when deletion_confirmed_at is set (normal cron path)', async () => {
    const confirmedUser = buildUserRow({
      deletion_confirmed_at: new Date(Date.now() - 15 * 86400 * 1000),
    });
    const { service: svc, prisma } = await buildService(confirmedUser);

    const result = await (svc as unknown as {
      finalizeUserDeletion: (
        id: string,
        opts: { isAdminForced: boolean },
      ) => Promise<{ skipped?: string } | void>;
    }).finalizeUserDeletion('user-1', { isAdminForced: false });

    // Returns void (no skipped key) on the normal path
    expect(result).toBeUndefined();
    // Transaction was entered
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('admin-force-delete bypasses the cancel check even when deletion_confirmed_at=null', async () => {
    const cancelledUser = buildUserRow({ deletion_confirmed_at: null });
    const { service: svc, prisma } = await buildService(cancelledUser);

    const result = await (svc as unknown as {
      finalizeUserDeletion: (
        id: string,
        opts: { isAdminForced: boolean },
      ) => Promise<{ skipped?: string } | void>;
    }).finalizeUserDeletion('user-1', { isAdminForced: true });

    // Admin path should proceed — no skipped result
    expect(result).toBeUndefined();
    // Transaction was entered for the scrub
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
  it('S-MWB B-640-3: deletes the client\'s own program copies inside the scrub transaction (the tombstoned User row never fires the FK cascade)', async () => {
    const confirmedUser = buildUserRow({
      deletion_confirmed_at: new Date(Date.now() - 15 * 86400 * 1000),
    });
    const { service: svc, txProxy } = await buildService(confirmedUser);
    const finalize = Reflect.get(svc, 'finalizeUserDeletion') as (
      id: string,
      opts: { isAdminForced: boolean },
    ) => Promise<{ skipped?: string } | void>;
    await finalize.call(svc, 'user-1', { isAdminForced: false });
    expect(txProxy.workoutProgram.deleteMany).toHaveBeenCalledWith({
      where: { client_id: 'user-1', is_template: false },
    });
    // ...and before the tombstone write, in the same transaction.
    const deleteOrder = txProxy.workoutProgram.deleteMany.mock.invocationCallOrder[0];
    const tombstoneOrder = txProxy.user.update.mock.invocationCallOrder[0];
    expect(deleteOrder).toBeLessThan(tombstoneOrder);
  });
});
