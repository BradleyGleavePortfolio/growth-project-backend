/**
 * H6 — AuditLogService.redactPii(userId) GDPR Art. 17 contract (D-H6-4 LOCKED).
 *
 * Targets the two ways the right-to-be-forgotten path can regress:
 *   - PII leak: a known-PII key survives with plaintext after erasure.
 *   - Lost audit fact / wrong scope: the audit row's identity is mangled, or
 *     the erasure reaches rows belonging to another actor (IDOR, #5).
 *
 * The Prisma double exposes the two delegates the method reads —
 * auditLogEntry.findMany (scoped by actor_id) and auditLogEntry.update — and
 * mutates the backing fixture on update so a second pass exercises idempotency.
 */

import { AuditLogService } from '../../src/audit-log/audit-log.service';
import { erasureToken } from '../../src/audit-log/erasure-token';
import { asPrismaDouble } from './prisma-test-double';

const USER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

interface Row {
  id: string;
  actor_id: string;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
}

function makeFixture(): Row[] {
  return [
    {
      id: 'row-1',
      actor_id: USER,
      before_state: { email: 'alice@old.example', display_name: 'Alice', phone: '+15550001' },
      after_state: { email: 'alice@new.example', role: 'user' },
    },
    {
      id: 'row-2',
      actor_id: OTHER,
      before_state: { email: 'bob@example.com' },
      after_state: null,
    },
  ];
}

function makePrisma(rows: Row[]) {
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
  const findMany = jest.fn(async (args: { where: { actor_id: string } }) =>
    rows
      .filter((r) => r.actor_id === args.where.actor_id)
      .map((r) => ({ id: r.id, before_state: r.before_state, after_state: r.after_state })),
  );
  const update = jest.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
    const row = rows.find((r) => r.id === args.where.id)!;
    Object.assign(row, args.data); // persist so a re-run sees already-redacted state
    updates.push(args);
    return row;
  });
  return { prisma: asPrismaDouble({ auditLogEntry: { findMany, update } }), updates, findMany };
}

describe('AuditLogService.redactPii (GDPR Art. 17, D-H6-4)', () => {
  it('tokenizes PII leaves via erasureToken() while preserving non-PII fields', async () => {
    const rows = makeFixture();
    const { prisma, updates } = makePrisma(rows);

    const count = await new AuditLogService(prisma).redactPii(USER);

    expect(count).toBe(1); // only the USER row
    const data = updates[0].data;
    expect(data.before_state).toEqual({
      email: erasureToken('alice@old.example'),
      display_name: 'Alice',
      phone: erasureToken('+15550001'),
    });
    expect(data.after_state).toEqual({ email: erasureToken('alice@new.example'), role: 'user' });
    // The update patch carries ONLY the state columns — the audit fact (id,
    // action, resource_type, request_id, created_at) is never rewritten.
    expect(Object.keys(data).sort()).toEqual(['after_state', 'before_state']);
  });

  it('is scoped to the passed userId only — never touches another actor (IDOR guard)', async () => {
    const rows = makeFixture();
    const { prisma, findMany } = makePrisma(rows);

    await new AuditLogService(prisma).redactPii(USER);

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { actor_id: USER } }));
    // OTHER's row is left with its plaintext intact.
    expect(rows.find((r) => r.id === 'row-2')!.before_state).toEqual({ email: 'bob@example.com' });
  });

  it('leaves no plaintext under any known-PII key after erasure', async () => {
    const rows = makeFixture();
    const { prisma } = makePrisma(rows);

    await new AuditLogService(prisma).redactPii(USER);

    const erased = rows.find((r) => r.id === 'row-1')!;
    for (const key of ['email', 'phone'] as const) {
      const before = erased.before_state?.[key];
      if (before !== undefined) expect(before).toMatch(/^tok_[a-f0-9]{16}$/);
    }
    expect(erased.after_state?.email).toMatch(/^tok_[a-f0-9]{16}$/);
  });

  it('is idempotent: a second pass does not double-tokenize already-erased rows', async () => {
    const rows = makeFixture();
    const { prisma } = makePrisma(rows);
    const service = new AuditLogService(prisma);

    await service.redactPii(USER);
    const firstToken = rows.find((r) => r.id === 'row-1')!.before_state?.email;
    await service.redactPii(USER);
    const secondToken = rows.find((r) => r.id === 'row-1')!.before_state?.email;

    expect(secondToken).toBe(firstToken); // stable, not re-hashed
  });
});
