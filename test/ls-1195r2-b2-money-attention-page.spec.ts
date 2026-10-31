import { CoachMoneyService } from '../src/coach-money/coach-money.service';
import type { PrismaService } from '../src/prisma.service';
import { FakePrisma } from './support/dunning-v2-fake-prisma';

describe('LS-1195R2 B2: hidden held rows do not consume the Money attention page', () => {
  it.each([0, 49, 50, 101])(
    'still returns an ordinary card failure behind %i newer held renewals',
    async (heldCount) => {
      const db = new FakePrisma();
      const coachId = 'review-coach';
      const failedAt = new Date('2026-10-30T08:00:00.000Z');
      for (let i = 0; i <= heldCount; i++) {
        const held = i < heldCount;
        const id = held ? `held-${i}` : 'ordinary-card-failure';
        const clientId = `buyer-${i}`;
        db.seed('user', { id: clientId, coach_id: coachId });
        db.seed('clientPurchase', {
          id,
          coach_user_id: coachId,
          client_user_id: clientId,
          source: null,
          status: 'past_due',
          amount_cents: 2500,
          currency: 'usd',
          updated_at: held
            ? new Date(failedAt.getTime() + (i + 1) * 60_000)
            : failedAt,
          last_error: held ? 'account_restricted' : 'card_declined',
          client: { id: clientId, name: `Buyer ${i}` },
          package: { name: 'Monthly plan' },
        });
        db.seed('dunningState', {
          id: `dunning-${i}`,
          purchase_id: id,
          status: 'active',
          locked_out_at: null,
          last_failed_amount_cents: 2500,
          last_failure_at: failedAt,
          last_failure_reason: held
            ? 'coach_account_not_ready'
            : 'card_declined',
          attempts: [],
        });
      }

      const service = new CoachMoneyService(db.client() as PrismaService);
      const attention = await service.getAttention(coachId);

      expect(attention.items.map((item) => item.id)).toEqual([
        'failed:ordinary-card-failure',
      ]);
      expect(attention.count).toBe(1);
      expect(attention.items[0]?.failed_payment?.last_failure_reason).toBe(
        'card_declined',
      );
    },
  );
});
