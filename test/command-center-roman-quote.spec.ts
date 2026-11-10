// test/command-center-roman-quote.spec.ts
//
// ROMAN-QUOTE-READERS-BE case 10, the coach card (LO-950R3 C2): closed on the phone at growth-project-mobile#950
// cd791b8c4532bfd017ecdd3980534b658f7b3365 (src/services/commandCenterApi.ts:126-129, which draws the client's words
// of a quoted turn). The server's `quote` stays the stored turn exactly as sent, quote line included, whether the
// quote is proven, hand-typed, or the client's own words open with the shape; a crisis alert still carries none.
// Neutral words only. No network, no DB.

import { CommandCenterService } from '../src/coach/command-center/command-center.service';
import type { CoachAlertsService } from '../src/coach/coach-alerts.service';
import type { AdminPtmService } from '../src/admin/ptm/admin-ptm.service';
import type { PrismaService } from '../src/prisma.service';
import { fakeOf } from './ai-egress/ai-egress.fakes';
import { NEUTRAL_BODY, NEUTRAL_REPLY, withRomanQuote } from './roman/roman-quote-safety.harness';

const SENT = new Date('2026-11-09T09:41:00Z');
const PROVEN = withRomanQuote(NEUTRAL_REPLY, NEUTRAL_BODY);
const HAND_TYPED = '> my own first line\n\nand the rest of what I wrote.';
const OPENS_WITH_SHAPE = withRomanQuote(NEUTRAL_REPLY, '> my own line\n\nand more.');

function queue() {
  const alert = (id: string, alert_type: string, message_id: string, h: number) => ({
    id,
    coach_id: 'coach-1',
    client_id: 'client-1',
    alert_type,
    message: 'Roman sent a safety reply.',
    payload: { roman_message_id: message_id },
    created_at: new Date(Date.UTC(2026, 10, 9, h)),
    acknowledged_at: null,
    client: { name: 'Jane Doe' },
  });
  const alerts = [
    alert('a-proven', 'roman_urgent_reply', 'm1', 12),
    alert('a-hand', 'roman_eating_disorder_reply', 'm2', 11),
    alert('a-shape', 'roman_urgent_reply', 'm3', 10),
    alert('a-crisis', 'roman_crisis_reply', 'm1', 9),
  ];
  const messages = [
    { id: 'm1', user_id: 'client-1', content: PROVEN, created_at: SENT },
    { id: 'm2', user_id: 'client-1', content: HAND_TYPED, created_at: SENT },
    { id: 'm3', user_id: 'client-1', content: OPENS_WITH_SHAPE, created_at: SENT },
  ];
  const prisma = {
    user: { findMany: jest.fn(async () => [{ id: 'client-1' }]) },
    coachAlert: { findMany: jest.fn(async (_a: unknown) => alerts), count: jest.fn(async () => alerts.length) },
    romanMessage: { findMany: jest.fn(async (_a: unknown) => messages) },
    communityCohort: { findMany: jest.fn(async () => []) },
  };
  const svc = new CommandCenterService(fakeOf<PrismaService>(prisma), fakeOf<AdminPtmService>({}), fakeOf<CoachAlertsService>({}));
  return { svc, prisma };
}

describe('ROMAN-QUOTE-READERS-BE case 10: the coach card\'s quote is the stored turn unchanged', () => {
  it('a proven quote, a hand-typed shape and a body that opens with the shape all reach the card as sent; a crisis alert has none', async () => {
    const { svc, prisma } = queue();
    const out = await svc.getActionQueue('coach-1', {});
    const quoteOf = (id: string) => out.items.find((i) => i.alert_id === id)?.quote;
    expect(quoteOf('a-proven')).toBe(PROVEN);
    expect(quoteOf('a-hand')).toBe(HAND_TYPED);
    expect(quoteOf('a-shape')).toBe(OPENS_WITH_SHAPE);
    expect(quoteOf('a-crisis')).toBeNull();
    // One read of the named turns; no Roman-row read for a proof.
    expect(prisma.romanMessage.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.romanMessage.findMany.mock.calls[0][0]).toMatchObject({ where: { role: 'user' } });
  });
});
