import { ReportsController } from '../src/admin/reports/reports.controller';

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
  const scorecard: any = { run: jest.fn() };
  return {
    ctrl: new ReportsController(reports as any, scorecard),
    reports,
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

  it('treats unknown ?format values as JSON (no CSV headers, no string body)', async () => {
    const { ctrl } = build();
    const res = makeRes();
    const out = await ctrl.coaches('xml', res);
    expect(typeof out).toBe('object');
    expect(res.setHeader).not.toHaveBeenCalled();
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
    for (const r of out.reports) {
      expect(r.formats).toEqual(['json', 'csv']);
    }
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
