// Owner decision 17: a client's move deletes the drafts about them that any
// other coach holds, in the move's own transaction. Approved or sent items
// are history and stay (owner decision 4). Runs the real move code over
// in-memory rows whose filters answer like Postgres (NULL never matches).
import { AiApprovalService, payloadClientIds } from '../src/ai/gateway/ai-approval.service';
import type { AuditService } from '../src/audit/audit.service';
import type { StripeApiService } from '../src/billing/stripe-api.service';
import type { ExpoPushMessage } from 'expo-server-sdk';
import { CoachAlertsService } from '../src/coach/coach-alerts.service';
import {
  MOVED_CLIENT_PAYLOAD_KEYS,
  deleteCoachRowsLeftByMove,
  deleteDraftsLeftByMove,
} from '../src/coach/moved-client-drafts';
import { CoachAlertEmitter } from '../src/notifications/emitters/coach-alert.emitter';
import { BookingEmitter } from '../src/notifications/emitters/booking.emitter';
import { NotificationsService } from '../src/notifications/notifications.service';
import { PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import type { PrismaService } from '../src/prisma.service';
import type { SubCoachCapacityService } from '../src/sub-coach/sub-coach-capacity.service';
import type { SubCoachIdempotencyService } from '../src/sub-coach/sub-coach-idempotency.service';
import { SubCoachReassignService } from '../src/sub-coach/sub-coach-reassign.service';
import { SubCoachesService } from '../src/sub-coaches/sub-coaches.service';
import type { TeamModeTierResolverService } from '../src/team-mode/tier-resolver.service';
import { TeamModeService } from '../src/team-mode/team-mode.service';
import type { TeamService } from '../src/team/team.service';
import { fakeOf } from './ai-egress/ai-egress.fakes';
import { pushOutboxWorld } from './utils/push-outbox-fake';

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true;
    if (key === 'AND') return (cond as Where[]).every((w) => matches(row, w));
    if (key === 'OR') return (cond as Where[]).some((w) => matches(row, w));
    if (key === 'NOT') return !matches(row, cond as Where);
    const value = row[key];
    if (cond && typeof cond === 'object') {
      const c = cond as { in?: unknown[]; not?: unknown; path?: string[]; equals?: unknown; startsWith?: string };
      if (c.in) return c.in.includes(value);
      if (c.startsWith !== undefined) return typeof value === 'string' && value.startsWith(c.startsWith);
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
function world(extra: object = {}) {
  const user = (id: string, role: string, coach_id: string | null) => ({ id, role, coach_id, name: id, deleted_at: null });
  const ai = (id: string, coachId: string, clientId: string, status: string) => ({ id, coachId, clientId, status });
  const gw = (id: string, tenant: string | null, subject: string, status: string, payload: Row = {}, requester = tenant) =>
    ({ id, tenant_coach_id: tenant, requester_id: requester, subject_user_id: subject, status, payload });
  const msg = (id: string, coach_id: string, client_id: string) => ({ id, coach_id, client_id });
  const churn = (id: string, coach_id: string, client_id: string, status: string) => ({ id, coach_id, client_id, status });
  const alert = (id: string, coach_id: string, client_id: string, alert_type: string, acknowledged_at: Date | null = null) =>
    ({ id, coach_id, client_id, alert_type, acknowledged_at });
  const note = (id: string, user_id: string, deep_link: string | null, payload: Row | null) => ({ id, user_id, deep_link, payload });
  const insight = (user_id: string, side: string) => ({ id: `${user_id}-${side}`, user_id, side });
  // An outbox row as push delivery stores it: tap data with the deep link, ids-only context.
  const push = (id: string, user_id: string, deepLink: string, context: Row | null = null, status = 'pending') =>
    ({ id, user_id, status, data: { deepLink }, context, deferred_reason: 'quiet_hours', time_zone: 'America/New_York' });
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
    coachAlert: table([
      alert('head1-client1-risk', 'head1', 'client1', 'risk_red_transition'),
      alert('head1-client1-urgent-open', 'head1', 'client1', 'roman_urgent_reply'),
      alert('head1-client1-ed-dismissed', 'head1', 'client1', 'roman_eating_disorder_reply', new Date()),
      alert('head1-client1-ed-open', 'head1', 'client1', 'roman_eating_disorder_reply'),
      alert('head1-client2-urgent-open', 'head1', 'client2', 'roman_urgent_reply'),
      alert('sub1-client3-misses', 'sub1', 'client3', 'consecutive_misses'),
      alert('sub1-client3-ed-open', 'sub1', 'client3', 'roman_eating_disorder_reply'),
    ]),
    // Each inbox row names the client the way its writer does.
    notification: table([
      note('head1-client1-alert', 'head1', 'tgp://coach/clients/client1', { alertId: 'a1', clientUserId: 'client1' }),
      note('head1-client1-flag', 'head1', null, { type: 'onboarding_screening_review', client_id: 'client1' }),
      note('head1-client1-checkins', 'head1', 'tgp://coach/clients/client1/checkins', null),
      note('head1-client1-chat', 'head1', 'tgp://messages/client1', { threadId: 'client1' }),
      note('head1-client1-first-payment', 'head1', null, { clientId: 'client1' }),
      note('head1-client1-drip-failed', 'head1', null, { client_user_id: 'client1' }),
      note('head1-client1-purchase', 'head1', 'tgp://coach/purchases/p1', { purchase_id: 'p1', buyer_id: 'client1' }),
      note('head1-client10-alert', 'head1', 'tgp://coach/clients/client10', { clientUserId: 'client10' }),
      note('head1-client2-alert', 'head1', 'tgp://coach/clients/client2', { clientUserId: 'client2' }),
      note('client1-own-chat', 'client1', 'tgp://messages/client1', { threadId: 'client1' }),
      note('sub1-client1-chat', 'sub1', 'tgp://messages/client1', { threadId: 'client1' }),
      note('sub1-client3-alert', 'sub1', 'tgp://coach/clients/client3', { clientUserId: 'client3' }),
      // Booking rows name the session, not the client (BookingEmitter).
      note('head1-client1-booking', 'head1', 'tgp://coach/sessions/s-client1', { sessionId: 's-client1', clientDisplayName: 'Client One' }),
      note('head1-client2-booking', 'head1', 'tgp://coach/sessions/s-client2', { sessionId: 's-client2', clientDisplayName: 'Client Two' }),
      note('client1-own-booking', 'client1', 'tgp://client/sessions/s-client1', { sessionId: 's-client1' }),
      note('sub1-client3-booking', 'sub1', 'tgp://coach/sessions/s-client3', { sessionId: 's-client3', clientDisplayName: 'Client Three' }),
    ]),
    coachingSession: table([
      { id: 's-client1', coach_id: 'head1', client_id: 'client1' },
      { id: 's-client2', coach_id: 'head1', client_id: 'client2' },
      { id: 's-client3', coach_id: 'sub1', client_id: 'client3' },
    ]),
    pushOutbox: table([
      push('head1-client1-alert-push', 'head1', 'tgp://coach/clients/client1'),
      push('head1-client1-ed-push', 'head1', 'tgp://coach/clients/client1', { safetyAlert: 'roman_eating_disorder_reply', alertId: 'head1-client1-ed-open' }),
      push('head1-client1-booking-push', 'head1', 'tgp://coach/sessions/s-client1', { sessionId: 's-client1' }),
      push('head1-client1-sent-push', 'head1', 'tgp://coach/clients/client1', null, 'sent'),
      push('head1-client2-alert-push', 'head1', 'tgp://coach/clients/client2'),
      push('sub1-client1-chat-push', 'sub1', 'tgp://messages/client1'),
      push('sub1-client3-ed-push', 'sub1', 'tgp://coach/clients/client3', { safetyAlert: 'roman_eating_disorder_reply', alertId: 'sub1-client3-ed-open' }),
    ]),
    // 'coach' is the shared coach-side row stored before rows were keyed by coach (#947).
    wearableInsightCache: table([
      insight('client1', 'coach:head1'), insight('client1', 'coach:sub1'), insight('client1', 'coach'),
      insight('client1', 'client'), insight('client2', 'coach:head1'),
      insight('client3', 'coach:sub1'), insight('client3', 'coach:head1'), insight('client3', 'client'),
    ]),
  };
  const prisma: PrismaService = fakeOf<PrismaService>({ ...db, ...extra, $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma) });
  const team = fakeOf<TeamService>({ refreshCounters: async () => undefined });
  const ids = () => ({
    aIDraft: db.aIDraft.rows.map((r) => String(r.id)),
    aiActionDraft: db.aiActionDraft.rows.map((r) => String(r.id)),
    messageDraft: db.messageDraft.rows.map((r) => String(r.id)),
    churnIntervention: db.churnIntervention.rows.map((r) => String(r.id)),
  });
  // Owner 4: what the coaches still hold; an alert and a push show their holder.
  const held = () => ({
    coachAlert: db.coachAlert.rows.map((r) => `${r.id} @${r.coach_id}`),
    notification: db.notification.rows.map((r) => String(r.id)),
    pushOutbox: db.pushOutbox.rows.map((r) => `${r.id} @${r.user_id}`),
    wearableInsightCache: db.wearableInsightCache.rows.map((r) => String(r.id)),
  });
  return { db, prisma, subCoaches: new SubCoachesService(prisma, team), ids, held };
}

const REMOVALS: Array<[string, (w: ReturnType<typeof world>) => Promise<unknown>]> = [
  ['revoking the sub-coach', (w) => w.subCoaches.revoke('head1', 'sub1', {})],
  [
    'removing the sub-coach from the team',
    (w) =>
      new TeamModeService(
        w.prisma,
        fakeOf<StripeApiService>({ isConfigured: () => false }),
        fakeOf<TeamModeTierResolverService>({}),
      ).removeSubCoach({ headCoachId: 'head1', subCoachId: 'sub1' }),
  ],
];

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

  it.each(REMOVALS)('%s moves their clients to the head coach and deletes only those clients\' drafts', async (_label, remove) => {
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

describe("a client move clears the old coach's alerts, inbox rows and coach-side insights (owner 4)", () => {
  it('the old coach keeps nothing about the moved client, and an open safety alert passes to the new coach (57q)', async () => {
    const w = world();
    await w.subCoaches.reassignClient('head1', 'sub1', { clientId: 'client1' });
    const after = {
      coachAlert: [
        'head1-client1-urgent-open @sub1', 'head1-client1-ed-open @sub1', 'head1-client2-urgent-open @head1',
        'sub1-client3-misses @sub1', 'sub1-client3-ed-open @sub1',
      ],
      // Money rows open the coach's own billing and stay; a client id that only starts the same stays.
      notification: [
        'head1-client1-purchase', 'head1-client10-alert', 'head1-client2-alert',
        'client1-own-chat', 'sub1-client1-chat', 'sub1-client3-alert',
        'head1-client2-booking', 'client1-own-booking', 'sub1-client3-booking',
      ],
      // The waiting safety push follows its alert; the old coach's other unsent pushes about the client go.
      pushOutbox: [
        'head1-client1-ed-push @sub1', 'head1-client1-sent-push @head1', 'head1-client2-alert-push @head1',
        'sub1-client1-chat-push @sub1', 'sub1-client3-ed-push @sub1',
      ],
      wearableInsightCache: [
        'client1-coach:sub1', 'client1-client', 'client2-coach:head1',
        'client3-coach:sub1', 'client3-coach:head1', 'client3-client',
      ],
    };
    expect(w.held()).toEqual(after);
    // Due now, so the worker decides quiet hours again in the new coach's own zone.
    expect(w.db.pushOutbox.rows.find((r) => r.id === 'head1-client1-ed-push')).toMatchObject({
      deferred_reason: null,
      time_zone: null,
    });
    // The alert lists: the old coach's leaves the client out; the new coach's has the open safety alerts.
    const alerts = new CoachAlertsService(w.prisma);
    expect((await alerts.listForCoach({ coachId: 'head1' })).map((a) => a.client_id)).toEqual(['client2']);
    expect((await alerts.listForCoach({ coachId: 'sub1' })).map((a) => a.id)).toEqual([
      'head1-client1-urgent-open', 'head1-client1-ed-open', 'sub1-client3-misses', 'sub1-client3-ed-open',
    ]);
    // Repeating it deletes and passes nothing more.
    await w.prisma.$transaction((tx) => deleteCoachRowsLeftByMove(tx, ['client1'], 'head1', 'sub1'));
    expect(w.held()).toEqual(after);
  });

  it('deletes the booking rows the real BookingEmitter wrote for the old coach about the moved client', async () => {
    const w = world();
    const notifications = fakeOf<NotificationsService>({
      createNotification: async (data: Row) => {
        const row = { id: `emitted-${String(data.user_id)}-${w.db.notification.rows.length}`, ...data };
        w.db.notification.rows.push(row);
        return row;
      },
      getPreferences: async () => ({ booking_push: false }),
    });
    const booking = new BookingEmitter(notifications, w.prisma);
    const request = (sessionId: string) =>
      booking.emitRequested({ coachUserId: 'head1', clientDisplayName: 'A client', requestedAt: new Date(), notes: null, sessionId });
    await request('s-client1');
    await request('s-client2');
    const [moved, other] = w.db.notification.rows.slice(-2).map((r) => String(r.id));
    await w.subCoaches.reassignClient('head1', 'sub1', { clientId: 'client1' });
    const ids = w.db.notification.rows.map((r) => r.id);
    expect(ids).not.toContain(moved);
    expect(ids).toContain(other);
  });

  it.each(REMOVALS)("%s clears the sub-coach's rows about their clients; the head coach gets the open safety alert", async (_label, remove) => {
    const w = world();
    const before = w.held();
    await remove(w);
    expect(w.held()).toEqual({
      ...left(before, ['sub1-client3-alert', 'sub1-client3-booking', 'client3-coach:sub1']),
      coachAlert: [
        'head1-client1-risk @head1', 'head1-client1-urgent-open @head1', 'head1-client1-ed-dismissed @head1',
        'head1-client1-ed-open @head1', 'head1-client2-urgent-open @head1', 'sub1-client3-ed-open @head1',
      ],
      pushOutbox: [...before.pushOutbox.slice(0, -1), 'sub1-client3-ed-push @head1'],
    });
  });
});

// Owner 57q, end to end: an eating-disorder push waiting for 08:00 when the client moves.
// Real CoachAlertEmitter, NotificationsService and PushDeliveryService; Expo mocked.
describe('a safety push still waiting when the client moves goes to the new coach, never the old one (57q)', () => {
  const OLD_PHONE = 'ExponentPushToken[oldcoacholdcoacholdcoa]';
  const NEW_PHONE = 'ExponentPushToken[newcoachnewcoachnewcoa]';
  const NY_2200 = new Date('2026-06-03T02:00:00Z'); // 03:00 in London
  const LONDON_0800 = new Date('2026-06-03T07:00:00Z');
  const NY_0800 = new Date('2026-06-03T12:00:00Z');
  let clock = NY_2200;
  class Clocked extends PushDeliveryService {
    protected now(): Date {
      return clock;
    }
  }
  beforeEach(() => {
    clock = NY_2200;
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    jest.setSystemTime(NY_2200);
  });
  afterEach(() => jest.useRealTimers());

  it('is sent once, to the new coach at 08:00 in their zone; the old coach is sent nothing', async () => {
    const zone = (timezone: string) => ({ timezone, timezone_updated_at: new Date('2026-06-01T00:00:00Z') });
    const out = pushOutboxWorld({
      now: () => clock,
      tokens: { head1: OLD_PHONE, sub1: NEW_PHONE },
      prefs: { head1: zone('America/New_York'), sub1: zone('Europe/London') },
    });
    const send = jest.fn(async (m: ExpoPushMessage[]) => m.map(() => ({ status: 'ok' as const, id: 'ticket' })));
    const delivery = new Clocked(fakeOf<PrismaService>(Object.create(out.db)), { send, getReceipts: jest.fn(async () => ({})) });
    delivery.autoDrain = false;
    const notifications = new NotificationsService(fakeOf<PrismaService>(Object.create(out.db)), undefined, undefined, delivery);
    // The old coach's ordinary alert push about the client, and the eating-disorder push as
    // backend #953 stores it (its own key, the alert id in the context): both wait for 08:00 New York.
    await new CoachAlertEmitter(notifications).emit(
      { coachId: 'head1', alertId: 'head1-client1-risk', alertType: 'risk_red_transition', severity: 'warning', message: 'Risk went red.', clientUserId: 'client1' },
      { inapp: false },
    );
    await out.db.pushOutbox.create({
      data: {
        ...out.rows[0],
        id: 'ed-push',
        dedupe_key: 'coach_alert:head1-client1-ed-open',
        context: { safetyAlert: 'roman_eating_disorder_reply', alertId: 'head1-client1-ed-open' },
      },
    });
    expect(out.rows.map((r) => [r.user_id, r.not_before])).toEqual([['head1', NY_0800], ['head1', NY_0800]]);

    const w = world({ pushOutbox: out.db.pushOutbox });
    await w.subCoaches.reassignClient('head1', 'sub1', { clientId: 'client1' });
    expect(out.rows.map((r) => [r.id, r.user_id])).toEqual([['ed-push', 'sub1']]);

    expect(await delivery.drain()).toBe(0); // 03:00 in London: it waits for the new coach's morning
    clock = LONDON_0800;
    expect(await delivery.drain()).toBe(1);
    clock = NY_0800;
    expect(await delivery.drain()).toBe(0);
    expect(send.mock.calls.flatMap(([messages]) => messages.map((m) => m.to))).toEqual([NEW_PHONE]);
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
    // The in-transaction team check is assertHasCapacityTx until the plan cap goes (owner TM-P1), then
    // assertSubCoachBelongsTo. The fake answers both, so this spec passes in either merge order.
    const teamCheck = async () => undefined;
    const service = new SubCoachReassignService(
      prisma,
      fakeOf<SubCoachCapacityService>({ assertHasCapacityTx: teamCheck, assertSubCoachBelongsTo: teamCheck }),
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

  it("deletes the sub-coach's inbox rows, unsent pushes and coach-side insight about that client and leaves the head coach's alerts (owner 4)", async () => {
    const h = handoff();
    const before = h.held();
    await h.move('sub2');
    expect(h.held()).toEqual(
      left(before, ['sub1-client1-chat', 'sub1-client1-chat-push @sub1', 'client1-coach:sub1', 'client1-coach']),
    );
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

  it('loses every alert, unsent push and coach-side insight about them; there is no coach to pass a safety alert or its push to (owner 4)', async () => {
    const w = world();
    const before = w.held();
    await w.prisma.$transaction((tx) => deleteCoachRowsLeftByMove(tx, ['client3'], 'sub1', null));
    expect(w.held()).toEqual(
      left(before, [
        'sub1-client3-misses @sub1', 'sub1-client3-ed-open @sub1', 'sub1-client3-alert', 'sub1-client3-booking',
        'sub1-client3-ed-push @sub1', 'client3-coach:sub1', 'client3-coach:head1',
      ]),
    );
  });
});
