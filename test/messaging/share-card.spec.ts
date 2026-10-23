/**
 * SHARE-BE (#SHARE-SEND option 1): a client's progress card goes into the
 * thread with their CURRENT coach, and nowhere else. Every case drives the
 * real global ValidationPipe options (src/main.ts), the real controllers and
 * the real MessagingService over an in-memory store that applies each where
 * clause, so a wrong tenant key reads or writes nothing. Each "0" follows a
 * control "1". On main the client send body refuses `card`, so every case
 * here fails before this change.
 */
import 'reflect-metadata';
import { HttpException, Type, ValidationPipe } from '@nestjs/common';
import type { AuthedRequest } from '../../src/auth/auth-request';
import { PrismaService } from '../../src/prisma.service';
import { SupabaseService } from '../../src/supabase/supabase.service';
import { AnalyticsService } from '../../src/analytics/analytics.service';
import { PtmService } from '../../src/ptm/ptm.service';
import { MessageReceivedEmitter } from '../../src/notifications/emitters/message-received.emitter';
import { AuditService } from '../../src/audit/audit.service';
import { ClientAIContextService } from '../../src/ai/client-ai-context.service';
import { MessagesSafetyService } from '../../src/messages-safety/messages-safety.service';
import { MessagingService } from '../../src/messaging/messaging.service';
import { MessageActionsService } from '../../src/messaging/message-actions.service';
import { MessagingInboxService } from '../../src/messaging/messaging-inbox.service';
import { ClientMessagingController } from '../../src/messaging/client-messaging.controller';
import { CoachMessagingController } from '../../src/messaging/coach-messaging.controller';

type Row = Record<string, unknown>;
const X = 'coach-x';
const Y = 'coach-y';
const Z = 'coach-z';
const SUB = 'sub-coach-of-x';
const A = 'client-a-of-x';
const B = 'client-b-of-y';
const C = 'client-c-coachless';
const RUN = {
  kind: 'weigh_in_run',
  value: 14,
  words: 'days in a row',
  from: '2026-10-04',
  to: '2026-10-17',
};
const BEST = { kind: 'recent_best', value: 225, words: 'Back squat', to: '2026-10-17' };
const share = (snapshot: unknown = RUN) => ({ card: { type: 'share', snapshot } });

const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
// The body types the real routes declare (POST /messages, POST /coach/clients/:id/messages).
const bodyOf = (controller: object, index: number) =>
  Reflect.getMetadata('design:paramtypes', controller, 'send')[index];
const CLIENT_BODY = bodyOf(ClientMessagingController.prototype, 1);
const COACH_BODY = bodyOf(CoachMessagingController.prototype, 2);
const req = (id: string) => ({ user: { id } }) as AuthedRequest;
const cardsById = (rows: Row[]) => Object.fromEntries(rows.map((r) => [String(r.id), r.card]));

async function outcome(p: Promise<unknown>): Promise<[number, unknown]> {
  try {
    await p;
    return [200, 'sent'];
  } catch (e) {
    if (!(e instanceof HttpException)) throw e;
    const body = e.getResponse();
    const code = typeof body === 'object' && body !== null && 'error' in body ? body.error : body;
    return [e.getStatus(), code];
  }
}

function fixture() {
  const users: Row[] = [
    { id: X, role: 'coach', coach_id: null, name: 'Coach X' },
    { id: Y, role: 'coach', coach_id: null, name: 'Coach Y' },
    { id: Z, role: 'coach', coach_id: null, name: 'Coach Z' },
    { id: SUB, role: 'coach', coach_id: X, name: 'Sub coach' },
    { id: A, role: 'student', coach_id: X, name: 'Riley' },
    { id: B, role: 'student', coach_id: Y, name: 'Sam' },
    { id: C, role: 'student', coach_id: null, name: 'Alex' },
  ];
  const messages: Row[] = [];
  const cards: Row[] = [];
  const same = (row: Row, where: Row) =>
    Object.entries(where).every(([k, v]) => (row[k] ?? null) === v);
  const first =
    (rows: Row[]) =>
    async ({ where }: { where: Row }) =>
      rows.find((r) => same(r, where)) ?? null;
  const cardOf = (m: Row) => {
    const c = cards.find((x) => x.message_id === m.id);
    return c ? { card_type: c.card_type, ref_id: c.ref_id, snapshot: c.snapshot } : null;
  };
  const prisma = {
    user: { findUnique: jest.fn(first(users)), findFirst: jest.fn(first(users)) },
    userBlock: { findMany: jest.fn().mockResolvedValue([]) }, // #168-4: who blocked the caller
    coachMessage: {
      findFirst: jest.fn(first(messages)),
      create: jest.fn(async ({ data }: { data: Row & { card?: { create: Row } } }) => {
        const { card, ...fields } = data;
        const row = { id: `m${messages.length + 1}`, deleted_at: null, ...fields };
        messages.push(row);
        if (card) cards.push({ message_id: row.id, ref_id: null, ...card.create });
        return row;
      }),
      findMany: jest.fn(async ({ where, include }: { where: Row; include?: Row }) =>
        messages
          .filter((m) => same(m, where))
          .map((m) => (include?.card ? { ...m, card: cardOf(m) } : m)),
      ),
    },
  };
  const dep = <T extends object>(cls: { prototype: T }, impl: object): T =>
    Object.assign(Object.create(cls.prototype) as T, impl);
  const prismaDep = dep(PrismaService, prisma);
  const audit = dep(AuditService, { write: jest.fn().mockResolvedValue(undefined) });
  const messaging = new MessagingService(
    prismaDep,
    dep(SupabaseService, { pingChat: jest.fn().mockResolvedValue(undefined) }),
    dep(AnalyticsService, { capture: jest.fn() }),
    dep(PtmService, { emit: jest.fn() }),
    dep(MessageReceivedEmitter, { emit: jest.fn().mockResolvedValue(undefined) }),
    audit,
    dep(ClientAIContextService, { invalidateForUser: jest.fn() }),
    dep(MessagesSafetyService, {
      getBlockedIdsFor: jest.fn().mockResolvedValue([]),
      isEitherSideBlocked: jest.fn().mockResolvedValue(false),
    }),
  );
  const actions = new MessageActionsService(prismaDep, messaging, audit);
  const inbox = new MessagingInboxService(prismaDep, messaging);
  const client = new ClientMessagingController(messaging, actions, inbox);
  const coach = new CoachMessagingController(messaging, actions, inbox);
  const send = async (who: string, body: Row) =>
    client.send(req(who), await pipe.transform(body, { type: 'body', metatype: CLIENT_BODY }));
  const moveTo = (clientId: string, coachId: string) => {
    for (const u of users) {
      if (u.id === clientId) u.coach_id = coachId;
    }
  };
  return { prisma, messages, cards, client, coach, send, moveTo };
}

const savedFlag = process.env.FEATURE_COACH_BROADCASTS;
afterEach(() => {
  if (savedFlag === undefined) delete process.env.FEATURE_COACH_BROADCASTS;
  else process.env.FEATURE_COACH_BROADCASTS = savedFlag;
});

describe('SHARE-BE: a client share card goes only into the thread with their current coach', () => {
  it('cross-tenant send: the card lands in the own thread only; another coach reads nothing', async () => {
    const f = fixture();
    const sent = await f.send(A, share());
    expect(sent).toMatchObject({ coach_id: X, client_id: A, sender_id: A, body: null });
    expect(sent).toMatchObject({ card: { card_type: 'share', ref_id: null, snapshot: RUN } });
    expect(f.cards).toEqual([
      { message_id: sent.id, card_type: 'share', ref_id: null, snapshot: RUN },
    ]);
    // Control 1: the current coach reads the card.
    expect(cardsById(await f.coach.listThread(req(X), A, {}))).toEqual({
      [sent.id]: { card_type: 'share', ref_id: null, snapshot: RUN },
    });
    f.prisma.coachMessage.findMany.mockClear();
    // 0: another coach is refused before any thread read; their own client sees nothing.
    expect(await outcome(f.coach.listThread(req(Y), A, {}))).toEqual([404, 'Not Found']);
    expect(f.prisma.coachMessage.findMany).not.toHaveBeenCalled();
    expect(await f.client.listThread(req(B), {})).toEqual([]);
  });

  it('former coach read: after a move the old coach gets 404; the next share goes to the new coach', async () => {
    const f = fixture();
    const before = await f.send(A, share());
    expect(await f.coach.listThread(req(X), A, {})).toMatchObject([{ id: before.id }]);
    f.moveTo(A, Z);
    expect(await outcome(f.coach.listThread(req(X), A, {}))).toEqual([404, 'Not Found']);
    const after = await f.send(A, share(BEST));
    expect(after).toMatchObject({ coach_id: Z, client_id: A, card: { snapshot: BEST } });
    expect(cardsById(await f.coach.listThread(req(Z), A, {}))).toEqual({
      [after.id]: { card_type: 'share', ref_id: null, snapshot: BEST },
    });
  });

  it('coachless send: 409 NO_COACH_ASSIGNED and nothing is written', async () => {
    const f = fixture();
    expect(await outcome(f.send(A, share()))).toEqual([200, 'sent']);
    expect(await outcome(f.send(C, share()))).toEqual([409, 'NO_COACH_ASSIGNED']);
    expect(f.prisma.coachMessage.create).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Row]>([
    ['an extra snapshot field', share({ ...RUN, note: 'free text' })],
    ['a snapshot over the byte cap', share({ ...RUN, words: 'x'.repeat(600) })],
    ['words over 60 characters', share({ ...BEST, words: 'x'.repeat(61) })],
    ['a line break in the words', share({ ...RUN, words: 'days\nin a row' })],
    ['an extra card field', { card: { type: 'share', ref_id: 'w1', snapshot: RUN } }],
    ['a coach card type', { card: { type: 'workout', snapshot: RUN } }],
    ['an unknown kind', share({ ...RUN, kind: 'transformation' })],
    ['a day that does not exist', share({ ...RUN, to: '2026-02-30' })],
    ['dates out of order', share({ ...RUN, from: '2026-10-18' })],
    ['a number as text', share({ ...RUN, value: '14' })],
    ['a negative number', share({ ...RUN, value: -1 })],
    ['a list for a snapshot', share([RUN])],
    ['text alongside the card', { ...share(), body: 'Look at this' }],
  ])('a card with %s answers 400 SHARE_CARD_INVALID and writes nothing', async (_label, body) => {
    const f = fixture();
    expect(await outcome(f.send(A, share(BEST)))).toEqual([200, 'sent']);
    expect(await outcome(f.send(A, body))).toEqual([400, 'SHARE_CARD_INVALID']);
    expect(f.prisma.coachMessage.create).toHaveBeenCalledTimes(1);
    expect(f.cards).toHaveLength(1);
  });

  it('a coach sending share: the coach body refuses `card`; a coach on the client route is refused', async () => {
    const f = fixture();
    const check = (metatype: Type<unknown>) => pipe.transform(share(), { type: 'body', metatype });
    // Control: the client route takes the card.
    await expect(check(CLIENT_BODY)).resolves.toMatchObject(share());
    await expect(check(COACH_BODY)).rejects.toBeInstanceOf(HttpException);
    // The coach-to-student role bypass reaches POST /messages: a head coach has no
    // coach (409), a sub-coach is no client of their head coach (404).
    expect(await outcome(f.send(X, share()))).toEqual([409, 'NO_COACH_ASSIGNED']);
    expect(await outcome(f.send(SUB, share()))).toEqual([404, 'Not Found']);
    expect(f.prisma.coachMessage.create).not.toHaveBeenCalled();
  });

  it('broadcasts flag off still returns a share card; coach cards stay behind the flag', async () => {
    const f = fixture();
    const shared = await f.send(A, share());
    f.messages.push({ id: 'w1', coach_id: X, client_id: A, sender_id: X, body: 'This week' });
    f.cards.push({ message_id: 'w1', card_type: 'workout', ref_id: 'p1', snapshot: { title: 'Up' } });
    delete process.env.FEATURE_COACH_BROADCASTS;
    const off = { [shared.id]: { card_type: 'share', ref_id: null, snapshot: RUN }, w1: null };
    expect(cardsById(await f.client.listThread(req(A), {}))).toEqual(off);
    expect(cardsById(await f.coach.listThread(req(X), A, {}))).toEqual(off);
    process.env.FEATURE_COACH_BROADCASTS = 'true';
    expect(cardsById(await f.client.listThread(req(A), {}))).toMatchObject({
      [shared.id]: { card_type: 'share' },
      w1: { card_type: 'workout', ref_id: 'p1' },
    });
  });
});
