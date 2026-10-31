import 'reflect-metadata';
import { CoachHomeService } from '../../../src/coach/home/coach-home.service';
import { DigestService } from '../../../src/notifications/digest.service';
import { accessWorld, type AccessWorld } from './member-content-fixture';
import { MEMBER_CONTENT_READERS } from './member-content-readers';

function message(w: AccessWorld, deleted: boolean) {
  const author = w.member(deleted ? 'Deleted Sender' : 'Control Sender');
  return w.db.seed('coachMessage', {
    coach_id: w.coach.id, client_id: author.id, sender_id: author.id,
    body: deleted ? null : 'Control words',
    voice_url: null, deleted_at: deleted ? new Date() : null, read_at: null,
  });
}

describe('LS-1185 B4: erased words do not imply erased counts', () => {
  it('CoachHomeService.countReview must declare a removal GAP while a deleted message still adds a conversation', async () => {
    const w = await accessWorld();
    const service = Object.create(CoachHomeService.prototype);
    service.prisma = w.db;
    const read = () => service.countReview(w.coach.id, new Date(0), new Date('2100-01-01T00:00:00Z'));
    message(w, false);
    expect((await read()).totalConversations).toBe(1);
    message(w, true);
    const count = (await read()).totalConversations;
    console.log(`LS-1185 countReview removal proof: control=1, with erased tombstone=${count}`);
    expect(count).toBeGreaterThanOrEqual(1);
    if (count > 1) {
      const row = MEMBER_CONTENT_READERS.find((r) => r.reader === 'CoachHomeService.countReview');
      expect(row?.removed).toMatch(/^GAP:/);
    }
  });

  it('DigestService._buildCoachDigestData must declare a removal GAP while a deleted message still adds to unread count', async () => {
    const w = await accessWorld();
    const service = Object.create(DigestService.prototype);
    service.prisma = w.db;
    const read = () => service._buildCoachDigestData(w.coach.id, 'daily');
    message(w, false);
    expect((await read()).rosterStats.unreadMessages).toBe(1);
    message(w, true);
    const count = (await read()).rosterStats.unreadMessages;
    console.log(`LS-1185 digest removal proof: control=1, with erased tombstone=${count}`);
    expect(count).toBeGreaterThanOrEqual(1);
    if (count > 1) {
      const row = MEMBER_CONTENT_READERS.find((r) => r.reader === 'DigestService._buildCoachDigestData');
      expect(row?.removed).toMatch(/^GAP:/);
    }
  });
});
