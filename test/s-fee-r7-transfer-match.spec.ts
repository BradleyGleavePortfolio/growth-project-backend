// S-FEE round 7 (B-627-8) — which Stripe transfer is a ConnectTransfer row's
// create. Tagged transfers (metadata.tgp_transfer_op) match only their own
// operation key; transfers created before round 7 carry no key and match on
// everything the old create sent. No live Stripe or DB.
import type { ConnectTransfer } from '@prisma/client';
import { isTransferOf } from '../src/connect/fees/transfer-orchestrator.service';

describe('B-627-8 transfer matching for the reconciliation lookup', () => {
  it('pre-round-7 head-coach rows: an untagged legacy transfer is matched on what the old create sent', () => {
    const row = {
      idempotency_key: 'tgp-tr-p1-headcoach',
      purchase_id: 'p1',
      kind: 'head_coach_split',
      amount_cents: 500,
      source_stripe_charge_id: 'ch_abc',
    } as ConnectTransfer;
    const legacy = {
      amount: 500,
      source_transaction: 'ch_abc',
      metadata: { tgp_purchase_id: 'p1', tgp_kind: 'head_coach_split' },
    };
    expect(isTransferOf(legacy, row)).toBe(true);
    expect(isTransferOf({ ...legacy, amount: 499 }, row)).toBe(false);
    expect(isTransferOf({ ...legacy, source_transaction: 'ch_other' }, row)).toBe(false);
    // A tagged transfer only ever matches its own operation key.
    expect(
      isTransferOf({ ...legacy, metadata: { ...legacy.metadata, tgp_transfer_op: 'other' } }, row),
    ).toBe(false);
    expect(
      isTransferOf(
        { ...legacy, metadata: { ...legacy.metadata, tgp_transfer_op: row.idempotency_key } },
        row,
      ),
    ).toBe(true);
  });
});
