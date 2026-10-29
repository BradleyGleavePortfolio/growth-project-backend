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
import type { CommunityMessage, CommunityMessageImage, User } from '@prisma/client';
import { CommunityMessagesController } from '../../../src/community/messages/community-messages.controller';
import { CommunityMessagesRepository } from '../../../src/community/messages/community-messages.repository';
import { CommunityMessagesService } from '../../../src/community/messages/community-messages.service';
import { CreateMessageDto } from '../../../src/community/dto/community-message.dto';
import { CreateVoiceNoteDto } from '../../../src/community/voice/community-voice.dto';
import { keyedMessageId, messageKey } from '../../../src/community/messages/message-idempotency';
import { mintImageKey } from '../../../src/community/images/community-image-store';
import { safetyWithBlocks } from '../safety/safety-test-helpers';
import { stub } from '../../utils/trial-fakes';

type Deps = ConstructorParameters<typeof CommunityMessagesService>;
type RepoDeps = ConstructorParameters<typeof CommunityMessagesRepository>;
type RouteDeps = ConstructorParameters<typeof CommunityMessagesController>;
type Route = CommunityMessagesController['send'];

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const SPACE = '11111111-1111-4111-8111-111111111111';
const OTHER_SPACE = '33333333-3333-4333-8333-333333333333';
const KEY = '6f1c2b0e-8d4a-4c1e-9b7a-2d3e4f5a6b7c';
const olive = stub<User>({ id: '0a11ce00-0000-4000-8000-000000000001', role: 'student' });
const vera = stub<User>({ id: '0a11ce00-0000-4000-8000-000000000002', role: 'student' });

function harness(alertsToday = 0) {
  const rows: CommunityMessage[] = [];
  const photos: CommunityMessageImage[] = [];
  const communityMessage = {
    create: jest.fn(async ({ data }: { data: Partial<CommunityMessage> }) => {
      const at = new Date();
      const row = { id: randomUUID(), created_at: at, updated_at: at, deleted_at: null, plan_context_type: null, high_alert: false,
        ...data } as CommunityMessage;
      rows.push(row);
      return row;
    }),
    findFirst: jest.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null),
    updateMany: jest.fn(async () => ({ count: 0 })),
  };
  // FR-1144B: the photo rows (SC-BE3), so a photo send runs the real repository too.
  const communityMessageImage = {
    create: jest.fn(async ({ data }: { data: Partial<CommunityMessageImage> }) => {
      photos.push({ id: randomUUID(), created_at: new Date(), ...data } as CommunityMessageImage);
      return photos[photos.length - 1];
    }),
    findMany: jest.fn(async ({ where }: { where: { message_id: { in: string[] } } }) =>
      photos.filter((p) => where.message_id.in.includes(p.message_id))),
  };
  const prisma: Record<string, unknown> = { communityMessage, communityMessageImage, $executeRaw: jest.fn(async () => 1) };
  prisma.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
  const access = {
    findCohort: jest.fn(async (id: string) => ({ id, workspace_id: WORKSPACE, kind: 'cohort' })),
    canAccessCohort: jest.fn(async () => true),
    assertCanPost: jest.fn(async () => undefined),
  };
  const realtime = { broadcastCommunityEvent: jest.fn(async () => undefined) };
  // SC-PUSH (main): the High alert gate; the coach may send, 4 people would get it, `alertsToday` sent before
  // today. FR-1144B: each mark counts against the 3, as the live count of marked messages does.
  const spacePush = {
    highAlertAllowance: jest.fn(async () => ({ reach: 4, used_today: alertsToday + rows.filter((r) => r.high_alert).length, limit: 3 })),
    markHighAlert: jest.fn(async (id: string) => {
      for (const r of rows) if (r.id === id) r.high_alert = true;
    }),
  };
  // FR-1144B: the photo store; every upload checks out (a JPEG, no location) and copies to its sent key.
  const images = {
    check: jest.fn(async () => ({ result: 'ok' as const, size: 2048 })),
    publish: jest.fn(async () => undefined),
    createSignedDownload: jest.fn(async (key: string) => `https://s.test/${key}`),
    removeObjects: jest.fn(async () => ({ failed: false })),
  };
  // The push tail asks pushEnabled once per new message (off here, so nothing is sent).
  const push = { pushEnabled: jest.fn(() => false), sendCommunityPush: jest.fn(async () => undefined) };
  const repo = new CommunityMessagesRepository(stub<RepoDeps[0]>(prisma));
  const service = new CommunityMessagesService(stub<Deps[0]>(access), repo, stub<Deps[2]>(realtime), stub<Deps[3]>({}),
    safetyWithBlocks(), stub<Deps[5]>(push), stub<Deps[6]>(images), stub<Deps[7]>(spacePush));
  const send = (u: User, body: string, key?: string, space = SPACE) =>
    service.send(u, space, body, undefined, undefined, undefined, undefined, key).then((r) => r.message);
  const alert = (u: User, body: string, key: string) =>
    service.send(u, SPACE, body, undefined, undefined, undefined, true, key);
  const photo = (u: User, body: string, key: string, upload: string, parentId?: string) =>
    service.send(u, SPACE, body, undefined, parentId, { key: upload, width: 800, height: 600 }, undefined, key);
  return { rows, photos, realtime, spacePush, communityMessage, images, push, send, alert, photo };
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

  it('FR-1144: a coach resending a High alert under its key marks it once and answers alike', async () => {
    const was = process.env.FEATURE_COMMUNITY_SPACE_PUSH;
    process.env.FEATURE_COMMUNITY_SPACE_PUSH = 'true';
    try {
      const h = harness();
      const coach = stub<User>({ id: '0a11ce00-0000-4000-8000-0000000000c0', role: 'coach' });
      const first = await h.alert(coach, 'Class moved to 6pm', KEY);
      const again = await h.alert(coach, 'Class moved to 6pm', KEY);
      expect(again).toEqual(first);
      expect(first.high_alert_reach).toBe(4);
      expect(h.rows).toHaveLength(1);
      // The mark, the coach-replied stamp and the realtime ping (which carries the space push) ran once.
      expect(h.spacePush.markHighAlert).toHaveBeenCalledTimes(1);
      expect(h.communityMessage.updateMany).toHaveBeenCalledTimes(1);
      expect(h.realtime.broadcastCommunityEvent).toHaveBeenCalledTimes(1);
    } finally {
      if (was === undefined) delete process.env.FEATURE_COMMUNITY_SPACE_PUSH;
      else process.env.FEATURE_COMMUNITY_SPACE_PUSH = was;
    }
  });
});

// FR-1144B (Sol round 2 B1, B2): failed on a64532da. A photo send ignored its key (a lost reply posted a second
// photo, or a 422 when the upload had already been used), and an identical resend of the coach's third High alert
// of the day was a 429 (the daily limit ran before the replay).
describe('FR-1144B: one send-once rule for photos and for the third High alert', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.FEATURE_COMMUNITY_IMAGES = 'true';
    process.env.VOICE_KEY_SIGNING_SECRET = 'fr-1144b-test-secret';
    process.env.FEATURE_COMMUNITY_SPACE_PUSH = 'true';
  });
  afterEach(() => {
    process.env = { ...env };
  });
  const coach = stub<User>({ id: '0a11ce00-0000-4000-8000-0000000000c0', role: 'coach' });

  it('B1: a photo resent under its key after a lost reply returns the first message and uses the upload once', async () => {
    const h = harness();
    const upload = mintImageKey(olive.id, SPACE);
    const first = await h.photo(olive, 'New PR', KEY, upload);
    const again = await h.photo(olive, 'New PR', KEY, upload);
    expect(again).toEqual(first);
    expect(first.message.image).toBeTruthy();
    expect(h.rows).toHaveLength(1);
    expect(h.photos).toHaveLength(1);
    // Nothing about the upload is checked or copied again, and no second ping or push runs.
    expect(h.images.check).toHaveBeenCalledTimes(1);
    expect(h.images.publish).toHaveBeenCalledTimes(1);
    expect(h.realtime.broadcastCommunityEvent).toHaveBeenCalledTimes(1);
    expect(h.push.pushEnabled).toHaveBeenCalledTimes(1);
  });

  it('B1: a photo reply resent under its key returns the first reply', async () => {
    const h = harness();
    const root = await h.send(vera, 'Show us');
    const upload = mintImageKey(olive.id, SPACE);
    const first = await h.photo(olive, '', KEY, upload, root.id);
    const again = await h.photo(olive, '', KEY, upload, root.id);
    expect(again).toEqual(first);
    expect(h.rows).toHaveLength(2);
    expect(h.images.publish).toHaveBeenCalledTimes(1);
  });

  it('B1: the same key on another photo or another caption is refused (409) and writes nothing', async () => {
    const h = harness();
    const upload = mintImageKey(olive.id, SPACE);
    await h.photo(olive, 'New PR', KEY, upload);
    expect(await status(h.photo(olive, 'New PR', KEY, mintImageKey(olive.id, SPACE)))).toBe(409);
    expect(await status(h.photo(olive, 'Other words', KEY, upload))).toBe(409);
    // A text send under a photo's key is another message too.
    expect(await status(h.send(olive, 'New PR', KEY))).toBe(409);
    expect(h.rows).toHaveLength(1);
    expect(h.photos).toHaveLength(1);
    expect(h.images.publish).toHaveBeenCalledTimes(1);
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
    const route = new CommunityMessagesController(stub<RouteDeps[0]>({ send }));
    const req = stub<Parameters<Route>[0]>({ user: olive });
    await route.send(req, SPACE, stub<CreateMessageDto>({ body: 'Leg day done' }), KEY.toUpperCase());
    expect(send).toHaveBeenCalledWith(olive, SPACE, 'Leg day done', undefined, undefined, undefined, undefined, KEY);
    await route.send(req, SPACE, stub<CreateMessageDto>({ body: 'Leg day done' }), undefined);
    expect(send).toHaveBeenLastCalledWith(olive, SPACE, 'Leg day done', undefined, undefined, undefined, undefined, null);
    await expect(route.send(req, SPACE, stub<CreateMessageDto>({ body: 'x' }), 'nope')).rejects.toBeInstanceOf(BadRequestException);
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
