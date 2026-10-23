/**
 * FX-IDEM: the space chat send honours Idempotency-Key. The phone's outbox (m#871 useSpaceChat) keeps one key per
 * pending row and sends it again after a timeout or a lost reply; the second send must answer with the first
 * message, never post a second one. The real service and repository run over an in-memory table (no DB); the
 * race under one key and the cross-tenant reads run live in test/rls/community-message-idempotency.live.spec.ts.
 * The first describe failed on the code before FX-IDEM (two rows, no 409); the second pins the header and the id.
 */
import { randomUUID } from 'crypto';
import { BadRequestException, ParseUUIDPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { CommunityMessage, User } from '@prisma/client';
import { CommunityMessagesController } from '../../../src/community/messages/community-messages.controller';
import { CommunityMessagesRepository } from '../../../src/community/messages/community-messages.repository';
import { CommunityMessagesService } from '../../../src/community/messages/community-messages.service';
import { CreateMessageDto } from '../../../src/community/dto/community-message.dto';
import { CreateVoiceNoteDto } from '../../../src/community/voice/community-voice.dto';
import { keyedMessageId, messageKey } from '../../../src/community/messages/message-idempotency';
import { safetyWithBlocks } from '../safety/safety-test-helpers';
import { noCommunityPush } from './community-push-test-helpers';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const SPACE = '11111111-1111-4111-8111-111111111111';
const OTHER_SPACE = '33333333-3333-4333-8333-333333333333';
const KEY = '6f1c2b0e-8d4a-4c1e-9b7a-2d3e4f5a6b7c';
const olive = { id: '0a11ce00-0000-4000-8000-000000000001', role: 'student' } as unknown as User;
const vera = { id: '0a11ce00-0000-4000-8000-000000000002', role: 'student' } as unknown as User;

function harness() {
  const rows: CommunityMessage[] = [];
  const communityMessage = {
    create: jest.fn(async ({ data }: { data: Partial<CommunityMessage> }) => {
      const at = new Date();
      const row = { id: randomUUID(), created_at: at, updated_at: at, deleted_at: null, ...data } as CommunityMessage;
      rows.push(row);
      return row;
    }),
    findFirst: jest.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null),
  };
  const prisma: Record<string, unknown> = { communityMessage, $executeRaw: jest.fn(async () => 1) };
  prisma.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
  const access = {
    findCohort: jest.fn(async (id: string) => ({ id, workspace_id: WORKSPACE, kind: 'cohort' })),
    canAccessCohort: jest.fn(async () => true),
    assertCanPost: jest.fn(async () => undefined),
  };
  const realtime = { broadcastCommunityEvent: jest.fn(async () => undefined) };
  const service = new CommunityMessagesService(access as never, new CommunityMessagesRepository(prisma as never),
    realtime as never, {} as never, safetyWithBlocks(), noCommunityPush());
  const send = (u: User, body: string, key?: string, space = SPACE) =>
    service.send(u, space, body, undefined, undefined, key).then((r) => r.message);
  return { rows, realtime, send };
}

const status = (p: Promise<unknown>) => p.then(() => 200, (e: { status?: number }) => e.status ?? 500);

describe('FX-IDEM: POST /community/cohorts/:id/messages with Idempotency-Key', () => {
  it('the same key twice from one author in one space returns the first message and writes one row', async () => {
    const h = harness();
    const first = await h.send(olive, 'Leg day done', KEY);
    const again = await h.send(olive, 'Leg day done', KEY);
    expect(again).toEqual(first);
    expect(h.rows).toHaveLength(1);
    // The replay has no side effects: one realtime ping, for the first write only.
    expect(h.realtime.broadcastCommunityEvent).toHaveBeenCalledTimes(1);
  });

  it('the same key with different words is refused (409) and writes nothing', async () => {
    const h = harness();
    await h.send(olive, 'Leg day done', KEY);
    expect(await status(h.send(olive, 'Rest day', KEY))).toBe(409);
    expect(h.rows).toHaveLength(1);
  });

  it('a key belongs to one author in one space: another author or another space gets its own message', async () => {
    const h = harness();
    const mine = await h.send(olive, 'Leg day done', KEY);
    const hers = await h.send(vera, 'Leg day done', KEY);
    const elsewhere = await h.send(olive, 'Leg day done', KEY, OTHER_SPACE);
    expect(new Set([mine.id, hers.id, elsewhere.id]).size).toBe(3);
    expect(hers.sender_user_id).toBe(vera.id);
    expect(h.rows).toHaveLength(3);
  });

  it('with no key every send is a new message, as before', async () => {
    const h = harness();
    await h.send(olive, 'Leg day done');
    await h.send(olive, 'Leg day done');
    expect(h.rows).toHaveLength(2);
  });
});

describe('FX-IDEM: the header and the id it names', () => {
  it('no header or a blank one means no dedupe; a UUID is read case-blind; anything else is a 400', () => {
    expect(messageKey(undefined)).toBeNull();
    expect(messageKey('  ')).toBeNull();
    expect(messageKey(KEY.toUpperCase())).toBe(KEY);
    expect(messageKey([KEY, 'second'])).toBe(KEY);
    let refused: unknown;
    try { messageKey('send-1'); } catch (e) { refused = e; }
    expect((refused as BadRequestException).getResponse()).toEqual({ error: 'bad_request', code: 'community.message.idempotency_key_invalid' });
  });

  it('one author, space and key always name the same UUID; change any one and the id changes', () => {
    const idOf = keyedMessageId(olive.id, SPACE, KEY);
    expect(idOf).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(keyedMessageId(olive.id, SPACE, KEY)).toBe(idOf);
    const others = [keyedMessageId(vera.id, SPACE, KEY), keyedMessageId(olive.id, OTHER_SPACE, KEY),
      keyedMessageId(olive.id, SPACE, randomUUID())];
    expect(new Set([idOf, ...others]).size).toBe(4);
  });

  it('the route passes the read key to the send, and refuses a bad key before any send', async () => {
    const send = jest.fn(async () => ({ message: {} }));
    const route = new CommunityMessagesController({ send } as never);
    const req = { user: olive } as never;
    await route.send(req, SPACE, { body: 'Leg day done' } as never, KEY.toUpperCase());
    expect(send).toHaveBeenCalledWith(olive, SPACE, 'Leg day done', undefined, undefined, KEY);
    await route.send(req, SPACE, { body: 'Leg day done' } as never, undefined);
    expect(send).toHaveBeenLastCalledWith(olive, SPACE, 'Leg day done', undefined, undefined, null);
    await expect(route.send(req, SPACE, { body: 'x' } as never, 'nope')).rejects.toBeInstanceOf(BadRequestException);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('FX-IDEM: a keyed message is repliable like any other (every version 4 id check accepts its id)', () => {
  const idOf = keyedMessageId(olive.id, SPACE, KEY);

  it('a text reply and a voice reply may name it as their parent', async () => {
    const text = plainToInstance(CreateMessageDto, { body: 'On it', parent_message_id: idOf });
    expect(await validate(text)).toEqual([]);
    const voice = plainToInstance(CreateVoiceNoteDto, {
      cohort_id: SPACE, storage_key: 'k', duration_ms: 1000, bytes: 10, mime_type: 'audio/m4a', parent_message_id: idOf,
    });
    expect((await validate(voice)).filter((e) => e.property === 'parent_message_id')).toEqual([]);
  });

  it('the ack routes take it (ParseUUIDPipe version 4)', async () => {
    await expect(new ParseUUIDPipe({ version: '4' }).transform(idOf, { type: 'param' })).resolves.toBe(idOf);
  });
});
