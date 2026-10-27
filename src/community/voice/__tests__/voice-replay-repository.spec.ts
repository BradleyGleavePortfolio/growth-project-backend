/**
 * VOICE-IDEM-BE (agent 174): the repository writes one voice note row per
 * storage key. The note id comes from the key, so the table's primary key
 * admits one row when creates race; the losing insert (P2002) returns the
 * winner's row, flagged `replayed`, for the service's replay rule.
 */
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../../prisma.service';
import { CommunityVoiceRepository, voiceNoteIdFor, type VoiceNoteSeed } from '../community-voice.repository';
import { stub } from '../../../../test/utils/trial-fakes';

const WS = '11111111-1111-4111-8111-111111111111';
const SPACE = '33333333-3333-4333-8333-333333333333';
const MEMBER_ID = '66666666-6666-4666-8666-666666666666';
const AT = new Date('2026-10-01T00:00:00.000Z');
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('VOICE-IDEM-BE: the repository writes one row per key', () => {
  const seed = (storageKey: string): VoiceNoteSeed => ({
    workspaceId: WS, cohortId: SPACE, conversationId: null, authorId: MEMBER_ID, storageKey, durationMs: 5000,
    bytes: 1000, mimeType: 'audio/mp4', waveformPeaks: null, parent: null, answersClients: false,
  });
  const firstRow = { id: 'first', storage_key: 'k' };
  const dup = () => new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`id`)',
    { code: 'P2002', clientVersion: 'test' });

  it('the note id comes from the storage key: stable, v4-shaped, distinct per key', () => {
    const a = voiceNoteIdFor(`${MEMBER_ID}/1700000000000-0123456789abcdef-x.m4a`);
    expect(a).toMatch(UUID_V4);
    expect(voiceNoteIdFor(`${MEMBER_ID}/1700000000000-0123456789abcdef-x.m4a`)).toBe(a);
    expect(voiceNoteIdFor(`${MEMBER_ID}/1700000000001-0123456789abcdef-x.m4a`)).not.toBe(a);
  });

  it('inserts the note and its chat message under that id', async () => {
    const data: Array<Record<string, unknown>> = [];
    const tx = {
      communityVoiceNote: { create: async (a: { data: Record<string, unknown> }) => { data.push(a.data); return { ...a.data, created_at: AT }; } },
      communityMessage: { create: async (a: { data: Record<string, unknown> }) => { data.push(a.data); return a.data; } },
    };
    const repo = new CommunityVoiceRepository(stub<PrismaService>({ $transaction: async (fn: (t: unknown) => unknown) => fn(tx) }));
    const out = await repo.createVoiceNote(seed('k1'));
    expect(out.replayed).toBe(false);
    expect(data.map((d) => d.id)).toEqual([voiceNoteIdFor('k1'), voiceNoteIdFor('k1')]);
  });

  it('a create the primary key refuses (a racing create won) returns the winner and writes nothing', async () => {
    const findFirst = jest.fn().mockResolvedValue(firstRow);
    const repo = new CommunityVoiceRepository(stub<PrismaService>({
      $transaction: jest.fn().mockRejectedValue(dup()), communityVoiceNote: { findFirst },
    }));
    expect(await repo.createVoiceNote(seed('k'))).toEqual({ row: firstRow, replayed: true });
    expect(findFirst).toHaveBeenCalledWith({ where: { storage_key: 'k' } });
  });

  it('any other failure, or a refused insert with no row for the key, still throws', async () => {
    const boom = new Error('db down');
    const failing = new CommunityVoiceRepository(stub<PrismaService>({
      $transaction: jest.fn().mockRejectedValue(boom), communityVoiceNote: { findFirst: jest.fn() },
    }));
    await expect(failing.createVoiceNote(seed('k'))).rejects.toBe(boom);
    const orphan = new CommunityVoiceRepository(stub<PrismaService>({
      $transaction: jest.fn().mockRejectedValue(dup()), communityVoiceNote: { findFirst: jest.fn().mockResolvedValue(null) },
    }));
    await expect(orphan.createVoiceNote(seed('k'))).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });
});
