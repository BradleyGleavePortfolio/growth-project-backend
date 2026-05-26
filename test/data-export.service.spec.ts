// Regression suite for DataExportService.requestExport rate-limit predicate.
//
// Context: A1-C5-P2-1 / A1-C5-INF-2 (PR-A C5 audit R1).
//          A1-C5-P1-2 — DB-level uniqueness via create+catch(P2002).
//
// The original predicate only blocked PENDING and READY rows. Because
// _runExport() flips a fresh row to RUNNING immediately, a user could
// spam POST /v1/me/data-export/request during a long-running export and
// create concurrent GDPR jobs.
//
// This file is intentionally located under `test/` (not `src/data-export/`)
// because jest is rooted at `<rootDir>/test` only — specs under `src/` are
// not executed by CI. The previous in-source spec
// (`src/data-export/data-export.spec.ts`) was dormant.
import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { DataExportStatus, Prisma } from '@prisma/client';
import { DataExportService } from '../src/data-export/data-export.service';
import { PrismaService } from '../src/prisma.service';

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
    created_at: overrides.created_at ?? new Date(),
    completed_at: overrides.completed_at ?? null,
    expires_at: overrides.expires_at ?? null,
    file_size_bytes: overrides.file_size_bytes ?? null,
    sha256: overrides.sha256 ?? null,
  };
}

// Minimal Prisma mock. requestExport only touches dataExportRequest
// (findFirst + create) and best-effort auditLog.create — _runExport is
// fire-and-forget and its dependencies don't need to resolve for the
// rate-limit predicate under test, but we stub the models it touches with
// empty results so the unhandled-rejection logger stays quiet.
function buildPrismaMock() {
  const noopFindMany = jest.fn().mockResolvedValue([]);
  return {
    dataExportRequest: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'user-1', email: 'a@b.com', name: 'A' }),
    },
    userProfile: { findMany: noopFindMany },
    userPreferences: { findMany: noopFindMany },
    notificationPreferences: { findMany: noopFindMany },
    weightLog: { findMany: noopFindMany },
    loggedFoodEntry: { findMany: noopFindMany },
    workoutSession: { findMany: noopFindMany },
    fastingWindow: { findMany: noopFindMany },
    waterLog: { findMany: noopFindMany },
    habit: { findMany: noopFindMany },
    lessonCompletion: { findMany: noopFindMany },
    checkIn: { findMany: noopFindMany },
    savedRecipe: { findMany: noopFindMany },
    listItem: { findMany: noopFindMany },
    coachMessage: { findMany: noopFindMany },
    coachNudge: { findMany: noopFindMany },
    messageDraft: { findMany: noopFindMany },
    mealPlan: { findMany: noopFindMany },
    communityWin: { findMany: noopFindMany },
    coachGuideline: { findMany: noopFindMany },
    buildWeekEnrollment: { findUnique: jest.fn().mockResolvedValue(null) },
    buildWeekDayCompletion: { findMany: noopFindMany },
    inviteCode: { findMany: noopFindMany },
    diagnosticSubmission: { findMany: noopFindMany },
    clientSignal: { findMany: noopFindMany },
    ptmPrediction: { findMany: noopFindMany },
    auditLog: {
      findMany: noopFindMany,
      create: jest.fn().mockResolvedValue({}),
    },
  };
}

describe('DataExportService.requestExport — rate-limit predicate', () => {
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

  // ── Floor-raising regression: every non-terminal status MUST block ────────

  it('rejects a new request when a PENDING export exists in the window', async () => {
    prismaMock.dataExportRequest.findFirst.mockResolvedValue(
      makeExportRecord({ status: DataExportStatus.PENDING }),
    );

    await expect(service.requestExport('user-1')).rejects.toThrow(
      ConflictException,
    );
    expect(prismaMock.dataExportRequest.create).not.toHaveBeenCalled();
  });

  it('rejects a new request when a RUNNING export exists in the window (regression A1-C5-INF-2)', async () => {
    // Before the fix, RUNNING was excluded from the predicate. _runExport()
    // flips a fresh row to RUNNING immediately, so the original code allowed
    // a user to spam concurrent GDPR jobs while one was being assembled.
    prismaMock.dataExportRequest.findFirst.mockResolvedValue(
      makeExportRecord({ status: DataExportStatus.RUNNING }),
    );

    await expect(service.requestExport('user-1')).rejects.toThrow(
      ConflictException,
    );
    expect(prismaMock.dataExportRequest.create).not.toHaveBeenCalled();
  });

  it('rejects a new request when a READY export exists in the window', async () => {
    prismaMock.dataExportRequest.findFirst.mockResolvedValue(
      makeExportRecord({ status: DataExportStatus.READY }),
    );

    await expect(service.requestExport('user-1')).rejects.toThrow(
      ConflictException,
    );
    expect(prismaMock.dataExportRequest.create).not.toHaveBeenCalled();
  });

  it('passes PENDING, RUNNING, and READY to the duplicate-check predicate (predicate-shape guard)', async () => {
    prismaMock.dataExportRequest.findFirst.mockResolvedValue(null);
    prismaMock.dataExportRequest.create.mockResolvedValue(
      makeExportRecord({ status: DataExportStatus.PENDING }),
    );

    await service.requestExport('user-1');

    expect(prismaMock.dataExportRequest.findFirst).toHaveBeenCalledTimes(1);
    const call = prismaMock.dataExportRequest.findFirst.mock.calls[0][0];
    const statusFilter = call.where.status.in;
    // Must include every non-terminal status. We compare as sets so the
    // ordering inside the array is not a load-bearing detail of the test.
    expect(new Set(statusFilter)).toEqual(
      new Set([
        DataExportStatus.PENDING,
        DataExportStatus.RUNNING,
        DataExportStatus.READY,
      ]),
    );
    // Must NOT block on terminal states — those represent finished work the
    // user should be able to follow up on.
    expect(statusFilter).not.toContain(DataExportStatus.FAILED);
    expect(statusFilter).not.toContain(DataExportStatus.EXPIRED);
  });

  it('allows a new request when only a FAILED export exists (terminal status excluded)', async () => {
    prismaMock.dataExportRequest.findFirst.mockResolvedValue(null);
    prismaMock.dataExportRequest.create.mockResolvedValue(
      makeExportRecord({ status: DataExportStatus.PENDING }),
    );

    const result = await service.requestExport('user-1');

    expect(result.status).toBe(DataExportStatus.PENDING);
    expect(prismaMock.dataExportRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          user_id: 'user-1',
          status: DataExportStatus.PENDING,
        }),
      }),
    );
  });

  // ── A1-C5-P1-2: DB-level uniqueness — create+catch(P2002) path ────────────

  it('converts a Prisma P2002 on create to ConflictException (TOCTOU race guard)', async () => {
    // Simulates the race: both concurrent requests passed findFirst (both saw
    // null), but the second one lost the DB unique-index race.
    prismaMock.dataExportRequest.findFirst.mockResolvedValue(null);

    const p2002 = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the fields: (`user_id`)',
      { code: 'P2002', clientVersion: '5.0.0', meta: {} },
    );
    prismaMock.dataExportRequest.create.mockRejectedValue(p2002);

    await expect(service.requestExport('user-1')).rejects.toThrow(
      ConflictException,
    );
    // The create was attempted (fast-path findFirst passed)
    expect(prismaMock.dataExportRequest.create).toHaveBeenCalledTimes(1);
  });

  it('P2002 ConflictException carries the structured EXPORT_ALREADY_IN_PROGRESS body', async () => {
    prismaMock.dataExportRequest.findFirst.mockResolvedValue(null);

    const p2002 = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the fields: (`user_id`)',
      { code: 'P2002', clientVersion: '5.0.0', meta: {} },
    );
    prismaMock.dataExportRequest.create.mockRejectedValue(p2002);

    await expect(service.requestExport('user-1')).rejects.toMatchObject({
      response: expect.objectContaining({
        error: 'EXPORT_ALREADY_IN_PROGRESS',
      }),
    });
  });

  it('re-throws non-P2002 Prisma errors from create (unknown error path)', async () => {
    prismaMock.dataExportRequest.findFirst.mockResolvedValue(null);

    const p2025 = new Prisma.PrismaClientKnownRequestError(
      'Record to update not found.',
      { code: 'P2025', clientVersion: '5.0.0', meta: {} },
    );
    prismaMock.dataExportRequest.create.mockRejectedValue(p2025);

    // Must propagate — not silently converted to ConflictException
    await expect(service.requestExport('user-1')).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
  });
});
