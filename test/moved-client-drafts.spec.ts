// Owner decision 17: a client's move deletes the drafts about them that any
// other coach holds, in the move's own transaction. Approved or sent items
// are history and stay (owner decision 4). Runs the real move code over
// in-memory rows whose filters answer like Postgres (NULL never matches).
import { AiApprovalService, payloadClientIds } from '../src/ai/gateway/ai-approval.service';
import type { AuditService } from '../src/audit/audit.service';
import type { StripeApiService } from '../src/billing/stripe-api.service';
import { MOVED_CLIENT_PAYLOAD_KEYS, deleteDraftsLeftByMove } from '../src/coach/moved-client-drafts';
import type { PrismaService } from '../src/prisma.service';
import type { SubCoachCapacityService } from '../src/sub-coach/sub-coach-capacity.service';
import type { SubCoachIdempotencyService } from '../src/sub-coach/sub-coach-idempotency.service';
import { SubCoachReassignService } from '../src/sub-coach/sub-coach-reassign.service';
import { SubCoachesService } from '../src/sub-coaches/sub-coaches.service';
import type { TeamModeTierResolverService } from '../src/team-mode/tier-resolver.service';
import { TeamModeService } from '../src/team-mode/team-mode.service';
import type { TeamService } from '../src/team/team.service';
import { fakeOf } from './ai-egress/ai-egress.fakes';

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true;
    if (key === 'AND') return (cond as Where[]).every((w) => matches(row, w));
    if (key === 'OR') return (cond as Where[]).some((w) => matches(row, w));
    const value = row[key];
    if (cond && typeof cond === 'object') {
      const c = cond as { in?: unknown[]; not?: unknown; path?: string[]; equals?: unknown };
      if (c.in) return c.in.includes(value);
      if ('not' in c) return value != null && value !== c.not;
      if (c.path) return value != null && (value as Row)[c.path[0]] === c.equals;
    }
    return value === cond;
  });
}

function table(rows: Row[]) {
  const hits = (where: Where = {}) => rows.filter((r) => matches(r, where));
  return {
    rows,
    findFirst: async ({ where }: { where: Where }) => hits(where)[0] ?? null,
    findMany: async ({ where }: { where?: Where }) => hits(where),
    findUnique: async ({ where }: { where: Where }) =>
      hits((where.head_coach_id_sub_coach_id as Where | undefined) ?? where)[0] ?? null,
    count: async ({ where }: { where: Where }) => hits(where).length,
    update: async ({ where, data }: { where: Where; data: Row }) => Object.assign(hits(where)[0], data),
    updateMany: async ({ where, data }: { where: Where; data: Row }) => {
      const hit = hits(where);
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
    deleteMany: async ({ where }: { where: Where }) => {
      const kept = rows.filter((r) => !matches(r, where));
      const count = rows.length - kept.length;
      rows.splice(0, rows.length, ...kept);
      return { count };
    },
    create: async ({ data }: { data: Row }) => data,
    createMany: async ({ data }: { data: Row[] }) => ({ count: data.length }),
  };
}

// head1 runs a team with sub1. client1 and client2 are head1's; client3 is
// sub1's. Every draft id says who holds it, about whom, and its state.
function world() {
  const user = (id: string, role: string, coach_id: string | null) => ({ id, role, coach_id, name: id, deleted_at: null });
  const ai = (id: string, coachId: string, clientId: string, status: string) => ({ id, coachId, clientId, status });
  const gw = (id: string, tenant: string | null, subject: string, status: string, payload: Row = {}, requester = tenant) =>
    ({ id, tenant_coach_id: tenant, requester_id: requester, subject_user_id: subject, status, payload });
  const msg = (id: string, coach_id: string, client_id: string) => ({ id, coach_id, client_id });
  const churn = (id: string, coach_id: string, client_id: string, status: string) => ({ id, coach_id, client_id, status });
  const db = {
    user: table([
      user('head1', 'coach', null), user('sub1', 'coach', 'head1'),
      user('client1', 'student', 'head1'), user('client2', 'student', 'head1'), user('client3', 'student', 'sub1'),
    ]),
    teamSubCoachAssignment: table([
      { id: 'seat1', head_coach_id: 'head1', sub_coach_id: 'sub1', archived_at: null, stripe_subscription_item_id: null },
    ]),
    teamAuditEvent: table([]),
    aIDraft: table([
      ai('head1-client1-draft', 'head1', 'client1', 'DRAFT'),
      ai('head1-client1-rejected', 'head1', 'client1', 'REJECTED'),
      ai('head1-client1-approved', 'head1', 'client1', 'APPROVED'),
      ai('head1-client2-draft', 'head1', 'client2', 'DRAFT'),
      ai('sub1-client1-draft', 'sub1', 'client1', 'DRAFT'),
      ai('sub1-client3-draft', 'sub1', 'client3', 'DRAFT'),
      ai('sub1-client3-approved', 'sub1', 'client3', 'APPROVED'),
    ]),
    aiActionDraft: table([
      gw('head1-client1-pending', 'head1', 'client1', 'pending'),
      gw('head1-client2-pending-names-client1', 'head1', 'client2', 'pending', { target_client_id: 'client1' }),
      gw('head1-client1-approved', 'head1', 'client1', 'approved'),
      gw('head1-client2-pending', 'head1', 'client2', 'pending', { clientId: 'client2' }),
      gw('no-tenant-client1-pending', null, 'client1', 'pending'),
      gw('sub1-client3-pending', 'sub1', 'client3', 'pending'),
      // The workout builder stamps a sub-coach's draft with the head coach's tenant.
      gw('sub1-in-head1-client3-pending', 'head1', 'client3', 'pending', {}, 'sub1'),
      gw('head1-client3-pending', 'head1', 'client3', 'pending'),
      gw('no-requester-head1-client3-pending', 'head1', 'client3', 'pending', {}, null),
    ]),
    messageDraft: table([
      msg('head1-client1-message', 'head1', 'client1'),
      msg('head1-client2-message', 'head1', 'client2'),
      msg('sub1-client3-message', 'sub1', 'client3'),
    ]),
    churnIntervention: table([
      churn('head1-client1-churn-edited', 'head1', 'client1', 'edited'),
      churn('head1-client1-churn-sent', 'head1', 'client1', 'sent'),
      churn('head1-client2-churn-draft', 'head1', 'client2', 'draft'),
      churn('sub1-client3-churn-draft', 'sub1', 'client3', 'draft'),
    ]),
  };
  const prisma: PrismaService = fakeOf<PrismaService>({ ...db, $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma) });
  const team = fakeOf<TeamService>({ refreshCounters: async () => undefined });
  const ids = () => ({
    aIDraft: db.aIDraft.rows.map((r) => String(r.id)),
    aiActionDraft: db.aiActionDraft.rows.map((r) => String(r.id)),
    messageDraft: db.messageDraft.rows.map((r) => String(r.id)),
    churnIntervention: db.churnIntervention.rows.map((r) => String(r.id)),
  });
  return { db, prisma, subCoaches: new SubCoachesService(prisma, team), ids };
}

// head1 hands client1 to sub1 directly.
const AFTER_CLIENT1_TO_SUB1 = {
  aIDraft: [
    'head1-client1-approved', 'head1-client2-draft', 'sub1-client1-draft',
    'sub1-client3-draft', 'sub1-client3-approved',
  ],
  aiActionDraft: [
    'head1-client1-approved', 'head1-client2-pending', 'no-tenant-client1-pending', 'sub1-client3-pending',
    'sub1-in-head1-client3-pending', 'head1-client3-pending', 'no-requester-head1-client3-pending',
  ],
  messageDraft: ['head1-client2-message', 'sub1-client3-message'],
  churnIntervention: ['head1-client1-churn-sent', 'head1-client2-churn-draft', 'sub1-client3-churn-draft'],
};

describe('a client move deletes the drafts left behind (owner decision 17)', () => {
  it('deletes the former coach\'s unapproved and unsent drafts and keeps approved or sent items', async () => {
    const w = world();
    await w.subCoaches.reassignClient('head1', 'sub1', { clientId: 'client1' });
    expect(w.db.user.rows.find((u) => u.id === 'client1')?.coach_id).toBe('sub1');
    expect(w.ids()).toEqual(AFTER_CLIENT1_TO_SUB1);
  });

  it('passes nothing to the new coach', async () => {
    const w = world();
    await w.subCoaches.reassignClient('head1', 'sub1', { clientId: 'client1' });
    const heldBySub1 = [
      ...w.db.aIDraft.rows.filter((r) => r.coachId === 'sub1'),
      ...w.db.aiActionDraft.rows.filter((r) => r.tenant_coach_id === 'sub1' || r.requester_id === 'sub1'),
      ...w.db.messageDraft.rows.filter((r) => r.coach_id === 'sub1'),
      ...w.db.churnIntervention.rows.filter((r) => r.coach_id === 'sub1'),
    ].map((r) => r.id);
    // Only what sub1 already held before the move.
    expect(heldBySub1).toEqual([
      'sub1-client1-draft', 'sub1-client3-draft', 'sub1-client3-approved',
      'sub1-client3-pending', 'sub1-in-head1-client3-pending', 'sub1-client3-message', 'sub1-client3-churn-draft',
    ]);
  });

  it('a repeated move is harmless, and moving back deletes only the drafts left behind again', async () => {
    const w = world();
    await w.subCoaches.reassignClient('head1', 'sub1', { clientId: 'client1' });
    await w.subCoaches.reassignClient('head1', 'sub1', { clientId: 'client1' });
    await w.prisma.$transaction((tx) => deleteDraftsLeftByMove(tx, ['client1'], 'sub1'));
    expect(w.ids()).toEqual(AFTER_CLIENT1_TO_SUB1);

    await w.subCoaches.reassignClient('head1', 'head1', { clientId: 'client1' });
    expect(w.ids().aIDraft).toEqual(AFTER_CLIENT1_TO_SUB1.aIDraft.filter((id) => id !== 'sub1-client1-draft'));
    expect(w.ids().aiActionDraft).toEqual(AFTER_CLIENT1_TO_SUB1.aiActionDraft);
  });

  it('taking a client back from a sub-coach deletes the sub-coach\'s drafts in the head coach\'s tenant', async () => {
    const w = world();
    await w.subCoaches.reassignClient('head1', 'head1', { clientId: 'client3' });
    expect(w.ids().aiActionDraft.filter((id) => id.includes('client3'))).toEqual(['head1-client3-pending']);
  });

  it.each([
    ['revoking the sub-coach', (w: ReturnType<typeof world>) => w.subCoaches.revoke('head1', 'sub1', {})],
    [
      'removing the sub-coach from the team',
      (w: ReturnType<typeof world>) =>
        new TeamModeService(
          w.prisma,
          fakeOf<StripeApiService>({ isConfigured: () => false }),
          fakeOf<TeamModeTierResolverService>({}),
        ).removeSubCoach({ headCoachId: 'head1', subCoachId: 'sub1' }),
    ],
  ])('%s moves their clients to the head coach and deletes only those clients\' drafts', async (_label, remove) => {
    const w = world();
    await remove(w);
    expect(w.db.user.rows.find((u) => u.id === 'client3')?.coach_id).toBe('head1');
    expect(w.ids()).toEqual({
      aIDraft: [
        'head1-client1-draft', 'head1-client1-rejected', 'head1-client1-approved', 'head1-client2-draft',
        'sub1-client1-draft', 'sub1-client3-approved',
      ],
      aiActionDraft: [
        'head1-client1-pending', 'head1-client2-pending-names-client1', 'head1-client1-approved',
        'head1-client2-pending', 'no-tenant-client1-pending', 'head1-client3-pending',
      ],
      messageDraft: ['head1-client1-message', 'head1-client2-message'],
      churnIntervention: ['head1-client1-churn-edited', 'head1-client1-churn-sent', 'head1-client2-churn-draft'],
    });
    // The head coach's pending list shows none of the sub-coach's drafts.
    const pending = await new AiApprovalService(w.prisma, fakeOf<AuditService>({})).listPending({ tenantCoachId: 'head1' });
    expect(pending.map((d) => d.id)).toEqual([
      'head1-client1-pending', 'head1-client2-pending-names-client1', 'head1-client2-pending', 'head1-client3-pending',
    ]);
  });

  it('matches every payload key that deciding a draft checks', () => {
    for (const key of MOVED_CLIENT_PAYLOAD_KEYS) expect(payloadClientIds({ [key]: 'client1' })).toEqual(['client1']);
  });
});

const left = (before: Record<string, string[]>, gone: string[]) =>
  Object.fromEntries(Object.entries(before).map(([model, ids]) => [model, ids.filter((id) => !gone.includes(id))]));

describe('a sub-coach handoff deletes the drafts the sub-coach handing on holds (owner decision 17)', () => {
  // client1 and client2 stay head1's clients, delegated to sub1; sub2 joins the team.
  function handoff() {
    const w = world();
    w.db.user.rows.push({ id: 'sub2', role: 'coach', coach_id: 'head1', name: 'sub2', deleted_at: null });
    w.db.aIDraft.rows.push(
      { id: 'sub1-client1-approved', coachId: 'sub1', clientId: 'client1', status: 'APPROVED' },
      { id: 'sub1-client2-draft', coachId: 'sub1', clientId: 'client2', status: 'DRAFT' },
    );
    w.db.aiActionDraft.rows.push(
      { id: 'sub1-in-head1-client1-pending', tenant_coach_id: 'head1', requester_id: 'sub1', subject_user_id: 'client1', status: 'pending', payload: {} },
      { id: 'sub1-in-head1-client1-approved', tenant_coach_id: 'head1', requester_id: 'sub1', subject_user_id: 'client1', status: 'approved', payload: {} },
    );
    w.db.messageDraft.rows.push({ id: 'sub1-client1-message', coach_id: 'sub1', client_id: 'client1' });
    w.db.churnIntervention.rows.push(
      { id: 'sub1-client1-churn-dismissed', coach_id: 'sub1', client_id: 'client1', status: 'dismissed' },
      { id: 'sub1-client1-churn-sent', coach_id: 'sub1', client_id: 'client1', status: 'sent' },
    );
    const delegations = table([
      { id: 'sca1', head_coach_id: 'head1', sub_coach_id: 'sub1', client_id: 'client1', unassigned_at: null },
      { id: 'sca2', head_coach_id: 'head1', sub_coach_id: 'sub1', client_id: 'client2', unassigned_at: null },
    ]);
    delegations.create = async ({ data }) => {
      const row = { id: `sca${delegations.rows.length + 1}`, unassigned_at: null, ...data };
      delegations.rows.push(row);
      return row;
    };
    const prisma: PrismaService = fakeOf<PrismaService>({
      ...w.db,
      subCoachAssignment: delegations,
      auditLog: table([]),
      $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
    });
    const service = new SubCoachReassignService(
      prisma,
      fakeOf<SubCoachCapacityService>({ assertHasCapacityTx: async () => undefined }),
      fakeOf<SubCoachIdempotencyService>({
        runWithIdempotency: async ({ runMutation }: { runMutation: () => Promise<unknown> }) => ({ response: await runMutation(), replay: false }),
      }),
    );
    const move = (to: string) =>
      service.reassignClient('head1', 'head1', 'coach', { clientId: 'client1', targetSubCoachId: to, idempotency_key: 'key' });
    const open = () => delegations.rows.filter((r) => r.unassigned_at === null).map((r) => `${r.client_id}:${r.sub_coach_id}`);
    return { ...w, move, open };
  }

  it("deletes only the sub-coach's unapproved and unsent drafts about that client; the head coach and new sub-coach keep theirs", async () => {
    const h = handoff();
    const before = h.ids();
    await h.move('sub2');
    expect(h.open()).toEqual(['client2:sub1', 'client1:sub2']);
    expect(h.ids()).toEqual(
      left(before, ['sub1-client1-draft', 'sub1-in-head1-client1-pending', 'sub1-client1-message', 'sub1-client1-churn-dismissed']),
    );
    const afterHandoff = h.ids();
    await h.move('sub2');
    expect(h.ids()).toEqual(afterHandoff);
  });

  it("taking the client back to the head coach deletes the sub-coach's drafts and keeps the head coach's", async () => {
    const h = handoff();
    await h.move('sub2');
    h.db.aIDraft.rows.push({ id: 'sub2-client1-draft', coachId: 'sub2', clientId: 'client1', status: 'DRAFT' });
    const before = h.ids();
    await h.move('head1');
    expect(h.open()).toEqual(['client2:sub1']);
    expect(h.ids()).toEqual(left(before, ['sub2-client1-draft']));
  });
});

describe('a client left with no coach loses every unapproved draft about them (owner decision 17)', () => {
  it("deletes every holder's unapproved and unsent drafts and keeps approved, sent and no-tenant items", async () => {
    const w = world();
    const before = w.ids();
    await w.prisma.$transaction((tx) => deleteDraftsLeftByMove(tx, ['client3'], null));
    expect(w.ids()).toEqual(
      left(before, [
        'sub1-client3-draft', 'sub1-client3-pending', 'sub1-in-head1-client3-pending', 'head1-client3-pending',
        'no-requester-head1-client3-pending', 'sub1-client3-message', 'sub1-client3-churn-draft',
      ]),
    );
  });
});
