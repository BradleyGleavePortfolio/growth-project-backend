import { Logger } from '@nestjs/common';
import type { ClientPurchase, SplitLedgerEntry } from '@prisma/client';
import { ChargeLock } from '../src/connect/fees/charge-lock';
import type { SplitPlan } from '../src/connect/fees/fee-policy.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import type { PrismaService } from '../src/prisma.service';

describe('AUD-SOL-F12-116 F1 independent boundaries', () => {
  afterEach(() => jest.restoreAllMocks());

  it('a failed charge-lock release never emits arbitrary DB error text', async () => {
    const canary = 'AUDIT_RELEASE_PERSONAL_CONTACT_MATERIAL';
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const delegates: object = {
      cronLease: {
        updateMany: jest.fn(async () => ({ count: 0 })),
        create: jest.fn(async () => ({})),
        deleteMany: jest.fn(async () => {
          throw new Error(canary);
        }),
      },
    };
    const lock = new ChargeLock(delegates as PrismaService);
    await expect(lock.run('ch_audit', async () => 'completed')).resolves.toBe('completed');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(canary);
  });

  it('two concurrent legacy planners cannot create two destination ledger rows', async () => {
    const rows: SplitLedgerEntry[] = [];
    let sequence = 0;
    const delegates: object = {
      splitLedgerEntry: {
        // Both callers observe absence before either continuation creates.
        // The migration's nullable stripe_charge_id admits both NULL rows.
        findFirst: jest.fn(async ({ where }: {
          where: { purchase_id: string; kind: string; payee_user_id: string | null };
        }) => rows.find((r) =>
          r.purchase_id === where.purchase_id && r.kind === where.kind &&
          r.payee_user_id === where.payee_user_id) ?? null),
        create: jest.fn(async ({ data }: { data: Partial<SplitLedgerEntry> }) => {
          const row = {
            id: `le_${++sequence}`,
            stripe_charge_id: null,
            created_at: new Date(),
            ...data,
          } as SplitLedgerEntry;
          rows.push(row);
          return row;
        }),
        update: jest.fn(async () => { throw new Error('unexpected update'); }),
      },
    };
    const ledger = new SplitLedgerService(delegates as PrismaService);
    const input = {
      purchase: { id: 'p_legacy', coach_user_id: 'coach', currency: 'usd' } as ClientPurchase,
      plan: {
        application_fee_cents: 200,
        destination_cents: 9_800,
        head_coach_split_cents: 0,
        head_coach_id: null,
      } as SplitPlan,
      platform_account_id: null,
      seller_stripe_account_id: 'acct_coach',
      head_coach_stripe_account_id: null,
    };
    await Promise.all([ledger.ensurePendingEntries(input), ledger.ensurePendingEntries(input)]);
    expect(rows.filter((r) => r.kind === 'destination')).toHaveLength(1);
  });
});
