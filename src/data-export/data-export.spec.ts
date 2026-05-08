import { Test, TestingModule } from '@nestjs/testing';
import { DataExportService } from './data-export.service';
import { DataExportCleanupCron } from './data-export-cleanup.cron';
import { PrismaService } from '../prisma.service';
import {
  ConflictException,
  NotFoundException,
  UnauthorizedException,
  GoneException,
} from '@nestjs/common';
import { DataExportStatus } from '@prisma/client';
import { SignJWT } from 'jose';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeExportRecord(
  overrides: Partial<{
    id: string;
    user_id: string;
    status: DataExportStatus;
    file_url: string | null;
    created_at: Date;
    completed_at: Date | null;
    expires_at: Date | null;
    file_size_bytes: number | null;
    sha256: string | null;
  }> = {},
) {
  return {
    id: overrides.id ?? 'export-1',
    user_id: overrides.user_id ?? 'user-1',
    status: overrides.status ?? DataExportStatus.PENDING,
    file_url: overrides.file_url ?? null,
    created_at: overrides.created_at ?? new Date('2026-01-01T00:00:00Z'),
    completed_at: overrides.completed_at ?? null,
    expires_at: overrides.expires_at ?? null,
    file_size_bytes: overrides.file_size_bytes ?? null,
    sha256: overrides.sha256 ?? null,
  };
}

// ─── Prisma mock factory ──────────────────────────────────────────────────────

function buildPrismaMock() {
  return {
    dataExportRequest: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
    // All other models return empty arrays for export assembly
    userProfile: { findMany: jest.fn().mockResolvedValue([]) },
    userPreferences: { findMany: jest.fn().mockResolvedValue([]) },
    notificationPreferences: { findMany: jest.fn().mockResolvedValue([]) },
    weightLog: { findMany: jest.fn().mockResolvedValue([]) },
    loggedFoodEntry: { findMany: jest.fn().mockResolvedValue([]) },
    workoutSession: { findMany: jest.fn().mockResolvedValue([]) },
    fastingWindow: { findMany: jest.fn().mockResolvedValue([]) },
    waterLog: { findMany: jest.fn().mockResolvedValue([]) },
    habit: { findMany: jest.fn().mockResolvedValue([]) },
    lessonCompletion: { findMany: jest.fn().mockResolvedValue([]) },
    checkIn: { findMany: jest.fn().mockResolvedValue([]) },
    savedRecipe: { findMany: jest.fn().mockResolvedValue([]) },
    listItem: { findMany: jest.fn().mockResolvedValue([]) },
    coachMessage: { findMany: jest.fn().mockResolvedValue([]) },
    coachNudge: { findMany: jest.fn().mockResolvedValue([]) },
    messageDraft: { findMany: jest.fn().mockResolvedValue([]) },
    mealPlan: { findMany: jest.fn().mockResolvedValue([]) },
    communityWin: { findMany: jest.fn().mockResolvedValue([]) },
    coachGuideline: { findMany: jest.fn().mockResolvedValue([]) },
    buildWeekEnrollment: { findUnique: jest.fn().mockResolvedValue(null) },
    buildWeekDayCompletion: { findMany: jest.fn().mockResolvedValue([]) },
    inviteCode: { findMany: jest.fn().mockResolvedValue([]) },
    diagnosticSubmission: { findMany: jest.fn().mockResolvedValue([]) },
    clientSignal: { findMany: jest.fn().mockResolvedValue([]) },
    ptmPrediction: { findMany: jest.fn().mockResolvedValue([]) },
    auditLog: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
    },
  };
}

// ─── JWT helper ───────────────────────────────────────────────────────────────

const TOKEN_SECRET_STR =
  process.env.DATA_EXPORT_TOKEN_SECRET ?? 'change-me-in-production-min32chars!';

async function mintToken(
  overrides: Partial<{
    sub: string;
    eid: string;
    type: string;
    expiresIn: string;
  }> = {},
): Promise<string> {
  return new SignJWT({
    eid: overrides.eid ?? 'export-1',
    type: overrides.type ?? 'data_export_download',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(overrides.sub ?? 'user-1')
    .setIssuedAt()
    .setExpirationTime(overrides.expiresIn ?? '7d')
    .sign(new TextEncoder().encode(TOKEN_SECRET_STR));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DataExportService', () => {
  let service: DataExportService;
  let prismaMock: ReturnType<typeof buildPrismaMock>;

  beforeEach(async () => {
    prismaMock = buildPrismaMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DataExportService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    service = module.get<DataExportService>(DataExportService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── requestExport ─────────────────────────────────────────────────────────

  describe('requestExport', () => {
    it('creates a new PENDING record and fires background export', async () => {
      prismaMock.dataExportRequest.findFirst.mockResolvedValue(null);
      const created = makeExportRecord({ status: DataExportStatus.PENDING });
      prismaMock.dataExportRequest.create.mockResolvedValue(created);
      prismaMock.dataExportRequest.update.mockResolvedValue(created);
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'a@b.com',
        name: 'Alice',
      });

      const result = await service.requestExport('user-1');

      expect(prismaMock.dataExportRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            user_id: 'user-1',
            status: DataExportStatus.PENDING,
          }),
        }),
      );
      expect(result.status).toBe(DataExportStatus.PENDING);
    });

    it('throws ConflictException when a PENDING export exists within 24h', async () => {
      prismaMock.dataExportRequest.findFirst.mockResolvedValue(
        makeExportRecord({ status: DataExportStatus.PENDING }),
      );

      await expect(service.requestExport('user-1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('throws ConflictException when a READY export exists within 24h', async () => {
      prismaMock.dataExportRequest.findFirst.mockResolvedValue(
        makeExportRecord({ status: DataExportStatus.READY }),
      );

      await expect(service.requestExport('user-1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('allows a new request when no PENDING/READY export exists (FAILED excluded)', async () => {
      prismaMock.dataExportRequest.findFirst.mockResolvedValue(null);
      const created = makeExportRecord();
      prismaMock.dataExportRequest.create.mockResolvedValue(created);
      prismaMock.dataExportRequest.update.mockResolvedValue(created);
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'a@b.com',
        name: 'Alice',
      });

      const result = await service.requestExport('user-1');
      expect(result.status).toBe(DataExportStatus.PENDING);
    });
  });

  // ── getLatestStatus ───────────────────────────────────────────────────────

  describe('getLatestStatus', () => {
    it('returns 404 when no export exists', async () => {
      prismaMock.dataExportRequest.findFirst.mockResolvedValue(null);

      await expect(service.getLatestStatus('user-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns status fields for a READY export', async () => {
      const record = makeExportRecord({
        status: DataExportStatus.READY,
        file_url: 'https://s3.example.com/export.json',
        completed_at: new Date(),
        expires_at: new Date(Date.now() + 7 * 86400 * 1000),
        file_size_bytes: 12345,
      });
      prismaMock.dataExportRequest.findFirst.mockResolvedValue(record);

      const result = await service.getLatestStatus('user-1');

      expect(result.status).toBe(DataExportStatus.READY);
      expect(result.file_size_bytes).toBe(12345);
      // Download token must be present for READY exports
      expect(result.download_token).toBeTruthy();
      // Raw file_url must NOT be returned
      expect((result as Record<string, unknown>).file_url).toBeUndefined();
    });

    it('returns null download_token for PENDING exports', async () => {
      prismaMock.dataExportRequest.findFirst.mockResolvedValue(
        makeExportRecord({ status: DataExportStatus.PENDING }),
      );

      const result = await service.getLatestStatus('user-1');
      expect(result.download_token).toBeNull();
    });
  });

  // ── resolveDownloadUrl ────────────────────────────────────────────────────

  describe('resolveDownloadUrl', () => {
    it('returns the file URL for a valid token + READY export', async () => {
      const record = makeExportRecord({
        id: 'export-1',
        user_id: 'user-1',
        status: DataExportStatus.READY,
        file_url: 'https://s3.example.com/export.json',
        expires_at: new Date(Date.now() + 7 * 86400 * 1000),
      });
      prismaMock.dataExportRequest.findUnique.mockResolvedValue(record);

      const token = await mintToken();
      const url = await service.resolveDownloadUrl(token);
      expect(url).toBe('https://s3.example.com/export.json');
    });

    it('throws UnauthorizedException for an invalid token', async () => {
      await expect(
        service.resolveDownloadUrl('not-a-valid-jwt'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when token user does not match record user', async () => {
      const record = makeExportRecord({
        id: 'export-1',
        user_id: 'other-user',
        status: DataExportStatus.READY,
        file_url: 'https://s3.example.com/export.json',
        expires_at: new Date(Date.now() + 7 * 86400 * 1000),
      });
      prismaMock.dataExportRequest.findUnique.mockResolvedValue(record);

      const token = await mintToken({ sub: 'user-1' }); // token sub != record user_id
      await expect(service.resolveDownloadUrl(token)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws GoneException (410) for an EXPIRED export', async () => {
      const record = makeExportRecord({
        id: 'export-1',
        user_id: 'user-1',
        status: DataExportStatus.EXPIRED,
      });
      prismaMock.dataExportRequest.findUnique.mockResolvedValue(record);

      const token = await mintToken();
      await expect(service.resolveDownloadUrl(token)).rejects.toThrow(
        GoneException,
      );
    });

    it('throws GoneException and marks expired when wall-clock expiry passes', async () => {
      const record = makeExportRecord({
        id: 'export-1',
        user_id: 'user-1',
        status: DataExportStatus.READY,
        file_url: 'https://s3.example.com/export.json',
        expires_at: new Date(Date.now() - 1000),
      });
      prismaMock.dataExportRequest.findUnique.mockResolvedValue(record);
      prismaMock.dataExportRequest.update.mockResolvedValue({
        ...record,
        status: DataExportStatus.EXPIRED,
      });

      const token = await mintToken();
      await expect(service.resolveDownloadUrl(token)).rejects.toThrow(
        GoneException,
      );
      expect(prismaMock.dataExportRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'export-1' },
          data: { status: DataExportStatus.EXPIRED },
        }),
      );
    });
  });

  // ── expireOldExports ──────────────────────────────────────────────────────

  describe('expireOldExports', () => {
    it('marks READY past-expiry rows as EXPIRED', async () => {
      const records = [
        makeExportRecord({
          id: 'e1',
          status: DataExportStatus.READY,
          file_url: 'local:///tmp/exports/e1.json',
          expires_at: new Date(Date.now() - 1000),
        }),
        makeExportRecord({
          id: 'e2',
          status: DataExportStatus.READY,
          file_url: 'local:///tmp/exports/e2.json',
          expires_at: new Date(Date.now() - 2000),
        }),
      ];
      prismaMock.dataExportRequest.findMany.mockResolvedValue(records);
      prismaMock.dataExportRequest.update.mockResolvedValue({});

      await service.expireOldExports();

      expect(prismaMock.dataExportRequest.update).toHaveBeenCalledTimes(2);
      for (const r of records) {
        expect(prismaMock.dataExportRequest.update).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: r.id },
            data: { status: DataExportStatus.EXPIRED },
          }),
        );
      }
    });

    it('handles an empty result set gracefully', async () => {
      prismaMock.dataExportRequest.findMany.mockResolvedValue([]);
      await expect(service.expireOldExports()).resolves.not.toThrow();
      expect(prismaMock.dataExportRequest.update).not.toHaveBeenCalled();
    });
  });
});

// ─── DataExportCleanupCron tests ──────────────────────────────────────────────

describe('DataExportCleanupCron', () => {
  let cron: DataExportCleanupCron;
  let serviceStub: { expireOldExports: jest.Mock };

  beforeEach(async () => {
    serviceStub = { expireOldExports: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DataExportCleanupCron,
        { provide: DataExportService, useValue: serviceStub },
      ],
    }).compile();

    cron = module.get<DataExportCleanupCron>(DataExportCleanupCron);
  });

  it('calls expireOldExports', async () => {
    await cron.handleCleanup();
    expect(serviceStub.expireOldExports).toHaveBeenCalledTimes(1);
  });

  it('does not throw when expireOldExports rejects', async () => {
    serviceStub.expireOldExports.mockRejectedValue(new Error('S3 down'));
    await expect(cron.handleCleanup()).resolves.not.toThrow();
  });
});
