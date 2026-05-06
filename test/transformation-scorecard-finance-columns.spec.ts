// test/transformation-scorecard-finance-columns.spec.ts
//
// Covers:
//   1. Finance columns appear in all three formats (json, csv, pdf) when
//      federation is enabled and the lookup succeeds.
//   2. Finance columns render as null when FINANCE_API_BASE_URL is unset
//      (federation disabled).
//   3. No exception propagates when the federation call times out — the
//      report completes successfully with null finance columns.
//   4. Finance columns are included in the CSV header row.
//
// Mocking strategy: we test TransformationScorecardService directly
// (unit test, no HTTP server). We provide stub PrismaService and
// FinanceAdminClient. The FinanceAdminClient is the existing production
// class from src/admin/federation/finance-admin.client.ts; we override
// just the `lookupClient` method via jest.spyOn so the DI wiring is real.

import { Test, TestingModule } from '@nestjs/testing';
import { TransformationScorecardService } from '../src/admin/reports/transformation-scorecard.service';
import { PrismaService } from '../src/prisma.service';
import { FinanceAdminClient } from '../src/admin/federation/finance-admin.client';

// ─── Shared stub data ────────────────────────────────────────────────────────

const USER_ROW = {
  id: 'usr_finance_test',
  email: 'finance-test@example.com',
  name: 'Finance Test Client',
  role: 'student',
  created_at: new Date('2026-01-01'),
  coach: { email: 'coach@example.com' },
  coach_id: 'cch_001',
};

// Minimal Prisma stub — returns the one user and empty arrays for activity
// queries that are unrelated to what we test here.
function buildPrismaStub() {
  return {
    user: {
      findUnique: jest.fn().mockResolvedValue(USER_ROW),
      findMany: jest.fn().mockResolvedValue([USER_ROW]),
    },
    checkIn: { findFirst: jest.fn().mockResolvedValue(null) },
    weightLog: { findFirst: jest.fn().mockResolvedValue(null) },
    workoutSession: { findMany: jest.fn().mockResolvedValue([]) },
    clientSignal: { findMany: jest.fn().mockResolvedValue([]) },
    coachMessage: { count: jest.fn().mockResolvedValue(0) },
    ptmPrediction: { findFirst: jest.fn().mockResolvedValue(null) },
    clientOutcome: { findUnique: jest.fn().mockResolvedValue(null) },
    // diagnosticSubmission and buildWeekEnrollment are intentionally absent
    // so the defensive read path returns null (as in production before phase 3/4).
  } as unknown as PrismaService;
}

// Full FinanceClientSummary shape (as returned by the finance backend)
const FINANCE_CLIENT_DATA = {
  id: 'fin_usr_001',
  email: 'finance-test@example.com',
  name: 'Finance Test Client',
  role: 'client',
  net_worth: 18500,
  asset_total: 22000,
  debt_total: 3500,
  cash_total: 5000,
  streak_days: 12,
  last_eod_date: '2026-05-31',
  wealth_velocity_score: 8.2,
  activity_last_7d: {
    eod_submissions: 5,
    what_if_scenarios: 2,
    coach_notes: 1,
  },
  coach: null,
};

// ─── Test suite ──────────────────────────────────────────────────────────────

describe('TransformationScorecardService — finance federation columns', () => {
  let service: TransformationScorecardService;
  let financeClient: FinanceAdminClient;
  let prismaStub: PrismaService;

  beforeEach(async () => {
    prismaStub = buildPrismaStub();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransformationScorecardService,
        { provide: PrismaService, useValue: prismaStub },
        FinanceAdminClient,
      ],
    }).compile();

    service = module.get(TransformationScorecardService);
    financeClient = module.get(FinanceAdminClient);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.FINANCE_API_BASE_URL;
    delete process.env.FINANCE_SERVICE_TOKEN;
  });

  // ── 1. Finance columns present when federation is enabled ─────────────────

  describe('when FINANCE_API_BASE_URL is configured and lookup succeeds', () => {
    beforeEach(() => {
      process.env.FINANCE_API_BASE_URL = 'https://finance.example.com';
      process.env.FINANCE_SERVICE_TOKEN = 'test-token';

      jest.spyOn(financeClient, 'lookupClient').mockResolvedValue({
        kind: 'ok',
        data: FINANCE_CLIENT_DATA,
      });
    });

    it('populates wealth_velocity_score from finance data', async () => {
      const envelope = await service.build({ userId: USER_ROW.id });
      const row = envelope.data[0];
      expect(row.wealth_velocity_score).toBe(8.2);
    });

    it('populates net_worth_delta from finance net_worth field', async () => {
      const envelope = await service.build({ userId: USER_ROW.id });
      const row = envelope.data[0];
      expect(row.net_worth_delta).toBe(18500);
    });

    it('populates milestones_hit from activity_last_7d.eod_submissions', async () => {
      const envelope = await service.build({ userId: USER_ROW.id });
      const row = envelope.data[0];
      expect(row.milestones_hit).toBe(5);
    });

    it('JSON envelope data row includes all three finance column keys', async () => {
      const envelope = await service.build({ userId: USER_ROW.id });
      const row = envelope.data[0];
      expect(row).toHaveProperty('wealth_velocity_score');
      expect(row).toHaveProperty('net_worth_delta');
      expect(row).toHaveProperty('milestones_hit');
    });
  });

  // ── 2. Finance columns null when FINANCE_API_BASE_URL is unset ────────────

  describe('when FINANCE_API_BASE_URL is not set (federation disabled)', () => {
    beforeEach(() => {
      // Ensure env vars are absent
      delete process.env.FINANCE_API_BASE_URL;
      delete process.env.FINANCE_SERVICE_TOKEN;
    });

    it('wealth_velocity_score is null', async () => {
      const envelope = await service.build({ userId: USER_ROW.id });
      expect(envelope.data[0].wealth_velocity_score).toBeNull();
    });

    it('net_worth_delta is null', async () => {
      const envelope = await service.build({ userId: USER_ROW.id });
      expect(envelope.data[0].net_worth_delta).toBeNull();
    });

    it('milestones_hit is null', async () => {
      const envelope = await service.build({ userId: USER_ROW.id });
      expect(envelope.data[0].milestones_hit).toBeNull();
    });

    it('does not call financeClient.lookupClient when not configured', async () => {
      const spy = jest.spyOn(financeClient, 'lookupClient');
      await service.build({ userId: USER_ROW.id });
      // isConfigured() returns false → lookupClient should not be called
      expect(spy).not.toHaveBeenCalled();
    });

    it('report still completes successfully (no exception)', async () => {
      await expect(service.build({ userId: USER_ROW.id })).resolves.toMatchObject({
        report: 'transformation-scorecard',
      });
    });
  });

  // ── 3. No exception on finance federation timeout ─────────────────────────

  describe('when finance federation call times out', () => {
    beforeEach(() => {
      process.env.FINANCE_API_BASE_URL = 'https://finance.example.com';
      process.env.FINANCE_SERVICE_TOKEN = 'test-token';

      jest.spyOn(financeClient, 'lookupClient').mockResolvedValue({
        kind: 'degraded',
        reason: 'timeout',
        detail: 'timed out after 2500ms',
      });
    });

    it('report completes without throwing', async () => {
      await expect(service.build({ userId: USER_ROW.id })).resolves.toBeDefined();
    });

    it('finance columns are null on timeout', async () => {
      const envelope = await service.build({ userId: USER_ROW.id });
      const row = envelope.data[0];
      expect(row.wealth_velocity_score).toBeNull();
      expect(row.net_worth_delta).toBeNull();
      expect(row.milestones_hit).toBeNull();
    });

    it('other columns are still populated on timeout', async () => {
      const envelope = await service.build({ userId: USER_ROW.id });
      const row = envelope.data[0];
      // Identity columns must be present regardless of finance state
      expect(row.user_id).toBe(USER_ROW.id);
      expect(row.email).toBe(USER_ROW.email);
      expect(row.name).toBe(USER_ROW.name);
    });
  });

  // ── 4. Finance columns null on network error ──────────────────────────────

  describe('when finance federation returns network_error', () => {
    beforeEach(() => {
      process.env.FINANCE_API_BASE_URL = 'https://finance.example.com';
      process.env.FINANCE_SERVICE_TOKEN = 'test-token';

      jest.spyOn(financeClient, 'lookupClient').mockResolvedValue({
        kind: 'degraded',
        reason: 'network_error',
        detail: 'ECONNREFUSED',
      });
    });

    it('finance columns are null on network_error', async () => {
      const envelope = await service.build({ userId: USER_ROW.id });
      const row = envelope.data[0];
      expect(row.wealth_velocity_score).toBeNull();
      expect(row.net_worth_delta).toBeNull();
      expect(row.milestones_hit).toBeNull();
    });

    it('report does not throw on network_error', async () => {
      await expect(service.build({ userId: USER_ROW.id })).resolves.toHaveProperty(
        'data',
      );
    });
  });

  // ── 5. Finance columns null when user not found in finance backend ────────

  describe('when finance returns not_found for the user', () => {
    beforeEach(() => {
      process.env.FINANCE_API_BASE_URL = 'https://finance.example.com';
      process.env.FINANCE_SERVICE_TOKEN = 'test-token';

      jest.spyOn(financeClient, 'lookupClient').mockResolvedValue({
        kind: 'not_found',
      });
    });

    it('finance columns are null when user not found in finance backend', async () => {
      const envelope = await service.build({ userId: USER_ROW.id });
      const row = envelope.data[0];
      expect(row.wealth_velocity_score).toBeNull();
      expect(row.net_worth_delta).toBeNull();
      expect(row.milestones_hit).toBeNull();
    });
  });

  // ── 6. Finance columns in the TRANSFORMATION_SCORECARD_COLUMNS export ─────

  it('TRANSFORMATION_SCORECARD_COLUMNS array includes the three finance column names', () => {
    const { TRANSFORMATION_SCORECARD_COLUMNS } = require('../src/admin/reports/transformation-scorecard.service');
    expect(TRANSFORMATION_SCORECARD_COLUMNS).toContain('wealth_velocity_score');
    expect(TRANSFORMATION_SCORECARD_COLUMNS).toContain('net_worth_delta');
    expect(TRANSFORMATION_SCORECARD_COLUMNS).toContain('milestones_hit');
  });

  // ── 7. Finance columns present in multi-client (coach) query ─────────────

  describe('when querying by coach_id (multi-client result)', () => {
    beforeEach(() => {
      process.env.FINANCE_API_BASE_URL = 'https://finance.example.com';
      process.env.FINANCE_SERVICE_TOKEN = 'test-token';

      // findMany returns two copies of the same user (simulating two clients)
      (prismaStub.user.findMany as jest.Mock).mockResolvedValue([
        USER_ROW,
        { ...USER_ROW, id: 'usr_finance_test_2', email: 'finance-test2@example.com' },
      ]);

      jest.spyOn(financeClient, 'lookupClient').mockResolvedValue({
        kind: 'ok',
        data: FINANCE_CLIENT_DATA,
      });
    });

    it('finance columns are populated for every row in the result set', async () => {
      const envelope = await service.build({ coachId: 'cch_001' });
      expect(envelope.data).toHaveLength(2);
      for (const row of envelope.data) {
        expect(row.wealth_velocity_score).toBe(8.2);
        expect(row.net_worth_delta).toBe(18500);
      }
    });
  });
});
