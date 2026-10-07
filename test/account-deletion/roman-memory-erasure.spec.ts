/**
 * R11-C2C (owner ruling 2026-10-07 11:46): Roman's notes about a client are
 * deleted only when the client deletes their account. Turning memory off,
 * withdrawing Roman and deleting a chat keep them
 * (test/ai-consent/ai-consent-memory-default.spec.ts, and the ON DELETE SET
 * NULL pin in test/roman/r11-memory-schema.spec.ts).
 *
 * This suite runs the real account-deletion manifest executor against an
 * in-memory store of Roman's three memory tables: the deleted client's notes,
 * summaries and memory state go; another client's stay.
 */
import type { Prisma } from '@prisma/client';
import {
  ERASURE_MANIFEST,
  executeErasureManifest,
} from '../../src/account-deletion/account-deletion.manifest';

function stub<T>(value: unknown): T {
  return value as T;
}

const MODELS = ['romanClientNote', 'romanClientSummary', 'romanMemoryState'] as const;
type Model = (typeof MODELS)[number];

class MemoryStore {
  rows: Record<Model, { client_id: string }[]> = {
    romanClientNote: [],
    romanClientSummary: [],
    romanMemoryState: [],
  };

  seed(clientId: string): void {
    for (const m of MODELS) this.rows[m].push({ client_id: clientId });
  }

  count(clientId: string): number {
    return MODELS.reduce((n, m) => n + this.rows[m].filter((r) => r.client_id === clientId).length, 0);
  }

  tx(): Prisma.TransactionClient {
    const noop = { deleteMany: async () => ({ count: 0 }), updateMany: async () => ({ count: 0 }) };
    const table = (m: Model) => ({
      deleteMany: async ({ where }: { where: { client_id?: unknown } }) => {
        if (typeof where.client_id !== 'string') throw new Error(`unexpected where on ${m}`);
        const before = this.rows[m].length;
        this.rows[m] = this.rows[m].filter((r) => r.client_id !== where.client_id);
        return { count: before - this.rows[m].length };
      },
      updateMany: async () => {
        throw new Error(`${m} is deleted, never updated`);
      },
    });
    return stub<Prisma.TransactionClient>(
      new Proxy(
        {
          romanClientNote: table('romanClientNote'),
          romanClientSummary: table('romanClientSummary'),
          romanMemoryState: table('romanMemoryState'),
          coachMediaAsset: { ...noop, findMany: async () => [] },
          clientAssetGrant: noop,
          $executeRaw: async () => 0,
          $queryRaw: async () => [{ present: false }],
        },
        {
          get(target, prop: string) {
            return prop in target ? Reflect.get(target, prop) : noop;
          },
        },
      ),
    );
  }
}

const ctx = (userId: string) => ({
  userId,
  email: `${userId}@example.test`,
  tombstoneEmail: `deleted+${userId}@tombstone.invalid`,
  now: new Date('2026-10-07T12:00:00Z'),
});

describe("account deletion erases Roman's notes (R11-C2C: the only path that does)", () => {
  it("deletes the client's notes, summaries and memory state, and nobody else's", async () => {
    const db = new MemoryStore();
    db.seed('client-1');
    db.seed('client-1');
    db.seed('client-2');
    const results = await executeErasureManifest(db.tx(), ctx('client-1'));
    expect(db.count('client-1')).toBe(0);
    expect(db.count('client-2')).toBe(3);
    for (const model of ['RomanClientNote', 'RomanClientSummary', 'RomanMemoryState']) {
      expect(results).toContainEqual({ model, field: 'client_id', op: 'delete', count: 2 });
    }
  });

  it('the manifest is the only place memory rows are deleted: one delete by client_id each', () => {
    for (const model of ['RomanClientNote', 'RomanClientSummary', 'RomanMemoryState']) {
      expect(ERASURE_MANIFEST.filter((e) => e.model === model)).toEqual([
        { model, field: 'client_id', action: { op: 'delete' } },
      ]);
    }
  });
});
