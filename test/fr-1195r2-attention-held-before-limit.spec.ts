/**
 * FR-1195R2 F2 (LS-1195R2 B2): getAttention leaves the coach's held renewals
 * out in its query, before the 50-row limit, so an older ordinary failed card
 * still shows and a held renewal never shows there. A bigger limit alone is
 * not the fix: these cases put 51 newer held rows in front of the card.
 */
import { CoachMoneyService } from '../src/coach-money/coach-money.service';
import type { PrismaService } from '../src/prisma.service';
import { FakePrisma } from './support/dunning-v2-fake-prisma';

const COACH = 'coach-1';
const AT = new Date('2026-10-30T08:00:00.000Z');

function purchase(db: FakePrisma, id: string, minutes: number): void {
  const clientId = `client-${id}`;
  db.seed('user', { id: clientId, coach_id: COACH });
  db.seed('clientPurchase', {
    id,
    coach_user_id: COACH,
    client_user_id: clientId,
    source: null,
    status: 'past_due',
    amount_cents: 2500,
    currency: 'usd',
    updated_at: new Date(AT.getTime() + minutes * 60_000),
    last_error: 'card_declined',
    client: { id: clientId, name: `Client ${id}` },
    package: { name: 'Monthly plan' },
  });
}

function dunning(db: FakePrisma, purchaseId: string, status: string, reason: string | null): void {
  db.seed('dunningState', {
    id: `dunning-${purchaseId}`,
    purchase_id: purchaseId,
    status,
    locked_out_at: null,
    last_failed_amount_cents: 2500,
    last_failure_at: AT,
    last_failure_reason: reason,
    attempts: [],
  });
}

function worldWith51Held(): FakePrisma {
  const db = new FakePrisma();
  for (let i = 0; i < 51; i++) {
    purchase(db, `held-${i}`, 10 + i);
    dunning(db, `held-${i}`, 'active', 'coach_account_not_ready');
  }
  return db;
}

describe('FR-1195R2 F2: held renewals are left out before the attention limit', () => {
  it('51 newer held rows and one older failed card: the card shows, no held row does', async () => {
    const db = worldWith51Held();
    purchase(db, 'card', 0);
    dunning(db, 'card', 'active', 'card_declined');
    const out = await new CoachMoneyService(db.client() as PrismaService).getAttention(COACH);
    expect(out.items.map((i) => i.id)).toEqual(['failed:card']);
    expect(out.count).toBe(1);
  });

  it('a failed card with no dunning row, or one with no reason, is not taken for a held one', async () => {
    const db = worldWith51Held();
    purchase(db, 'no-dunning', 1);
    purchase(db, 'no-reason', 0);
    dunning(db, 'no-reason', 'active', null);
    const out = await new CoachMoneyService(db.client() as PrismaService).getAttention(COACH);
    expect(out.items.map((i) => i.id)).toEqual(['failed:no-dunning', 'failed:no-reason']);
  });

  it('a renewal whose hold has ended (dunning row no longer active) shows again', async () => {
    const db = worldWith51Held();
    purchase(db, 'was-held', 0);
    dunning(db, 'was-held', 'resolved', 'coach_account_not_ready');
    const out = await new CoachMoneyService(db.client() as PrismaService).getAttention(COACH);
    expect(out.items.map((i) => i.id)).toEqual(['failed:was-held']);
  });

  it('the filter is in the query the limit applies to', async () => {
    const db = worldWith51Held();
    const client = db.client();
    await new CoachMoneyService(client as PrismaService).getAttention(COACH);
    const args = client.clientPurchase.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      take: number;
    };
    expect(args.take).toBe(50);
    expect(args.where.NOT).toEqual({
      dunning: { status: 'active', last_failure_reason: 'coach_account_not_ready' },
    });
  });
});
