/**
 * S-MWB-3: the consultation copy (#607 onboarding, is_template = false) records
 * the client on WorkoutProgram.client_id, so account deletion's final
 * transaction (which deletes the client's non-template programs by client_id)
 * erases it with the client's other program copies. Masters never carry one.
 */
import type { Prisma } from '@prisma/client';
import { writeProgramTree, type ProgramTreeInput } from '../src/onboarding/program-writer';

function fake<T>(value: unknown): T {
  return value as T;
}

function makeTx() {
  return {
    workoutProgram: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'prog-1',
        name: data.name,
      })),
      update: jest.fn(async () => ({})),
    },
    workoutPlan: {
      create: jest.fn(async () => ({ id: 'plan-1' })),
      update: jest.fn(async () => ({})),
    },
    workoutPlanExercise: { createMany: jest.fn(async () => ({ count: 0 })) },
    workoutPlanRevision: { create: jest.fn(async () => ({ id: 'rev-1' })) },
    workoutProgramRevision: { create: jest.fn(async () => ({ id: 'prev-1' })) },
  };
}

const BASE: ProgramTreeInput = {
  tenantCoachId: 'coach-1',
  ownerUserId: 'coach-1',
  name: 'Strength foundations',
  description: null,
  weeks: 4,
  daysPerWeek: 3,
  goalTag: null,
  isTemplate: false,
  clonedFromId: 'master-1',
  plans: [],
  revisionMeta: {},
};

describe('writeProgramTree client_id (S-MWB-3)', () => {
  it('a client copy records client_id', async () => {
    const tx = makeTx();
    await writeProgramTree(fake<Prisma.TransactionClient>(tx), { ...BASE, clientId: 'client-1' });
    expect(tx.workoutProgram.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ is_template: false, client_id: 'client-1' }),
    });
  });

  it('a master never records a client, even if one is passed', async () => {
    const tx = makeTx();
    await writeProgramTree(fake<Prisma.TransactionClient>(tx), {
      ...BASE,
      isTemplate: true,
      clonedFromId: null,
      clientId: 'client-1',
    });
    expect(tx.workoutProgram.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ is_template: true, client_id: null }),
    });
  });
});
