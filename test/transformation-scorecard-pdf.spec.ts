// test/transformation-scorecard-pdf.spec.ts
//
// Covers:
//   1. GET /admin/reports/transformation-scorecard?format=pdf
//      → Content-Type: application/pdf header set on response
//      → Content-Disposition: attachment; filename="transformation-scorecard-YYYYMMDD.pdf"
//      → Cache-Control: no-store
//   2. GET /admin/reports/transformation-scorecard?format=bad
//      → throws BadRequestException with a message listing valid formats
//   3. buildScorecardPdf returns a stream whose first bytes are %PDF-
//   4. format=json (default) still returns an envelope (regression)
//   5. format=csv still sets text/csv headers (regression)
//
// Mocking strategy: Direct controller instantiation (same pattern as the
// existing reports.controller.spec.ts). No HTTP server, no supertest.
// The PDF builder is called for real so we can assert the byte signature.

import { BadRequestException } from '@nestjs/common';
import { ReportsController } from '../src/admin/reports/reports.controller';
import { buildScorecardPdf } from '../src/admin/reports/scorecard-pdf';
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRes() {
  const headers = new Map<string, string>();
  return {
    setHeader: jest.fn((k: string, v: string) => headers.set(k, v)),
    // write/end are called by pdfkit stream piping machinery
    write: jest.fn(),
    end: jest.fn(),
    on: jest.fn(),
    headers,
  } as any;
}

function buildController() {
  const scorecardService: any = {
    build: jest.fn().mockResolvedValue(STUB_ENVELOPE),
  };
  const reportsService: any = {
    metricsOverview: jest.fn(),
    coaches: jest.fn(),
    clients: jest.fn(),
    billingPastDue: jest.fn(),
    productUsage: jest.fn(),
    federationHealth: jest.fn(),
    auditSummary: jest.fn(),
    ptmSignalWeights: jest.fn(),
  };
  return new ReportsController(reportsService, scorecardService);
}

// ─── Tests: PDF response headers ─────────────────────────────────────────────

describe('GET /admin/reports/transformation-scorecard — PDF format', () => {
  it('sets Content-Type: application/pdf when format=pdf', async () => {
    const ctrl = buildController();
    const res = makeRes();
    await ctrl.transformationScorecard('pdf', undefined, undefined, undefined, res);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
  });

  it('Content-Disposition names the file as transformation-scorecard-<date>.pdf', async () => {
    const ctrl = buildController();
    const res = makeRes();
    await ctrl.transformationScorecard('pdf', undefined, undefined, undefined, res);
    const cd = res.headers.get('Content-Disposition');
    expect(cd).toMatch(/attachment; filename="transformation-scorecard-\d{8}\.pdf"/);
  });

  it('sets Cache-Control: no-store on PDF response', async () => {
    const ctrl = buildController();
    const res = makeRes();
    await ctrl.transformationScorecard('pdf', undefined, undefined, undefined, res);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

// ─── Tests: PDF byte signature ────────────────────────────────────────────────

describe('buildScorecardPdf — byte signature', () => {
  it('returns a stream that emits a %PDF- byte signature at position 0', async () => {
    const doc = buildScorecardPdf([STUB_ROW], {
      clientName: STUB_ROW.name,
      generatedAt: STUB_ROW.generated_at,
    });

    const firstBytes = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: unknown) => {
        const buf = chunk as Buffer;
        chunks.push(buf);
        const total = Buffer.concat(chunks);
        if (total.length >= 5) {
          resolve(total.slice(0, 5).toString('ascii'));
        }
      });
      doc.on('end', () => {
        const total = Buffer.concat(chunks);
        resolve(total.slice(0, 5).toString('ascii'));
      });
      doc.on('error', (err: unknown) => reject(err as Error));
    });

    expect(firstBytes).toBe('%PDF-');
  });

  it('produces a stream without throwing when given an empty rows array', (done) => {
    const doc = buildScorecardPdf([]);
    doc.on('data', () => { /* consume */ });
    doc.on('end', done);
    doc.on('error', done);
  });

  it('produces a stream without throwing when given multiple rows', (done) => {
    const doc = buildScorecardPdf([STUB_ROW, STUB_ROW]);
    doc.on('data', () => { /* consume */ });
    doc.on('end', done);
    doc.on('error', done);
  });
});

// ─── Tests: format validation ─────────────────────────────────────────────────

describe('GET /admin/reports/transformation-scorecard — format validation', () => {
  it('throws BadRequestException for an unknown format value', async () => {
    const ctrl = buildController();
    await expect(
      ctrl.transformationScorecard('xlsx', undefined, undefined, undefined, makeRes()),
    ).rejects.toThrow(BadRequestException);
  });

  it('BadRequestException message names the valid formats', async () => {
    const ctrl = buildController();
    let caught: unknown;
    try {
      await ctrl.transformationScorecard('xlsx', undefined, undefined, undefined, makeRes());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    const message = (caught as BadRequestException).message;
    expect(message).toMatch(/json/);
    expect(message).toMatch(/csv/);
    expect(message).toMatch(/pdf/);
  });

  it('throws BadRequestException for format=XML (case-insensitive check)', async () => {
    const ctrl = buildController();
    await expect(
      ctrl.transformationScorecard('XML', undefined, undefined, undefined, makeRes()),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequestException for format=html', async () => {
    const ctrl = buildController();
    await expect(
      ctrl.transformationScorecard('html', undefined, undefined, undefined, makeRes()),
    ).rejects.toThrow(BadRequestException);
  });

  it('does NOT throw for format=pdf (valid)', async () => {
    const ctrl = buildController();
    await expect(
      ctrl.transformationScorecard('pdf', undefined, undefined, undefined, makeRes()),
    ).resolves.not.toThrow();
  });

  it('does NOT throw for format=csv (valid)', async () => {
    const ctrl = buildController();
    await expect(
      ctrl.transformationScorecard('csv', undefined, undefined, undefined, makeRes()),
    ).resolves.not.toThrow();
  });

  it('does NOT throw for format=json (valid)', async () => {
    const ctrl = buildController();
    await expect(
      ctrl.transformationScorecard('json', undefined, undefined, undefined, makeRes()),
    ).resolves.not.toThrow();
  });
});

// ─── Tests: JSON / CSV regression ────────────────────────────────────────────

describe('GET /admin/reports/transformation-scorecard — JSON/CSV regression', () => {
  it('returns JSON envelope when no format param', async () => {
    const ctrl = buildController();
    const out = await ctrl.transformationScorecard(undefined, undefined, undefined, undefined, makeRes());
    expect(out).toHaveProperty('report', 'transformation-scorecard');
    expect(out).toHaveProperty('data');
    expect(Array.isArray((out as any).data)).toBe(true);
  });

  it('returns JSON envelope for format=json', async () => {
    const ctrl = buildController();
    const out = await ctrl.transformationScorecard('json', undefined, undefined, undefined, makeRes());
    expect((out as any).report).toBe('transformation-scorecard');
  });

  it('sets text/csv header for format=csv', async () => {
    const ctrl = buildController();
    const res = makeRes();
    await ctrl.transformationScorecard('csv', undefined, undefined, undefined, res);
    expect(res.headers.get('Content-Type')).toMatch(/text\/csv/);
  });

  it('manifest index lists pdf as a valid format for transformation-scorecard', () => {
    const ctrl = buildController();
    const out = ctrl.index();
    const scorecard = out.reports.find((r) => r.name === 'transformation-scorecard');
    expect(scorecard).toBeDefined();
    expect(scorecard?.formats).toContain('pdf');
    expect(scorecard?.formats).toContain('json');
    expect(scorecard?.formats).toContain('csv');
  });
});
