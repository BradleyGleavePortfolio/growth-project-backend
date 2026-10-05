import type { Prisma } from '@prisma/client';
import { BroadcastScopeService } from '../../src/broadcasts/broadcast-scope.service';
import type { SubCoachScopeService } from '../../src/sub-coach/sub-coach-scope.service';
import { stub } from './_stub';

/**
 * A-659-7: the send-time authority check. The real row locks are proven on
 * Postgres in broadcasts-dispatch.live.spec.ts; this pins the decision table
 * and that every read is a FOR SHARE lock.
 */
type U = { id: string; role: string; coach_id: string | null; deleted_at: Date | null };

function harness(opts: {
  users: Record<string, U | undefined>;
  membershipHead?: string | null;
  openAssignment?: boolean;
}) {
  const sql: string[] = [];
  const tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      sql.push(text);
      if (text.includes('FROM "User"')) {
        const u = opts.users[values[0] as string];
        return u ? [u] : [];
      }
      if (text.includes('FROM "SubCoachAssignment"'))
        return opts.openAssignment ? [{ id: 'a1' }] : [];
      return [];
    }),
  };
  const lockMembershipHeadCoachIdInTx = jest.fn(async () => opts.membershipHead ?? null);
  const svc = new BroadcastScopeService(
    stub<SubCoachScopeService>({ lockMembershipHeadCoachIdInTx }),
  );
  const check = (authorId: string, clientId = 'client-1') =>
    svc.lockSendAuthority(stub<Prisma.TransactionClient>(tx), 'head-1', authorId, clientId);
  return { check, sql, lockMembershipHeadCoachIdInTx };
}

const head: U = { id: 'head-1', role: 'coach', coach_id: null, deleted_at: null };
const sub: U = { id: 'sub-1', role: 'coach', coach_id: 'head-1', deleted_at: null };
const client: U = { id: 'client-1', role: 'student', coach_id: 'head-1', deleted_at: null };

describe('BroadcastScopeService.lockSendAuthority (A-659-7)', () => {
  it('the head coach may message a live client on the roster; every read is FOR SHARE', async () => {
    const h = harness({ users: { 'head-1': head, 'client-1': client } });
    expect(await h.check('head-1')).toBeNull();
    expect(h.sql.length).toBeGreaterThan(0);
    for (const q of h.sql) expect(q).toMatch(/FOR SHARE/);
  });

  it('a client transferred to another coach or deleted is off the roster', async () => {
    expect(
      await harness({
        users: { 'head-1': head, 'client-1': { ...client, coach_id: 'other' } },
      }).check('head-1'),
    ).toBe('not_on_roster');
    expect(
      await harness({
        users: { 'head-1': head, 'client-1': { ...client, deleted_at: new Date() } },
      }).check('head-1'),
    ).toBe('not_on_roster');
  });

  it('a sub-coach with a live seat and an open assignment may message the client', async () => {
    const h = harness({
      users: { 'sub-1': sub, 'client-1': client },
      membershipHead: 'head-1',
      openAssignment: true,
    });
    expect(await h.check('sub-1')).toBeNull();
    expect(h.lockMembershipHeadCoachIdInTx).toHaveBeenCalledTimes(1);
    expect(
      h.sql.some(
        (q) => q.includes('"SubCoachAssignment"') && q.includes('"unassigned_at" IS NULL'),
      ),
    ).toBe(true);
  });

  it('a client reassigned away from the sub-coach is refused', async () => {
    const h = harness({
      users: { 'sub-1': sub, 'client-1': client },
      membershipHead: 'head-1',
      openAssignment: false,
    });
    expect(await h.check('sub-1')).toBe('author_not_assigned');
  });

  it('a sub-coach who left the team (no membership) is refused, never treated as the head', async () => {
    const h = harness({
      users: { 'sub-1': sub, 'client-1': client },
      membershipHead: null,
      openAssignment: true,
    });
    expect(await h.check('sub-1')).toBe('author_not_in_tenant');
  });

  it('a deleted author or one who is no longer a coach is refused', async () => {
    expect(
      await harness({
        users: { 'sub-1': { ...sub, deleted_at: new Date() }, 'client-1': client },
        membershipHead: 'head-1',
        openAssignment: true,
      }).check('sub-1'),
    ).toBe('author_not_in_tenant');
    expect(
      await harness({
        users: { 'sub-1': { ...sub, role: 'student' }, 'client-1': client },
        membershipHead: 'head-1',
        openAssignment: true,
      }).check('sub-1'),
    ).toBe('author_not_in_tenant');
    expect(await harness({ users: { 'client-1': client } }).check('sub-1')).toBe(
      'author_not_in_tenant',
    );
  });
});
