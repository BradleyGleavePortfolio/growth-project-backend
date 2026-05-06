import { ReportsController } from '../src/admin/reports/reports.controller';
import { BadRequestException } from '@nestjs/common';

// Controller-level tests: verifies the controller hands the right options
// to the service, switches between JSON and CSV based on ?format=, and
// sets Content-Type / Content-Disposition / Cache-Control on CSV
// responses. The class-level @Roles('owner') guard is exercised via the
// route-doc-drift / throttler suites that walk every controller's guard
// configuration; here we focus on the per-handler logic.

function makeRes() {
  const headers = new Map<string, string>();
  return {
    setHeader: jest.fn((k: string, v: string) => headers.set(k, v)),
    pipe: jest.fn(),
    headers,
  } as any;
}

function envelope<T>(data: T, extras: Partial<{ window: any }> = {}) {
  return {
    report: 'r',
    generated_at: '2026-04-28T00:00:00.000Z',
    window: extras.window ?? null,
    data,
  };
}

// Minimal stub scorecard row for PDF/CSV tests
const STUB_SCORECARD_ROW = {
  user_id: 'u-1',
  email: 'a@x.test',
  name: 'Alice',
  role: 'student',
  coach_email: null,
  days_active: 42,
  latest_mood: null,
  latest_energy: null,
  latest_sleep_hrs: null,
  starting_weight_lbs: null,
  current_weight_lbs: null,
  weight_delta_lbs: null,
  workout_volume_30d: 0,
  meals_logged_30d: 0,
  meal_consistency_pct_30d: 0,
  messages_sent_30d: 0,
  messages_received_30d: 0,
  ptm_risk_score: 0.4,
  ptm_success_score: 0.6,
  ptm_bucket: 'amber',
  latest_outcome: null,
  diagnostic_overall_score: null,
  diagnostic_bucket: null,
  build_week_status: null,
  wealth_velocity_score: null,
  net_worth_delta: null,
  milestones_hit: null,
  generated_at: '2026-04-28T00:00:00.000Z',
};

function build() {
  const reports: any = {
    metricsOverview: jest.fn(async () =>
      envelope({ users: { total: 1 } }, { window: { since_days: 30, since: 's' } }),
    ),
    coaches: jest.fn(async () =>
      envelope([
        {
          id: 'c1',
          email: 'c1@x.test',
          name: 'Coach',
          created_at: '2026-01-01T00:00:00.000Z',
          business_name: null,
          invite_code: null,
          subscription_status: null,
          plan_tier: null,
          client_count: 0,
          active_client_count: 0,
        },
      ]),
    ),
    clients: jest.fn(async () =>
      envelope([
        {
          id: 's1',
          email: 's1@x.test',
          name: 'Stu',
          created_at: '2026-01-01T00:00:00.000Z',
          archived_at: null,
          coach_id: null,
          coach_email: null,
          deletion_scheduled_at: null,
        },
      ]),
    ),
    billingPastDue: jest.fn(async () =>
      envelope([
        {
          coach_id: 'c1',
          coach_email: 'c1@x.test',
          status: 'past_due',
          current_period_end: null,
          last_payment_failed_at: null,
          failed_payments_this_month: 0,
          cancel_at_period_end: false,
          billing_email: null,
        },
      ]),
    ),
    productUsage: jest.fn(async () => envelope({ status: 'ok' })),
    federationHealth: jest.fn(async () => envelope({ integrations: {} })),
    auditSummary: jest.fn(async () => envelope([])),
  };
  // The controller now also injects TransformationScorecardService —
  // pass a no-op stub so the constructor signature is satisfied. The
  // scorecard surface has its own spec.
  const scorecard: any = {
    build: jest.fn(async () =>
      envelope([STUB_SCORECARD_ROW], {
        window: { since_days: 90, since: '2026-01-28T00:00:00.000Z' },
      }),
    ),
  };
  return {
    ctrl: new ReportsController(reports as any, scorecard),
    reports,
    scorecard,
  };
}

describe('ReportsController — JSON default', () => {
  it('returns the envelope payload when ?format is unset', async () => {
    const { ctrl } = build();
    const res = makeRes();
    const out = await ctrl.metricsOverview(undefined, undefined, res);
    expect(typeof (out as any).generated_at).toBe('string');
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('forwards since_days to the service when provided', async () => {
    const { ctrl, reports } = build();
    await ctrl.metricsOverview(undefined, '7', makeRes());
    expect(reports.metricsOverview).toHaveBeenCalledWith({ sinceDays: 7 });
  });

  it('drops a non-numeric since_days instead of forwarding NaN', async () => {
    const { ctrl, reports } = build();
    await ctrl.metricsOverview(undefined, 'abc', makeRes());
    expect(reports.metricsOverview).toHaveBeenCalledWith({ sinceDays: undefined });
  });
});

describe('ReportsController — CSV format', () => {
  it('sets Content-Type, Content-Disposition, and Cache-Control on CSV responses', async () => {
    const { ctrl } = build();
    const res = makeRes();
    const body = await ctrl.coaches('csv', res);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'text/csv; charset=utf-8',
    );
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const cd = res.headers.get('Content-Disposition');
    expect(cd).toMatch(/^attachment; filename="coaches-\d{8}\.csv"$/);
    expect(body).toContain(
      'id,email,name,created_at,business_name,invite_code,subscription_status,plan_tier,client_count,active_client_count\r\n',
    );
    expect(body).toContain('c1,c1@x.test,Coach');
  });

  it('emits clients CSV with the exact privacy-reviewed column header', async () => {
    const { ctrl } = build();
    const body = await ctrl.clients('csv', undefined, makeRes());
    expect(body).toMatch(
      /^id,email,name,created_at,archived_at,coach_id,coach_email,deletion_scheduled_at\r\n/,
    );
  });

  it('emits billing-past-due CSV with the canonical column order', async () => {
    const { ctrl } = build();
    const body = await ctrl.billingPastDue('csv', makeRes());
    expect(body).toMatch(
      /^coach_id,coach_email,status,current_period_end,last_payment_failed_at,failed_payments_this_month,cancel_at_period_end,billing_email\r\n/,
    );
  });

  it('flattens metrics-overview as key/value CSV', async () => {
    const { ctrl } = build();
    const body = await ctrl.metricsOverview('csv', undefined, makeRes());
    expect(body).toMatch(/^key,value\r\n/);
    expect(body).toContain('report,r\r\n');
    expect(body).toContain('data.users.total,1\r\n');
  });

  it('treats unknown ?format values as JSON (no CSV headers, no string body) for non-scorecard endpoints', async () => {
    const { ctrl } = build();
    const res = makeRes();
    const out = await ctrl.coaches('xml', res);
    expect(typeof out).toBe('object');
    expect(res.setHeader).not.toHaveBeenCalled();
  });
});

describe('ReportsController — transformation scorecard format handling', () => {
  it('returns JSON envelope for format=json', async () => {
    const { ctrl } = build();
    const out = await ctrl.transformationScorecard('json', undefined, undefined, undefined, makeRes());
    expect(typeof (out as any).report).toBe('string');
  });

  it('returns JSON envelope when format is undefined', async () => {
    const { ctrl } = build();
    const out = await ctrl.transformationScorecard(undefined, undefined, undefined, undefined, makeRes());
    expect(typeof (out as any).report).toBe('string');
  });

  it('returns CSV string for format=csv', async () => {
    const { ctrl } = build();
    const res = makeRes();
    const body = await ctrl.transformationScorecard('csv', undefined, undefined, undefined, res);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8');
    expect(typeof body).toBe('string');
  });

  it('throws BadRequestException for unknown format values', async () => {
    const { ctrl } = build();
    await expect(
      ctrl.transformationScorecard('xlsx', undefined, undefined, undefined, makeRes()),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequestException for format=html', async () => {
    const { ctrl } = build();
    await expect(
      ctrl.transformationScorecard('html', undefined, undefined, undefined, makeRes()),
    ).rejects.toThrow(BadRequestException);
  });

  it('sets PDF headers and calls res.pipe for format=pdf', async () => {
    const { ctrl } = build();
    const res = makeRes();
    await ctrl.transformationScorecard('pdf', undefined, undefined, undefined, res);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/pdf');
    const cd = res.headers.get('Content-Disposition');
    expect(cd).toMatch(/transformation-scorecard-\d{8}\.pdf/);
    // The PDF stream pipes directly into res
    expect(res.pipe).toHaveBeenCalled();
  });
});

describe('ReportsController — index manifest', () => {
  it('lists all available report names without inventing extras', () => {
    const { ctrl } = build();
    const out = ctrl.index();
    const names = out.reports.map((r) => r.name).sort();
    expect(names).toEqual(
      [
        'audit-summary',
        'billing-past-due',
        'clients',
        'coaches',
        'federation-health',
        'metrics-overview',
        'product-usage',
        'ptm-signal-weights',
        'transformation-scorecard',
      ].sort(),
    );
    // All reports support json and csv
    for (const r of out.reports) {
      expect(r.formats).toContain('json');
      expect(r.formats).toContain('csv');
    }
    // transformation-scorecard additionally supports pdf
    const scorecard = out.reports.find((r) => r.name === 'transformation-scorecard');
    expect(scorecard?.formats).toContain('pdf');
  });
});

describe('ReportsController — audit-summary filters', () => {
  it('forwards every documented filter to the service', async () => {
    const { ctrl, reports } = build();
    await ctrl.auditSummary(
      undefined,
      'user.role_changed',
      'u-1',
      'coach-3',
      '7',
      '50',
      makeRes(),
    );
    expect(reports.auditSummary).toHaveBeenCalledWith({
      action: 'user.role_changed',
      targetUserId: 'u-1',
      tenantCoachId: 'coach-3',
      sinceDays: 7,
      limit: 50,
    });
  });
});
