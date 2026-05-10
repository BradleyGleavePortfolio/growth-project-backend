import { ReportsService } from '../src/admin/reports/reports.service';

// ReportsService — verifies that:
//  - Each report wraps its payload in the canonical envelope shape
//    (`report`, `generated_at`, `window`, `data`) so a CSV/JSON dump is
//    self-describing.
//  - Coach and client reports project the documented column set without
//    inventing fields. No per-record activity counters appear in the
//    client report (privacy contract).
//  - Billing past-due is a pure read off CoachSubscription with status
//    'past_due' — no synthesised dunning state.
//  - The audit-summary report clamps since_days to [1, 365] and forwards
//    the same filters the live /admin/audit-log endpoint accepts.
//  - Federation/product-usage reports surface the underlying degraded
//    envelope verbatim (no zero-padding).

function makePrisma() {
  const coaches = [
    {
      id: 'coach-1',
      email: 'c1@x.test',
      name: 'Coach One',
      created_at: new Date('2026-01-01T00:00:00Z'),
      coach_profile: {
        business_name: 'Foo',
        invite_code: 'GP-AAAAAA',
        subscription_status: 'active',
        plan_tier: 'pro',
      },
      students: [{ archived_at: null }, { archived_at: new Date() }],
    },
    {
      id: 'coach-2',
      email: 'c2@x.test',
      name: 'Coach Two',
      created_at: new Date('2026-01-02T00:00:00Z'),
      coach_profile: null,
      students: [],
    },
  ];

  const students = [
    {
      id: 's-1',
      email: 's1@x.test',
      name: 'Student One',
      role: 'student',
      created_at: new Date('2026-02-01T00:00:00Z'),
      archived_at: null,
      coach_id: 'coach-1',
      coach: { email: 'c1@x.test' },
      deletion_scheduled_at: null,
    },
  ];

  const subs = [
    {
      coach_id: 'coach-1',
      coach: { email: 'c1@x.test' },
      status: 'past_due',
      current_period_end: new Date('2026-05-01T00:00:00Z'),
      last_payment_failed_at: new Date('2026-04-25T00:00:00Z'),
      failed_payments_this_month: 2,
      cancel_at_period_end: false,
      billing_email: 'pay@x.test',
    },
  ];

  const auditLogs = [
    {
      id: 'a-1',
      created_at: new Date('2026-04-27T00:00:00Z'),
      action: 'user.role_changed',
      actor_id: 'owner-1',
      actor_role: 'owner',
      actor_email_snapshot: 'o@x.test',
      target_user_id: 'u-1',
      target_type: 'user',
      target_id: 'u-1',
      tenant_coach_id: null,
      ip: '5.5.5.5',
      user_agent: 'jest',
      metadata: { from: 'student', to: 'coach' },
    },
  ];

  return {
    prisma: {
      user: {
        findMany: jest.fn(async ({ where }: any) => {
          if (where?.role === 'coach') return coaches;
          if (where?.role === 'student') return students;
          return [];
        }),
      },
      coachSubscription: {
        findMany: jest.fn(async () => subs),
      },
      auditLog: {
        findMany: jest.fn(async ({ where, take }: any) => {
          // Surface filter args back so the test can assert them.
          (auditLogs as any).$lastWhere = where;
          (auditLogs as any).$lastTake = take;
          return auditLogs;
        }),
      },
    } as any,
    coaches,
    students,
    subs,
    auditLogs,
  };
}

function build(opts: {
  metricsResult?: any;
  productUsage?: any;
  integrationsStatus?: any;
} = {}) {
  const { prisma } = makePrisma();
  const metrics: any = {
    getOverview: jest.fn(async () => ({
      window: { since_days: 30, since: '2026-03-29T00:00:00.000Z' },
      users: { total: 1, coaches: 1, clients: 0, new_in_window: 0 },
      ...(opts.metricsResult ?? {}),
    })),
  };
  const financeFederation: any = {
    getProductUsage: jest.fn(async () =>
      opts.productUsage ?? {
        status: 'ok',
        reason: null,
        detail: null,
        data: { dau: 1 },
        checked_at: '2026-04-28T00:00:00.000Z',
      },
    ),
    getIntegrationsStatus: jest.fn(async () =>
      opts.integrationsStatus ?? {
        checked_at: '2026-04-28T00:00:00.000Z',
        integrations: {
          finance_federation: {
            status: 'ok',
            configured: true,
            authenticated: true,
            base_url_present: true,
            probe: {
              attempted: true,
              outcome: 'ok',
              reason: null,
              detail: null,
              identity_mapping: 'email',
              service: 'finance',
            },
            checked_at: '2026-04-28T00:00:00.000Z',
          },
        },
      },
    ),
  };
  const audit: any = { write: jest.fn(), list: jest.fn() };
  // PTM weighted service is unused by the existing report specs; pass a
  // bare stub so the constructor signature is satisfied. The 1D-specific
  // ptm-signal-weights tests live in test/ptm-weighted-report.spec.ts
  // and seed a real-shaped stub there.
  const ptmWeighted: any = {
    isActive: jest.fn(async () => false),
    getCurrentWeights: jest.fn(async () => ({
      generated_at: '2026-05-06T00:00:00.000Z',
      training_count: 0,
      skipped_no_snapshot: 0,
      skipped_unclassified: 0,
      success_count: 0,
      failure_count: 0,
      weights: [],
    })),
  };
  const svc = new ReportsService(
    prisma,
    metrics,
    financeFederation,
    audit,
    ptmWeighted,
  );
  return { svc, prisma, metrics, financeFederation };
}

describe('ReportsService.metricsOverview', () => {
  it('wraps the live metrics payload in the report envelope and forwards window', async () => {
    const { svc, metrics } = build();
    const out = await svc.metricsOverview({ sinceDays: 7 });
    expect(metrics.getOverview).toHaveBeenCalledWith({ sinceDays: 7 });
    expect(out.report).toBe('metrics-overview');
    expect(typeof out.generated_at).toBe('string');
    expect(out.window).toEqual({
      since_days: 30,
      since: '2026-03-29T00:00:00.000Z',
    });
    expect(out.data.users.total).toBe(1);
  });
});

describe('ReportsService.coaches', () => {
  it('projects only the documented column set with derived counts', async () => {
    const { svc } = build();
    const out = await svc.coaches();
    expect(out.report).toBe('coaches');
    expect(out.window).toBeNull();
    expect(out.data).toHaveLength(2);
    const [c1, c2] = out.data;
    expect(c1).toEqual({
      id: 'coach-1',
      email: 'c1@x.test',
      name: 'Coach One',
      created_at: '2026-01-01T00:00:00.000Z',
      business_name: 'Foo',
      invite_code: 'GP-AAAAAA',
      subscription_status: 'active',
      plan_tier: 'pro',
      client_count: 2,
      active_client_count: 1, // one of the two students has archived_at set
    });
    // No CoachProfile → all profile-derived fields are null, not synthesised
    expect(c2.business_name).toBeNull();
    expect(c2.invite_code).toBeNull();
    expect(c2.subscription_status).toBeNull();
    expect(c2.client_count).toBe(0);
  });
});

describe('ReportsService.clients', () => {
  it('emits the client roster without per-record activity counters', async () => {
    const { svc } = build();
    const out = await svc.clients();
    expect(out.report).toBe('clients');
    expect(out.data).toHaveLength(1);
    const row = out.data[0];
    // Whitelist: privacy contract — these are the only keys the client
    // report is allowed to project. If a future change adds activity data
    // here, this assertion will fail and force the privacy review.
    expect(Object.keys(row).sort()).toEqual(
      [
        'archived_at',
        'coach_email',
        'coach_id',
        'created_at',
        'deletion_scheduled_at',
        'email',
        'id',
        'name',
      ].sort(),
    );
    expect(row.coach_email).toBe('c1@x.test');
  });

  it('clamps an absurd limit to MAX_LIMIT (5000)', async () => {
    const { svc, prisma } = build();
    await svc.clients({ limit: 10_000_000 });
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5000 }),
    );
  });
});

describe('ReportsService.billingPastDue', () => {
  it('reads CoachSubscription with status=past_due and projects flat columns', async () => {
    const { svc, prisma } = build();
    const out = await svc.billingPastDue();
    expect(prisma.coachSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'past_due' } }),
    );
    expect(out.report).toBe('billing-past-due');
    expect(out.data).toEqual([
      {
        coach_id: 'coach-1',
        coach_email: 'c1@x.test',
        status: 'past_due',
        current_period_end: '2026-05-01T00:00:00.000Z',
        last_payment_failed_at: '2026-04-25T00:00:00.000Z',
        failed_payments_this_month: 2,
        cancel_at_period_end: false,
        billing_email: 'pay@x.test',
      },
    ]);
  });
});

describe('ReportsService.productUsage', () => {
  it('passes through the finance degraded envelope verbatim — no zero-padding', async () => {
    const degraded = {
      status: 'degraded',
      reason: 'timeout',
      detail: 'finance backend timed out after 1500ms',
      data: null,
      checked_at: '2026-04-28T00:00:00.000Z',
    };
    const { svc } = build({ productUsage: degraded });
    const out = await svc.productUsage();
    expect(out.report).toBe('product-usage');
    expect(out.data).toEqual(degraded);
  });
});

describe('ReportsService.federationHealth', () => {
  it('wraps the integrations status envelope without modification', async () => {
    const { svc } = build();
    const out = await svc.federationHealth();
    expect(out.report).toBe('federation-health');
    expect(out.data.integrations.finance_federation.status).toBe('ok');
  });
});

describe('ReportsService.auditSummary', () => {
  it('clamps since_days to [1, 365] and forwards filters to prisma', async () => {
    const { svc, prisma } = build();
    await svc.auditSummary({
      action: 'user.',
      targetUserId: 'u-9',
      tenantCoachId: 'coach-3',
      sinceDays: 9999,
      limit: 10,
    });
    const args = (prisma.auditLog.findMany as jest.Mock).mock.calls[0][0];
    expect(args.where.action).toEqual({ startsWith: 'user.' });
    expect(args.where.target_user_id).toBe('u-9');
    expect(args.where.tenant_coach_id).toBe('coach-3');
    expect(args.take).toBe(10);
    // 9999 clamps to 365
    const since: Date = args.where.created_at.gte;
    const days = Math.round(
      (Date.now() - since.getTime()) / (24 * 60 * 60 * 1000),
    );
    expect(days).toBe(365);
  });

  it('projects audit rows without leaking the metadata payload', async () => {
    const { svc } = build();
    const out = await svc.auditSummary({});
    expect(out.report).toBe('audit-summary');
    expect(out.window?.since_days).toBe(30);
    const row = out.data[0] as any;
    expect(row).not.toHaveProperty('metadata');
    expect(row).not.toHaveProperty('user_agent');
    expect(row.actor_email).toBe('o@x.test'); // sourced from actor_email_snapshot
  });
});
