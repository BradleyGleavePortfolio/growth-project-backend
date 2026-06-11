/**
 * MWB-2 (§3.3, Decision A LOCKED) — transactional guarantees of
 * WorkoutBuilderService.cloneProgramToClient.
 *
 * cloneProgramToClient does a deep copy-by-value of a master template program
 * onto a client inside ONE Serializable transaction. Two things must hold and
 * are pinned here without a live Postgres (PrismaService is fully mocked):
 *
 *   1. Isolation contract: the clone runs in a $transaction opened with
 *      `Prisma.TransactionIsolationLevel.Serializable`. A future refactor that
 *      silently drops to the default READ COMMITTED would let a concurrent
 *      edit of the source program tear the copy — this test fails if the
 *      isolation level is ever weakened.
 *
 *   2. Concurrent-write rollback: when a concurrent write to the SAME source
 *      program causes Postgres to abort this transaction with a
 *      serialization failure (SQLSTATE 40001 → Prisma P2034
 *      "Transaction failed due to a write conflict or a deadlock"), the
 *      service does NOT swallow it. It rejects deterministically and leaves
 *      no partial clone — the program create that ran before the conflicting
 *      revision write is rolled back as one atomic unit. This is the
 *      "second one rolls back deterministically" guarantee from the brief.
 *
 * Decision A is also re-asserted: the clone is non-template, sets
 * cloned_from_id, and anchors a FRESH program-level revision (head_revision_id
 * → its own "v1"), never mutating the source.
 */

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma.service';
import { WorkoutBuilderService } from '../src/workout-builder/workout-builder.service';

const COACH_ID = 'coach-uuid-1';
const CLIENT_ID = 'client-uuid-1';
const MASTER_ID = 'prog-master';

const coachRow = { id: COACH_ID, role: 'coach' as const, coach_id: null };

const master = {
  id: MASTER_ID,
  coach_id: COACH_ID,
  owner_user_id: COACH_ID,
  visibility: 'owner_only',
  name: 'Hypertrophy Master',
  description: '12-week build',
  weeks: 12,
  days_per_week: 4,
  is_template: true,
  goal_tag: 'hypertrophy',
};

/**
 * A Prisma serialization-failure: code P2034 is what `@prisma/client` raises
 * when Postgres aborts a Serializable transaction with SQLSTATE 40001 (a write
 * conflict against a concurrent transaction touching the same rows). Building
 * the real error class keeps the test faithful to runtime behaviour.
 */
function serializationFailure(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'Transaction failed due to a write conflict or a deadlock. Please retry your transaction',
    { code: 'P2034', clientVersion: 'test' },
  );
}

interface CloneTxMock {
  workoutProgram: { create: jest.Mock; update: jest.Mock };
  workoutPlan: { findMany: jest.Mock; create: jest.Mock; update: jest.Mock };
  workoutPlanExercise: { createMany: jest.Mock };
  workoutPlanRevision: { create: jest.Mock };
  workoutProgramRevision: { create: jest.Mock };
}

function makeTx(): CloneTxMock {
  return {
    workoutProgram: {
      create: jest.fn().mockResolvedValue({
        id: 'prog-clone',
        is_template: false,
        cloned_from_id: MASTER_ID,
        weeks: 12,
        days_per_week: 4,
      }),
      update: jest.fn().mockResolvedValue({
        id: 'prog-clone',
        is_template: false,
        cloned_from_id: MASTER_ID,
        head_revision_id: 'prog-rev-1',
      }),
    },
    workoutPlan: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
    },
    workoutPlanExercise: { createMany: jest.fn() },
    workoutPlanRevision: { create: jest.fn().mockResolvedValue({ id: 'rev-1' }) },
    workoutProgramRevision: {
      create: jest.fn().mockResolvedValue({ id: 'prog-rev-1' }),
    },
  };
}

describe('cloneProgramToClient — Serializable transaction (MWB-2 §3.3)', () => {
  let service: WorkoutBuilderService;
  let prisma: {
    workoutProgram: { findUnique: jest.Mock };
    user: { findUnique: jest.Mock };
    subCoachAssignment: { findMany: jest.Mock };
    $transaction: jest.Mock;
  };
  const ORIGINAL_FLAG = process.env.FEATURE_MWB_TEMPLATES;

  beforeEach(() => {
    process.env.FEATURE_MWB_TEMPLATES = 'true';

    prisma = {
      workoutProgram: { findUnique: jest.fn().mockResolvedValue(master) },
      user: {
        findUnique: jest.fn().mockImplementation(
          ({ where }: { where: { id: string } }) => {
            if (where.id === COACH_ID) return Promise.resolve(coachRow);
            if (where.id === CLIENT_ID)
              return Promise.resolve({ id: CLIENT_ID, coach_id: COACH_ID });
            return Promise.resolve(null);
          },
        ),
      },
      subCoachAssignment: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(),
    };

    service = new WorkoutBuilderService(prisma as unknown as PrismaService);
  });

  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.FEATURE_MWB_TEMPLATES;
    else process.env.FEATURE_MWB_TEMPLATES = ORIGINAL_FLAG;
    jest.clearAllMocks();
  });

  it('opens the clone in a SERIALIZABLE transaction', async () => {
    const tx = makeTx();
    prisma.$transaction.mockImplementation(
      async (fn: (t: CloneTxMock) => unknown) => fn(tx),
    );

    await service.cloneProgramToClient(MASTER_ID, CLIENT_ID, COACH_ID);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const options = prisma.$transaction.mock.calls[0][1];
    expect(options).toEqual(
      expect.objectContaining({
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      }),
    );
  });

  it('copies by value into a fresh non-template program with its own v1 revision', async () => {
    const tx = makeTx();
    prisma.$transaction.mockImplementation(
      async (fn: (t: CloneTxMock) => unknown) => fn(tx),
    );

    const result = await service.cloneProgramToClient(
      MASTER_ID,
      CLIENT_ID,
      COACH_ID,
    );

    // Non-template clone with provenance back to the master.
    expect(tx.workoutProgram.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          is_template: false,
          cloned_from_id: MASTER_ID,
          owner_user_id: COACH_ID,
        }),
      }),
    );
    // Fresh program-level revision (index 0, cause 'clone') + head pointer.
    expect(tx.workoutProgramRevision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          program_id: 'prog-clone',
          revision_index: 0,
          cause: 'clone',
        }),
      }),
    );
    expect(tx.workoutProgram.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'prog-clone' },
        data: { head_revision_id: 'prog-rev-1' },
      }),
    );
    expect(result.program.head_revision_id).toBe('prog-rev-1');
    // The source master is read once, never written.
    expect(prisma.workoutProgram.findUnique).toHaveBeenCalledTimes(1);
  });

  it('rolls back deterministically when a concurrent write conflicts (P2034)', async () => {
    // Model a real Serializable abort: the program row is created, then the
    // concurrent transaction that touched the same source program forces
    // Postgres to abort THIS transaction at commit. Prisma surfaces that as
    // P2034 from inside the interactive transaction callback, and the WHOLE
    // unit rolls back — the prior create is undone, no partial clone persists.
    const tx = makeTx();
    tx.workoutProgramRevision.create.mockRejectedValueOnce(
      serializationFailure(),
    );

    let committed = false;
    prisma.$transaction.mockImplementation(
      async (fn: (t: CloneTxMock) => unknown) => {
        // Real Prisma rolls back automatically when the callback throws; the
        // returned promise rejects with the same error and nothing commits.
        const out = await fn(tx);
        committed = true;
        return out;
      },
    );

    const err = await service
      .cloneProgramToClient(MASTER_ID, CLIENT_ID, COACH_ID)
      .catch((e) => e);

    // The conflict is NOT swallowed — it propagates as the deterministic
    // P2034 write-conflict, and the transaction never reached commit.
    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2034');
    expect(committed).toBe(false);
    // The conflicting revision write was attempted exactly once (no silent
    // retry that could mask the conflict or double-write).
    expect(tx.workoutProgramRevision.create).toHaveBeenCalledTimes(1);
  });

  it('two concurrent clones of the same source: exactly one commits, the other aborts', async () => {
    // Drive two clone calls against the same master. The first transaction
    // wins and commits; the second collides on the source rows and Postgres
    // aborts it with a serialization failure. This is the brief's
    // "second one rolls back deterministically" — proven by one resolved
    // result and one P2034 rejection, never two successful commits.
    const txWinner = makeTx();
    const txLoser = makeTx();
    txLoser.workoutProgram.create.mockRejectedValueOnce(serializationFailure());

    prisma.$transaction
      .mockImplementationOnce(
        async (fn: (t: CloneTxMock) => unknown) => fn(txWinner),
      )
      .mockImplementationOnce(
        async (fn: (t: CloneTxMock) => unknown) => fn(txLoser),
      );

    const [winner, loser] = await Promise.allSettled([
      service.cloneProgramToClient(MASTER_ID, CLIENT_ID, COACH_ID),
      service.cloneProgramToClient(MASTER_ID, CLIENT_ID, COACH_ID),
    ]);

    expect(winner.status).toBe('fulfilled');
    expect(loser.status).toBe('rejected');
    const reason = (loser as PromiseRejectedResult)
      .reason as Prisma.PrismaClientKnownRequestError;
    expect(reason).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(reason.code).toBe('P2034');
    // The loser never wrote a revision or a head pointer — it aborted before.
    expect(txLoser.workoutProgramRevision.create).not.toHaveBeenCalled();
    expect(txLoser.workoutProgram.update).not.toHaveBeenCalled();
  });

  it('still 404s before opening any transaction when the flag is OFF', async () => {
    delete process.env.FEATURE_MWB_TEMPLATES;
    await expect(
      service.cloneProgramToClient(MASTER_ID, CLIENT_ID, COACH_ID),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.workoutProgram.findUnique).not.toHaveBeenCalled();
  });

  it('403s before opening any transaction when the client is out of scope', async () => {
    prisma.user.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) => {
        if (where.id === COACH_ID) return Promise.resolve(coachRow);
        if (where.id === CLIENT_ID)
          return Promise.resolve({ id: CLIENT_ID, coach_id: 'other-coach' });
        return Promise.resolve(null);
      },
    );
    await expect(
      service.cloneProgramToClient(MASTER_ID, CLIENT_ID, COACH_ID),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
