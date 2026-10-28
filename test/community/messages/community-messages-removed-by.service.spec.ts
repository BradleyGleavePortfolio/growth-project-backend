/**
 * REMOVED-BY-BE (#174-4): a coach's removal of someone else's space message
 * stays visible as a placeholder (who sent it and when, who removed it and
 * when; never the words, photo, voice note, reply quote or ack). The author's
 * own delete is unchanged (the row drops from the space), and so is every
 * removal made before 20270502009400 (no removed_by_user_id).
 *
 * Repo, access and realtime are mocks (no DB); the transaction itself (who,
 * when, erased words, one notice) is pinned in
 * test/community/safety/community-removed-by-tx.spec.ts.
 */
import type { CommunityMessage, User } from '@prisma/client';
import { CommunityMessagesService } from '../../../src/community/messages/community-messages.service';
import { MessageRemovedPayloadSchema } from '../../../src/community/realtime/community-realtime.types';
import { FIXTURE_IDS, buildMessage } from '../../../src/community/ack/ack.test-fixtures';
import { safetyWithBlocks } from '../safety/safety-test-helpers';
import { noCommunityPush } from './community-push-test-helpers';

/** Partial mocks typed at the constructor (no cast token). */
function stub<T>(v: unknown): T {
  return v as T;
}

const COACH = FIXTURE_IDS.coach;
const AUTHOR = FIXTURE_IDS.clientSender;
const OTHER = '99999999-0000-4000-8000-000000000009';
const PARENT = 'eeeeeeee-0000-4000-8000-000000000002';
const SENT_AT = new Date('2026-10-01T10:00:00.000Z');
const REMOVED_AT = new Date('2026-10-01T11:00:00.000Z');

const coach = stub<User>({ id: COACH, role: 'coach' });
const author = stub<User>({ id: AUTHOR, role: 'student' });
const other = stub<User>({ id: OTHER, role: 'student' });

function removed(over: Partial<CommunityMessage> = {}): CommunityMessage {
  return buildMessage({
    created_at: SENT_AT,
    updated_at: REMOVED_AT,
    body: null,
    deleted_at: REMOVED_AT,
    visibility: 'hidden',
    removed_by_user_id: COACH,
    ...over,
  });
}

describe('REMOVED-BY-BE: a coach removal of a space message is a placeholder', () => {
  let repo: {
    findById: jest.Mock;
    listCohortMessages: jest.Mock;
    chatExtras: jest.Mock;
    removeByCoach: jest.Mock;
    softDelete: jest.Mock;
    softDeleteImage: jest.Mock;
    imagesFor: jest.Mock;
    voiceNotesFor: jest.Mock;
    attemptImageErasure: jest.Mock;
  };
  let access: { findCohort: jest.Mock; canAccessCohort: jest.Mock; isWorkspaceCoach: jest.Mock };
  let realtime: { broadcastCommunityEvent: jest.Mock };
  let service: CommunityMessagesService;

  const build = (blocks: Array<[string, string]> = []) =>
    new CommunityMessagesService(
      stub(access),
      stub(repo),
      stub(realtime),
      stub({}),
      safetyWithBlocks(blocks),
      noCommunityPush(),
    );

  beforeEach(() => {
    repo = {
      findById: jest.fn(async () => buildMessage({ created_at: SENT_AT })),
      listCohortMessages: jest.fn(async () => [removed()]),
      chatExtras: jest.fn(async () => ({
        coachId: COACH,
        people: new Map([
          [AUTHOR, { id: AUTHOR, name: 'Sam Rivers', profile: { avatar_url: null } }],
          [COACH, { id: COACH, name: 'Kim Lee', profile: { avatar_url: null } }],
        ]),
        fullName: () => true,
        parents: [],
      })),
      removeByCoach: jest.fn(async (m: CommunityMessage, by: string) =>
        removed({ id: m.id, kind: m.kind, removed_by_user_id: by }),
      ),
      softDelete: jest.fn(async (m: CommunityMessage) =>
        buildMessage({ id: m.id, created_at: SENT_AT, deleted_at: REMOVED_AT, visibility: 'hidden' }),
      ),
      softDeleteImage: jest.fn(async (m: CommunityMessage, _reason: string, by: string | null) => ({
        deleted: by
          ? removed({ id: m.id, kind: 'image', removed_by_user_id: by })
          : buildMessage({ id: m.id, kind: 'image', deleted_at: REMOVED_AT }),
        work: [],
      })),
      imagesFor: jest.fn(async () => []),
      voiceNotesFor: jest.fn(async () => new Map()),
      attemptImageErasure: jest.fn(async () => undefined),
    };
    access = {
      findCohort: jest.fn(async () => ({ id: FIXTURE_IDS.cohort, workspace_id: FIXTURE_IDS.workspace })),
      canAccessCohort: jest.fn(async () => true),
      isWorkspaceCoach: jest.fn(async (_ws: string, id: string) => id === COACH),
    };
    realtime = { broadcastCommunityEvent: jest.fn(async () => undefined) };
    service = build();
  });

  // Item 2: who removed it and when; moderation, not an author delete.
  it('a coach removing a member message stores who removed it (not a plain author delete)', async () => {
    await service.remove(coach, FIXTURE_IDS.message);
    expect(repo.removeByCoach).toHaveBeenCalledWith(expect.objectContaining({ id: FIXTURE_IDS.message }), COACH);
    expect(repo.softDelete).not.toHaveBeenCalled();
  });

  it("the author's own delete is unchanged: plain soft delete, no remover, no removal ping", async () => {
    const res = await service.remove(author, FIXTURE_IDS.message);
    expect(repo.softDelete).toHaveBeenCalledTimes(1);
    expect(repo.removeByCoach).not.toHaveBeenCalled();
    expect(realtime.broadcastCommunityEvent).not.toHaveBeenCalled();
    expect(res.message).not.toHaveProperty('removed_by');
    expect(res.message).toMatchObject({ deleted: true, body: null });
  });

  it('a coach deleting their own message is an author delete', async () => {
    repo.findById.mockResolvedValue(buildMessage({ sender_id: COACH }));
    await service.remove(coach, FIXTURE_IDS.message);
    expect(repo.softDelete).toHaveBeenCalledTimes(1);
    expect(repo.removeByCoach).not.toHaveBeenCalled();
  });

  it('a coach removing a photo files it as moderation with the remover', async () => {
    repo.findById.mockResolvedValue(buildMessage({ kind: 'image' }));
    const res = await service.remove(coach, FIXTURE_IDS.message);
    expect(repo.softDeleteImage).toHaveBeenCalledWith(expect.objectContaining({ id: FIXTURE_IDS.message }), 'moderation', COACH);
    expect(res.message).toMatchObject({ kind: 'image', image: null, removed_by: { role: 'coach', user_id: COACH } });
  });

  it('the delete answer for a coach removal is the placeholder (no sender, as today)', async () => {
    const res = await service.remove(coach, FIXTURE_IDS.message);
    expect(res.message).toEqual({
      id: FIXTURE_IDS.message,
      cohort_id: FIXTURE_IDS.cohort,
      sender_user_id: AUTHOR,
      body: null,
      kind: 'text',
      created_at: SENT_AT.toISOString(),
      updated_at: REMOVED_AT.toISOString(),
      edited: false,
      deleted: true,
      plan_context: null,
      parent_message_id: null,
      voice_note: null,
      removed_at: REMOVED_AT.toISOString(),
      removed_by: { role: 'coach', user_id: COACH, name: 'Kim Lee' },
    });
  });

  // Item 5: the live update carries the placeholder (ids and times only).
  it('pings everyone in the space with the placeholder so open screens swap the row', async () => {
    await service.remove(coach, FIXTURE_IDS.message);
    expect(realtime.broadcastCommunityEvent).toHaveBeenCalledTimes(1);
    const [audience, event, payload, meta] = realtime.broadcastCommunityEvent.mock.calls[0];
    expect(audience).toEqual({ workspaceId: FIXTURE_IDS.workspace, cohortId: FIXTURE_IDS.cohort });
    expect(event).toBe('community.message.updated');
    expect(MessageRemovedPayloadSchema.parse(payload)).toEqual({
      id: FIXTURE_IDS.message,
      cohortId: FIXTURE_IDS.cohort,
      updatedAt: REMOVED_AT.toISOString(),
      removedAt: REMOVED_AT.toISOString(),
      createdAt: SENT_AT.toISOString(),
      kind: 'text',
      authorId: AUTHOR,
      removedBy: { role: 'coach', userId: COACH },
    });
    expect(JSON.stringify(payload)).not.toMatch(/Kim|Sam|hello coach/);
    expect(meta).toEqual({ distinctId: COACH, channelKind: 'cohort' });
  });

  it('a second delete of a removed message answers the placeholder again with no second ping', async () => {
    repo.findById.mockResolvedValue(removed());
    const res = await service.remove(coach, FIXTURE_IDS.message);
    expect(res.message).toMatchObject({ removed_by: { role: 'coach', user_id: COACH } });
    expect(repo.removeByCoach).not.toHaveBeenCalled();
    expect(realtime.broadcastCommunityEvent).not.toHaveBeenCalled();
  });

  // Item 3: lists and single reads return the placeholder.
  it('lists a coach-removed message as a placeholder: sender, times, remover; no words, quote or voice', async () => {
    repo.listCohortMessages.mockResolvedValue([removed({ parent_message_id: PARENT, parent_message_at: SENT_AT })]);
    const res = await service.list(other, FIXTURE_IDS.cohort, {});
    expect(res.messages).toEqual([
      {
        id: FIXTURE_IDS.message,
        cohort_id: FIXTURE_IDS.cohort,
        sender_user_id: AUTHOR,
        body: null,
        kind: 'text',
        created_at: SENT_AT.toISOString(),
        updated_at: REMOVED_AT.toISOString(),
        edited: false,
        deleted: true,
        plan_context: null,
        parent_message_id: PARENT,
        voice_note: null,
        sender: { id: AUTHOR, name: 'Sam Rivers', avatar_url: null, is_coach: false },
        parent: null,
        removed_at: REMOVED_AT.toISOString(),
        removed_by: { role: 'coach', user_id: COACH, name: 'Kim Lee' },
      },
    ]);
    expect(repo.voiceNotesFor).not.toHaveBeenCalled();
    expect(repo.imagesFor).not.toHaveBeenCalled();
  });

  it('a coach-removed voice message in the chat has no voice note and no audio', async () => {
    repo.listCohortMessages.mockResolvedValue([removed({ kind: 'voice' })]);
    const res = await service.list(other, FIXTURE_IDS.cohort, {});
    expect(res.messages[0]).toMatchObject({ kind: 'voice', voice_note: null, body: null, removed_at: REMOVED_AT.toISOString() });
    expect(repo.voiceNotesFor).not.toHaveBeenCalled();
  });

  it('reads a coach-removed message by id as its placeholder', async () => {
    repo.findById.mockResolvedValue(removed());
    const res = await service.getOne(other, FIXTURE_IDS.message);
    expect(res.message).toMatchObject({ deleted: true, body: null, removed_by: { role: 'coach', name: 'Kim Lee' } });
  });

  it('live rows carry no removed keys', async () => {
    repo.listCohortMessages.mockResolvedValue([buildMessage()]);
    const res = await service.list(other, FIXTURE_IDS.cohort, {});
    expect(res.messages[0]).not.toHaveProperty('removed_at');
    expect(res.messages[0]).not.toHaveProperty('removed_by');
    expect(res.messages[0].body).toBe('hello coach');
  });

  it('a removal never reveals a blocked author: the placeholder is dropped from the list and 404 by id', async () => {
    const blocked = build([[OTHER, AUTHOR]]);
    const list = await blocked.list(other, FIXTURE_IDS.cohort, {});
    expect(list.messages).toEqual([]);
    repo.findById.mockResolvedValue(removed());
    await expect(blocked.getOne(other, FIXTURE_IDS.message)).rejects.toMatchObject({ status: 404 });
  });
});
