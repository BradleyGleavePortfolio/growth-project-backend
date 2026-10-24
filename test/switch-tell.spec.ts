// SWITCH-TELL-BE (agent 167) — owner 10-21 16:5x "#SWITCH-TELL - b - both":
// when a client moves to TGP's house coach, the coach they left gets one
// notification ("{Client} has moved to another coach.") and a quiet line in
// Money ("Moved to another coach · {date}"); the new coach is never named.
// The live walk (the move writes it once, the inbox shows it, Money dates the
// charge) is in test/rls/house-join-rls.spec.ts; this spec pins the pieces.
import type { Prisma } from '@prisma/client';
import {
  movedAwayDates,
  switchTellBody,
  tellFormerCoachTx,
} from '../src/checkout/plan-renewal/switch-tell';
import { NotificationKind } from '../src/notifications/notification-kind';
import type { PrismaService } from '../src/prisma.service';
import { stub } from './utils/trial-fakes';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const FORMER = '22222222-2222-4222-8222-222222222222';

describe('SWITCH-TELL-BE — the former coach is told, the new coach is never named', () => {
  it('the body names only the client, within 160 characters', () => {
    expect(switchTellBody('  Ann Client ')).toBe('Ann Client has moved to another coach.');
    expect(switchTellBody('')).toBe('A client has moved to another coach.');
    expect(switchTellBody(null)).toBe('A client has moved to another coach.');
    expect(switchTellBody('x'.repeat(400)).length).toBeLessThanOrEqual(160);
  });

  it('writes one in-app row for the former coach: no link, payload only the client id', async () => {
    // FR-1154 (owner #171-3): Mute all never stops an in-app row: muted or not, the same visible row.
    for (const stored of [null, { muted: false }, { muted: true }]) {
      const create = jest.fn(async (_args: unknown) => ({}));
      const tx = stub<Prisma.TransactionClient>({
        user: { findUnique: jest.fn(async () => ({ name: 'Ann Client' })) },
        notificationPreferences: { findUnique: jest.fn(async () => stored) },
        notification: { create },
      });
      await tellFormerCoachTx(tx, CLIENT, FORMER);
      expect(create.mock.calls).toEqual([
        [
          {
            data: {
              user_id: FORMER,
              kind: NotificationKind.COACH_CLIENT_MOVED,
              channel: 'inapp',
              deep_link: null,
              body: 'Ann Client has moved to another coach.',
              payload: { client_id: CLIENT },
            },
          },
        ],
      ]);
    }
  });

  it("Money's date is the latest move notification per client, read from the coach's own rows", async () => {
    const findMany = jest.fn(async (_args: unknown) => [
      { payload: { client_id: CLIENT }, created_at: new Date('2026-10-21T10:00:00Z') },
      { payload: { client_id: CLIENT }, created_at: new Date('2026-09-01T10:00:00Z') },
      { payload: null, created_at: new Date('2026-08-01T10:00:00Z') },
    ]);
    const prisma = stub<PrismaService>({ notification: { findMany } });
    const dates = await movedAwayDates(prisma, FORMER, [CLIENT, OTHER, CLIENT]);
    expect([...dates]).toEqual([[CLIENT, new Date('2026-10-21T10:00:00Z')]]);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        user_id: FORMER,
        kind: NotificationKind.COACH_CLIENT_MOVED,
        OR: [
          { payload: { path: ['client_id'], equals: CLIENT } },
          { payload: { path: ['client_id'], equals: OTHER } },
        ],
      },
      orderBy: { created_at: 'desc' },
      select: { payload: true, created_at: true },
    });
    // No moved client: no read at all.
    findMany.mockClear();
    expect((await movedAwayDates(prisma, FORMER, [])).size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});
