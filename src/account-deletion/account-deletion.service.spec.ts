import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccountDeletionService, DeletionAuditEvent } from './account-deletion.service';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    email: 'test@example.com',
    name: 'Test User',
    role: 'student',
    phone: null,
    supabase_id: 'supa-1',
    deleted_at: null,
    deletion_requested_at: null,
    deletion_confirmed_at: null,
    deletion_token_hash: null,
    deletion_token_expires_at: null,
    deletion_scheduled_at: null,
    archived_at: null,
    coach_id: null,
    created_at: new Date('2025-01-01'),
    first_win_completed_at: null,
    ...overrides,
  };
}

function buildPrisma() {
  return {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({}),
    },
    coachMessage: { updateMany: jest.fn().mockResolvedValue({}) },
    auditLog: { updateMany: jest.fn().mockResolvedValue({}) },
    mealPlan: { deleteMany: jest.fn().mockResolvedValue({}) },
    diagnosticSubmission: { updateMany: jest.fn().mockResolvedValue({}) },
    recipe: { deleteMany: jest.fn().mockResolvedValue({}) },
    lesson: { deleteMany: jest.fn().mockResolvedValue({}) },
    workoutRoutine: { deleteMany: jest.fn().mockResolvedValue({}) },
    coachGuideline: {
      updateMany: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({}),
    },
    coachNudge: { deleteMany: jest.fn().mockResolvedValue({}) },
    coachAlert: { deleteMany: jest.fn().mockResolvedValue({}) },
    activityEvent: { deleteMany: jest.fn().mockResolvedValue({}) },
    messageDraft: { deleteMany: jest.fn().mockResolvedValue({}) },
    communityWin: { updateMany: jest.fn().mockResolvedValue({}) },
    loggedFoodEntry: { deleteMany: jest.fn().mockResolvedValue({}) },
    workoutSession: { deleteMany: jest.fn().mockResolvedValue({}) },
    fastingWindow: { deleteMany: jest.fn().mockResolvedValue({}) },
    weightLog: { deleteMany: jest.fn().mockResolvedValue({}) },
    waterLog: { deleteMany: jest.fn().mockResolvedValue({}) },
    checkIn: { deleteMany: jest.fn().mockResolvedValue({}) },
    habit: { deleteMany: jest.fn().mockResolvedValue({}) },
    lessonCompletion: { deleteMany: jest.fn().mockResolvedValue({}) },
    savedRecipe: { deleteMany: jest.fn().mockResolvedValue({}) },
    listItem: { deleteMany: jest.fn().mockResolvedValue({}) },
    clientSignal: { deleteMany: jest.fn().mockResolvedValue({}) },
    clientOutcome: { deleteMany: jest.fn().mockResolvedValue({}) },
    ptmPrediction: { deleteMany: jest.fn().mockResolvedValue({}) },
    coachEffectivenessScore: { deleteMany: jest.fn().mockResolvedValue({}) },
    coachOnboardingProgress: { deleteMany: jest.fn().mockResolvedValue({}) },
    coachProfile: { deleteMany: jest.fn().mockResolvedValue({}) },
    coachSubscription: { deleteMany: jest.fn().mockResolvedValue({}) },
    invoice: { updateMany: jest.fn().mockResolvedValue({}) },
    paymentFailure: { deleteMany: jest.fn().mockResolvedValue({}) },
    inviteCode: { deleteMany: jest.fn().mockResolvedValue({}) },
    buildWeekEnrollment: { deleteMany: jest.fn().mockResolvedValue({}) },
    dataExportRequest: { deleteMany: jest.fn().mockResolvedValue({}) },
    clientCoachConsent: { deleteMany: jest.fn().mockResolvedValue({}) },
    notificationPreferences: { deleteMany: jest.fn().mockResolvedValue({}) },
    userPreferences: { deleteMany: jest.fn().mockResolvedValue({}) },
    userProfile: { deleteMany: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      // Run the callback with the same mock so we can assert on individual calls
      return fn({
        loggedFoodEntry: { deleteMany: jest.fn().mockResolvedValue({}) },
        workoutSession: { deleteMany: jest.fn().mockResolvedValue({}) },
        fastingWindow: { deleteMany: jest.fn().mockResolvedValue({}) },
        weightLog: { deleteMany: jest.fn().mockResolvedValue({}) },
        waterLog: { deleteMany: jest.fn().mockResolvedValue({}) },
        checkIn: { deleteMany: jest.fn().mockResolvedValue({}) },
        habit: { deleteMany: jest.fn().mockResolvedValue({}) },
        lessonCompletion: { deleteMany: jest.fn().mockResolvedValue({}) },
        communityWin: { deleteMany: jest.fn().mockResolvedValue({}) },
        savedRecipe: { deleteMany: jest.fn().mockResolvedValue({}) },
        listItem: { deleteMany: jest.fn().mockResolvedValue({}) },
        clientSignal: { deleteMany: jest.fn().mockResolvedValue({}) },
        clientOutcome: { deleteMany: jest.fn().mockResolvedValue({}) },
        ptmPrediction: { deleteMany: jest.fn().mockResolvedValue({}) },
        coachEffectivenessScore: { deleteMany: jest.fn().mockResolvedValue({}) },
        coachOnboardingProgress: { deleteMany: jest.fn().mockResolvedValue({}) },
        coachProfile: { deleteMany: jest.fn().mockResolvedValue({}) },
        coachSubscription: { deleteMany: jest.fn().mockResolvedValue({}) },
        invoice: { updateMany: jest.fn().mockResolvedValue({}) },
        paymentFailure: { deleteMany: jest.fn().mockResolvedValue({}) },
        inviteCode: { deleteMany: jest.fn().mockResolvedValue({}) },
        buildWeekEnrollment: { deleteMany: jest.fn().mockResolvedValue({}) },
        dataExportRequest: { deleteMany: jest.fn().mockResolvedValue({}) },
        clientCoachConsent: { deleteMany: jest.fn().mockResolvedValue({}) },
        notificationPreferences: { deleteMany: jest.fn().mockResolvedValue({}) },
        userPreferences: { deleteMany: jest.fn().mockResolvedValue({}) },
        userProfile: { deleteMany: jest.fn().mockResolvedValue({}) },
        user: { update: jest.fn().mockResolvedValue({}) },
      });
    }),
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('AccountDeletionService', () => {
  let service: AccountDeletionService;
  let prisma: ReturnType<typeof buildPrisma>;
  let auditService: { write: jest.Mock };

  beforeEach(async () => {
    prisma = buildPrisma();
    auditService = { write: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountDeletionService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: auditService },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'DELETION_GRACE_DAYS') return '14';
              if (key === 'DELETION_TOKEN_TTL_HOURS') return '24';
              if (key === 'APP_BASE_URL') return 'https://test.example.com';
              return undefined;
            },
          },
        },
      ],
    }).compile();

    service = module.get<AccountDeletionService>(AccountDeletionService);
  });

  // ── requestDeletion ────────────────────────────────────────────────────────

  describe('requestDeletion', () => {
    it('throws NotFoundException when user does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.requestDeletion('missing-id')).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when account is already deleted', async () => {
      prisma.user.findUnique.mockResolvedValue(mockUser({ deleted_at: new Date() }));
      await expect(service.requestDeletion('user-1')).rejects.toThrow(BadRequestException);
    });

    it('sets deletion_requested_at and a token hash', async () => {
      prisma.user.findUnique.mockResolvedValue(mockUser());
      const result = await service.requestDeletion('user-1');

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'user-1' },
          data: expect.objectContaining({
            deletion_requested_at: expect.any(Date),
            deletion_token_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
            deletion_token_expires_at: expect.any(Date),
          }),
        }),
      );
      expect(result.expires_at).toBeDefined();
    });

    it('is idempotent when a valid token already exists', async () => {
      const tokenExpiresAt = new Date(Date.now() + 1_000_000);
      prisma.user.findUnique.mockResolvedValue(
        mockUser({
          deletion_requested_at: new Date(),
          deletion_token_hash: 'existinghash',
          deletion_token_expires_at: tokenExpiresAt,
        }),
      );
      const result = await service.requestDeletion('user-1');
      // Should NOT call user.update when token is still valid
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(result.expires_at).toBe(tokenExpiresAt.toISOString());
    });

    it('writes an audit log entry', async () => {
      prisma.user.findUnique.mockResolvedValue(mockUser());
      await service.requestDeletion('user-1');
      expect(auditService.write).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'account_deletion.requested' }),
      );
    });
  });

  // ── confirmDeletion ────────────────────────────────────────────────────────

  describe('confirmDeletion', () => {
    it('throws UnauthorizedException when token does not match any user', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      await expect(service.confirmDeletion('badtoken')).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when token is expired', async () => {
      // findFirst returns a user but with an expired token
      prisma.user.findFirst.mockResolvedValue(
        mockUser({
          deletion_token_expires_at: new Date(Date.now() - 1000),
          deletion_requested_at: new Date(),
        }),
      );
      await expect(service.confirmDeletion('expiredtoken')).rejects.toThrow(UnauthorizedException);
    });

    it('sets deletion_confirmed_at and clears the token (single-use)', async () => {
      const validExpiry = new Date(Date.now() + 1_000_000);
      prisma.user.findFirst.mockResolvedValue(
        mockUser({
          deletion_token_expires_at: validExpiry,
          deletion_requested_at: new Date(),
          deletion_token_hash: 'somehash',
        }),
      );
      const result = await service.confirmDeletion('validtoken');

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            deletion_confirmed_at: expect.any(Date),
            // Token cleared after single use
            deletion_token_hash: null,
            deletion_token_expires_at: null,
          }),
        }),
      );
      expect(result.purge_after).toBeDefined();
    });

    it('returns a purge_after 14 days in the future', async () => {
      const validExpiry = new Date(Date.now() + 1_000_000);
      prisma.user.findFirst.mockResolvedValue(
        mockUser({ deletion_token_expires_at: validExpiry, deletion_requested_at: new Date() }),
      );
      const result = await service.confirmDeletion('token');
      const purgeAfter = new Date(result.purge_after);
      const diffMs = purgeAfter.getTime() - Date.now();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeGreaterThan(13.9);
      expect(diffDays).toBeLessThan(14.1);
    });

    it('token hash comparison is one-way (SHA-256)', async () => {
      // A fresh token generates a sha256 hash. We verify the hash stored in DB
      // is never the raw token.
      const crypto = await import('crypto');
      const rawToken = 'a'.repeat(64);
      const expectedHash = crypto.createHash('sha256').update(rawToken).digest('hex');

      prisma.user.findFirst.mockImplementation(({ where }: { where: { deletion_token_hash: string } }) => {
        if (where.deletion_token_hash === expectedHash) {
          return Promise.resolve(
            mockUser({
              deletion_token_expires_at: new Date(Date.now() + 1_000_000),
              deletion_requested_at: new Date(),
              deletion_token_hash: expectedHash,
            }),
          );
        }
        return Promise.resolve(null);
      });

      // Confirm with raw token — service should hash it internally
      const result = await service.confirmDeletion(rawToken);
      expect(result.purge_after).toBeDefined();
      // Verify the stored hash is NOT the raw token
      expect(expectedHash).not.toBe(rawToken);
    });
  });

  // ── cancelDeletion ─────────────────────────────────────────────────────────

  describe('cancelDeletion', () => {
    it('throws NotFoundException when user does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.cancelDeletion('missing')).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when nothing is scheduled', async () => {
      prisma.user.findUnique.mockResolvedValue(mockUser());
      await expect(service.cancelDeletion('user-1')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when grace period has expired', async () => {
      const confirmedLongAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
      prisma.user.findUnique.mockResolvedValue(
        mockUser({
          deletion_requested_at: confirmedLongAgo,
          deletion_confirmed_at: confirmedLongAgo,
        }),
      );
      await expect(service.cancelDeletion('user-1')).rejects.toThrow(BadRequestException);
    });

    it('clears all deletion fields on valid cancel', async () => {
      prisma.user.findUnique.mockResolvedValue(
        mockUser({
          deletion_requested_at: new Date(),
          deletion_confirmed_at: new Date(),
        }),
      );
      const result = await service.cancelDeletion('user-1');

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            deletion_requested_at: null,
            deletion_confirmed_at: null,
            deletion_token_hash: null,
            deletion_token_expires_at: null,
          }),
        }),
      );
      expect(result.message).toMatch(/cancelled/i);
    });

    it('can cancel when only REQUESTED (not yet confirmed)', async () => {
      prisma.user.findUnique.mockResolvedValue(
        mockUser({ deletion_requested_at: new Date() }),
      );
      await expect(service.cancelDeletion('user-1')).resolves.toBeDefined();
    });

    it('writes an audit entry on cancel', async () => {
      prisma.user.findUnique.mockResolvedValue(
        mockUser({ deletion_requested_at: new Date(), deletion_confirmed_at: new Date() }),
      );
      await service.cancelDeletion('user-1');
      expect(auditService.write).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'account_deletion.cancelled' }),
      );
    });
  });

  // ── getDeletionStatus ──────────────────────────────────────────────────────

  describe('getDeletionStatus', () => {
    it('returns state=none when no deletion requested', async () => {
      prisma.user.findUnique.mockResolvedValue(mockUser());
      const status = await service.getDeletionStatus('user-1');
      expect(status.state).toBe('none');
    });

    it('returns state=requested when only requested', async () => {
      prisma.user.findUnique.mockResolvedValue(
        mockUser({ deletion_requested_at: new Date() }),
      );
      const status = await service.getDeletionStatus('user-1');
      expect(status.state).toBe('requested');
    });

    it('returns state=confirmed when confirmed', async () => {
      prisma.user.findUnique.mockResolvedValue(
        mockUser({
          deletion_requested_at: new Date(),
          deletion_confirmed_at: new Date(),
        }),
      );
      const status = await service.getDeletionStatus('user-1');
      expect(status.state).toBe('confirmed');
      expect(status.purge_after).toBeDefined();
    });

    it('returns state=deleted when deleted_at is set', async () => {
      prisma.user.findUnique.mockResolvedValue(
        mockUser({ deleted_at: new Date() }),
      );
      const status = await service.getDeletionStatus('user-1');
      expect(status.state).toBe('deleted');
    });
  });

  // ── adminForceDelete ───────────────────────────────────────────────────────

  describe('adminForceDelete', () => {
    it('throws NotFoundException when target user does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(
        service.adminForceDelete('missing', {
          actorId: 'admin-1',
          actorRole: 'owner',
          actorEmail: 'admin@example.com',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('is idempotent when user is already deleted', async () => {
      prisma.user.findUnique.mockResolvedValue(mockUser({ deleted_at: new Date() }));
      const result = await service.adminForceDelete('user-1', {
        actorId: 'admin-1',
        actorRole: 'owner',
        actorEmail: null,
      });
      expect(result.message).toMatch(/already deleted/i);
      // Should NOT call $transaction for already-deleted user
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('writes both deletion_audit and AuditLog on force-delete', async () => {
      prisma.user.findUnique.mockResolvedValue(mockUser());
      await service.adminForceDelete('user-1', {
        actorId: 'admin-1',
        actorRole: 'owner',
        actorEmail: 'admin@example.com',
        reason: 'test force-delete',
      });

      expect(auditService.write).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'account_deletion.admin_force_delete' }),
      );
      expect(prisma.$executeRaw).toHaveBeenCalled();
    });

    it('runs finalizeUserDeletion (calls $transaction)', async () => {
      prisma.user.findUnique.mockResolvedValue(mockUser());
      await service.adminForceDelete('user-1', {
        actorId: 'admin-1',
        actorRole: 'owner',
        actorEmail: null,
      });
      expect(prisma.$transaction).toHaveBeenCalled();
    });
  });

  // ── Full lifecycle ─────────────────────────────────────────────────────────

  describe('full lifecycle: request → confirm → cancel works during grace', () => {
    it('allows request → confirm → cancel within 14 days', async () => {
      // Step 1: request
      prisma.user.findUnique.mockResolvedValue(mockUser());
      const req = await service.requestDeletion('user-1');
      expect(req.expires_at).toBeDefined();

      // Step 2: confirm
      const validExpiry = new Date(Date.now() + 1_000_000);
      prisma.user.findFirst.mockResolvedValue(
        mockUser({
          deletion_token_expires_at: validExpiry,
          deletion_requested_at: new Date(),
          deletion_token_hash: 'anyhash',
        }),
      );
      const confirm = await service.confirmDeletion('sometoken');
      expect(confirm.purge_after).toBeDefined();

      // Step 3: cancel within grace
      prisma.user.findUnique.mockResolvedValue(
        mockUser({
          deletion_requested_at: new Date(),
          deletion_confirmed_at: new Date(),
        }),
      );
      const cancel = await service.cancelDeletion('user-1');
      expect(cancel.message).toMatch(/cancelled/i);
    });
  });

  // ── Finalize cron ──────────────────────────────────────────────────────────

  describe('runFinalizeCron', () => {
    it('does nothing when no candidates are past the grace cutoff', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      await service.runFinalizeCron();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('finalizes each past-grace candidate and writes audit', async () => {
      prisma.user.findMany.mockResolvedValue([
        { id: 'user-1', email: 'test@example.com' },
        { id: 'user-2', email: 'other@example.com' },
      ]);
      // Make findUnique succeed for each candidate (called by finalizeUserDeletion)
      prisma.user.findUnique.mockResolvedValue(mockUser());

      await service.runFinalizeCron();

      // Both candidates should have their PII scrubbed
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      // Two audit log entries (one per user)
      expect(auditService.write).toHaveBeenCalledTimes(2);
    });

    it('is idempotent: re-running on already-finalized users (deleted_at set) skips them', async () => {
      // findMany returns empty because WHERE deleted_at IS NULL filters them out
      prisma.user.findMany.mockResolvedValue([]);
      await service.runFinalizeCron();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // ── Expired tokens are rejected ─────────────────────────────────────────────

  describe('expired token rejection', () => {
    it('rejects a confirm call with an expired token', async () => {
      prisma.user.findFirst.mockResolvedValue(
        mockUser({
          deletion_token_expires_at: new Date(Date.now() - 5000),
          deletion_requested_at: new Date(),
          deletion_token_hash: 'hash',
        }),
      );
      await expect(service.confirmDeletion('token')).rejects.toThrow(UnauthorizedException);
    });
  });

  // ── DeletionAuditEvent constants ───────────────────────────────────────────

  describe('DeletionAuditEvent constants', () => {
    it('exports the expected event strings', () => {
      expect(DeletionAuditEvent.DELETION_REQUESTED).toBe('deletion_requested');
      expect(DeletionAuditEvent.DELETION_CONFIRMED).toBe('deletion_confirmed');
      expect(DeletionAuditEvent.DELETION_CANCELLED).toBe('deletion_cancelled');
      expect(DeletionAuditEvent.DELETION_FINALIZED).toBe('deletion_finalized');
      expect(DeletionAuditEvent.ADMIN_FORCE_DELETE).toBe('admin_force_delete');
    });
  });
});
