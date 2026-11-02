/**
 * LO-1186R2 B2 (b#1186 review round 2): b#1184 (STORE-B2, on main at 8d63e481) made PlanRenewalService.advance pass
 * `...(step > 0 ? { context: RENEWAL_OFFER } : {})` (src/checkout/plan-renewal/plan-renewal.service.ts:154 on main).
 * A renewal offer (Day 1, Day 7) needs the person's yes in the app and Mute all STOPS it, although plan_renewal is a
 * money kind (push-preferences.ts pushAllowedByPreferences / muteAllStops on main).
 *
 * The registry row still says "money kind, Mute all passes" with one plain funnel entry, and funnelArgFindings
 * (notify-sender-checks.ts:114-118) reads any context it cannot read as "can pass Mute all": it asks for an entry
 * that passes Mute all, which is the opposite of what the offer does. So b#1186 merged with main is red, and the
 * only edit that turns it green (declare a Mute all pass) would make the funnel table assert the wrong rule.
 *
 * The fixture below is the main sendPush call, as written there. Red today; green when the row declares the offer
 * (Mute all stops it, consent needed) and the check reads RENEWAL_OFFER as a context that does not pass Mute all.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { funnelArgFindings } from './utils/notify-sender-checks';
import { SENDERS } from './utils/notify-sender-registry';
import { scanSenders } from './utils/notify-sender-scan';

const FILE = 'src/checkout/plan-renewal/plan-renewal.service.ts';
const MAIN_CALL = `import { NotificationsService } from '../../notifications/notifications.service';
import { NotificationKind } from '../../notifications/notification-kind';
import { RENEWAL_OFFER } from '../../notifications/push/push-preferences';
export class PlanRenewalService {
  constructor(private readonly notifications: NotificationsService) {}
  async advance(row: { id: string; client_user_id: string }, step: number, tx: unknown) {
    await this.notifications.sendPush(
      {
        user_id: row.client_user_id,
        kind: NotificationKind.PLAN_RENEWAL,
        body: 'Your plan has ended.',
        deep_link: 'tgp://home',
        dedupe_key: \`plan_renewal:\${row.id}:\${step}\`,
        ...(step > 0 ? { context: RENEWAL_OFFER } : {}),
      },
      tx,
    );
  }
}
`;

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

describe('LO-1186R2 B2: the plan renewal offer on main (b#1184)', () => {
  it('LO-1186R2 B2 the registry reads the main PlanRenewalService.advance call with no finding', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lo1186r2-b2-'));
    roots.push(root);
    fs.mkdirSync(path.dirname(path.join(root, FILE)), { recursive: true });
    fs.writeFileSync(path.join(root, FILE), MAIN_CALL);
    expect(funnelArgFindings(scanSenders(root))).toEqual([]);
  });

  it('LO-1186R2 B2 the row declares a renewal offer that Mute all stops', () => {
    const row = SENDERS.find((r) => r.fn === 'PlanRenewalService.advance');
    const offer = (row?.funnel ?? []).find((e) => (e.context as { renewalOffer?: unknown } | null | undefined)?.renewalOffer === true);
    expect({ offer: !!offer, muteAll: offer?.muteAll }).toEqual({ offer: true, muteAll: 'stops' });
  });
});
