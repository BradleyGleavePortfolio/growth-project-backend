/**
 * Backend #640 (S-MWB Programs) adds WorkoutProgram.client_id: the client a
 * program copy was made for (bulk assign, package delivery, consultation
 * clones). The User row is tombstoned on deletion, so its ON DELETE CASCADE
 * never fires; the erasure manifest must delete those copies itself, and must
 * never touch the coach's masters (is_template = true, client_id null).
 *
 * Without the manifest entry the manifest runs no WorkoutProgram delete at all
 * and this suite fails (the copies would outlive the account).
 */
import { Prisma } from '@prisma/client';
import {
  ERASURE_MANIFEST,
  executeErasureManifest,
} from '../../src/account-deletion/account-deletion.manifest';

function stub<T>(value: unknown): T {
  return value as T;
}

const USER = 'client-erased-1';

type Call = { model: string; op: 'deleteMany' | 'updateMany'; where: Record<string, unknown> };

function recordingTx() {
  const calls: Call[] = [];
  const delegate = (model: string) => ({
    deleteMany: async (args: { where: Record<string, unknown> }) => {
      calls.push({ model, op: 'deleteMany', where: args.where });
      return { count: 0 };
    },
    updateMany: async (args: { where: Record<string, unknown> }) => {
      calls.push({ model, op: 'updateMany', where: args.where });
      return { count: 0 };
    },
    findMany: async () => [],
  });
  const tx = new Proxy(
    {},
    {
      get: (_t, prop: string | symbol) => {
        if (prop === '$executeRaw') return async () => 0;
        if (prop === '$queryRaw') return async () => [];
        if (typeof prop !== 'string') return undefined;
        return delegate(prop);
      },
    },
  );
  return { tx: stub<Prisma.TransactionClient>(tx), calls };
}

describe('erasure manifest: S-MWB program copies (#640)', () => {
  it('names WorkoutProgram.client_id as a delete of non-template copies only', () => {
    const entries = ERASURE_MANIFEST.filter(
      (e) => e.model === 'WorkoutProgram' && e.field === 'client_id',
    );
    expect(entries).toEqual([
      expect.objectContaining({ action: { op: 'delete' }, where: { is_template: false } }),
    ]);
  });

  it("deletes the client's program copies inside the finalization run", async () => {
    const { tx, calls } = recordingTx();
    await executeErasureManifest(tx, {
      userId: USER,
      email: 'erased@example.test',
      tombstoneEmail: 'deleted+x@example.invalid',
      now: new Date('2026-10-03T00:00:00Z'),
    });
    const programDeletes = calls.filter(
      (c) => c.model === 'workoutProgram' && c.op === 'deleteMany',
    );
    expect(programDeletes).toEqual([
      { model: 'workoutProgram', op: 'deleteMany', where: { client_id: USER, is_template: false } },
    ]);
    // Masters are coach content: no delete or scrub of a template ever runs.
    expect(
      calls.some((c) => c.model === 'workoutProgram' && c.where.is_template === true),
    ).toBe(false);
  });
});
