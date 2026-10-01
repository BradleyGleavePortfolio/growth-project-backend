// C05/C07 — OnboardingService with an in-memory Prisma fake.
// Covers: 409 machine codes, idempotent completion (replay never re-assigns),
// concurrency claim, MacroTarget under the coach, clone-before-assign with
// tenancy checks, space joins with joined_at, coach flag on any screening yes.
import { redactObject } from '../src/observability/log-redaction';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ConflictException } from '@nestjs/common';
import { OnboardingService } from '../src/onboarding/onboarding.service';
import { parseFixture } from '../src/onboarding/clinic-programs';
import type { PrismaService } from '../src/prisma.service';
import type { WorkoutBuilderService } from '../src/workout-builder/workout-builder.service';
import type { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';

const fx = parseFixture(
  readFileSync(join(__dirname, '..', 'seed', 'clinic-programs.v1.json'), 'utf8'),
);
const NOW = new Date('2026-10-01T12:00:00.000Z');

function asPrisma(m: object): PrismaService {
  return m as PrismaService;
}
function asBuilder(m: object): WorkoutBuilderService {
  return m as WorkoutBuilderService;
}
function asScope(m: object): SubCoachScopeService {
  return m as SubCoachScopeService;
}

type Row = Record<string, unknown>;

function makeWorld() {
  let seq = 0;
  const id = (p: string) => `${p}-${++seq}`;
  const users: Row[] = [
    { id: 'coach-1', role: 'coach', name: 'Coach Rae', coach_id: null },
    { id: 'client-1', role: 'student', coach_id: 'coach-1' },
    { id: 'loner', role: 'student', coach_id: null },
    { id: 'other-coach', role: 'coach', name: 'Other', coach_id: null },
    { id: 'sub-1', role: 'coach', name: 'Sub One', coach_id: 'coach-1' },
    { id: 'sub-x', role: 'coach', name: 'Sub X', coach_id: 'other-coach' },
    { id: 'client-2', role: 'student', coach_id: 'sub-1' },
  ];
  const intakes: Row[] = [];
  const programs: Row[] = [];
  const plans: Row[] = [];
  const memberships: Row[] = [];
  const macroTargets: Row[] = [];
  const notifications: Row[] = [];
  const profiles: Row[] = [];
  const cohorts: Row[] = [
    {
      id: 'cohort-all',
      name: 'All members',
      workspace_id: 'ws-1',
      archived_at: null,
      coach: 'coach-1',
    },
  ];
  const masterIds: Record<string, string> = {};
  for (const p of fx.programs) {
    const pid = `master-${p.fixture_key}`;
    masterIds[p.fixture_key] = pid;
    programs.push({
      id: pid,
      owner_user_id: 'coach-1',
      is_template: true,
      archived_at: null,
      name: p.data.name,
      description: p.data.description,
      weeks: 4,
      goal_tag: p.data.goal_tag,
    });
    p.plans.forEach((pl) =>
      plans.push({
        id: id('mplan'),
        program_id: pid,
        archived_at: null,
        name: pl.data.name,
        type: pl.data.type,
        duration_estimate_minutes: pl.data.duration_estimate_minutes,
        week_index: pl.data.week_index,
        day_index: pl.data.day_index,
        exercises: pl.exercises.map((e) => ({ ...e })),
      }),
    );
    cohorts.push({
      id: `cohort-${p.fixture_key}`,
      name: p.data.name,
      workspace_id: 'ws-1',
      archived_at: null,
      coach: 'coach-1',
    });
  }
  const set = {
    id: 'set-1',
    coach_id: 'coach-1',
    active: true,
    workspace_id: 'ws-1',
    all_members_cohort_id: 'cohort-all',
    programs: Object.fromEntries(
      fx.programs.map((p) => [
        p.fixture_key,
        {
          program_id: masterIds[p.fixture_key],
          cohort_id: `cohort-${p.fixture_key}`,
          name: p.data.name,
        },
      ]),
    ),
    materialisation: JSON.parse(JSON.stringify(fx.materialisation)),
  };
  const sets: Row[] = [set];
  const createdClones: Row[] = [];
  const revisions: Row[] = [];
  const apply = (row: Row, data: Row) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && 'increment' in (v as Row))
        row[k] = Number(row[k] ?? 0) + Number((v as Row).increment);
      else row[k] = v;
    }
    return row;
  };

  const match = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'OR') return (v as Row[]).some((w) => match(row, w));
      if (v && typeof v === 'object' && 'lt' in (v as Row)) {
        const r = row[k];
        return r instanceof Date && r < ((v as Row).lt as Date);
      }
      if (v && typeof v === 'object' && 'not' in (v as Row)) return row[k] !== (v as Row).not;
      if (v === null) return row[k] === null || row[k] === undefined;
      return row[k] === v;
    });

  const prisma = {
    user: {
      findUnique: jest.fn(
        async ({ where }: { where: Row }) => users.find((u) => u.id === where.id) ?? null,
      ),
    },
    clientOnboardingIntake: {
      findUnique: jest.fn(
        async ({ where }: { where: Row }) =>
          intakes.find((i) => i.client_id === where.client_id) ?? null,
      ),
      upsert: jest.fn(
        async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
          const ex = intakes.find((i) => i.client_id === where.client_id);
          if (ex) return apply(ex, update);
          const row = {
            id: id('intake'),
            completed_at: null,
            completion_claimed_at: null,
            selected_program_key: null,
            completion_result: null,
            ...create,
          };
          intakes.push(row);
          return row;
        },
      ),
      updateMany: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const rows = intakes.filter((i) => match(i, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      }),
      update: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const r = intakes.find((i) => i.client_id === where.client_id)!;
        return apply(r, data);
      }),
    },
    clientOnboardingIntakeRevision: {
      create: jest.fn(async ({ data }: { data: Row }) => {
        if (revisions.some((r) => r.intake_id === data.intake_id && r.revision === data.revision))
          throw new Error('P2002');
        const row = { id: id('rev'), created_at: NOW, ...data };
        revisions.push(row);
        return row;
      }),
      findUnique: jest.fn(
        async ({ where }: { where: { intake_id_revision: Row } }) =>
          revisions.find(
            (r) =>
              r.intake_id === where.intake_id_revision.intake_id &&
              r.revision === where.intake_id_revision.revision,
          ) ?? null,
      ),
      findMany: jest.fn(async ({ where }: { where: Row }) =>
        revisions.filter((r) => r.client_id === where.client_id).reverse(),
      ),
    },
    userProfile: {
      upsert: jest.fn(
        async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
          const ex = profiles.find((p) => p.user_id === where.user_id);
          if (ex) return Object.assign(ex, update);
          profiles.push({ ...create });
          return create;
        },
      ),
    },
    clinicProgramSet: {
      findFirst: jest.fn(
        async ({ where }: { where: Row }) => sets.find((s) => match(s, where)) ?? null,
      ),
    },
    workoutProgram: {
      findUnique: jest.fn(
        async ({ where }: { where: Row }) => programs.find((p) => p.id === where.id) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = { id: id('clone'), ...data };
        programs.push(row);
        createdClones.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: { where: Row; data: Row }) =>
        Object.assign(
          programs.find((p) => p.id === where.id)!,
          data,
        ),
      ),
    },
    workoutPlan: {
      findMany: jest.fn(async ({ where }: { where: Row }) =>
        plans.filter((p) => p.program_id === where.program_id && !p.archived_at),
      ),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = { id: id('plan'), ...data };
        plans.push(row);
        return row;
      }),
      update: jest.fn(async () => ({})),
    },
    workoutPlanExercise: {
      createMany: jest.fn(async ({ data }: { data: Row[] }) => ({ count: data.length })),
    },
    workoutPlanRevision: { create: jest.fn(async () => ({ id: id('prev') })) },
    workoutProgramRevision: { create: jest.fn(async () => ({ id: id('grev') })) },
    macroTarget: {
      create: jest.fn(async ({ data }: { data: Row }) => {
        macroTargets.push(data);
        return data;
      }),
    },
    communityCohort: {
      findFirst: jest.fn(async ({ where }: { where: Row & { workspace: Row } }) => {
        const c = cohorts.find(
          (x) =>
            x.id === where.id &&
            x.workspace_id === where.workspace_id &&
            x.coach === where.workspace.coach_id,
        );
        return c ? { id: c.id, name: c.name } : null;
      }),
    },
    communityMembership: {
      upsert: jest.fn(async ({ create }: { create: Row }) => {
        const ex = memberships.find(
          (m) => m.cohort_id === create.cohort_id && m.user_id === create.user_id,
        );
        if (ex) return ex;
        memberships.push(create);
        return create;
      }),
    },
    notification: {
      create: jest.fn(async ({ data }: { data: Row }) => {
        notifications.push(data);
        return data;
      }),
    },
  };
  Object.assign(prisma, {
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(prisma)),
  });

  const cache = new Map<string, unknown>();
  const builder = {
    withIdempotency: jest.fn(
      async (u: string, r: string, k: string, op: () => Promise<unknown>) => {
        const key = `${u}|${r}|${k}`;
        if (cache.has(key)) return cache.get(key);
        const v = await op();
        cache.set(key, v);
        return v;
      },
    ),
    assignProgramToClient: jest.fn(async () => ({
      assignments: [{ id: 'asg-1' }, { id: 'asg-2' }],
    })),
  };
  // Sub-coach overlay: sub-1 (under coach-1) is assigned client-1;
  // sub-x belongs to another head and has no assignment here.
  const subCoachScope = {
    canAccessClient: jest.fn(
      async (reader: string, client: string) => reader === 'sub-1' && client === 'client-1',
    ),
  };
  const svc = new OnboardingService(asPrisma(prisma), asBuilder(builder), asScope(subCoachScope));
  // The real consent gate: P0 alone first, then answers.
  const consentThenSave = async (
    clientId: string,
    body: { version: string; answers: Record<string, unknown> },
    now: Date,
  ) => {
    const on = intakes.find((i) => i.client_id === clientId && i.disclaimer_accepted_at);
    if (!on) {
      await svc.saveConsultation(
        clientId,
        { version: 'consult-v1', answers: { P0: CONSENT } },
        now,
      );
    }
    const { P0: p0, ...rest } = body.answers;
    const answers = p0 === undefined ? rest : body.answers;
    return svc.saveConsultation(clientId, { ...body, answers }, now);
  };
  return {
    svc,
    consentThenSave,
    prisma,
    builder,
    revisions,
    intakes,
    memberships,
    macroTargets,
    notifications,
    profiles,
    createdClones,
    sets,
    plans,
  };
}

const CONSENT = {
  agreed: true,
  copy_version: 'consult-consent-v1',
  agreed_at: '2026-10-01T11:59:00.000Z',
};

const COMPLETE = {
  G1: 'fat_loss',
  B1: 'female',
  B2: '1988-04-01',
  B3: { height_cm: 167.64, weight_lbs: 172, unit: 'imperial' },
  B4: 150,
  L1: 'moderate',
  T1: 'beginner',
  T3: 'no',
  S1: '3',
  S3: 'gym',
  N1: 'none',
  N2: ['nothing'],
  P0: { agreed: true, copy_version: 'consult-consent-v1', agreed_at: '2026-10-01T11:59:00.000Z' },
  P1: 'no',
  P2: 'no',
  P3: 'no',
  P4: 'no',
  P5: 'no',
  P6: 'no',
  P7: 'no',
  C1: '2026-10-05',
};

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    if (e instanceof ConflictException) return String((e.getResponse() as { code: string }).code);
    throw e;
  }
}

describe('PUT /me/onboarding/consultation', () => {
  it('rejects an unsupported version and invalid answers with machine codes', async () => {
    const w = makeWorld();
    await expect(
      w.svc.saveConsultation('client-1', { version: 'v0', answers: {} }, NOW),
    ).rejects.toMatchObject({
      response: { code: 'unsupported_version' },
    });
    await expect(
      w.svc.saveConsultation('client-1', { version: 'consult-v1', answers: { G1: 'bulk' } }, NOW),
    ).rejects.toMatchObject({
      response: { code: 'invalid_answers' },
    });
  });

  it('merges partial saves, stamps P0 server-side, maps the profile and never maps screening', async () => {
    const w = makeWorld();
    await w.consentThenSave(
      'client-1',
      { version: 'consult-v1', answers: { G1: 'fat_loss', B1: 'female' } },
      NOW,
    );
    const later = new Date(NOW.getTime() + 60_000);
    const out = await w.consentThenSave(
      'client-1',
      { version: 'consult-v1', answers: { ...COMPLETE, P3: 'yes' } },
      later,
    );
    expect(out.completed_chapters).toContain('safety');
    const intake = w.intakes[0];
    expect(intake.disclaimer_version).toBe('consult-consent-v1');
    expect(intake.disclaimer_accepted_at).toEqual(NOW);
    expect(intake.screening_any_yes).toBe(true);
    expect(w.profiles[0]).toMatchObject({ sex: 'female', macro_target_calories: 1789 });
    expect(JSON.stringify(w.profiles)).not.toMatch(/P3/);
    // Re-saving the same P0 version keeps the original accepted time.
    await w.svc.saveConsultation(
      'client-1',
      {
        version: 'consult-v1',
        answers: { P0: { agreed: true, copy_version: 'consult-consent-v1' } },
      },
      new Date(later.getTime() + 1),
    );
    expect(w.intakes[0].disclaimer_accepted_at).toEqual(NOW);
    // Every save is an immutable revision; nothing is overwritten.
    expect(w.revisions.map((r) => r.revision)).toEqual([1, 2, 3, 4]);
    expect(w.revisions[0].answers).toEqual({ P0: CONSENT });
    expect(w.revisions[1].answers).toEqual({ P0: CONSENT, G1: 'fat_loss', B1: 'female' });
    expect(w.intakes[0].first_session_date).toEqual(new Date('2026-10-05T00:00:00.000Z'));
  });
});

describe('consent before answers (privacy ruling 2026-09-30 18:24)', () => {
  it('answers sent before consent are rejected with 409 consent_missing and not stored', async () => {
    const w = makeWorld();
    const { P0: _p0, ...noConsent } = COMPLETE;
    expect(
      await code(
        w.svc.saveConsultation('client-1', { version: 'consult-v1', answers: noConsent }, NOW),
      ),
    ).toBe('consent_missing');
    // Bundling answers with the first consent is also refused: consent must be on file first.
    expect(
      await code(
        w.svc.saveConsultation('client-1', { version: 'consult-v1', answers: COMPLETE }, NOW),
      ),
    ).toBe('consent_missing');
    expect(w.intakes).toHaveLength(0);
    expect(w.revisions).toHaveLength(0);
    expect(w.profiles).toHaveLength(0);
    expect(w.prisma.clientOnboardingIntake.upsert).not.toHaveBeenCalled();
    expect(w.prisma.userProfile.upsert).not.toHaveBeenCalled();
  });

  it('records consent alone first, then accepts answers', async () => {
    const w = makeWorld();
    const first = await w.svc.saveConsultation(
      'client-1',
      { version: 'consult-v1', answers: { P0: CONSENT } },
      NOW,
    );
    expect(first.revision).toBe(1);
    expect(w.intakes[0]).toMatchObject({
      disclaimer_version: 'consult-consent-v1',
      disclaimer_accepted_at: NOW,
    });
    const { P0: _p0, ...rest } = COMPLETE;
    await expect(
      w.svc.saveConsultation('client-1', { version: 'consult-v1', answers: rest }, NOW),
    ).resolves.toMatchObject({
      revision: 2,
    });
  });

  it('rejects an outdated consent copy version and consent withdrawal through PUT', async () => {
    const w = makeWorld();
    expect(
      await code(
        w.svc.saveConsultation(
          'client-1',
          { version: 'consult-v1', answers: { P0: { agreed: true, copy_version: 'old-v0' } } },
          NOW,
        ),
      ),
    ).toBe('consent_missing');
    await w.svc.saveConsultation(
      'client-1',
      { version: 'consult-v1', answers: { P0: CONSENT } },
      NOW,
    );
    await expect(
      w.svc.saveConsultation('client-1', { version: 'consult-v1', answers: { P0: null } }, NOW),
    ).rejects.toMatchObject({
      response: { code: 'invalid_answers' },
    });
    expect(w.intakes[0].disclaimer_accepted_at).toEqual(NOW);
  });
});

describe('POST /me/onboarding/complete', () => {
  async function ready(answers: Record<string, unknown> = COMPLETE) {
    const w = makeWorld();
    await w.consentThenSave('client-1', { version: 'consult-v1', answers }, NOW);
    return w;
  }

  it('not_attached when the client has no coach', async () => {
    const w = makeWorld();
    await w.consentThenSave('loner', { version: 'consult-v1', answers: COMPLETE }, NOW);
    expect(await code(w.svc.complete('loner', NOW))).toBe('not_attached');
  });

  it('consultation_incomplete lists the missing keys', async () => {
    const w = makeWorld();
    expect(await code(w.svc.complete('client-1', NOW))).toBe('consultation_incomplete');
    await w.consentThenSave(
      'client-1',
      { version: 'consult-v1', answers: { G1: 'fat_loss' } },
      NOW,
    );
    await expect(w.svc.complete('client-1', NOW)).rejects.toMatchObject({
      response: {
        code: 'consultation_incomplete',
        missing: expect.arrayContaining(['B1', 'B2', 'P1', 'C1']),
      },
    });
  });

  it('consent_missing at complete when the accepted copy version is no longer current', async () => {
    const w = await ready();
    process.env.CONSULT_CONSENT_COPY_VERSIONS = 'consult-consent-v2';
    try {
      expect(await code(w.svc.complete('client-1', NOW))).toBe('consent_missing');
    } finally {
      delete process.env.CONSULT_CONSENT_COPY_VERSIONS;
    }
  });

  it('clinic_not_configured when the coach has no program set', async () => {
    const w = await ready();
    w.sets.length = 0;
    expect(await code(w.svc.complete('client-1', NOW))).toBe('clinic_not_configured');
  });

  it('happy path: macros, clone-then-assign under the coach, two spaces, no coach flag', async () => {
    const w = await ready();
    const res = await w.svc.complete('client-1', NOW);
    expect(res.macros).toEqual({
      calories: 1789,
      protein_g: 150,
      carbs_g: 185,
      fat_g: 50,
      method: 'mifflin_st_jeor',
      floor_applied: false,
    });
    expect(res.program).toMatchObject({
      key: 'considered-strength',
      name: 'Considered Strength',
      days_per_week: 3,
      weeks: 4,
      start_date: '2026-10-05',
    });
    expect(res.program.why).toHaveLength(3);
    expect(res.spaces.map((s) => s.id)).toEqual(['cohort-all', 'cohort-considered-strength']);
    expect(res.coach).toEqual({ id: 'coach-1', display_name: 'Coach Rae' });

    expect(w.createdClones).toHaveLength(1);
    expect(w.createdClones[0]).toMatchObject({
      is_template: false,
      cloned_from_id: 'master-considered-strength',
      owner_user_id: 'coach-1',
      days_per_week: 3,
    });
    expect(w.builder.assignProgramToClient).toHaveBeenCalledWith(
      'coach-1',
      w.createdClones[0].id,
      { client_id: 'client-1', start_date: '2026-10-05' },
      'onboarding:client-1',
    );
    expect(w.macroTargets).toEqual([
      expect.objectContaining({
        coach_id: 'coach-1',
        client_id: 'client-1',
        calories_kcal: 1789,
        fats_g: 50,
      }),
    ]);
    expect(w.memberships).toHaveLength(2);
    w.memberships.forEach((m) =>
      expect(m).toMatchObject({
        user_id: 'client-1',
        joined_at: NOW,
        role: 'student',
        status: 'active',
      }),
    );
    expect(w.notifications).toHaveLength(0);
    expect(w.profiles[0].onboardingCompleted).toBe(true);
  });

  it('is idempotent: a second call replays the stored result and assigns nothing new', async () => {
    const w = await ready();
    const first = await w.svc.complete('client-1', NOW);
    const second = await w.svc.complete('client-1', new Date(NOW.getTime() + 5000));
    expect(second).toEqual(first);
    expect(w.builder.assignProgramToClient).toHaveBeenCalledTimes(1);
    expect(w.createdClones).toHaveLength(1);
    expect(w.macroTargets).toHaveLength(1);
  });

  it('completion_in_progress while another request holds the claim', async () => {
    const w = await ready();
    w.intakes[0].completion_claimed_at = new Date(NOW.getTime() - 1000);
    expect(await code(w.svc.complete('client-1', NOW))).toBe('completion_in_progress');
  });

  it('any screening yes: Steady Foundations at 2 days with extra care, and the coach is flagged', async () => {
    const w = await ready({ ...COMPLETE, T1: 'advanced', S1: '5', P4: 'yes' });
    const res = await w.svc.complete('client-1', NOW);
    expect(res.program).toMatchObject({ key: 'steady-foundations', days_per_week: 2 });
    expect(w.notifications).toEqual([
      expect.objectContaining({
        user_id: 'coach-1',
        kind: 'coach_alert',
        payload: { type: 'onboarding_screening_review', client_id: 'client-1' },
      }),
    ]);
    expect(String(w.notifications[0].body)).not.toMatch(/P4|heart|chest|pregnan/i);
    expect(w.intakes[0].screening_flagged_at).toEqual(NOW);
  });

  it("refuses a master that is not the attached coach's own template (tenancy)", async () => {
    const w = await ready();
    const set = w.sets[0] as { programs: Record<string, { program_id: string }> };
    set.programs['considered-strength'].program_id = 'not-a-program';
    expect(await code(w.svc.complete('client-1', NOW))).toBe('clinic_not_configured');
    expect(w.builder.assignProgramToClient).not.toHaveBeenCalled();
    // The claim is released so a later retry can succeed.
    expect(w.intakes[0].completion_claimed_at).toBeNull();
  });

  it('archives the clone if assignment fails, then a retry succeeds', async () => {
    const w = await ready();
    w.builder.assignProgramToClient.mockRejectedValueOnce(new Error('boom'));
    await expect(w.svc.complete('client-1', NOW)).rejects.toThrow('boom');
    expect(w.createdClones[0].archived_at).toBeInstanceOf(Date);
    const res = await w.svc.complete('client-1', NOW);
    expect(res.program.id).toBe(w.createdClones[1].id);
    expect(w.macroTargets).toHaveLength(1);
  });
});

describe('macro display mode (C05 item 8)', () => {
  it('never-trackers get simple display for 7 days in the complete payload, full otherwise', async () => {
    const w = makeWorld();
    await w.consentThenSave(
      'client-1',
      { version: 'consult-v1', answers: { ...COMPLETE, N4: 'never' } },
      NOW,
    );
    const res = await w.svc.complete('client-1', NOW);
    expect(res.macro_display_mode).toBe('simple');
    expect(res.simple_until).toBe(new Date(NOW.getTime() + 7 * 86_400_000).toISOString());
    expect(res.macros.carbs_g).toBe(185);
    const later = await w.svc.complete('client-1', new Date(NOW.getTime() + 8 * 86_400_000));
    expect(later.macro_display_mode).toBe('full');
    expect(later.simple_until).toBe(res.simple_until);

    const w2 = makeWorld();
    await w2.consentThenSave(
      'client-1',
      { version: 'consult-v1', answers: { ...COMPLETE, N4: 'some' } },
      NOW,
    );
    expect(await w2.svc.complete('client-1', NOW)).toMatchObject({
      macro_display_mode: 'full',
      simple_until: null,
    });
  });

  it('exposes engagement inputs after completion only', async () => {
    const w = makeWorld();
    await w.consentThenSave(
      'client-1',
      { version: 'consult-v1', answers: { ...COMPLETE, S2: 'evening' } },
      NOW,
    );
    expect(await w.svc.getEngagementInputs('client-1')).toBeNull();
    await w.svc.complete('client-1', NOW);
    expect(await w.svc.getEngagementInputs('client-1')).toEqual({
      client_id: 'client-1',
      coach_id: 'coach-1',
      onboarding_completed_at: NOW.toISOString(),
      first_session_date: '2026-10-05',
      preferred_training_time: 'evening',
    });
  });
});

describe('GET /coach/clients/:clientId/consultation', () => {
  async function saved() {
    const w = makeWorld();
    await w.consentThenSave(
      'client-1',
      {
        version: 'consult-v1',
        answers: {
          ...COMPLETE,
          T3: 'yes',
          T3_areas: ['knee'],
          T3_note: 'Old ski injury',
          P2: 'yes',
          P2_note: 'On stairs',
        },
      },
      NOW,
    );
    return w;
  }
  const notFound = async (p: Promise<unknown>) => {
    await expect(p).rejects.toMatchObject({ status: 404 });
  };

  it('the head coach reads chapters with human-readable labels, screening and consent', async () => {
    const w = await saved();
    const v = await w.svc.getCoachConsultation('coach-1', 'client-1', undefined, NOW);
    expect(v.version).toBe('consult-v1');
    expect(v.revision).toBe(2); // 1 = consent alone, 2 = answers
    expect(v.chapters.map((c) => c.key)).toEqual([
      'goals',
      'body',
      'lifestyle',
      'training',
      'schedule',
      'nutrition',
      'commitment',
    ]);
    const body = v.chapters.find((c) => c.key === 'body')!;
    expect(body.answers.find((a) => a.screen === 'B1')!.answer_label).toBe('Female');
    expect(body.answers.find((a) => a.screen === 'B2')!.answer_label).toMatch(/1988.*age 38/);
    expect(body.answers.find((a) => a.screen === 'B3')!.answer_label).toBe(
      '5 ft 6 in (168 cm), 172 lb',
    );
    const training = v.chapters.find((c) => c.key === 'training')!;
    expect(training.answers.find((a) => a.screen === 'T3')!.answer_label).toMatch(
      /Knee.*Old ski injury/,
    );
    expect(v.screening.any_yes).toBe(true);
    expect(v.screening.items).toHaveLength(7);
    expect(v.screening.items.find((i) => i.key === 'P2')).toMatchObject({
      answer: 'yes',
      note: 'On stairs',
    });
    expect(v.screening.items[0].question.length).toBeGreaterThan(20);
    expect(v.consent).toEqual({ version: 'consult-consent-v1', agreed_at: NOW.toISOString() });
  });

  it('an assigned sub-coach can read; earlier revisions stay readable after edits', async () => {
    const w = await saved();
    await w.consentThenSave(
      'client-1',
      { version: 'consult-v1', answers: { G1: 'muscle_gain' } },
      NOW,
    );
    expect((await w.svc.getCoachConsultation('sub-1', 'client-1', undefined, NOW)).revision).toBe(
      3,
    );
    const before = await w.svc.getCoachConsultation('coach-1', 'client-1', 2, NOW);
    expect(before.chapters[0].answers[0].answer_label).not.toBe(
      (await w.svc.getCoachConsultation('coach-1', 'client-1', 3, NOW)).chapters[0].answers[0]
        .answer_label,
    );
    expect(
      (await w.svc.listCoachConsultationRevisions('coach-1', 'client-1')).map((r) => r.revision),
    ).toEqual([3, 2, 1]);
  });

  it("the head coach of the client's coach can read", async () => {
    const w = makeWorld();
    await w.consentThenSave('client-2', { version: 'consult-v1', answers: COMPLETE }, NOW);
    await expect(
      w.svc.getCoachConsultation('coach-1', 'client-2', undefined, NOW),
    ).resolves.toMatchObject({ revision: 2 });
  });

  it('404 for a foreign coach, a sub-coach of another head, and the client themselves', async () => {
    const w = await saved();
    await notFound(w.svc.getCoachConsultation('other-coach', 'client-1', undefined, NOW));
    await notFound(w.svc.getCoachConsultation('sub-x', 'client-1', undefined, NOW));
    await notFound(w.svc.getCoachConsultation('client-1', 'client-1', undefined, NOW));
    await notFound(w.svc.listCoachConsultationRevisions('other-coach', 'client-1'));
    await notFound(w.svc.getCoachConsultation('coach-1', 'client-1', 99, NOW));
  });
});

describe('consultation answers never reach logs', () => {
  it('the log redactor masks answers, completion results and screening at any depth', () => {
    const out = redactObject({
      msg: 'onboarding',
      answers: { P1: 'yes', T3_note: 'knee' },
      nested: { completion_result: { macros: {} }, screening: { any_yes: true } },
    }) as Record<string, unknown>;
    expect(out.answers).toBe('[REDACTED]');
    expect(out.nested).toEqual({ completion_result: '[REDACTED]', screening: '[REDACTED]' });
  });
});
