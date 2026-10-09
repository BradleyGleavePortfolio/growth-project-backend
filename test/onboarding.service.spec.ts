// C05/C07 — OnboardingService with an in-memory Prisma fake.
// Covers: 409 machine codes, idempotent completion (replay never re-assigns),
// concurrency claim, MacroTarget under the coach, clone-before-assign with
// tenancy checks, space joins with joined_at, coach flag on any screening yes.
import { redactObject } from '../src/observability/log-redaction';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isLockConflict, OnboardingService } from '../src/onboarding/onboarding.service';
import { parseFixture } from '../src/onboarding/clinic-programs';
import type { PrismaService } from '../src/prisma.service';
import type { WorkoutBuilderService } from '../src/workout-builder/workout-builder.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import { CONSULT_CONSENT_V3_TEXT_SHA256 } from '../src/onboarding/consult-consent-copy';
import { macroRawFromAnswers, type Answers } from '../src/onboarding/consultation-answers';
import { computeMacros, resolveMacroInputs } from '../src/macros/macro-calculator';

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
  // Open sub-coach assignments (current-tenancy predicate reads these).
  const subAssignments: Row[] = [
    {
      id: 'sca-1',
      sub_coach_id: 'sub-1',
      client_id: 'client-1',
      head_coach_id: 'coach-1',
      unassigned_at: null,
    },
  ];
  // Team Mode seats (TeamSubCoachAssignment). Main's membership rule (#597)
  // reads these first; sub-1 is a team member through its open delegation
  // sca-1 above, so the default world needs none (INT-607-1).
  const teamSeats: Row[] = [];
  // Client workout assignments created by assignProgramToClient.
  const workoutAssignments: Row[] = [];
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
      if (v && typeof v === 'object' && 'in' in (v as Row))
        return ((v as Row).in as unknown[]).includes(row[k]);
      if (v === null) return row[k] === null || row[k] === undefined;
      return row[k] === v;
    });

  // Test hook: runs at the start of the next $transaction call, before its
  // rollback snapshot is taken (one-shot; clear it in the hook). For
  // POST complete that is the fenced final transaction, i.e. after the
  // pre-checks and the claim: the point at which another request (a coach
  // transfer, a save, a second worker) can commit in between.
  const hooks: { beforeTransaction?: () => Promise<void> | void } = {};
  const sqlLog: string[] = [];
  const prisma = {
    // Raw statements used by the services: the A607-3 tenancy fence (User
    // FOR SHARE) and the B606-3 profile row lock (UserProfile FOR UPDATE).
    // Locks are serialised for real only in the live Postgres suites; here
    // the double returns the CURRENT committed row at the moment of the read.
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?').replace(/\s+/g, ' ').trim();
      sqlLog.push(sql);
      if (/FROM "User" WHERE "id" = \? FOR SHARE$/.test(sql)) {
        const u = users.find((x) => x.id === values[0]);
        return u
          ? [
              {
                id: u.id,
                coach_id: u.coach_id ?? null,
                role: u.role,
                deleted_at: u.deleted_at ?? null,
              },
            ]
          : [];
      }
      if (/FROM "UserProfile" WHERE "user_id" = \? FOR UPDATE$/.test(sql)) return [];
      // A-607-4: the in-transaction membership decision (seat, then delegation).
      if (
        /FROM "TeamSubCoachAssignment" WHERE "head_coach_id" = \? AND "sub_coach_id" = \? AND "archived_at" IS NULL LIMIT 1 FOR SHARE$/.test(
          sql,
        )
      ) {
        const seat = teamSeats.find(
          (a) =>
            a.head_coach_id === values[0] &&
            a.sub_coach_id === values[1] &&
            (a.archived_at ?? null) === null,
        );
        return seat ? [{ id: seat.id }] : [];
      }
      if (
        /FROM "SubCoachAssignment" WHERE "head_coach_id" = \? AND "sub_coach_id" = \? AND "unassigned_at" IS NULL LIMIT 1 FOR SHARE$/.test(
          sql,
        )
      ) {
        const open = subAssignments.find(
          (a) =>
            a.head_coach_id === values[0] &&
            a.sub_coach_id === values[1] &&
            (a.unassigned_at ?? null) === null,
        );
        return open ? [{ id: open.id ?? 'delegation' }] : [];
      }
      throw new Error(`unexpected raw SQL in double: ${sql}`);
    }),
    user: {
      findUnique: jest.fn(
        async ({ where }: { where: Row }) => users.find((u) => u.id === where.id) ?? null,
      ),
    },
    subCoachAssignment: {
      findFirst: jest.fn(
        async ({ where }: { where: Row }) => subAssignments.find((a) => match(a, where)) ?? null,
      ),
    },
    teamSubCoachAssignment: {
      findFirst: jest.fn(
        async ({ where }: { where: Row }) => teamSeats.find((a) => match(a, where)) ?? null,
      ),
    },
    clientWorkoutAssignment: {
      findMany: jest.fn(async ({ where }: { where: Row & { workout_plan: { program: Row } } }) => {
        const { workout_plan: wp, ...flat } = where;
        return workoutAssignments
          .filter((a) => match(a, flat))
          .filter((a) => {
            const prog = programs.find((p) => p.id === a.program_id);
            return Boolean(prog) && match(prog as Row, wp.program);
          })
          .map((a) => ({ id: a.id, workout_plan: { program_id: a.program_id } }));
      }),
      deleteMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        const before = workoutAssignments.length;
        for (let i = workoutAssignments.length - 1; i >= 0; i--)
          if (where.id.in.includes(String(workoutAssignments[i].id)))
            workoutAssignments.splice(i, 1);
        return { count: before - workoutAssignments.length };
      }),
    },
    clientOnboardingIntake: {
      findUnique: jest.fn(async ({ where }: { where: Row }) => {
        const r = intakes.find((i) => i.client_id === where.client_id);
        return r ? { ...r } : null;
      }),
      create: jest.fn(async ({ data }: { data: Row }) => {
        if (intakes.some((i) => i.client_id === data.client_id))
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          });
        const row = {
          id: id('intake'),
          completed_at: null,
          completion_claimed_at: null,
          completion_claim_token: null,
          selected_program_key: null,
          completion_result: null,
          ...data,
        };
        intakes.push(row);
        return { ...row };
      }),
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
      findUnique: jest.fn(async ({ where }: { where: Row }) => {
        const p = profiles.find((x) => x.user_id === where.user_id);
        return p ? { ...p } : null;
      }),
      update: jest.fn(async ({ where, data }: { where: Row; data: Row }) =>
        Object.assign(
          profiles.find((x) => x.user_id === where.user_id)!,
          data,
        ),
      ),
      create: jest.fn(async ({ data }: { data: Row }) => {
        profiles.push({ ...data });
        return data;
      }),
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
      updateMany: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const rows = programs.filter((p) => match(p, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      }),
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
  // Transactions roll back on throw, like Postgres: every mutable table is
  // snapshotted and restored, so a fenced-off attempt leaves no effects.
  const tables: Row[][] = [
    intakes,
    revisions,
    macroTargets,
    notifications,
    memberships,
    profiles,
    workoutAssignments,
    programs,
    subAssignments,
    createdClones,
  ];
  Object.assign(prisma, {
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => {
      if (hooks.beforeTransaction) await hooks.beforeTransaction();
      const snap = tables.map((t) => t.map((r) => ({ ...r })));
      try {
        return await fn(prisma);
      } catch (err) {
        tables.forEach((t, i) => {
          t.length = 0;
          snap[i].forEach((r) => t.push(r));
        });
        throw err;
      }
    }),
  });

  const builder = {
    // In-transaction fan-out (A607-2-R1): rows are written through the
    // caller's transaction, so they roll back with a fenced-off attempt.
    writeProgramAssignmentsInTx: jest.fn(
      async (_tx: unknown, coachId: string, programId: string, clientId: string) => {
        const created = [1, 2].map(() => ({
          id: id('asg'),
          client_id: clientId,
          assigned_by_coach_id: coachId,
          program_id: programId,
          started_at: null,
          completed_at: null,
        }));
        workoutAssignments.push(...created);
        return {
          assignments: created.map((a) => ({ id: a.id })),
          first_plan_id: `first-plan-of-${programId}`,
        };
      },
    ),
    // Post-commit push.
    notifyProgramAssigned: jest.fn(),
    // The legacy out-of-transaction path must never be used by onboarding.
    assignProgramToClient: jest.fn(async () => {
      throw new Error('onboarding must not call assignProgramToClient');
    }),
    withIdempotency: jest.fn(async () => {
      throw new Error('onboarding must not call withIdempotency');
    }),
  };
  // Sub-coach overlay: sub-1 (under coach-1) is assigned client-1;
  // sub-x belongs to another head and has no assignment here. The
  // consultation read asks main's REAL SubCoachScopeService (over this same
  // double) only for explicit team membership (INT-607-1); it never uses the
  // legacy canAccessClient scope (A607-1), which the spy below proves.
  const subCoachScope = new SubCoachScopeService(asPrisma(prisma));
  const legacyScope = jest.spyOn(subCoachScope, 'canAccessClient');
  const svc = new OnboardingService(asPrisma(prisma), asBuilder(builder), subCoachScope);
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
    users,
    subAssignments,
    teamSeats,
    legacyScope,
    workoutAssignments,
    programs,
    masterIds,
    hooks,
    sqlLog,
    cohorts,
  };
}

// The exact P0 the mobile app (#310) sends: copy version + sha256 of the
// whole screen text it showed (consult-consent-copy.ts).
const CONSENT = {
  agreed: true,
  copy_version: 'consult-consent-v3',
  agreed_at: '2026-10-01T11:59:00.000Z',
  text_sha256: CONSULT_CONSENT_V3_TEXT_SHA256,
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
  P0: CONSENT,
  P1: 'no',
  P2: 'no',
  P3: 'no',
  P4: 'no',
  P5: 'no',
  P6: 'no',
  P7: 'no',
  C1: '2026-10-05',
};

/** A copy of a stored intake's answers (to build a tampered record). */
function answersOf(row: Row): Record<string, unknown> {
  const a = row.answers;
  if (typeof a !== 'object' || a === null || Array.isArray(a)) throw new Error('no answers');
  return Object.fromEntries(Object.entries(a));
}

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
    expect(intake.disclaimer_version).toBe('consult-consent-v3');
    expect(intake.disclaimer_accepted_at).toEqual(NOW);
    expect(intake.screening_any_yes).toBe(true);
    expect(w.profiles[0]).toMatchObject({ sex: 'female', macro_target_calories: 1789 });
    expect(JSON.stringify(w.profiles)).not.toMatch(/P3/);
    // Re-saving the same P0 version keeps the original accepted time.
    await w.svc.saveConsultation(
      'client-1',
      {
        version: 'consult-v1',
        answers: { P0: { ...CONSENT, agreed_at: '2026-10-01T12:30:00.000Z' } },
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
      disclaimer_version: 'consult-consent-v3',
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

  it('a coachless client before any house set exists: clinic_not_configured, nothing written (CONSULT-ALL-BE-133)', async () => {
    const w = makeWorld();
    await w.consentThenSave('loner', { version: 'consult-v1', answers: COMPLETE }, NOW);
    expect(await code(w.svc.complete('loner', NOW))).toBe('clinic_not_configured');
    expect(w.createdClones).toHaveLength(0);
    expect(w.macroTargets).toHaveLength(0);
    expect(w.intakes[0].completed_at).toBeNull();
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

  it('consent_missing at complete when the stored consent is not a current, provable v3 record', async () => {
    // A stamp for a version that is no longer accepted (v2: no compat window).
    const stale = await ready();
    stale.intakes[0].disclaimer_version = 'consult-consent-v2';
    stale.intakes[0].answers = {
      ...answersOf(stale.intakes[0]),
      P0: { ...CONSENT, copy_version: 'consult-consent-v2' },
    };
    expect(await code(stale.svc.complete('client-1', NOW))).toBe('consent_missing');
    // A v3 stamp whose stored P0 no longer proves the v3 text.
    const tampered = await ready();
    tampered.intakes[0].answers = {
      ...answersOf(tampered.intakes[0]),
      P0: { ...CONSENT, text_sha256: 'a'.repeat(64) },
    };
    expect(await code(tampered.svc.complete('client-1', NOW))).toBe('consent_missing');
    // A stamp that names a different version than the stored P0.
    const split = await ready();
    split.intakes[0].disclaimer_version = 'consult-consent-v4';
    expect(await code(split.svc.complete('client-1', NOW))).toBe('consent_missing');
    // No server stamp at all.
    const unstamped = await ready();
    unstamped.intakes[0].disclaimer_accepted_at = null;
    expect(await code(unstamped.svc.complete('client-1', NOW))).toBe('consent_missing');
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
    expect(w.builder.writeProgramAssignmentsInTx).toHaveBeenCalledWith(
      expect.anything(),
      'coach-1',
      w.createdClones[0].id,
      'client-1',
      '2026-10-05',
    );
    // One push, after the commit, for the committed assignment.
    expect(w.builder.notifyProgramAssigned).toHaveBeenCalledTimes(1);
    expect(w.builder.notifyProgramAssigned).toHaveBeenCalledWith(
      'client-1',
      w.workoutAssignments[0].id,
      `first-plan-of-${w.createdClones[0].id}`,
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
    expect(w.builder.writeProgramAssignmentsInTx).toHaveBeenCalledTimes(1);
    expect(w.builder.notifyProgramAssigned).toHaveBeenCalledTimes(1);
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
    expect(w.builder.writeProgramAssignmentsInTx).not.toHaveBeenCalled();
    expect(w.createdClones).toHaveLength(0);
    // The claim is released so a later retry can succeed.
    expect(w.intakes[0].completion_claimed_at).toBeNull();
  });

  it('a failed assignment rolls back the clone with everything else, then a retry succeeds', async () => {
    const w = await ready();
    w.builder.writeProgramAssignmentsInTx.mockRejectedValueOnce(new Error('boom'));
    await expect(w.svc.complete('client-1', NOW)).rejects.toThrow('boom');
    expect(w.createdClones).toHaveLength(0);
    expect(w.workoutAssignments).toHaveLength(0);
    expect(w.builder.notifyProgramAssigned).not.toHaveBeenCalled();
    expect(w.intakes[0].completed_at).toBeNull();
    expect(w.intakes[0].completion_claim_token).toBeNull();
    const res = await w.svc.complete('client-1', NOW);
    expect(w.createdClones).toHaveLength(1);
    expect(res.program.id).toBe(w.createdClones[0].id);
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
    expect(v.consent).toEqual({ version: 'consult-consent-v3', agreed_at: NOW.toISOString() });
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

// ─── Fix round (independent audit of #607) ─────────────────────────────────
// Each block turns an audit reproduction (wt/audit-606-607-sol/evidence/
// sol-onboarding.spec.ts) into a permanent regression, inverted to assert the
// fixed behaviour.

const ADVANCED_GYM_4 = { ...COMPLETE, T1: 'advanced', S1: '4', S3: 'gym' };

function deferred() {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return { gate, release };
}

describe('A607-1: consultation read uses CURRENT tenancy only', () => {
  async function saved() {
    const w = makeWorld();
    await w.consentThenSave('client-1', { version: 'consult-v1', answers: COMPLETE }, NOW);
    return w;
  }
  const notFound = async (p: Promise<unknown>) => {
    await expect(p).rejects.toMatchObject({ status: 404 });
  };
  const user = (w: ReturnType<typeof makeWorld>, uid: string) => w.users.find((u) => u.id === uid)!;

  it('audit reproduction: stale head-A assignment, client now attached to head B -> 404 for the old sub-coach', async () => {
    const w = await saved();
    user(w, 'client-1').coach_id = 'other-coach';
    await notFound(w.svc.getCoachConsultation('sub-1', 'client-1', undefined, NOW));
    await notFound(w.svc.listCoachConsultationRevisions('sub-1', 'client-1'));
    // The old head coach loses access too; the new head gains it.
    await notFound(w.svc.getCoachConsultation('coach-1', 'client-1', undefined, NOW));
    await expect(
      w.svc.getCoachConsultation('other-coach', 'client-1', undefined, NOW),
    ).resolves.toMatchObject({ version: 'consult-v1' });
  });

  it('a sub-coach moved to another team loses access even with the assignment row still open', async () => {
    const w = await saved();
    await expect(w.svc.canCoachRead('sub-1', 'client-1')).resolves.toBe(true);
    user(w, 'sub-1').coach_id = 'other-coach';
    await expect(w.svc.canCoachRead('sub-1', 'client-1')).resolves.toBe(false);
  });

  it('a revoked assignment loses access immediately', async () => {
    const w = await saved();
    w.subAssignments[0].unassigned_at = NOW;
    await expect(w.svc.canCoachRead('sub-1', 'client-1')).resolves.toBe(false);
  });

  it("no cross-head grant: an assignment issued by a different head than the client's current head is ignored", async () => {
    const w = await saved();
    w.subAssignments.push({
      id: 'sca-x',
      sub_coach_id: 'sub-x',
      client_id: 'client-1',
      head_coach_id: 'other-coach',
      unassigned_at: null,
    });
    await expect(w.svc.canCoachRead('sub-x', 'client-1')).resolves.toBe(false);
  });

  it('deleted readers, deleted clients and deleted coaches are refused', async () => {
    const w = await saved();
    user(w, 'sub-1').deleted_at = NOW;
    await expect(w.svc.canCoachRead('sub-1', 'client-1')).resolves.toBe(false);
    user(w, 'client-1').deleted_at = NOW;
    await expect(w.svc.canCoachRead('coach-1', 'client-1')).resolves.toBe(false);
  });

  it("INT-607-1: a sub_coach-role user is not a team member under main's rule (role must be coach)", async () => {
    // Main's SubCoachScopeService (#597) counts only role = 'coach' rows as
    // team members, and no code path writes role 'sub_coach'. The open
    // assignment alone therefore grants nothing, exactly as everywhere else.
    const w = await saved();
    user(w, 'sub-1').role = 'sub_coach';
    await expect(w.svc.canCoachRead('sub-1', 'client-1')).resolves.toBe(false);
    // The head keeps its direct-roster access.
    await expect(w.svc.canCoachRead('coach-1', 'client-1')).resolves.toBe(true);
  });

  it('never consults the legacy canAccessClient scope', async () => {
    const w = await saved();
    await w.svc.canCoachRead('sub-1', 'client-1');
    await w.svc.canCoachRead('sub-x', 'client-1');
    await w.svc.canCoachRead('coach-1', 'client-2');
    expect(w.legacyScope).not.toHaveBeenCalled();
  });
});

/** The double's $transaction (attached with Object.assign, so not in its static type). */
const txOf = (w: ReturnType<typeof makeWorld>): jest.Mock =>
  Reflect.get(w.prisma, '$transaction') as jest.Mock;

describe("INT-607-1: the completion clone's tenant follows main's explicit membership rule", () => {
  const user = (w: ReturnType<typeof makeWorld>, uid: string) => w.users.find((u) => u.id === uid)!;
  async function ready() {
    const w = makeWorld();
    await w.consentThenSave('client-1', { version: 'consult-v1', answers: COMPLETE }, NOW);
    return w;
  }
  const tenantsOf = (w: ReturnType<typeof makeWorld>) => ({
    program: w.createdClones.map((c) => c.coach_id),
    plans: [
      ...new Set(
        w.plans
          .filter((pl) => w.createdClones.some((c) => c.id === pl.program_id))
          .map((pl) => pl.coach_id),
      ),
    ],
  });

  it('a head coach (no coach_id) keeps the clone in its own tenant', async () => {
    const w = await ready();
    await w.svc.complete('client-1', NOW);
    expect(tenantsOf(w)).toEqual({ program: ['coach-1'], plans: ['coach-1'] });
  });

  it('a phantom-tagged coach (bare coach_id, no membership row) keeps the clone in its own tenant', async () => {
    // Old guest checkout stamped coach-1.coach_id = other-coach. Without a
    // seat or delegation from other-coach, other-coach must never own (and
    // list) this client's plans.
    const w = await ready();
    user(w, 'coach-1').coach_id = 'other-coach';
    await w.svc.complete('client-1', NOW);
    expect(tenantsOf(w)).toEqual({ program: ['coach-1'], plans: ['coach-1'] });
    expect(w.createdClones[0].owner_user_id).toBe('coach-1');
  });

  it("an explicit team member's client clone lands in the head's tenant", async () => {
    const w = await ready();
    user(w, 'coach-1').coach_id = 'other-coach';
    w.teamSeats.push({
      id: 'seat-1',
      head_coach_id: 'other-coach',
      sub_coach_id: 'coach-1',
      archived_at: null,
    });
    await w.svc.complete('client-1', NOW);
    expect(tenantsOf(w)).toEqual({ program: ['other-coach'], plans: ['other-coach'] });
    expect(w.createdClones[0].owner_user_id).toBe('coach-1');
  });

  it('the coach row moving to another head under the fence re-runs against the current team', async () => {
    const w = await ready();
    user(w, 'coach-1').coach_id = 'other-coach';
    w.teamSeats.push({
      id: 'seat-1',
      head_coach_id: 'other-coach',
      sub_coach_id: 'coach-1',
      archived_at: null,
    });
    // Commits after the membership read, before the fenced transaction.
    w.hooks.beforeTransaction = () => {
      w.hooks.beforeTransaction = undefined;
      user(w, 'coach-1').coach_id = 'third-head';
    };
    await w.svc.complete('client-1', NOW);
    // The first attempt rolled back; the re-run sees no membership under
    // third-head, so the only clone is in coach-1's own tenant.
    expect(tenantsOf(w)).toEqual({ program: ['coach-1'], plans: ['coach-1'] });
  });

  // ── A-607-4: main retires membership WITHOUT touching User ──────────────
  const seatUnder = (w: ReturnType<typeof makeWorld>) => {
    user(w, 'coach-1').coach_id = 'other-coach';
    const seat: Row = {
      id: 'seat-1',
      head_coach_id: 'other-coach',
      sub_coach_id: 'coach-1',
      archived_at: null,
    };
    w.teamSeats.push(seat);
    return seat;
  };
  const membershipLocks = (w: ReturnType<typeof makeWorld>) =>
    w.prisma.$queryRaw.mock.calls
      .map((c: unknown[]) => (c[0] as TemplateStringsArray).join('?').replace(/\s+/g, ' ').trim())
      .filter((sql: string) => /"(TeamSubCoachAssignment|SubCoachAssignment)"/.test(sql));

  it('A-607-4 (Sol reproduction): a seat archived after the membership read never writes the removed head', async () => {
    const w = await ready();
    const seat = seatUnder(w);
    // Main's multi-head removal archives only the seat; User is unchanged.
    w.hooks.beforeTransaction = () => {
      w.hooks.beforeTransaction = undefined;
      seat.archived_at = NOW;
    };
    await w.svc.complete('client-1', NOW);
    expect(
      await new SubCoachScopeService(asPrisma(w.prisma)).getHeadCoachIdForSubCoach('coach-1'),
    ).toBeNull();
    expect(user(w, 'coach-1').coach_id).toBe('other-coach');
    expect(tenantsOf(w)).toEqual({ program: ['coach-1'], plans: ['coach-1'] });
  });

  it('A-607-4: the last delegation closed after the membership read never writes the removed head', async () => {
    const w = await ready();
    user(w, 'coach-1').coach_id = 'other-coach';
    const delegation: Row = {
      id: 'deleg-1',
      head_coach_id: 'other-coach',
      sub_coach_id: 'coach-1',
      client_id: 'someone',
      unassigned_at: null,
    };
    w.subAssignments.push(delegation);
    w.hooks.beforeTransaction = () => {
      w.hooks.beforeTransaction = undefined;
      delegation.unassigned_at = NOW; // SubCoachReassignService closes it; User unchanged
    };
    await w.svc.complete('client-1', NOW);
    expect(tenantsOf(w)).toEqual({ program: ['coach-1'], plans: ['coach-1'] });
  });

  it('A-607-4: a membership added after an earlier null read re-runs and lands in the head tenant', async () => {
    const w = await ready();
    user(w, 'coach-1').coach_id = 'other-coach'; // bare pointer: no membership yet
    w.hooks.beforeTransaction = () => {
      w.hooks.beforeTransaction = undefined;
      w.teamSeats.push({
        id: 'seat-new',
        head_coach_id: 'other-coach',
        sub_coach_id: 'coach-1',
        archived_at: null,
      });
    };
    await w.svc.complete('client-1', NOW);
    expect(tenantsOf(w)).toEqual({ program: ['other-coach'], plans: ['other-coach'] });
    expect(w.createdClones).toHaveLength(1);
  });

  it('A-607-4 control: unchanged membership completes in one transaction, the seat read FOR SHARE in it', async () => {
    const w = await ready();
    seatUnder(w);
    w.prisma.$queryRaw.mockClear();
    txOf(w).mockClear();
    await w.svc.complete('client-1', NOW);
    expect(tenantsOf(w)).toEqual({ program: ['other-coach'], plans: ['other-coach'] });
    expect(txOf(w)).toHaveBeenCalledTimes(1);
    const locks = membershipLocks(w);
    expect(locks).toHaveLength(1);
    expect(locks[0]).toMatch(/"archived_at" IS NULL LIMIT 1 FOR SHARE$/);
  });

  it('A-607-4 control: a head coach (no coach_id) takes no membership lock', async () => {
    const w = await ready();
    w.prisma.$queryRaw.mockClear();
    await w.svc.complete('client-1', NOW);
    expect(membershipLocks(w)).toHaveLength(0);
  });
});

describe('C-607-3: a lock conflict aborted by Postgres is retried, then a retryable 409', () => {
  const lockConflict = () =>
    new Prisma.PrismaClientKnownRequestError(
      'Transaction failed due to a write conflict or a deadlock',
      {
        code: 'P2034',
        clientVersion: 'test',
      },
    );

  it('one deadlock: the attempt rolled back and the re-run completes once', async () => {
    const w = makeWorld();
    await w.consentThenSave('client-1', { version: 'consult-v1', answers: COMPLETE }, NOW);
    const real = txOf(w).getMockImplementation()!;
    txOf(w).mockImplementationOnce(async () => {
      throw lockConflict();
    });
    txOf(w).mockImplementation(real);
    const out = await w.svc.complete('client-1', NOW);
    expect(out).toBeTruthy();
    expect(w.createdClones).toHaveLength(1);
    expect(w.intakes[0].completion_claim_token ?? null).toBeNull();
  });

  it('deadlocks on every attempt: 409 completion_in_progress, the claim released, nothing written', async () => {
    const w = makeWorld();
    await w.consentThenSave('client-1', { version: 'consult-v1', answers: COMPLETE }, NOW);
    txOf(w).mockImplementation(async () => {
      throw lockConflict();
    });
    await expect(w.svc.complete('client-1', NOW)).rejects.toMatchObject({
      response: { code: 'completion_in_progress' },
    });
    expect(w.createdClones).toHaveLength(0);
    expect(w.intakes[0].completion_claim_token ?? null).toBeNull();
  });

  it('a raw-statement deadlock (P2010 / 40P01) is the same lock conflict; other errors are not', () => {
    const raw = new Prisma.PrismaClientKnownRequestError(
      'Raw query failed. Code: `40P01`. Message: `deadlock detected`',
      {
        code: 'P2010',
        clientVersion: 'test',
        meta: { code: '40P01', message: 'deadlock detected' },
      },
    );
    expect(isLockConflict(raw)).toBe(true);
    expect(isLockConflict(lockConflict())).toBe(true);
    expect(
      isLockConflict(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      ),
    ).toBe(false);
    expect(isLockConflict(new Error('deadlock detected'))).toBe(false);
  });
});

describe('A607-2: a safety-screen change after a failed completion re-runs assignment', () => {
  it('audit reproduction: finalisation of the advanced 4-day attempt fails, P1=yes, retry -> Foundations 2 days with extra care; the failed attempt left no clone and no assignment', async () => {
    const w = makeWorld();
    await w.consentThenSave('client-1', { version: 'consult-v1', answers: ADVANCED_GYM_4 }, NOW);
    // Finalisation fails after the clone and fan-out were written in the
    // fenced transaction (community space missing once): everything rolls back.
    w.prisma.communityCohort.findFirst.mockResolvedValueOnce(null);
    expect(await code(w.svc.complete('client-1', NOW))).toBe('clinic_not_configured');
    expect(w.builder.writeProgramAssignmentsInTx).toHaveBeenCalledTimes(1);
    expect(w.createdClones).toHaveLength(0);
    expect(w.workoutAssignments).toHaveLength(0);
    expect(w.macroTargets).toHaveLength(0);
    expect(w.builder.notifyProgramAssigned).not.toHaveBeenCalled();

    const later = new Date(NOW.getTime() + 60_000);
    await w.svc.saveConsultation(
      'client-1',
      { version: 'consult-v1', answers: { P1: 'yes' } },
      later,
    );
    const res = await w.svc.complete('client-1', later);

    expect(res.program).toMatchObject({ key: 'steady-foundations', days_per_week: 2 });
    expect(w.createdClones).toHaveLength(1);
    expect(w.createdClones[0]).toMatchObject({
      cloned_from_id: 'master-steady-foundations',
      days_per_week: 2,
    });
    expect(new Set(w.workoutAssignments.map((a) => a.program_id))).toEqual(
      new Set([res.program.id]),
    );
    expect(w.notifications).toHaveLength(1);
    expect(w.builder.notifyProgramAssigned).toHaveBeenCalledTimes(1);
  });

  it('a plain retry after a failed attempt assigns exactly once', async () => {
    const w = makeWorld();
    await w.consentThenSave('client-1', { version: 'consult-v1', answers: ADVANCED_GYM_4 }, NOW);
    w.prisma.communityCohort.findFirst.mockResolvedValueOnce(null);
    await code(w.svc.complete('client-1', NOW));
    const res = await w.svc.complete('client-1', NOW);
    expect(w.createdClones).toHaveLength(1);
    expect(res.program.id).toBe(w.createdClones[0].id);
    expect(w.workoutAssignments).toHaveLength(2);
    expect(w.builder.notifyProgramAssigned).toHaveBeenCalledTimes(1);
  });

  it('edits are refused with 409 completion_in_progress while a live completion claim is held', async () => {
    const w = makeWorld();
    await w.consentThenSave('client-1', { version: 'consult-v1', answers: COMPLETE }, NOW);
    Object.assign(w.intakes[0], {
      completion_claimed_at: new Date(NOW.getTime() - 1000),
      completion_claim_token: 'other-worker',
    });
    expect(
      await code(
        w.svc.saveConsultation('client-1', { version: 'consult-v1', answers: { P1: 'yes' } }, NOW),
      ),
    ).toBe('completion_in_progress');
  });
});

describe('B607-1: concurrent partial saves never lose answers', () => {
  it('audit reproduction: G1 and B1 saved concurrently -> both survive, revisions strictly increase', async () => {
    const w = makeWorld();
    await w.svc.saveConsultation(
      'client-1',
      { version: 'consult-v1', answers: { P0: CONSENT } },
      NOW,
    );
    const [a, b] = await Promise.all([
      w.svc.saveConsultation(
        'client-1',
        { version: 'consult-v1', answers: { G1: 'fat_loss' } },
        NOW,
      ),
      w.svc.saveConsultation('client-1', { version: 'consult-v1', answers: { B1: 'female' } }, NOW),
    ]);
    expect(new Set([a.revision, b.revision])).toEqual(new Set([2, 3]));
    const head = w.intakes[0].answers as Record<string, unknown>;
    expect(head).toMatchObject({ G1: 'fat_loss', B1: 'female' });
    const last = w.revisions.find((r) => r.revision === 3)!;
    expect(last.answers).toMatchObject({ G1: 'fat_loss', B1: 'female' });
    expect(w.intakes[0].current_revision).toBe(3);
  });

  it('two simultaneous FIRST saves: no 500 from the unique constraint, both recorded', async () => {
    const w = makeWorld();
    const results = await Promise.all([
      w.svc.saveConsultation('client-1', { version: 'consult-v1', answers: { P0: CONSENT } }, NOW),
      w.svc.saveConsultation('client-1', { version: 'consult-v1', answers: { P0: CONSENT } }, NOW),
    ]);
    expect(results.map((r) => r.revision).sort()).toEqual([1, 2]);
    expect(w.intakes).toHaveLength(1);
  });

  it('gives up with 409 save_conflict after bounded retries (never a silent overwrite)', async () => {
    const w = makeWorld();
    await w.svc.saveConsultation(
      'client-1',
      { version: 'consult-v1', answers: { P0: CONSENT } },
      NOW,
    );
    const upd = w.prisma.clientOnboardingIntake.updateMany;
    upd.mockResolvedValue({ count: 0 });
    expect(
      await code(
        w.svc.saveConsultation(
          'client-1',
          { version: 'consult-v1', answers: { G1: 'fat_loss' } },
          NOW,
        ),
      ),
    ).toBe('save_conflict');
    upd.mockReset();
  });
});

describe('B607-2: completion effects are fenced; lease expiry cannot duplicate them', () => {
  it('audit reproduction: worker 1 paused before its fenced transaction, worker 2 completes at +120001ms, worker 1 resumes -> one program, one MacroTarget, one coach alert, one push', async () => {
    const w = makeWorld();
    await w.consentThenSave(
      'client-1',
      { version: 'consult-v1', answers: { ...COMPLETE, P2: 'yes' } },
      NOW,
    );
    const pause = deferred();
    w.hooks.beforeTransaction = async () => {
      w.hooks.beforeTransaction = undefined;
      await pause.gate;
    };
    const worker1 = w.svc.complete('client-1', NOW);
    await new Promise((r) => setImmediate(r));
    const worker2 = await w.svc.complete('client-1', new Date(NOW.getTime() + 120_001));
    pause.release();
    const r1 = await worker1;

    expect(r1).toEqual(worker2);
    expect(w.macroTargets).toHaveLength(1);
    expect(w.notifications).toHaveLength(1);
    expect(w.revisions.filter((r) => r.cause === 'complete')).toHaveLength(1);
    expect(w.createdClones).toHaveLength(1);
    expect(w.workoutAssignments).toHaveLength(2);
    expect(w.builder.notifyProgramAssigned).toHaveBeenCalledTimes(1);
  });

  it('A607-2-R1 audit reproduction (no winning worker): worker 1 paused, lease expires, client saves P1=yes, worker 1 resumes -> it assigns NOTHING (no clone, no assignment, no push) and answers completion_in_progress', async () => {
    const w = makeWorld();
    await w.consentThenSave('client-1', { version: 'consult-v1', answers: ADVANCED_GYM_4 }, NOW);
    const pause = deferred();
    w.hooks.beforeTransaction = async () => {
      w.hooks.beforeTransaction = undefined;
      await pause.gate;
    };
    const worker1 = w.svc.complete('client-1', NOW);
    await new Promise((r) => setImmediate(r));
    // Lease expires; the client adds a safety answer. Nobody else completes.
    const t2 = new Date(NOW.getTime() + 120_001);
    await w.svc.saveConsultation('client-1', { version: 'consult-v1', answers: { P1: 'yes' } }, t2);
    pause.release();
    expect(await code(worker1)).toBe('completion_in_progress');

    // The stale four-day Strength & Balance selection never became visible.
    expect(w.createdClones).toHaveLength(0);
    expect(w.workoutAssignments).toHaveLength(0);
    expect(w.macroTargets).toHaveLength(0);
    expect(w.notifications).toHaveLength(0);
    expect(w.builder.notifyProgramAssigned).not.toHaveBeenCalled();
    expect(w.intakes[0].completed_at).toBeNull();

    // The next completion uses the new answers.
    const res = await w.svc.complete('client-1', new Date(t2.getTime() + 1000));
    expect(res.program).toMatchObject({ key: 'steady-foundations', days_per_week: 2 });
    expect(new Set(w.workoutAssignments.map((a) => a.program_id))).toEqual(
      new Set([res.program.id]),
    );
  });

  it('a stale worker that resumes AFTER the winner finalised writes nothing and replays the winner', async () => {
    const w = makeWorld();
    await w.consentThenSave('client-1', { version: 'consult-v1', answers: ADVANCED_GYM_4 }, NOW);
    const pause = deferred();
    w.hooks.beforeTransaction = async () => {
      w.hooks.beforeTransaction = undefined;
      await pause.gate;
    };
    const worker1 = w.svc.complete('client-1', NOW);
    await new Promise((r) => setImmediate(r));
    // Lease expires; the client changes a safety answer; worker 2 completes.
    const t2 = new Date(NOW.getTime() + 120_001);
    await w.svc.saveConsultation('client-1', { version: 'consult-v1', answers: { P3: 'yes' } }, t2);
    const won = await w.svc.complete('client-1', t2);
    expect(won.program.key).toBe('steady-foundations');
    pause.release();
    const r1 = await worker1;

    expect(r1.program.id).toBe(won.program.id);
    expect(w.createdClones).toHaveLength(1);
    expect(new Set(w.workoutAssignments.map((a) => a.program_id))).toEqual(
      new Set([won.program.id]),
    );
    expect(w.macroTargets).toHaveLength(1);
    expect(w.builder.notifyProgramAssigned).toHaveBeenCalledTimes(1);
  });

  it('completion hooks (welcome-message scheduling) run once, inside the fenced transaction', async () => {
    const w = makeWorld();
    await w.consentThenSave('client-1', { version: 'consult-v1', answers: COMPLETE }, NOW);
    const hook = { onCompleted: jest.fn(async () => undefined) };
    const svc = new OnboardingService(asPrisma(w.prisma), asBuilder(w.builder), undefined, [hook]);
    await svc.complete('client-1', NOW);
    await svc.complete('client-1', new Date(NOW.getTime() + 1000));
    expect(hook.onCompleted).toHaveBeenCalledTimes(1);
    expect(hook.onCompleted).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        client_id: 'client-1',
        coach_id: 'coach-1',
        first_session_date: '2026-10-05',
      }),
    );
  });

  it('a failing hook rolls back every completion effect and releases the claim', async () => {
    const w = makeWorld();
    await w.consentThenSave('client-1', { version: 'consult-v1', answers: COMPLETE }, NOW);
    const hook = { onCompleted: jest.fn(async () => Promise.reject(new Error('hook down'))) };
    const svc = new OnboardingService(asPrisma(w.prisma), asBuilder(w.builder), undefined, [hook]);
    await expect(svc.complete('client-1', NOW)).rejects.toThrow('hook down');
    expect(w.macroTargets).toHaveLength(0);
    expect(w.intakes[0].completed_at).toBeNull();
    expect(w.intakes[0].completion_claim_token).toBeNull();
  });
});

/** Give `coachId` its own clinic program set (masters, plans, cohorts). */
function addClinicFor(w: ReturnType<typeof makeWorld>, coachId: string) {
  const entries: Record<string, { program_id: string; cohort_id: string; name: string }> = {};
  for (const [key, masterId] of Object.entries(w.masterIds)) {
    const master = w.programs.find((p) => p.id === masterId)!;
    const id = `${coachId}-${masterId}`;
    w.programs.push({ ...master, id, owner_user_id: coachId });
    w.plans
      .filter((p) => p.program_id === masterId)
      .forEach((p, i) => w.plans.push({ ...p, id: `${id}-plan-${i}`, program_id: id }));
    entries[key] = {
      program_id: id,
      cohort_id: `${coachId}-cohort-${key}`,
      name: String(master.name),
    };
  }
  const cohorts = w.cohorts;
  cohorts.push({
    id: `${coachId}-cohort-all`,
    name: 'All members',
    workspace_id: `${coachId}-ws`,
    archived_at: null,
    coach: coachId,
  });
  for (const [key, e] of Object.entries(entries))
    cohorts.push({
      id: e.cohort_id,
      name: key,
      workspace_id: `${coachId}-ws`,
      archived_at: null,
      coach: coachId,
    });
  w.sets.push({
    ...(w.sets[0] as Row),
    id: `${coachId}-set`,
    coach_id: coachId,
    workspace_id: `${coachId}-ws`,
    all_members_cohort_id: `${coachId}-cohort-all`,
    programs: entries,
  });
}

describe('A607-3: finalisation never writes for a former coach', () => {
  const user = (w: ReturnType<typeof makeWorld>, id: string) => w.users.find((u) => u.id === id)!;

  function transferBeforeFence(w: ReturnType<typeof makeWorld>, change: () => void) {
    // The attach-code transfer (or detach / deletion) commits after the
    // pre-checks and the claim, before the fenced final transaction.
    w.hooks.beforeTransaction = () => {
      w.hooks.beforeTransaction = undefined;
      change();
    };
  }

  function expectNothingWritten(w: ReturnType<typeof makeWorld>, hook: jest.Mock) {
    expect(w.macroTargets).toHaveLength(0);
    expect(w.memberships).toHaveLength(0);
    expect(w.notifications).toHaveLength(0);
    expect(w.createdClones).toHaveLength(0);
    expect(w.workoutAssignments).toHaveLength(0);
    expect(w.builder.notifyProgramAssigned).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
    expect(w.intakes[0].completed_at).toBeNull();
    expect(w.intakes[0].completion_claim_token).toBeNull();
    expect(w.revisions.filter((r) => r.cause === 'complete')).toHaveLength(0);
  }

  it('audit reproduction: client moved from head A to head B mid-completion (P1=yes) -> no MacroTarget, space, screening alert, clone, assignment, push or welcome hook for A; re-run against B (not set up -> clinic_not_configured)', async () => {
    const w = makeWorld();
    await w.consentThenSave(
      'client-1',
      { version: 'consult-v1', answers: { ...COMPLETE, P1: 'yes' } },
      NOW,
    );
    const hook = { onCompleted: jest.fn(async () => undefined) };
    const svc = new OnboardingService(asPrisma(w.prisma), asBuilder(w.builder), undefined, [hook]);
    transferBeforeFence(w, () => {
      user(w, 'client-1').coach_id = 'other-coach';
    });
    expect(await code(svc.complete('client-1', NOW))).toBe('clinic_not_configured');
    expectNothingWritten(w, hook.onCompleted);
  });

  it('client moved to a head B that has a clinic set -> completion runs entirely under B', async () => {
    const w = makeWorld();
    addClinicFor(w, 'other-coach');
    await w.consentThenSave(
      'client-1',
      { version: 'consult-v1', answers: { ...COMPLETE, P1: 'yes' } },
      NOW,
    );
    const hook = { onCompleted: jest.fn(async () => undefined) };
    const svc = new OnboardingService(asPrisma(w.prisma), asBuilder(w.builder), undefined, [hook]);
    transferBeforeFence(w, () => {
      user(w, 'client-1').coach_id = 'other-coach';
    });
    const res = await svc.complete('client-1', NOW);
    expect(res.coach?.id).toBe('other-coach');
    expect(w.macroTargets.map((m) => m.coach_id)).toEqual(['other-coach']);
    expect(w.notifications.map((n) => n.user_id)).toEqual(['other-coach']);
    expect(w.memberships.every((m) => String(m.cohort_id).startsWith('other-coach-'))).toBe(true);
    expect(w.createdClones).toHaveLength(1);
    expect(w.createdClones[0].owner_user_id).toBe('other-coach');
    expect(w.workoutAssignments.every((a) => a.assigned_by_coach_id === 'other-coach')).toBe(true);
    expect(hook.onCompleted).toHaveBeenCalledTimes(1);
    expect(hook.onCompleted).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ coach_id: 'other-coach' }),
    );
    expect(JSON.stringify([w.macroTargets, w.notifications, w.memberships])).not.toContain(
      'coach-1',
    );
  });

  it('client detached mid-completion -> nothing written for the former coach; re-run as coachless (no house set -> clinic_not_configured)', async () => {
    const w = makeWorld();
    await w.consentThenSave('client-1', { version: 'consult-v1', answers: COMPLETE }, NOW);
    const hook = { onCompleted: jest.fn(async () => undefined) };
    const svc = new OnboardingService(asPrisma(w.prisma), asBuilder(w.builder), undefined, [hook]);
    transferBeforeFence(w, () => {
      user(w, 'client-1').coach_id = null;
    });
    expect(await code(svc.complete('client-1', NOW))).toBe('clinic_not_configured');
    expectNothingWritten(w, hook.onCompleted);
  });

  it('coach deleted mid-completion -> not_attached, nothing written', async () => {
    const w = makeWorld();
    await w.consentThenSave('client-1', { version: 'consult-v1', answers: COMPLETE }, NOW);
    const hook = { onCompleted: jest.fn(async () => undefined) };
    const svc = new OnboardingService(asPrisma(w.prisma), asBuilder(w.builder), undefined, [hook]);
    transferBeforeFence(w, () => {
      user(w, 'coach-1').deleted_at = NOW;
    });
    expect(await code(svc.complete('client-1', NOW))).toBe('not_attached');
    expectNothingWritten(w, hook.onCompleted);
  });

  it('an attachment that keeps changing gives up with completion_in_progress after bounded attempts', async () => {
    const w = makeWorld();
    addClinicFor(w, 'other-coach');
    await w.consentThenSave('client-1', { version: 'consult-v1', answers: COMPLETE }, NOW);
    let flips = 0;
    const flip = () => {
      flips += 1;
      const c = user(w, 'client-1');
      c.coach_id = c.coach_id === 'coach-1' ? 'other-coach' : 'coach-1';
    };
    w.hooks.beforeTransaction = flip; // never cleared: every attempt sees a change
    expect(await code(w.svc.complete('client-1', NOW))).toBe('completion_in_progress');
    expect(flips).toBe(2);
    expect(w.macroTargets).toHaveLength(0);
    expect(w.workoutAssignments).toHaveLength(0);
    expect(w.intakes[0].completion_claim_token).toBeNull();
  });

  it('the fenced transaction locks the coach row, then the client row, FOR SHARE (parameterised)', async () => {
    const w = makeWorld();
    await w.consentThenSave('client-1', { version: 'consult-v1', answers: COMPLETE }, NOW);
    w.sqlLog.length = 0;
    w.prisma.$queryRaw.mockClear();
    await w.svc.complete('client-1', NOW);
    const userLocks = w.prisma.$queryRaw.mock.calls
      .map((c) => ({ sql: (c[0] as TemplateStringsArray).join('?'), id: c[1] }))
      .filter((c) => c.sql.includes('FROM "User"'));
    expect(userLocks.map((c) => c.id)).toEqual(['coach-1', 'client-1']);
    userLocks.forEach((c) => expect(c.sql.replace(/\s+/g, ' ').trim()).toMatch(/FOR SHARE$/));
  });
});

describe('D2 consent: box 1 only gates completion; box 2 is never required (#607 does not depend on #601)', () => {
  it('the accepted P0 copy is consult-consent-v3 with its exact text digest; v1 and v2 are not current', async () => {
    const w = makeWorld();
    for (const P0 of [
      { agreed: true, copy_version: 'consult-consent-v1' },
      { agreed: true, copy_version: 'consult-consent-v2' },
      // v2 with the v3 digest is still v2: version and text must both match.
      { ...CONSENT, copy_version: 'consult-consent-v2' },
    ]) {
      expect(
        await code(
          w.svc.saveConsultation('client-1', { version: 'consult-v1', answers: { P0 } }, NOW),
        ),
      ).toBe('consent_missing');
    }
    expect(w.intakes).toHaveLength(0);
    await w.svc.saveConsultation(
      'client-1',
      { version: 'consult-v1', answers: { P0: CONSENT } },
      NOW,
    );
    expect(w.intakes[0].disclaimer_version).toBe('consult-consent-v3');
    expect(answersOf(w.intakes[0]).P0).toEqual(CONSENT);
  });

  it('a v3 P0 without the exact v3 text digest is not consent and nothing is stored', async () => {
    const w = makeWorld();
    const { text_sha256: _sha, ...noDigest } = CONSENT;
    for (const P0 of [
      noDigest,
      { ...CONSENT, text_sha256: 'b'.repeat(64) },
      // The box 2 (AI) copy digest is not the screen digest.
      {
        ...CONSENT,
        text_sha256: 'fbf821401d4313c6a301a6cc08d3870bb117c293fbb970e321bf87f49abe34f4',
      },
    ]) {
      expect(
        await code(
          w.svc.saveConsultation('client-1', { version: 'consult-v1', answers: { P0 } }, NOW),
        ),
      ).toBe('consent_missing');
    }
    expect(w.intakes).toHaveLength(0);
    expect(w.revisions).toHaveLength(0);
    // A malformed digest is a shape error (400), also before any write.
    await expect(
      w.svc.saveConsultation(
        'client-1',
        { version: 'consult-v1', answers: { P0: { ...CONSENT, text_sha256: 'NOT-HEX' } } },
        NOW,
      ),
    ).rejects.toMatchObject({ response: { code: 'invalid_answers' } });
    expect(w.intakes).toHaveLength(0);
  });

  it('a stored P0 that no longer proves the v3 text is not on file: answers are refused until P0 is re-sent', async () => {
    const w = makeWorld();
    await w.svc.saveConsultation(
      'client-1',
      { version: 'consult-v1', answers: { P0: CONSENT } },
      NOW,
    );
    expect((await w.svc.getOnboarding('client-1')).consent_recorded).toBe(true);
    w.intakes[0].answers = {
      ...answersOf(w.intakes[0]),
      P0: { ...CONSENT, text_sha256: 'c'.repeat(64) },
    };
    expect((await w.svc.getOnboarding('client-1')).consent_recorded).toBe(false);
    expect(
      await code(
        w.svc.saveConsultation(
          'client-1',
          { version: 'consult-v1', answers: { G1: 'fat_loss' } },
          NOW,
        ),
      ),
    ).toBe('consent_missing');
    // A stale v2 stamp reads the same way.
    w.intakes[0].answers = { ...answersOf(w.intakes[0]), P0: { ...CONSENT } };
    w.intakes[0].disclaimer_version = 'consult-consent-v2';
    expect((await w.svc.getOnboarding('client-1')).consent_recorded).toBe(false);
    // Re-sending the exact v3 P0 alone restores it.
    await w.svc.saveConsultation(
      'client-1',
      { version: 'consult-v1', answers: { P0: CONSENT } },
      NOW,
    );
    expect(w.intakes[0].disclaimer_version).toBe('consult-consent-v3');
    expect((await w.svc.getOnboarding('client-1')).consent_recorded).toBe(true);
  });

  it('C-607-5: re-sending a provable v3 over an unprovable stored v3 re-stamps the acceptance time', async () => {
    const LATER = new Date('2026-10-02T09:30:00.000Z');
    const w = makeWorld();
    await w.svc.saveConsultation(
      'client-1',
      { version: 'consult-v1', answers: { P0: CONSENT } },
      NOW,
    );
    expect(w.intakes[0].disclaimer_accepted_at).toEqual(NOW);
    // A proven resume keeps the original time.
    await w.svc.saveConsultation(
      'client-1',
      { version: 'consult-v1', answers: { P0: CONSENT } },
      LATER,
    );
    expect(w.intakes[0].disclaimer_accepted_at).toEqual(NOW);
    // The stored v3 P0 stops proving the v3 text (hand-edited row).
    w.intakes[0].answers = {
      ...answersOf(w.intakes[0]),
      P0: { ...CONSENT, text_sha256: 'c'.repeat(64) },
    };
    expect(w.intakes[0].disclaimer_version).toBe('consult-consent-v3');
    await w.svc.saveConsultation(
      'client-1',
      { version: 'consult-v1', answers: { P0: CONSENT } },
      LATER,
    );
    expect(w.intakes[0].disclaimer_version).toBe('consult-consent-v3');
    expect(w.intakes[0].disclaimer_accepted_at).toEqual(LATER);
    expect((await w.svc.getOnboarding('client-1')).consent_recorded).toBe(true);
  });

  it('CONSULT_CONSENT_COPY_VERSIONS only chooses among versions with known text', async () => {
    // Unknown names cannot be verified, so they are ignored; v2 is unknown.
    process.env.CONSULT_CONSENT_COPY_VERSIONS = 'consult-consent-v1, consult-consent-v2';
    try {
      const w = makeWorld();
      expect(
        await code(
          w.svc.saveConsultation(
            'client-1',
            {
              version: 'consult-v1',
              answers: { P0: { agreed: true, copy_version: 'consult-consent-v1' } },
            },
            NOW,
          ),
        ),
      ).toBe('consent_missing');
      // No known name in the list: the default (v3) still applies.
      await w.svc.saveConsultation(
        'client-1',
        { version: 'consult-v1', answers: { P0: CONSENT } },
        NOW,
      );
      expect(w.intakes[0].disclaimer_version).toBe('consult-consent-v3');
    } finally {
      delete process.env.CONSULT_CONSENT_COPY_VERSIONS;
    }
  });

  it('completion with box 1 only (no AI consent anywhere) succeeds', async () => {
    const w = makeWorld();
    await w.consentThenSave('client-1', { version: 'consult-v1', answers: COMPLETE }, NOW);
    const res = await w.svc.complete('client-1', NOW);
    expect(res.program.key).toBe('considered-strength');
    // The double has no AI-consent model at all: nothing was read from one.
    expect(Object.keys(w.prisma).some((k) => /ai.?consent|consent.?grant/i.test(k))).toBe(false);
  });

  it('box 2 (AI) data can never ride inside P0: unknown P0 keys are rejected and nothing is stored', async () => {
    const w = makeWorld();
    for (const extra of [
      { ai_consent: true },
      { ai_consent_version: 'client-ai-v3' },
      { box2: true },
    ]) {
      await expect(
        w.svc.saveConsultation(
          'client-1',
          {
            version: 'consult-v1',
            answers: { P0: { ...CONSENT, ...extra } },
          },
          NOW,
        ),
      ).rejects.toMatchObject({ response: { code: 'invalid_answers' } });
    }
    expect(w.intakes).toHaveLength(0);
  });

  it('the onboarding module never imports the AI consent ledger (#601 / R2a)', () => {
    const dir = join(__dirname, '..', 'src', 'onboarding');
    const sources = readdirSync(dir)
      .filter((f: string) => f.endsWith('.ts'))
      .map((f: string) => readFileSync(join(dir, f), 'utf8'))
      .join('\n');
    expect(sources).not.toMatch(/from '[^']*(ai-consent|consent-ledger|ai\/consent)[^']*'/);
    expect(sources).not.toMatch(/hasClientAiConsent|client_ai_processing/);
  });
});

describe('S-REVENUE-124 B-REV-1: GET /me/onboarding says whether the consultation can finish', () => {
  it('true for a client whose coach has an active clinic program set', async () => {
    const w = makeWorld();
    expect((await w.svc.getOnboarding('client-1')).consultation_available).toBe(true);
  });

  it('false for a coachless client only while no house set exists (CONSULT-ALL-BE-133)', async () => {
    const w = makeWorld();
    expect((await w.svc.getOnboarding('loner')).consultation_available).toBe(false);
  });

  it('false for a client whose coach has no program set, the case complete() answers clinic_not_configured', async () => {
    const w = makeWorld();
    w.sets.length = 0;
    expect((await w.svc.getOnboarding('client-1')).consultation_available).toBe(false);
    w.sets.push({ id: 'set-off', coach_id: 'coach-1', active: false, materialisation: {} });
    expect((await w.svc.getOnboarding('client-1')).consultation_available).toBe(false);
  });

  it('true once the consultation is completed, whatever the coach has today', async () => {
    const w = makeWorld();
    await w.consentThenSave('client-1', { version: 'consult-v1', answers: COMPLETE }, NOW);
    await w.svc.complete('client-1', NOW);
    w.sets.length = 0;
    const state = await w.svc.getOnboarding('client-1');
    expect(state.completed).toBe(true);
    expect(state.consultation_available).toBe(true);
  });
});

// ─── CONSULT-ALL-BE-133 (B14, B33, owner decision 28): the house program set ──
// Every client gets the full consultation. A coachless client finishes it
// attached to no coach (clone in the client's own tenant); a client whose
// coach has no set gets the house programs under that coach's name.

const HOUSE = 'house-1';

/** Seeds the house account, its three masters, its own spaces and an is_house set. */
function addHouseSet(
  w: ReturnType<typeof makeWorld>,
  opts: { ownerRole?: string; deleted?: boolean } = {},
) {
  w.users.push({
    id: HOUSE,
    role: opts.ownerRole ?? 'owner',
    name: 'House',
    coach_id: null,
    deleted_at: opts.deleted ? NOW : null,
  });
  const entries: Record<string, { program_id: string; cohort_id: string; name: string }> = {};
  for (const [key, masterId] of Object.entries(w.masterIds)) {
    const master = w.programs.find((p) => p.id === masterId)!;
    const id = `${HOUSE}-${masterId}`;
    w.programs.push({ ...master, id, owner_user_id: HOUSE, coach_id: HOUSE });
    w.plans
      .filter((p) => p.program_id === masterId)
      .forEach((p, i) => w.plans.push({ ...p, id: `${id}-plan-${i}`, program_id: id }));
    entries[key] = {
      program_id: id,
      cohort_id: `${HOUSE}-cohort-${key}`,
      name: String(master.name),
    };
    w.cohorts.push({
      id: `${HOUSE}-cohort-${key}`,
      name: key,
      workspace_id: `${HOUSE}-ws`,
      archived_at: null,
      coach: HOUSE,
    });
  }
  w.cohorts.push({
    id: `${HOUSE}-cohort-all`,
    name: 'All members',
    workspace_id: `${HOUSE}-ws`,
    archived_at: null,
    coach: HOUSE,
  });
  w.sets.push({
    ...(w.sets[0] as Row),
    id: 'house-set',
    coach_id: HOUSE,
    is_house: true,
    workspace_id: `${HOUSE}-ws`,
    all_members_cohort_id: `${HOUSE}-cohort-all`,
    programs: entries,
  });
}

describe('CONSULT-ALL-BE-133: every client can finish the consultation (house set)', () => {
  const coachIds = (w: ReturnType<typeof makeWorld>) =>
    w.users.filter((u) => u.role === 'coach' || u.role === 'owner').map((u) => String(u.id));

  it('GET /me/onboarding: consultation_available is true for a coachless client once a house set exists', async () => {
    const w = makeWorld();
    addHouseSet(w);
    expect((await w.svc.getOnboarding('loner')).consultation_available).toBe(true);
  });

  it('GET /me/onboarding: true for a client whose coach has no set, once a house set exists', async () => {
    const w = makeWorld();
    addHouseSet(w);
    // coach-1 keeps no set of its own (the false case is covered above).
    w.sets.splice(0, w.sets.length, ...w.sets.filter((s) => s.id === 'house-set'));
    expect((await w.svc.getOnboarding('client-1')).consultation_available).toBe(true);
  });

  it('a house set whose owner account is deleted or is not a coach is never used', async () => {
    for (const opts of [{ deleted: true }, { ownerRole: 'student' }]) {
      const w = makeWorld();
      addHouseSet(w, opts);
      expect((await w.svc.getOnboarding('loner')).consultation_available).toBe(false);
      await w.consentThenSave('loner', { version: 'consult-v1', answers: COMPLETE }, NOW);
      expect(await code(w.svc.complete('loner', NOW))).toBe('clinic_not_configured');
      expect(w.createdClones).toHaveLength(0);
    }
  });

  it('coachless completes: house master cloned into the client OWN tenant, no coach, no spaces, no alert', async () => {
    const w = makeWorld();
    addHouseSet(w);
    await w.consentThenSave('loner', { version: 'consult-v1', answers: COMPLETE }, NOW);
    const res = await w.svc.complete('loner', NOW);
    expect(res.coach).toBeNull();
    expect(res.spaces).toEqual([]);
    expect(res.program).toMatchObject({ key: 'considered-strength', days_per_week: 3, weeks: 4 });
    expect(res.macros.calories).toBe(1789);
    expect(w.createdClones).toHaveLength(1);
    expect(w.createdClones[0]).toMatchObject({
      is_template: false,
      cloned_from_id: `${HOUSE}-master-considered-strength`,
      coach_id: 'loner',
      owner_user_id: 'loner',
      client_id: 'loner',
    });
    expect(w.builder.writeProgramAssignmentsInTx).toHaveBeenCalledWith(
      expect.anything(),
      'loner',
      w.createdClones[0].id,
      'loner',
      '2026-10-05',
    );
    expect(w.builder.notifyProgramAssigned).toHaveBeenCalledTimes(1);
    expect(w.macroTargets).toEqual([
      expect.objectContaining({ coach_id: 'loner', client_id: 'loner', calories_kcal: 1789 }),
    ]);
    expect(w.memberships).toHaveLength(0);
    expect(w.notifications).toHaveLength(0);
    expect(w.intakes[0].completed_at).toEqual(NOW);
    expect(w.profiles.find((p) => p.user_id === 'loner')?.onboardingCompleted).toBe(true);
    const state = await w.svc.getOnboarding('loner');
    expect(state.completed).toBe(true);
    expect(state.consultation_available).toBe(true);
  });

  it("no cross-tenant read: a coachless client's clone and targets sit in no coach's tenant", async () => {
    const w = makeWorld();
    addHouseSet(w);
    await w.consentThenSave('loner', { version: 'consult-v1', answers: COMPLETE }, NOW);
    await w.svc.complete('loner', NOW);
    // Coach program reads are keyed on the coach's tenant (program-library
    // `coach_id: actor.tenantId`, tenantId = head ?? coach id): a coach or
    // owner id. The clone's tenant and owner are the client's id, so no coach,
    // the house account included, can list it.
    const coaches = coachIds(w);
    for (const clone of w.createdClones) {
      expect(coaches).not.toContain(clone.coach_id);
      expect(coaches).not.toContain(clone.owner_user_id);
    }
    expect(coaches).not.toContain(w.macroTargets[0].coach_id);
    expect(w.workoutAssignments.every((a) => a.assigned_by_coach_id === 'loner')).toBe(true);
    // The house tenant still holds only its own templates.
    expect(w.programs.filter((p) => p.coach_id === HOUSE).every((p) => p.is_template)).toBe(true);
  });

  it('coachless with a screening yes: extra-care program, flag recorded, the house account alerted in-app (decision 133-11)', async () => {
    const w = makeWorld();
    addHouseSet(w);
    await w.consentThenSave(
      'loner',
      { version: 'consult-v1', answers: { ...COMPLETE, T1: 'advanced', S1: '5', P4: 'yes' } },
      NOW,
    );
    const res = await w.svc.complete('loner', NOW);
    expect(res.program).toMatchObject({ key: 'steady-foundations', days_per_week: 2 });
    expect(w.intakes[0].screening_flagged_at).toEqual(NOW);
    expect(w.notifications).toEqual([
      {
        user_id: HOUSE,
        kind: 'coach_alert',
        channel: 'inapp',
        body: 'A client without a coach finished their consultation and was flagged for extra care.',
        payload: { type: 'onboarding_screening_review', client_id: 'loner', coachless: true },
      },
    ]);
    // No screening details, and never "your coach" for a client without one.
    expect(String(w.notifications[0].body)).not.toMatch(/P4|heart|chest|pregnan|your coach/i);
    // The alert names a flag only: the house account still cannot open the intake.
    expect(await w.svc.canCoachRead(HOUSE, 'loner')).toBe(false);
  });

  it('coachless flagged: a replayed completion alerts the house account once', async () => {
    const w = makeWorld();
    addHouseSet(w);
    await w.consentThenSave('loner', { version: 'consult-v1', answers: { ...COMPLETE, P4: 'yes' } }, NOW);
    await w.svc.complete('loner', NOW);
    await w.svc.complete('loner', new Date(NOW.getTime() + 5000));
    expect(w.notifications.map((n) => n.user_id)).toEqual([HOUSE]);
  });

  it('coachless: consent_missing is still enforced', async () => {
    const w = makeWorld();
    addHouseSet(w);
    await w.consentThenSave('loner', { version: 'consult-v1', answers: COMPLETE }, NOW);
    w.intakes[0].disclaimer_accepted_at = null;
    expect(await code(w.svc.complete('loner', NOW))).toBe('consent_missing');
    expect(w.createdClones).toHaveLength(0);
  });

  it('coachless: idempotent replay returns the frozen result and assigns nothing new', async () => {
    const w = makeWorld();
    addHouseSet(w);
    await w.consentThenSave('loner', { version: 'consult-v1', answers: COMPLETE }, NOW);
    const first = await w.svc.complete('loner', NOW);
    const second = await w.svc.complete('loner', new Date(NOW.getTime() + 5000));
    expect(second).toEqual(first);
    expect(w.createdClones).toHaveLength(1);
    expect(w.macroTargets).toHaveLength(1);
    expect(w.builder.notifyProgramAssigned).toHaveBeenCalledTimes(1);
  });

  it('coachless: the fenced transaction locks the client row only, FOR SHARE', async () => {
    const w = makeWorld();
    addHouseSet(w);
    await w.consentThenSave('loner', { version: 'consult-v1', answers: COMPLETE }, NOW);
    w.prisma.$queryRaw.mockClear();
    await w.svc.complete('loner', NOW);
    const userLocks = w.prisma.$queryRaw.mock.calls
      .map((c) => ({ sql: (c[0] as TemplateStringsArray).join('?'), id: c[1] }))
      .filter((c) => c.sql.includes('FROM "User"'));
    expect(userLocks.map((c) => c.id)).toEqual(['loner']);
  });

  it('coachless client attached to a coach mid-completion: nothing written in the client tenant; re-run under the coach', async () => {
    const w = makeWorld();
    addHouseSet(w);
    await w.consentThenSave('loner', { version: 'consult-v1', answers: COMPLETE }, NOW);
    w.hooks.beforeTransaction = () => {
      w.hooks.beforeTransaction = undefined;
      w.users.find((u) => u.id === 'loner')!.coach_id = 'coach-1';
    };
    const res = await w.svc.complete('loner', NOW);
    expect(res.coach).toEqual({ id: 'coach-1', display_name: 'Coach Rae' });
    expect(w.createdClones).toHaveLength(1);
    expect(w.createdClones[0]).toMatchObject({
      owner_user_id: 'coach-1',
      coach_id: 'coach-1',
      cloned_from_id: 'master-considered-strength',
    });
    expect(w.macroTargets.map((m) => m.coach_id)).toEqual(['coach-1']);
    expect(w.programs.some((p) => p.coach_id === 'loner')).toBe(false);
  });

  it('coached with their own set: unchanged when a house set also exists', async () => {
    const w = makeWorld();
    addHouseSet(w);
    await w.consentThenSave('client-1', { version: 'consult-v1', answers: COMPLETE }, NOW);
    const res = await w.svc.complete('client-1', NOW);
    expect(res.coach).toEqual({ id: 'coach-1', display_name: 'Coach Rae' });
    expect(res.spaces.map((s) => s.id)).toEqual(['cohort-all', 'cohort-considered-strength']);
    expect(w.createdClones[0]).toMatchObject({
      cloned_from_id: 'master-considered-strength',
      owner_user_id: 'coach-1',
    });
    expect(w.memberships.some((m) => String(m.cohort_id).startsWith(HOUSE))).toBe(false);
  });

  it("coached without a set falls back to the house programs, under the coach's name and tenant, joining no house space", async () => {
    const w = makeWorld();
    addHouseSet(w);
    w.sets.splice(0, w.sets.length, ...w.sets.filter((s) => s.id === 'house-set'));
    await w.consentThenSave(
      'client-1',
      { version: 'consult-v1', answers: { ...COMPLETE, P4: 'yes' } },
      NOW,
    );
    const res = await w.svc.complete('client-1', NOW);
    expect(res.coach).toEqual({ id: 'coach-1', display_name: 'Coach Rae' });
    expect(res.spaces).toEqual([]);
    expect(w.memberships).toHaveLength(0);
    expect(w.createdClones).toHaveLength(1);
    expect(w.createdClones[0]).toMatchObject({
      cloned_from_id: `${HOUSE}-master-steady-foundations`,
      owner_user_id: 'coach-1',
      coach_id: 'coach-1',
      client_id: 'client-1',
    });
    expect(w.macroTargets.map((m) => m.coach_id)).toEqual(['coach-1']);
    // The screening alert goes to the client's own coach, never the house account.
    expect(w.notifications.map((n) => n.user_id)).toEqual(['coach-1']);
  });

  it("refuses a house-set master that is not the house account's own template (tenancy)", async () => {
    const w = makeWorld();
    addHouseSet(w);
    const house = w.sets.find((s) => s.id === 'house-set') as {
      programs: Record<string, { program_id: string }>;
    };
    // Points at coach-1's master: a set may never clone another account's template.
    house.programs['considered-strength'].program_id = 'master-considered-strength';
    await w.consentThenSave('loner', { version: 'consult-v1', answers: COMPLETE }, NOW);
    expect(await code(w.svc.complete('loner', NOW))).toBe('clinic_not_configured');
    expect(w.createdClones).toHaveLength(0);
    expect(w.intakes[0].completion_claimed_at).toBeNull();
  });
});

describe('B-GOALCLEAR-BE-135: a goal weight removed in the summary leaves the profile', () => {
  const later = new Date(NOW.getTime() + 60_000);
  const NO_GOAL = Object.fromEntries(Object.entries(COMPLETE).filter(([k]) => k !== 'B4'));
  const calculated = (answers: Answers) => {
    const r = resolveMacroInputs(macroRawFromAnswers(answers), later);
    if (!r.ok) throw new Error(`fixture not computable: ${r.missing.join(',')}`);
    return computeMacros(r.inputs);
  };

  it('{B4: null} clears target_weight_lbs, and the profile targets equal the completion targets', async () => {
    const w = makeWorld();
    await w.consentThenSave('client-1', { version: 'consult-v1', answers: COMPLETE }, NOW);
    expect(w.profiles[0]).toMatchObject({
      target_weight_lbs: 150,
      macro_target_protein_g: calculated(COMPLETE).protein_g,
    });
    // The mobile "No number, just the goal" edit sends exactly this.
    await w.svc.saveConsultation(
      'client-1',
      { version: 'consult-v1', answers: { B4: null } },
      later,
    );
    expect(w.profiles[0].target_weight_lbs).toBeNull();
    // Protein now follows the current weight, not the deleted goal.
    expect(calculated(NO_GOAL).protein_g).not.toBe(calculated(COMPLETE).protein_g);
    const res = await w.svc.complete('client-1', later);
    expect(res.macros.protein_g).toBe(calculated(NO_GOAL).protein_g);
    expect(w.macroTargets).toHaveLength(1);
    const done = w.macroTargets[0];
    expect(w.profiles[0]).toMatchObject({
      macro_target_calories: done.calories_kcal,
      macro_target_protein_g: done.protein_g,
      macro_target_carbs_g: done.carbs_g,
      macro_target_fat_g: done.fats_g,
    });
  });

  it('a save that omits B4 keeps the stored goal weight; a cleared required answer still clears nothing', async () => {
    const w = makeWorld();
    await w.consentThenSave('client-1', { version: 'consult-v1', answers: COMPLETE }, NOW);
    await w.svc.saveConsultation(
      'client-1',
      { version: 'consult-v1', answers: { L1: 'active' } },
      later,
    );
    expect(w.profiles[0]).toMatchObject({
      target_weight_lbs: 150,
      activity_level: 'active',
      macro_target_protein_g: calculated({ ...COMPLETE, L1: 'active' }).protein_g,
    });
    await w.svc.saveConsultation(
      'client-1',
      { version: 'consult-v1', answers: { L1: null } },
      later,
    );
    expect(w.profiles[0]).toMatchObject({ target_weight_lbs: 150, activity_level: 'active' });
  });

  it('a goal weight already on the profile is kept while the consultation never sends B4', async () => {
    const w = makeWorld();
    w.profiles.push({ user_id: 'client-1', target_weight_lbs: 140 });
    await w.consentThenSave('client-1', { version: 'consult-v1', answers: NO_GOAL }, NOW);
    expect(w.profiles[0].target_weight_lbs).toBe(140);
  });
});
