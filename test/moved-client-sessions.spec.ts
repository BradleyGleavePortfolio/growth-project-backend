// Owner HIST-2b Option 1: "A move cancels the old coach's upcoming sessions
// with that client. The old coach's calendar frees up, and the client books
// with the new coach." Runs every move path's real code and the real session
// lifecycle over in-memory rows whose filters answer like Postgres.
import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { AuditAction, AuditService } from '../src/audit/audit.service';
import type { StripeApiService } from '../src/billing/stripe-api.service';
import type { BookingEmitter } from '../src/notifications/emitters/booking.emitter';
import type { PrismaService } from '../src/prisma.service';
import type { SchedulingProviderRegistry } from '../src/scheduling/providers/scheduling-provider.registry';
import type { SchedulingOpenSlotsService } from '../src/scheduling/scheduling-open-slots.service';
import { SchedulingSessionLifecycleService } from '../src/scheduling/scheduling-session-lifecycle.service';
import { SchedulingModule } from '../src/scheduling/scheduling.module';
import { SchedulingService } from '../src/scheduling/scheduling.service';
import type { ActorContext } from '../src/scheduling/scheduling.types';
import type { SubCoachCapacityService } from '../src/sub-coach/sub-coach-capacity.service';
import type { SubCoachIdempotencyService } from '../src/sub-coach/sub-coach-idempotency.service';
import { SubCoachReassignService } from '../src/sub-coach/sub-coach-reassign.service';
import { SubCoachModule } from '../src/sub-coach/sub-coach.module';
import { SubCoachInviteService } from '../src/sub-coaches/sub-coach-invite.service';
import { SubCoachesModule } from '../src/sub-coaches/sub-coaches.module';
import { SubCoachesService } from '../src/sub-coaches/sub-coaches.service';
import { TeamModeModule } from '../src/team-mode/team-mode.module';
import { TeamModeService } from '../src/team-mode/team-mode.service';
import type { TeamModeTierResolverService } from '../src/team-mode/tier-resolver.service';
import type { TeamService } from '../src/team/team.service';
import { fakeOf } from './ai-egress/ai-egress.fakes';

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

const same = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

function matches(row: Row, where: Where = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Where[]).every((w) => matches(row, w));
    if (key === 'OR') return (cond as Where[]).some((w) => matches(row, w));
    const value = row[key];
    if (!cond || typeof cond !== 'object' || cond instanceof Date) return same(value, cond);
    const c = cond as { in?: unknown[]; not?: unknown; equals?: unknown; gt?: Date; lte?: Date; is?: Where };
    if (c.is) return value != null && matches(value as Row, c.is);
    return (!c.in || c.in.some((v) => same(v, value)))
      && (!('not' in c) || (value != null && !same(value, c.not)))
      && (!('equals' in c) || same(value, c.equals))
      && (!c.gt || (value instanceof Date && value > c.gt))
      && (!c.lte || (value instanceof Date && value <= c.lte));
  });
}

function table(name: string, rows: Row[], writes: Set<string>) {
  const hits = (where?: Where) => rows.filter((r) => matches(r, where));
  const wrote = <T>(result: T): T => {
    writes.add(name);
    return result;
  };
  const updateManyAndReturn = async ({ where, data }: { where: Where; data: Row }) =>
    wrote(hits(where).map((r) => Object.assign(r, data)));
  return {
    rows,
    findFirst: async ({ where }: { where?: Where } = {}) => hits(where)[0] ?? null,
    findMany: async ({ where }: { where?: Where } = {}) => hits(where),
    findUnique: async ({ where }: { where: Where }) =>
      hits((where.head_coach_id_sub_coach_id as Where | undefined) ?? where)[0] ?? null,
    count: async ({ where }: { where?: Where } = {}) => hits(where).length,
    create: async ({ data }: { data: Row }) => {
      const row = { id: `${name}-${rows.length + 1}`, ...data };
      rows.push(row);
      return wrote(row);
    },
    createMany: async ({ data }: { data: Row[] }) => {
      rows.push(...data);
      return wrote({ count: data.length });
    },
    update: async ({ where, data }: { where: Where; data: Row }) => wrote(Object.assign(hits(where)[0], data)),
    updateMany: async (args: { where: Where; data: Row }) => ({ count: (await updateManyAndReturn(args)).length }),
    updateManyAndReturn,
    deleteMany: async ({ where }: { where?: Where } = {}) => {
      const gone = hits(where);
      rows.splice(0, rows.length, ...rows.filter((r) => !gone.includes(r)));
      return wrote({ count: gone.length });
    },
  };
}

const at = (days: number) => new Date(Date.now() + days * 86_400_000);

// head1 runs a team with sub1. client1 and client2 are head1's, and client2
// is delegated to sub1; client3 is sub1's own client. Each session id names
// whose calendar it is on, the client, and what it is.
function world() {
  const user = (id: string, role: string, coach_id: string | null) => ({ id, role, coach_id, name: id, deleted_at: null });
  const session = (coach: string, client: string, what: string, status: string, days: number, linked = false) => {
    const id = `${coach}-${client}-${what}`;
    return {
      id, coach_id: coach, client_id: client, status, session_type_id: null,
      start_at: at(days), end_at: at(days + 0.04), ended_at: null, end_reason: null,
      // A lapsed request: left open, the expiry sweep would name the client to the old coach.
      request_expires_at: status === 'requested' ? at(-1) : null,
      calendar_provider: 'stub', calendar_event_id: linked ? `event-${id}` : null,
      video_provider: linked ? 'zoom' : 'stub', video_meeting_id: linked ? `meeting-${id}` : null,
    };
  };
  const seed: Record<string, Row[]> = {
    user: [
      user('head1', 'coach', null), user('sub1', 'coach', 'head1'),
      user('client1', 'student', 'head1'), user('client2', 'student', 'head1'), user('client3', 'student', 'sub1'),
    ],
    teamSubCoachAssignment: [
      { id: 'seat1', head_coach_id: 'head1', sub_coach_id: 'sub1', archived_at: null, stripe_subscription_item_id: null },
    ],
    subCoachAssignment: [{ id: 'delegation1', head_coach_id: 'head1', sub_coach_id: 'sub1', client_id: 'client2', unassigned_at: null }],
    coachingSession: [
      session('sub1', 'client3', 'ahead', 'scheduled', 2, true),
      session('sub1', 'client3', 'request', 'requested', 3),
      session('sub1', 'client3', 'past', 'scheduled', -2),
      session('sub1', 'client3', 'done', 'completed', -5),
      session('sub1', 'client3', 'cancelled', 'canceled', 4),
      session('sub1', 'client2', 'ahead', 'scheduled', 2, true),
      session('head1', 'client3', 'ahead', 'scheduled', 3),
      session('head1', 'client2', 'ahead', 'scheduled', 1),
      session('head1', 'client1', 'ahead', 'scheduled', 2, true),
      // Another tenant's coach: no move in head1's team touches their calendar.
      session('head2', 'client3', 'ahead', 'scheduled', 2),
    ],
  };
  // A session reads its client like Prisma's `client` relation.
  for (const s of seed.coachingSession) {
    Object.defineProperty(s, 'client', { get: () => seed.user.find((u) => u.id === s.client_id) });
  }
  // Models the spec does not seed start empty, so it keeps working as the
  // move paths gain more clean-ups.
  const writes = new Set<string>();
  const tables = new Map<string, ReturnType<typeof table>>();
  const model = (name: string) => {
    const t = tables.get(name) ?? table(name, seed[name] ?? [], writes);
    tables.set(name, t);
    return t;
  };
  const prisma: PrismaService = fakeOf<PrismaService>(new Proxy({}, {
    get: (_, key) => key === '$transaction'
      ? async (fn: (tx: PrismaService) => unknown) => fn(prisma)
      : typeof key === 'string' && key !== 'then' ? model(key) : undefined,
  }));
  const notices: string[] = [];
  const bookingEmitter = fakeOf<BookingEmitter>(new Proxy({}, {
    get: (_, kind) => async () => { notices.push(String(kind)); },
  }));
  const external: string[] = [];
  const providers = fakeOf<SchedulingProviderRegistry>({
    resolveCalendar: () => ({ cancelEvent: async (id: string) => { external.push(id); } }),
    resolveVideo: () => ({ cancelMeeting: async (id: string) => { external.push(id); } }),
  });
  const freed: string[] = [];
  const openSlots = fakeOf<SchedulingOpenSlotsService>({ invalidateCoach: (id: string) => freed.push(id) });
  const lifecycle = new SchedulingSessionLifecycleService(
    prisma, new AuditService(prisma), providers, bookingEmitter, undefined, openSlots,
  );
  const team = fakeOf<TeamService>({ refreshCounters: async () => undefined });
  const idempotency = fakeOf<SubCoachIdempotencyService>({
    runWithIdempotency: async ({ runMutation }: { runMutation: () => Promise<unknown> }) =>
      ({ response: await runMutation(), replay: false }),
  });
  return {
    prisma, lifecycle, notices, external, freed,
    subCoaches: new SubCoachesService(prisma, team, undefined, undefined, lifecycle),
    teamMode: new TeamModeService(prisma, fakeOf<StripeApiService>({}), fakeOf<TeamModeTierResolverService>({}), lifecycle),
    handoff: new SubCoachReassignService(prisma, fakeOf<SubCoachCapacityService>({}), idempotency, lifecycle),
    scheduling: new SchedulingService(prisma, new AuditService(prisma), providers, bookingEmitter, lifecycle, openSlots),
    session: (id: string) => model('coachingSession').rows.find((s) => s.id === id),
    statuses: () => Object.fromEntries(model('coachingSession').rows.map((s) => [s.id, s.status])),
    audits: (action: string) => model('auditLog').rows.filter((r) => r.action === action),
    takeWrites: () => { const taken = new Set(writes); writes.clear(); return taken; },
  };
}

type World = ReturnType<typeof world>;
const CLIENT3_CANCELLED = ['sub1-client3-ahead', 'sub1-client3-request'];
const CLIENT3_ALL = ['ahead', 'request', 'past', 'done', 'cancelled'].map((what) => `sub1-client3-${what}`);
const coach = (id: string): ActorContext => ({ id, role: 'coach', email: null, coach_id: null });
// Every session id the actor reads in their upcoming and past lists.
const listed = async (w: World, actor: ActorContext) =>
  (await Promise.all((['upcoming', 'past'] as const).map((scope) => w.scheduling.listSessionsForActor(actor, { scope }))))
    .flat().map((s) => s.id).sort();

describe('a client move cancels the old coach\'s upcoming sessions with them (owner HIST-2b)', () => {
  // The last column is what sub1 still reads after the move: the clients
  // still theirs (revoke and Team Mode removal end sub1's seat).
  it.each<[string, (w: World) => Promise<unknown>, string, string[], string[]]>([
    [
      'moves sub1\'s client to themselves',
      (w) => w.subCoaches.reassignClient('head1', 'head1', { clientId: 'client3' }),
      'client3', CLIENT3_CANCELLED, ['sub1-client2-ahead'],
    ],
    ['revokes sub1', (w) => w.subCoaches.revoke('head1', 'sub1', {}), 'client3', CLIENT3_CANCELLED, []],
    [
      'removes sub1 from Team Mode',
      (w) => w.teamMode.removeSubCoach({ headCoachId: 'head1', subCoachId: 'sub1' }),
      'client3', CLIENT3_CANCELLED, [],
    ],
    [
      'takes a delegated client back from sub1',
      (w) => w.handoff.unassignClient('head1', 'head1', 'coach', { clientId: 'client2', idempotency_key: 'k1' }),
      'client2', ['sub1-client2-ahead'], CLIENT3_ALL,
    ],
  ])('when the head coach %s', async (_, move, clientId, cancelled, kept) => {
    const w = world();
    const before = w.statuses();
    const sub1Sessions = Object.keys(before).filter((id) => id.startsWith('sub1-')).sort();
    expect(await listed(w, coach('sub1'))).toEqual(sub1Sessions);
    await move(w);

    // Only the old coach's upcoming sessions with the moved client end. Past,
    // finished and already cancelled sessions, the new coach's sessions and
    // every other client's sessions stay as they were.
    const after = { ...before, ...Object.fromEntries(cancelled.map((id) => [id, 'canceled'])) };
    expect(w.statuses()).toEqual(after);
    for (const id of cancelled) {
      expect(w.session(id)).toMatchObject({ ended_at: expect.any(Date), end_reason: 'client_moved' });
    }
    // Audited and cleaned up like a coach cancel, and the old coach's times open again.
    expect(w.audits(AuditAction.SESSION_CANCELED)).toEqual(cancelled.map((id) => expect.objectContaining({
      actor_id: 'head1', tenant_coach_id: 'sub1', target_user_id: clientId, target_type: 'coaching_session', target_id: id,
      metadata: { from: before[id], to: 'canceled', reason: 'client_moved' },
    })));
    const linked = cancelled.filter((id) => w.session(id)?.calendar_event_id);
    expect(w.audits(AuditAction.SESSION_PROVIDER_CANCELED).map((r) => r.target_id)).toEqual(linked);
    expect(w.external).toEqual(linked.flatMap((id) => [`event-${id}`, `meeting-${id}`]));
    expect(new Set(w.freed)).toEqual(new Set(['sub1']));
    // No notice to anyone: none names the client to the old coach (owner 4),
    // and the client's notice waits for approved wording.
    expect(w.notices).toEqual([]);

    // Reads (owner 4): at once the old coach finds no session with the moved
    // client, by id, in either list or to act on, and keeps the clients still
    // theirs. The new coach never reads the old coach's session or its notes;
    // the client keeps their whole history.
    const leftBehind = sub1Sessions.filter((id) => id.startsWith(`sub1-${clientId}-`));
    expect(await listed(w, coach('sub1'))).toEqual([...kept].sort());
    for (const id of leftBehind) {
      await expect(w.scheduling.getSession(coach('sub1'), id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(w.scheduling.cancelSession(coach('sub1'), id, {})).rejects.toBeInstanceOf(NotFoundException);
      await expect(w.scheduling.getSession(coach('head1'), id)).rejects.toBeInstanceOf(NotFoundException);
    }
    const client: ActorContext = { id: clientId, role: 'student', email: null, coach_id: 'head1' };
    expect(await listed(w, client)).toEqual(expect.arrayContaining(leftBehind));
    expect(await w.scheduling.getSession(client, cancelled[0])).toMatchObject({ status: 'canceled', coach_notes_md: null });
    expect(await w.scheduling.getSession(coach('head1'), 'head1-client1-ahead')).toMatchObject({ status: 'scheduled' });

    // A repeated move finds nothing left to cancel and writes nothing more.
    const audited = w.audits(AuditAction.SESSION_CANCELED).length;
    await w.lifecycle.finishMoveCancels('head1', await w.lifecycle.cancelLeftByMove(w.prisma, [clientId], 'sub1'));
    expect(w.statuses()).toEqual(after);
    expect(w.audits(AuditAction.SESSION_CANCELED)).toHaveLength(audited);
  });

  it('returns what a coach cancel returns: a session holds no credit or payment, so both write only the session and its audit', async () => {
    const w = world();
    await w.lifecycle.cancelSession(coach('head1'), 'head1-client1-ahead', {});
    const byCoach = w.takeWrites();
    await w.lifecycle.finishMoveCancels('head1', await w.lifecycle.cancelLeftByMove(w.prisma, ['client3'], 'sub1'));
    expect(w.takeWrites()).toEqual(byCoach);
    expect(byCoach).toEqual(new Set(['coachingSession', 'auditLog']));
    expect(w.session('head1-client1-ahead')).toMatchObject({ status: 'canceled', ended_at: expect.any(Date) });
    // The coach cancel tells the client; the move cancel tells no one.
    expect(w.notices).toEqual(['emitCancelled']);
  });

  it('is wired into every move path in production', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, SchedulingModule)).toContain(SchedulingSessionLifecycleService);
    for (const mod of [SubCoachesModule, TeamModeModule, SubCoachModule]) {
      expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, mod)).toContain(SchedulingModule);
    }
    for (const svc of [SubCoachesService, SubCoachInviteService, TeamModeService, SubCoachReassignService]) {
      expect(Reflect.getMetadata('design:paramtypes', svc)).toContain(SchedulingSessionLifecycleService);
    }
  });
});
