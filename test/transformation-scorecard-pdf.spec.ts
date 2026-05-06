// test/transformation-scorecard-pdf.spec.ts
//
// Covers:
//   1. GET /admin/reports/transformation-scorecard?format=pdf
//      → Content-Type: application/pdf
//      → Response body starts with `%PDF-` (valid PDF byte signature)
//   2. GET /admin/reports/transformation-scorecard?format=bad
//      → HTTP 400 with a human-readable message listing valid formats
//   3. format=json (default) still returns an envelope with data array (regression)
//   4. format=csv still returns text/csv (regression)
//
// Mocking strategy: NestJS Testing module with the real controller wired
// to a stub TransformationScorecardService (no Prisma, no finance calls).
// The PDF builder is called for real because we want to assert the byte
// signature — faking it would make the test circular.

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, BadRequestException } from '@nestjs/common';
import * as request from 'supertest';
import { ReportsController } from '../src/admin/reports/reports.controller';
import { TransformationScorecardService } from '../src/admin/reports/transformation-scorecard.service';
import { ReportsService } from '../src/admin/reports/reports.service';
import type { TransformationScorecardRow } from '../src/admin/reports/transformation-scorecard.service';

// ─── Minimal stub row ────────────────────────────────────────────────────────

const STUB_ROW: TransformationScorecardRow = {
  user_id: 'usr_test_001',
  email: 'test@example.com',
  name: 'Test Client',
  role: 'student',
  coach_email: 'coach@example.com',
  days_active: 42,
  latest_mood: 8,
  latest_energy: 7,
  latest_sleep_hrs: 7.5,
  starting_weight_lbs: 185.0,
  current_weight_lbs: 178.0,
  weight_delta_lbs: -7.0,
  workout_volume_30d: 12000,
  meals_logged_30d: 25,
  meal_consistency_pct_30d: 83.3,
  messages_sent_30d: 14,
  messages_received_30d: 12,
  ptm_risk_score: 0.32,
  ptm_success_score: 0.71,
  ptm_bucket: 'amber',
  latest_outcome: null,
  diagnostic_overall_score: 112,
  diagnostic_bucket: 'MOVING',
  build_week_status: 'completed',
  wealth_velocity_score: 7.4,
  net_worth_delta: 3200,
  milestones_hit: 3,
  generated_at: '2026-06-01T00:00:00.000Z',
};

const STUB_ENVELOPE = {
  report: 'transformation-scorecard',
  generated_at: '2026-06-01T00:00:00.000Z',
  window: { since_days: 90, since: '2026-03-03T00:00:00.000Z' },
  data: [STUB_ROW],
};

// ─── Guard stubs ─────────────────────────────────────────────────────────────

// We do not want to spin up real auth in unit tests. Provide a passthrough
// guard that always allows the request through.
import { CanActivate, ExecutionContext } from '@nestjs/common';
class AlwaysAllowGuard implements CanActivate {
  canActivate(_ctx: ExecutionContext): boolean {
    return true;
  }
}

// ─── Test module setup ───────────────────────────────────────────────────────

let app: INestApplication;
let scorecardService: Partial<TransformationScorecardService>;

beforeAll(async () => {
  scorecardService = {
    build: jest.fn().mockResolvedValue(STUB_ENVELOPE),
  };

  const reportsService: Partial<ReportsService> = {
    metricsOverview: jest.fn(),
    coaches: jest.fn(),
    clients: jest.fn(),
    billingPastDue: jest.fn(),
    productUsage: jest.fn(),
    federationHealth: jest.fn(),
    auditSummary: jest.fn(),
    ptmSignalWeights: jest.fn(),
  };

  const module: TestingModule = await Test.createTestingModule({
    controllers: [ReportsController],
    providers: [
      { provide: TransformationScorecardService, useValue: scorecardService },
      { provide: ReportsService, useValue: reportsService },
    ],
  })
    .overrideGuard('JwtAuthGuard' as never)
    .useClass(AlwaysAllowGuard)
    .overrideGuard('RolesGuard' as never)
    .useClass(AlwaysAllowGuard)
    .compile();

  app = module.createNestApplication();
  await app.init();
});

afterAll(async () => {
  await app.close();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GET /admin/reports/transformation-scorecard — PDF format', () => {
  it('returns Content-Type application/pdf when format=pdf', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/reports/transformation-scorecard?format=pdf')
      .expect(200);

    expect(res.headers['content-type']).toMatch(/application\/pdf/);
  });

  it('response body starts with %PDF- byte signature', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/reports/transformation-scorecard?format=pdf')
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);

    const bodyBuf = res.body as Buffer;
    // First 5 bytes of any valid PDF must be %PDF-
    const sig = bodyBuf.slice(0, 5).toString('ascii');
    expect(sig).toBe('%PDF-');
  });

  it('Content-Disposition header names the file as transformation-scorecard-<date>.pdf', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/reports/transformation-scorecard?format=pdf')
      .expect(200);

    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="transformation-scorecard-\d{8}\.pdf"/,
    );
  });

  it('sets Cache-Control: no-store on PDF response', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/reports/transformation-scorecard?format=pdf')
      .expect(200);

    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('GET /admin/reports/transformation-scorecard — format validation', () => {
  it('returns 400 for an unknown format value', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/reports/transformation-scorecard?format=xlsx')
      .expect(400);

    expect(res.body.message).toMatch(/format must be one of/i);
    // The error message must name the valid options
    expect(res.body.message).toMatch(/json/);
    expect(res.body.message).toMatch(/csv/);
    expect(res.body.message).toMatch(/pdf/);
  });

  it('returns 400 for format=XML (case insensitive check)', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/reports/transformation-scorecard?format=XML')
      .expect(400);

    expect(res.body.message).toMatch(/format must be one of/i);
  });

  it('returns 400 for format=html', async () => {
    await request(app.getHttpServer())
      .get('/admin/reports/transformation-scorecard?format=html')
      .expect(400);
  });
});

describe('GET /admin/reports/transformation-scorecard — JSON/CSV regression', () => {
  it('returns JSON envelope when no format param', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/reports/transformation-scorecard')
      .expect(200);

    expect(res.body).toHaveProperty('report', 'transformation-scorecard');
    expect(res.body).toHaveProperty('data');
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('returns JSON envelope for format=json', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/reports/transformation-scorecard?format=json')
      .expect(200);

    expect(res.body.report).toBe('transformation-scorecard');
  });

  it('returns text/csv for format=csv', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/reports/transformation-scorecard?format=csv')
      .expect(200);

    expect(res.headers['content-type']).toMatch(/text\/csv/);
  });

  it('GET /admin/reports manifest lists pdf as a valid format for transformation-scorecard', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/reports')
      .expect(200);

    const scorecard = (res.body.reports as Array<{ name: string; formats: string[] }>).find(
      (r) => r.name === 'transformation-scorecard',
    );
    expect(scorecard).toBeDefined();
    expect(scorecard?.formats).toContain('pdf');
    expect(scorecard?.formats).toContain('json');
    expect(scorecard?.formats).toContain('csv');
  });
});
