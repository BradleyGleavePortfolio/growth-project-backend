// test/churn-intervention.service.spec.ts
//
// Unit tests for ChurnInterventionService. The Anthropic client is
// injected via the CHURN_ANTHROPIC_CLIENT_TOKEN so no real network
// traffic occurs.

import { ChurnInterventionService } from '../src/coach/command-center/churn-intervention.service';

const VALID_UUID = '11111111-1111-4111-8111-111111111111';
const VALID_UUID_2 = '22222222-2222-4222-8222-222222222222';

interface FakeRows {
  users: any[];
  predictions: any[];
  alerts: any[];
  interventions: any[];
  nudges: any[];
  checkIns: any[];
}

function buildPrisma(initial: Partial<FakeRows> = {}): any {
  const rows: FakeRows = {
    users: initial.users ?? [],
    predictions: initial.predictions ?? [],
    alerts: initial.alerts ?? [],
    interventions: initial.interventions ?? [],
    nudges: initial.nudges ?? [],
    checkIns: initial.checkIns ?? [],
  };

  let interventionCounter = 0;
  let nudgeCounter = 0;

  return {
    rows,
    user: {
      findMany: jest.fn(async ({ where }: any) => {
        return rows.users.filter((u) => {
          if (where.coach_id && u.coach_id !== where.coach_id) return false;
          if (where.role && u.role !== where.role) return false;
          if (where.deleted_at === null && u.deleted_at !== null) return false;
          return true;
        });
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        return rows.users.find((u) => {
          if (where.id && u.id !== where.id) return false;
          if (where.coach_id && u.coach_id !== where.coach_id) return false;
          if (where.role && u.role !== where.role) return false;
          if (where.deleted_at === null && u.deleted_at !== null) return false;
          return true;
        }) ?? null;
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        return rows.users.find((u) => u.id === where.id) ?? null;
      }),
    },
    ptmPrediction: {
      groupBy: jest.fn(async ({ where }: any) => {
        const filtered = rows.predictions.filter((p) => {
          if (where.user_id?.in && !where.user_id.in.includes(p.user_id)) return false;
          return true;
        });
        const byUser = new Map<string, Date>();
        for (const p of filtered) {
          const prev = byUser.get(p.user_id);
          if (!prev || p.computed_at > prev) byUser.set(p.user_id, p.computed_at);
        }
        return Array.from(byUser.entries()).map(([uid, max]) => ({
          user_id: uid,
          _max: { computed_at: max },
        }));
      }),
      findMany: jest.fn(async ({ where }: any) => {
        const ors = where.OR ?? [];
        return rows.predictions
          .filter((p) =>
            ors.some(
              (o: any) =>
                o.user_id === p.user_id &&
                o.computed_at?.getTime?.() === p.computed_at.getTime(),
            ),
          )
          .map((p) => ({
            ...p,
            user: {
              id: p.user_id,
              name: rows.users.find((u) => u.id === p.user_id)?.name ?? 'Unknown',
              ptm_signals: [],
            },
          }));
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        const filtered = rows.predictions.filter((p) =>
          where.user_id ? p.user_id === where.user_id : true,
        );
        filtered.sort((a, b) => b.computed_at.getTime() - a.computed_at.getTime());
        return filtered[0] ?? null;
      }),
    },
    coachAlert: {
      findMany: jest.fn(async ({ where }: any) => {
        return rows.alerts.filter((a) => {
          if (where.coach_id && a.coach_id !== where.coach_id) return false;
          if (where.client_id?.in && !where.client_id.in.includes(a.client_id)) return false;
          if (where.alert_type && a.alert_type !== where.alert_type) return false;
          if (where.acknowledged_at === null && a.acknowledged_at !== null) return false;
          return true;
        });
      }),
    },
    churnIntervention: {
      findUnique: jest.fn(async ({ where, include: _ }: any) => {
        const row = rows.interventions.find((i) => i.idempotency_key === where.idempotency_key || i.id === where.id);
        if (!row) return null;
        return {
          ...row,
          client: { name: rows.users.find((u) => u.id === row.client_id)?.name ?? 'Unknown' },
        };
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        return rows.interventions.find((i) => {
          if (where.id && i.id !== where.id) return false;
          if (where.coach_id && i.coach_id !== where.coach_id) return false;
          return true;
        }) ?? null;
      }),
      create: jest.fn(async ({ data }: any) => {
        interventionCounter += 1;
        const row = {
          id: `int-${interventionCounter}`,
          coach_id: data.coach_id,
          client_id: data.client_id,
          draft_text: data.draft_text,
          edited_text: null,
          status: data.status ?? 'draft',
          alert_id: data.alert_id ?? null,
          risk_score_at_draft: data.risk_score_at_draft ?? null,
          top_factor: data.top_factor ?? null,
          idempotency_key: data.idempotency_key,
          created_at: new Date(),
          sent_at: null,
          dismissed_at: null,
          nudge_id: null,
        };
        rows.interventions.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const idx = rows.interventions.findIndex((i) => i.id === where.id);
        if (idx < 0) throw new Error('not found');
        rows.interventions[idx] = { ...rows.interventions[idx], ...data };
        return rows.interventions[idx];
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (let i = 0; i < rows.interventions.length; i++) {
          const r = rows.interventions[i];
          if (where.id && r.id !== where.id) continue;
          if (where.coach_id && r.coach_id !== where.coach_id) continue;
          if (where.status?.notIn && where.status.notIn.includes(r.status)) continue;
          rows.interventions[i] = { ...r, ...data };
          count++;
        }
        return { count };
      }),
    },
    coachNudge: {
      create: jest.fn(async ({ data }: any) => {
        nudgeCounter += 1;
        const row = {
          id: `nudge-${nudgeCounter}`,
          coach_id: data.coach_id,
          client_id: data.client_id,
          title: data.title,
          body: data.body,
          created_at: new Date(),
          read_at: null,
        };
        rows.nudges.push(row);
        return row;
      }),
    },
    checkIn: {
      findFirst: jest.fn(async ({ where }: any) => {
        return rows.checkIns.find((c) => c.user_id === where.user_id) ?? null;
      }),
    },
  };
}

function buildPtmService(): any {
  return {
    getLatestPrediction: jest.fn(async (_uid: string) => ({
      user_id: _uid,
      risk_score: 0.7,
      success_score: 0.2,
      factors: [
        { key: 'app_open_gap_7d', label: 'No app open in 7 days', contribution: 0.25 },
        { key: 'checkin_miss_3plus', label: '3+ missed check-ins in 14 days', contribution: 0.2 },
      ],
      computed_at: new Date(),
    })),
  };
}

function buildConfig(): any {
  return {
    get: jest.fn((k: string) => (k === 'ANTHROPIC_API_KEY' ? 'sk-test' : null)),
  };
}

function buildAnthropicClient(text: string = 'Hi Alice, I noticed it has been quiet on your end. — Coach'): any {
  return {
    messages: {
      create: jest.fn(async () => ({
        content: [{ type: 'text', text }],
        usage: { input_tokens: 50, output_tokens: 30 },
        model: 'claude-sonnet-4-6',
      })),
    },
  };
}

function buildNotifications(): any {
  return {
    pushToUser: jest.fn(async () => undefined),
  };
}

describe('ChurnInterventionService.generateChurnDraft', () => {
  it('rejects non-UUID idempotency_key', async () => {
    const svc = new ChurnInterventionService(
      buildPrisma() as any,
      buildPtmService(),
      buildConfig(),
      buildNotifications(),
      buildAnthropicClient(),
    );
    await expect(
      svc.generateChurnDraft('c1', 'u1', { idempotency_key: 'not-a-uuid' }),
    ).rejects.toThrow(/UUID/);
  });

  it('returns existing row when idempotency_key already used by same coach', async () => {
    const prisma = buildPrisma({
      users: [{ id: 'u1', name: 'Alice', coach_id: 'c1', role: 'student', deleted_at: null }],
      interventions: [
        {
          id: 'existing',
          coach_id: 'c1',
          client_id: 'u1',
          draft_text: 'prior draft',
          status: 'draft',
          top_factor: 'Declining engagement',
          idempotency_key: VALID_UUID,
          created_at: new Date(),
          alert_id: null,
          risk_score_at_draft: null,
          edited_text: null,
          sent_at: null,
          dismissed_at: null,
          nudge_id: null,
        },
      ],
    });
    const anthropic = buildAnthropicClient();
    const svc = new ChurnInterventionService(
      prisma as any,
      buildPtmService(),
      buildConfig(),
      buildNotifications(),
      anthropic,
    );
    const out = await svc.generateChurnDraft('c1', 'u1', {
      idempotency_key: VALID_UUID,
    });
    expect(out.intervention_id).toBe('existing');
    expect(out.draft_text).toBe('prior draft');
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when client is not in coach roster', async () => {
    const prisma = buildPrisma({
      users: [{ id: 'u1', name: 'Alice', coach_id: 'OTHER_COACH', role: 'student', deleted_at: null }],
    });
    const svc = new ChurnInterventionService(
      prisma as any,
      buildPtmService(),
      buildConfig(),
      buildNotifications(),
      buildAnthropicClient(),
    );
    await expect(
      svc.generateChurnDraft('c1', 'u1', { idempotency_key: VALID_UUID }),
    ).rejects.toThrow(/Client not found/);
  });

  it('throws sanitized 503 when Anthropic fails — does not leak provider error', async () => {
    const prisma = buildPrisma({
      users: [{ id: 'u1', name: 'Alice', coach_id: 'c1', role: 'student', deleted_at: null }],
    });
    const anthropic = {
      messages: {
        create: jest.fn(async () => {
          throw new Error('Internal Anthropic-specific error mentioning ANTHROPIC_API_KEY');
        }),
      },
    };
    const svc = new ChurnInterventionService(
      prisma as any,
      buildPtmService(),
      buildConfig(),
      buildNotifications(),
      anthropic as any,
    );
    let caught: any = null;
    try {
      await svc.generateChurnDraft('c1', 'u1', { idempotency_key: VALID_UUID });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    const response = caught.getResponse ? caught.getResponse() : caught.response;
    const msg = JSON.stringify(response);
    expect(msg).not.toMatch(/ANTHROPIC_API_KEY/);
    expect(msg).not.toMatch(/Anthropic-specific/);
    expect(msg).toMatch(/Unable to generate/);
    // No intervention row written
    expect(prisma.rows.interventions.length).toBe(0);
  });

  it('happy path persists ChurnIntervention with status=draft', async () => {
    const prisma = buildPrisma({
      users: [{ id: 'u1', name: 'Alice', coach_id: 'c1', role: 'student', deleted_at: null }],
    });
    const svc = new ChurnInterventionService(
      prisma as any,
      buildPtmService(),
      buildConfig(),
      buildNotifications(),
      buildAnthropicClient('Hey Alice, missed you this week.'),
    );
    const out = await svc.generateChurnDraft('c1', 'u1', { idempotency_key: VALID_UUID });
    expect(out.status).toBe('draft');
    expect(out.draft_text).toBe('Hey Alice, missed you this week.');
    expect(prisma.rows.interventions.length).toBe(1);
    expect(prisma.rows.interventions[0].idempotency_key).toBe(VALID_UUID);
  });
});

describe('ChurnInterventionService.sendIntervention', () => {
  function buildSendTestPrisma(extraInterventions: any[] = []) {
    return buildPrisma({
      users: [{ id: 'u1', name: 'Alice', coach_id: 'c1', role: 'student', deleted_at: null }],
      interventions: [
        {
          id: 'int-1',
          coach_id: 'c1',
          client_id: 'u1',
          draft_text: 'Hi Alice, miss you.',
          edited_text: null,
          status: 'draft',
          alert_id: null,
          risk_score_at_draft: 0.7,
          top_factor: 'No app activity',
          idempotency_key: VALID_UUID,
          created_at: new Date(),
          sent_at: null,
          dismissed_at: null,
          nudge_id: null,
        },
        ...extraInterventions,
      ],
    });
  }

  it('happy path: creates CoachNudge + marks intervention as sent', async () => {
    const prisma = buildSendTestPrisma();
    const notif = buildNotifications();
    const svc = new ChurnInterventionService(
      prisma as any,
      buildPtmService(),
      buildConfig(),
      notif,
      buildAnthropicClient(),
    );
    const out = await svc.sendIntervention('c1', 'int-1', {
      message_text: 'Hi Alice, missed you. Drop me a line when you can.',
      idempotency_key: VALID_UUID_2,
    });
    expect(out.ok).toBe(true);
    expect(out.nudge_id).toMatch(/^nudge-/);
    expect(prisma.rows.nudges.length).toBe(1);
    expect(prisma.rows.interventions[0].status).toBe('sent');
    expect(prisma.rows.interventions[0].nudge_id).toBe(out.nudge_id);
    expect(notif.pushToUser).toHaveBeenCalled();
  });

  it('idempotent: second send returns existing sent_at and nudge_id', async () => {
    const prisma = buildSendTestPrisma();
    const svc = new ChurnInterventionService(
      prisma as any,
      buildPtmService(),
      buildConfig(),
      buildNotifications(),
      buildAnthropicClient(),
    );
    const first = await svc.sendIntervention('c1', 'int-1', {
      message_text: 'msg 1',
      idempotency_key: VALID_UUID_2,
    });
    const second = await svc.sendIntervention('c1', 'int-1', {
      message_text: 'msg 1',
      idempotency_key: VALID_UUID_2,
    });
    expect(second.sent_at).toBe(first.sent_at);
    expect(second.nudge_id).toBe(first.nudge_id);
    expect(prisma.rows.nudges.length).toBe(1);
  });

  it('throws ConflictException for dismissed intervention', async () => {
    const prisma = buildSendTestPrisma();
    prisma.rows.interventions[0].status = 'dismissed';
    const svc = new ChurnInterventionService(
      prisma as any,
      buildPtmService(),
      buildConfig(),
      buildNotifications(),
      buildAnthropicClient(),
    );
    await expect(
      svc.sendIntervention('c1', 'int-1', {
        message_text: 'msg',
        idempotency_key: VALID_UUID_2,
      }),
    ).rejects.toThrow(/Cannot send a dismissed/);
  });

  it('rejects empty or oversized message_text', async () => {
    const prisma = buildSendTestPrisma();
    const svc = new ChurnInterventionService(
      prisma as any,
      buildPtmService(),
      buildConfig(),
      buildNotifications(),
      buildAnthropicClient(),
    );
    await expect(
      svc.sendIntervention('c1', 'int-1', { message_text: '', idempotency_key: VALID_UUID_2 }),
    ).rejects.toThrow(/1–1000/);
    await expect(
      svc.sendIntervention('c1', 'int-1', { message_text: 'x'.repeat(1001), idempotency_key: VALID_UUID_2 }),
    ).rejects.toThrow(/1–1000/);
  });

  it('rolls back status when CoachNudge create fails', async () => {
    const prisma = buildSendTestPrisma();
    prisma.coachNudge.create = jest.fn(async () => {
      throw new Error('DB down');
    });
    const svc = new ChurnInterventionService(
      prisma as any,
      buildPtmService(),
      buildConfig(),
      buildNotifications(),
      buildAnthropicClient(),
    );
    await expect(
      svc.sendIntervention('c1', 'int-1', {
        message_text: 'msg',
        idempotency_key: VALID_UUID_2,
      }),
    ).rejects.toThrow();
    // Status reverted to draft
    expect(prisma.rows.interventions[0].status).toBe('draft');
    expect(prisma.rows.interventions[0].sent_at).toBeNull();
  });
});

describe('ChurnInterventionService.dismissIntervention', () => {
  it('happy path: marks intervention as dismissed', async () => {
    const prisma = buildPrisma({
      users: [{ id: 'u1', name: 'Alice', coach_id: 'c1', role: 'student', deleted_at: null }],
      interventions: [
        {
          id: 'int-1',
          coach_id: 'c1',
          client_id: 'u1',
          status: 'draft',
          draft_text: 'd',
          edited_text: null,
          alert_id: null,
          risk_score_at_draft: null,
          top_factor: null,
          idempotency_key: VALID_UUID,
          created_at: new Date(),
          sent_at: null,
          dismissed_at: null,
          nudge_id: null,
        },
      ],
    });
    const svc = new ChurnInterventionService(
      prisma as any,
      buildPtmService(),
      buildConfig(),
      buildNotifications(),
      buildAnthropicClient(),
    );
    const out = await svc.dismissIntervention('c1', 'int-1');
    expect(out.ok).toBe(true);
    expect(prisma.rows.interventions[0].status).toBe('dismissed');
  });

  it('idempotent: dismissing already-dismissed returns ok without re-write', async () => {
    const dismissedAt = new Date(Date.now() - 1000);
    const prisma = buildPrisma({
      users: [{ id: 'u1', name: 'Alice', coach_id: 'c1', role: 'student', deleted_at: null }],
      interventions: [
        {
          id: 'int-1',
          coach_id: 'c1',
          client_id: 'u1',
          status: 'dismissed',
          draft_text: 'd',
          edited_text: null,
          alert_id: null,
          risk_score_at_draft: null,
          top_factor: null,
          idempotency_key: VALID_UUID,
          created_at: new Date(),
          sent_at: null,
          dismissed_at: dismissedAt,
          nudge_id: null,
        },
      ],
    });
    const svc = new ChurnInterventionService(
      prisma as any,
      buildPtmService(),
      buildConfig(),
      buildNotifications(),
      buildAnthropicClient(),
    );
    const out = await svc.dismissIntervention('c1', 'int-1');
    expect(out.ok).toBe(true);
    expect(prisma.rows.interventions[0].dismissed_at).toEqual(dismissedAt);
  });

  it('throws ConflictException when intervention already sent', async () => {
    const prisma = buildPrisma({
      users: [{ id: 'u1', name: 'Alice', coach_id: 'c1', role: 'student', deleted_at: null }],
      interventions: [
        {
          id: 'int-1',
          coach_id: 'c1',
          client_id: 'u1',
          status: 'sent',
          draft_text: 'd',
          edited_text: null,
          alert_id: null,
          risk_score_at_draft: null,
          top_factor: null,
          idempotency_key: VALID_UUID,
          created_at: new Date(),
          sent_at: new Date(),
          dismissed_at: null,
          nudge_id: 'nudge-1',
        },
      ],
    });
    const svc = new ChurnInterventionService(
      prisma as any,
      buildPtmService(),
      buildConfig(),
      buildNotifications(),
      buildAnthropicClient(),
    );
    await expect(svc.dismissIntervention('c1', 'int-1')).rejects.toThrow(
      /already-sent/,
    );
  });
});
