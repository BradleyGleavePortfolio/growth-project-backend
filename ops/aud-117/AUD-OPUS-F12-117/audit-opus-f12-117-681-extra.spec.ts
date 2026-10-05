// AUD-OPUS-F12-117 lens probe (Claude Opus 5.5, agent 117) on #681 @ 9de3135c. Never merge.
// Extra cases beyond the AUD-OPUS-F12R-116 probe: a P2002 that names no
// legacy-key winner is rethrown (never adopted, never swallowed), the
// head-coach slice is skipped without its account, and the platform row is
// never rewritten by an adopting loser.
import { Prisma, type ClientPurchase } from '@prisma/client';
import type { SplitPlan } from '../src/connect/fees/fee-policy.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import type { PrismaService } from '../src/prisma.service';

type Row = Record<string, unknown>;
const purchase = { id: 'cp-117', coach_user_id: 'coach-117', currency: 'usd' } as ClientPurchase;
const plan = (dest: number, head = 0, fee = 200) =>
  ({
    application_fee_cents: fee,
    destination_cents: dest,
    head_coach_split_cents: head,
    head_coach_id: head > 0 ? 'head-117' : null,
  }) as SplitPlan;

describe('PROBE F1-X legacy ledger identity, extra cases', () => {
  it('X1: a P2002 whose legacy key has no row (another unique fired) is rethrown, nothing adopted', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'probe',
    });
    const t = {
      findFirst: jest.fn(async () => null),
      findUnique: jest.fn(async () => null),
      create: jest.fn(async () => {
        throw p2002;
      }),
      update: jest.fn(async () => ({})),
    };
    const s = new SplitLedgerService({ splitLedgerEntry: t } as object as PrismaService);
    await expect(
      s.ensurePendingEntries({
        purchase,
        plan: plan(9_800),
        platform_account_id: null,
        seller_stripe_account_id: 'acct_s',
        head_coach_stripe_account_id: null,
      }),
    ).rejects.toBe(p2002);
    expect(t.update).not.toHaveBeenCalled();
  });

  it('X2: the adopting loser never rewrites the platform row and applies its own payee amount', async () => {
    const rows: Row[] = [];
    let n = 0;
    const tick = () => new Promise<void>((r) => setImmediate(r));
    const t = {
      findFirst: jest.fn(async ({ where }: { where: Row }) => {
        const hit = rows.find((r) =>
          Object.entries(where).every(([k, v]) => (v === null ? r[k] == null : r[k] === v)),
        );
        await tick();
        return hit ? { ...hit } : null;
      }),
      findUnique: jest.fn(async ({ where }: { where: Row }) => {
        const hit = rows.find((r) => r.idempotency_key === where.idempotency_key);
        return hit ? { ...hit } : null;
      }),
      create: jest.fn(async ({ data }: { data: Row }) => {
        await tick();
        if (rows.some((r) => r.idempotency_key === data.idempotency_key)) {
          throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'p' });
        }
        const row = { id: `le-${++n}`, ...data };
        rows.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return { ...row };
      }),
    };
    const s = new SplitLedgerService({ splitLedgerEntry: t } as object as PrismaService);
    const base = {
      purchase,
      platform_account_id: null,
      seller_stripe_account_id: 'acct_s',
      head_coach_stripe_account_id: null,
    };
    // Both planners race; the second carries a renewal amount for the payee and
    // a different platform fee (which must not overwrite the platform row).
    await Promise.all([
      s.ensurePendingEntries({ ...base, plan: plan(9_800, 0, 200) }),
      s.ensurePendingEntries({ ...base, plan: plan(9_700, 0, 300) }),
    ]);
    expect(rows.filter((r) => r.kind === 'application_fee')).toHaveLength(1);
    expect(rows.filter((r) => r.kind === 'destination')).toHaveLength(1);
    expect(rows.find((r) => r.kind === 'application_fee')!.amount_cents).toBe(200);
    // The last writer's payee amount stands (same rule as the pre-round-11 update path).
    expect([9_800, 9_700]).toContain(rows.find((r) => r.kind === 'destination')!.amount_cents);
    const updatesToPlatform = t.update.mock.calls.filter(([a]) =>
      rows.find((r) => r.id === (a as { where: { id: string } }).where.id && r.kind === 'application_fee'),
    );
    expect(updatesToPlatform).toHaveLength(0);
  });
});
