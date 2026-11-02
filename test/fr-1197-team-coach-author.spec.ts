// FR-1197 (LS-1197 B1, the whole class): the count rule asks each message's author, not only the thread's client.
// A team coach S (role coach, coach_id = the head H) writes in H's threads. Once H and S are in a block either way,
// no count or preview H reads may include S's words, and the newest message H may read becomes the preview. Live, on
// the replayed migration chain (test/ls-1197-live-fixture.ts), with the real readers. A message whose author is gone
// (sender_id SetNull) stays, as on the thread page (MessagingService.filterBlockedAuthors).
import { randomUUID } from 'crypto';
import { CoachBriefService } from '../src/coach/brief/coach-brief.service';
import { CommandCenterService } from '../src/coach/command-center/command-center.service';
import { loadHomeDay } from '../src/coach/command-center/coach-home-day';
import { CoachHomeService } from '../src/coach/home/coach-home.service';
import { DigestService } from '../src/notifications/digest.service';
import { V1CoachService } from '../src/v1/v1-coach.service';
import { ls1197Database } from './ls-1197-live-fixture';

type Direction = 'the head blocks the team coach' | 'the team coach blocks the head';
type Value = number | string | null;

describe('FR-1197: a team coach in a block with the viewer adds no words and no count', () => {
  let fixture: Awaited<ReturnType<typeof ls1197Database>>;
  const id = Object.fromEntries(
    (['H', 'S', 'K', 'K2', 'H2', 'K3'] as const).map((k) => [k, randomUUID()]),
  );
  const SINCE = new Date(0);
  const UNTIL = new Date('2100-01-01T00:00:00Z');
  // Today, in a zone where it is not near midnight, so the messages stay "today" for the whole run.
  const homeZone = () =>
    new Date().getUTCHours() >= 1 && new Date().getUTCHours() <= 22 ? 'UTC' : 'Asia/Tokyo';
  const of = (proto: object) => Object.assign(Object.create(proto), { prisma: fixture.db });

  beforeAll(async () => {
    fixture = await ls1197Database();
    const users: Array<[string, string, string | null]> = [
      ['H', 'coach', null],
      ['S', 'coach', 'H'],
      ['K', 'student', 'H'],
      ['K2', 'student', 'H'],
      ['H2', 'coach', null],
      ['K3', 'student', 'H2'],
    ];
    for (const [k, role, coach] of users) {
      await fixture.prisma.user.create({
        data: {
          id: id[k],
          supabase_id: randomUUID(),
          email: randomUUID(),
          name: `Fixture ${k}`,
          role: role as 'coach' | 'student',
          coach_id: coach ? id[coach] : null,
        },
      });
    }
    const at = Date.now() - 3000;
    const rows: Array<[string, string, string, string | null, string, number]> = [
      // K's thread: K writes, then S answers (S's words are the newest).
      ['H', 'K', 'K', 'K', 'client words', 0],
      ['H', 'K', 'S', 'S', 'team words in K', 1000],
      // K2's thread: only S has written.
      ['H', 'K2', 'S', 'S', 'team words in K2', 1000],
      // H2's thread with K3: the author is gone (sender_id SetNull).
      ['H2', 'K3', '', null, 'words with no author', 0],
    ];
    for (const [coach, client, , sender, body, dt] of rows) {
      await fixture.prisma.coachMessage.create({
        data: {
          coach_id: id[coach],
          client_id: id[client],
          sender_id: sender ? id[sender] : null,
          body,
          created_at: new Date(at + dt),
        },
      });
    }
  }, 240_000);
  afterAll(async () => {
    await fixture?.stop();
  });

  const inbox = () => of(CommandCenterService.prototype).getInbox(id.H, {});
  const v1 = () => of(V1CoachService.prototype).listThreads({ id: id.H, role: 'coach' });
  const previewOf = (
    threads: Array<{
      client_id?: string;
      clientId?: string;
      last_message_preview?: string;
      lastMessage?: string;
    }>,
    k: string,
  ) => {
    const t = threads.find((r) => (r.client_id ?? r.clientId) === id[k]);
    return t ? (t.last_message_preview ?? t.lastMessage ?? null) : null;
  };

  // [surface, reader, read, value before the block, value under it]. Undoing the block restores the first value.
  const READS: Array<[string, string, () => Promise<Value>, Value, Value]> = [
    [
      'Command Center inbox preview',
      'CommandCenterService.getInbox',
      async () => previewOf((await inbox()).threads, 'K'),
      'team words in K',
      'client words',
    ],
    [
      'Command Center inbox rows',
      'CommandCenterService.getInbox',
      async () => (await inbox()).threads.length,
      2,
      1,
    ],
    [
      'Home conversations to review',
      'CoachHomeService.countReview',
      async () =>
        (await of(CoachHomeService.prototype).countReview(id.H, SINCE, UNTIL)).totalConversations,
      2,
      1,
    ],
    [
      'coach digest unread',
      'DigestService._buildCoachDigestData',
      async () =>
        (await of(DigestService.prototype)._buildCoachDigestData(id.H, 'daily')).rosterStats
          .unreadMessages,
      3,
      1,
    ],
    [
      'Home Replies ring, answered',
      'contactRings (through loadHomeDay)',
      async () => {
        const scope = {
          coachId: id.H,
          ownerCoachId: id.H,
          clientIds: [id.K, id.K2],
          habits: [],
          workouts: [],
          weighIns: [],
          needsYou: [],
        };
        return (await loadHomeDay(fixture.db, scope, homeZone(), new Date())).rings.replies
          .answered;
      },
      1,
      0,
    ],
    [
      'Coach Brief unread threads',
      'CoachBriefService.aggregateSoloContext',
      async () =>
        (
          await of(CoachBriefService.prototype).aggregateSoloContext(
            id.H,
            [id.K, id.K2],
            'UTC',
            '2026-10-30',
          )
        ).unreadThreads.length,
      2,
      1,
    ],
    [
      'Coach Brief stored previews',
      'CoachBriefService.ownThreadPreviews',
      async () => {
        const items = [
          { type: 'message_unread', client_id: id.K, detail: 'client words' },
          { type: 'message_unread', client_id: id.K2, detail: 'team words in K2' },
        ];
        const keep = await of(CoachBriefService.prototype).ownThreadPreviews(id.H, [
          { brief_mode: 'solo_coach', action_items: items },
        ]);
        return (keep(items) as unknown[]).length;
      },
      2,
      1,
    ],
    [
      'v1 console chat list preview',
      'V1CoachService.listThreads',
      async () => previewOf(await v1(), 'K'),
      'team words in K',
      'client words',
    ],
    [
      'v1 console chat list rows',
      'V1CoachService.listThreads',
      async () => (await v1()).length,
      2,
      1,
    ],
  ];
  const DIRECTIONS: Direction[] = [
    'the head blocks the team coach',
    'the team coach blocks the head',
  ];

  for (const [surface, reader, read, before, under] of READS) {
    for (const direction of DIRECTIONS) {
      it(`${surface} (${reader}): ${direction}; unblock restores`, async () => {
        expect(await read()).toEqual(before);
        const pair =
          direction === 'the head blocks the team coach'
            ? { blocker_id: id.H, blocked_id: id.S }
            : { blocker_id: id.S, blocked_id: id.H };
        await fixture.prisma.userBlock.create({ data: pair });
        try {
          expect(await read()).toEqual(under);
        } finally {
          await fixture.prisma.userBlock.deleteMany({ where: pair });
        }
        expect(await read()).toEqual(before);
      });
    }
  }

  it('a message whose author is gone (sender_id SetNull) is still the preview, as on the thread page', async () => {
    const threads = (await of(CommandCenterService.prototype).getInbox(id.H2, {})).threads;
    expect(previewOf(threads, 'K3')).toBe('words with no author');
    expect(
      previewOf(await of(V1CoachService.prototype).listThreads({ id: id.H2, role: 'coach' }), 'K3'),
    ).toBe('words with no author');
  });
});
