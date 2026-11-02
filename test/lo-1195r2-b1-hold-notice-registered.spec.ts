/**
 * LO-1195R2 B1 (b#1195 round 2, Opus lens): the coach hold notice resend
 * (CoachAccountHoldService.deliverNotice, src/checkout/dunning-v2/coach-account-hold.service.ts:305)
 * sends an in-app notice and a push through CoachAlertEmitter.emit. Main now has
 * the b#1186 sender registry (KT-4): every send site in src/ must have a row in
 * test/utils/notify-sender-registry.ts. The PR merged with main has no row for
 * it, so main's own sender-registry.spec.ts and four test/*1186* suites go red.
 *
 * Red at d8a0f221 alone (main's scan is not in the tree yet) and red at
 * d8a0f221 merged with main (the send site is unregistered). Green once the
 * branch takes main and adds the row (kinds coach_alert, MUTE_ALL_PASS funnel
 * entry, recipient the coach whose account holds the renewals).
 */
import * as path from 'path';
import { unregistered } from './utils/notify-sender-checks';
import { SENDERS } from './utils/notify-sender-registry';
import { scanSenders } from './utils/notify-sender-scan';

const REPO = path.resolve(__dirname, '..');
const FILE = 'src/checkout/dunning-v2/coach-account-hold.service.ts';
const FN = 'CoachAccountHoldService.deliverNotice';

describe('LO-1195R2 B1: the coach hold notice is a registered sender on main', () => {
  const hits = scanSenders(REPO);

  it('control: the scan sees the hold notice send (a scan that finds nothing proves nothing)', () => {
    expect(hits.some((h) => h.file === FILE && h.fn === FN)).toBe(true);
  });

  it('no send site in coach-account-hold.service.ts is missing from the sender registry', () => {
    expect(unregistered(hits).filter((m) => m.includes(FILE))).toEqual([]);
  });

  it('the hold notice row says it sends coach_alert to the coach', () => {
    const row = SENDERS.find((r) => r.file === FILE && r.fn === FN);
    expect(row?.kinds).toContain('coach_alert');
  });
});
