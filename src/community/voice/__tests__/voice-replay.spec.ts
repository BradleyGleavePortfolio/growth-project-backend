/**
 * VOICE-IDEM-BE (agent 174): a voice note sent again after a lost reply posts once.
 *
 * A create whose storage key this same author already published, in the same
 * place (same space, same reply parent), gets that first note back (201, the
 * same body) instead of 409. Every access, ban, block and key gate runs first;
 * any other use of the key, or a first note since deleted or hidden, stays the
 * 409. Racing creates write one row; the ping and telemetry run once. The
 * repository half (one row per key) is voice-replay-repository.spec.ts.
 */
import { randomUUID } from 'crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { CommunityVoiceNote } from '@prisma/client';
import type { CommunityAccessService } from '../../community-access.service';
import type { AnalyticsService } from '../../../analytics/analytics.service';
import type { CommunityRealtimeService } from '../../realtime/community-realtime.service';
import { CommunityVoiceService } from '../community-voice.service';
import type { CommunityVoiceRepository, VoiceNoteSeed } from '../community-voice.repository';
import type { VoiceUploadProvider } from '../voice-upload.provider';
import { mintVoiceKey } from '../voice-storage-key';
import { makeUser } from './test-user.factory';
import { safetyWithBlocks } from '../../../../test/community/safety/safety-test-helpers';
import { stub } from '../../../../test/utils/trial-fakes';

const WS = '11111111-1111-4111-8111-111111111111';
const SPACE = '33333333-3333-4333-8333-333333333333';
const OTHER_SPACE = '12121212-1212-4212-8212-121212121212';
const COACH_ID = '55555555-5555-4555-8555-555555555555';
const MEMBER_ID = '66666666-6666-4666-8666-666666666666';
const OTHER_ID = '77777777-7777-4777-8777-777777777777';
const PARENT_ID = '99999999-9999-4999-8999-999999999999';

const member = makeUser({ id: MEMBER_ID, role: 'student' });
const other = makeUser({ id: OTHER_ID, role: 'student' });
const AT = new Date('2026-10-01T00:00:00.000Z');

type Chat = {
  id: string; kind: string; scope: string; workspace_id: string; cohort_id: string | null; sender_id: string;
  deleted_at: Date | null; visibility: string; plan_context_type: string | null; created_at: Date;
  parent_message_id: string | null; parent_message_at: Date | null;
};
const chatRow = (over: Partial<Chat> = {}): Chat => ({
  id: PARENT_ID, kind: 'text', scope: 'cohort', workspace_id: WS, cohort_id: SPACE, sender_id: COACH_ID,
  deleted_at: null, visibility: 'active', plan_context_type: null, created_at: new Date('2026-09-30T00:00:00.000Z'),
  parent_message_id: null, parent_message_at: null, ...over,
});

describe('VOICE-IDEM-BE: the same voice create sent again posts once', () => {
  let rows: CommunityVoiceNote[];
  let chats: Map<string, Chat>;
  let blocks: Array<[string, string]>;
  let canAccessCohort: jest.Mock;
  let statObject: jest.Mock;
  let broadcast: jest.Mock;
  let capture: jest.Mock;
  let repo: {
    findByStorageKey: jest.Mock; createVoiceNote: jest.Mock; findChatMessage: jest.Mock; viewExtras: jest.Mock;
  };
  let service: CommunityVoiceService;
  let key: string;
  const dto = (over: Record<string, unknown> = {}) => ({
    storage_key: key, cohort_id: SPACE, duration_ms: 5000, bytes: 1000, mime_type: 'audio/mp4' as const, ...over,
  });
  const refusal = (p: Promise<unknown>) => p.then(() => 'sent', (e: { getStatus: () => number; getResponse: () => unknown }) =>
    [e.getStatus(), e.getResponse()]);
  const settle = () => new Promise((r) => setImmediate(r));
  const published = () => capture.mock.calls.filter((c) => c[1] === 'community.voice.note_published').length;

  beforeEach(() => {
    process.env.FEATURE_COMMUNITY_TELEMETRY = 'true';
    process.env.VOICE_KEY_SIGNING_SECRET = 'test-voice-key-secret';
    delete process.env.FEATURE_COMMUNITY_VOICE_NOTES_REQUIRE_ENTITLEMENT;
    key = mintVoiceKey(MEMBER_ID, 'm4a');
    rows = [];
    chats = new Map([[PARENT_ID, chatRow()]]);
    blocks = [];
    // What the real repository does: one row per key; a create that finds the
    // key's row already written (the primary key refused it) gets that row back.
    repo = {
      findByStorageKey: jest.fn(async (k: string) => rows.find((r) => r.storage_key === k) ?? null),
      createVoiceNote: jest.fn(async (seed: VoiceNoteSeed) => {
        const hit = rows.find((r) => r.storage_key === seed.storageKey);
        if (hit) return { row: hit, replayed: true };
        const row: CommunityVoiceNote = {
          id: randomUUID(), workspace_id: seed.workspaceId, cohort_id: seed.cohortId,
          conversation_id: seed.conversationId, author_id: seed.authorId, storage_key: seed.storageKey,
          duration_ms: seed.durationMs, bytes: BigInt(seed.bytes), mime_type: seed.mimeType, waveform_peaks: null,
          created_at: AT, soft_deleted_at: null, removed_by_user_id: null,
        };
        rows.push(row);
        if (row.cohort_id) {
          chats.set(row.id, chatRow({ id: row.id, kind: 'voice', sender_id: row.author_id, created_at: AT,
            parent_message_id: seed.parent?.id ?? null, parent_message_at: seed.parent?.at ?? null }));
        }
        return { row, replayed: false };
      }),
      findChatMessage: jest.fn(async (id: string) => chats.get(id) ?? null),
      viewExtras: jest.fn(async (_viewer: string, list: CommunityVoiceNote[]) => ({
        coachId: COACH_ID,
        names: new Map([[MEMBER_ID, 'Sam Rivers']]),
        fullName: () => false,
        heardAt: new Map(),
        chat: new Map(list.flatMap((r) => {
          const c = chats.get(r.id);
          return c ? [[r.id, { parent_message_id: c.parent_message_id }] as const] : [];
        })),
      })),
    };
    canAccessCohort = jest.fn().mockResolvedValue(true);
    statObject = jest.fn().mockResolvedValue({ state: 'present', size: 1000, contentType: 'audio/mp4' });
    broadcast = jest.fn().mockResolvedValue(undefined);
    capture = jest.fn();
    const access = stub<CommunityAccessService>({
      findWorkspace: async () => ({ id: WS }),
      canAccessWorkspace: async () => true,
      findCohort: async (id: string) => ({ id, workspace_id: WS, kind: 'channel', posting_policy: 'all' }),
      canAccessCohort,
      assertCanPost: async () => undefined,
      isWorkspaceCoach: async () => false,
    });
    const upload = stub<VoiceUploadProvider>({
      bucket: () => 'voice-notes',
      statObject,
      createSignedDownload: async () => 'https://signed.download/get',
    });
    service = new CommunityVoiceService(access, stub<CommunityVoiceRepository>(repo), upload,
      stub<CommunityRealtimeService>({ broadcastCommunityEvent: broadcast }), stub<AnalyticsService>({ capture }),
      safetyWithBlocks(blocks));
  });

  it('the repeat create returns the first note (same id and body) and writes no second row', async () => {
    const first = await service.create(member, WS, dto());
    const again = await service.create(member, WS, dto());
    expect(again).toEqual(first);
    expect(again.voice_note.id).toBe(rows[0].id);
    expect(rows).toHaveLength(1);
    expect(repo.createVoiceNote).toHaveBeenCalledTimes(1);
    expect(statObject).toHaveBeenCalledTimes(1);
  });

  it('a reply sent again gets the first reply back', async () => {
    const first = await service.create(member, WS, dto({ parent_message_id: PARENT_ID }));
    expect(await service.create(member, WS, dto({ parent_message_id: PARENT_ID }))).toEqual(first);
    expect(rows).toHaveLength(1);
  });

  it('two racing creates write one row and both get the same note', async () => {
    repo.findByStorageKey.mockResolvedValue(null); // both read before either commits
    const [a, b] = await Promise.all([service.create(member, WS, dto()), service.create(member, WS, dto())]);
    expect(a).toEqual(b);
    expect(rows).toHaveLength(1);
    await settle();
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(published()).toBe(1);
  });

  it('the realtime ping (which carries the push) and the published event run once', async () => {
    await service.create(member, WS, dto());
    await service.create(member, WS, dto());
    await service.create(member, WS, dto());
    await settle();
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(published()).toBe(1);
  });

  const ALREADY = [409, expect.objectContaining({ code: 'community.voice.already_posted' })];
  const OTHER_PARENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const REPLY = { parent_message_id: PARENT_ID };
  const hide = (over: Partial<Chat>) => () => {
    const c = chats.get(rows[0].id);
    if (c) Object.assign(c, over);
  };
  it.each<[string, Record<string, unknown>, () => void, Record<string, unknown>]>([
    ['in another space', {}, () => undefined, { cohort_id: OTHER_SPACE }],
    ['in the Hall instead of the space', {}, () => undefined, { cohort_id: undefined }],
    ['as a reply when the first was not one', {}, () => undefined, REPLY],
    ['as a top-level note when the first was a reply', REPLY, () => undefined, {}],
    ['as a reply to another parent', REPLY, () => { chats.set(OTHER_PARENT, chatRow({ id: OTHER_PARENT })); },
      { parent_message_id: OTHER_PARENT }],
    ['after the author deleted the first', {}, () => {
      rows[0].soft_deleted_at = new Date();
      hide({ deleted_at: new Date(), visibility: 'hidden' })();
    }, {}],
    ['after a coach removed the first (chat message hidden)', {}, hide({ deleted_at: new Date(), visibility: 'hidden' }), {}],
    ['while the first is hidden from the space', {}, hide({ visibility: 'hidden' }), {}],
    ['when the first has no chat message', {}, () => { chats.delete(rows[0].id); }, {}],
    ['when the row holding the key is another author\'s', {}, () => { rows[0].author_id = OTHER_ID; }, {}],
    ['when the row holding the key is in another workspace', {}, () => { rows[0].workspace_id = OTHER_SPACE; }, {}],
  ])('a key reused %s stays 409 and returns nothing', async (_case, first, change, again) => {
    await service.create(member, WS, dto(first));
    change();
    expect(await refusal(service.create(member, WS, dto(again)))).toEqual(ALREADY);
    expect(rows).toHaveLength(1);
  });

  it('another author presenting the key gets the key refusal, never the note', async () => {
    await service.create(member, WS, dto());
    const got = await refusal(service.create(other, WS, dto()));
    expect(got).toEqual([400, expect.objectContaining({ code: 'community.voice.storage_key_rejected' })]);
    expect(repo.findByStorageKey).toHaveBeenCalledTimes(1);
  });

  it('a banned author gets the same refusal as a first create, not the note', async () => {
    await service.create(member, WS, dto());
    canAccessCohort.mockResolvedValue(false);
    const repeat = await refusal(service.create(member, WS, dto()));
    const fresh = await refusal(service.create(member, WS, dto({ storage_key: mintVoiceKey(MEMBER_ID, 'm4a') })));
    expect(repeat).toEqual(fresh);
    expect(repeat[0]).toBe(404);
    expect(repo.findByStorageKey).toHaveBeenCalledTimes(1);
  });

  it('an author blocked by the reply parent\'s author gets the same refusal as a first create', async () => {
    await service.create(member, WS, dto({ parent_message_id: PARENT_ID }));
    blocks.push([COACH_ID, MEMBER_ID]);
    const repeat = await refusal(service.create(member, WS, dto({ parent_message_id: PARENT_ID })));
    const fresh = await refusal(service.create(member, WS,
      dto({ parent_message_id: PARENT_ID, storage_key: mintVoiceKey(MEMBER_ID, 'm4a') })));
    expect(repeat).toEqual(fresh);
    expect(repeat).toEqual([404, { error: 'not_found', code: 'community.message.not_found' }]);
    expect(repo.findByStorageKey).toHaveBeenCalledTimes(1);
  });

  it('a 409 is a ConflictException and a gate refusal a NotFoundException (types unchanged)', async () => {
    await service.create(member, WS, dto());
    await expect(service.create(member, WS, dto({ cohort_id: OTHER_SPACE }))).rejects.toBeInstanceOf(ConflictException);
    canAccessCohort.mockResolvedValue(false);
    await expect(service.create(member, WS, dto())).rejects.toBeInstanceOf(NotFoundException);
  });
});
