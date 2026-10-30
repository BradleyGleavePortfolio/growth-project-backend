/**
 * LS-1186R2 B2: registry compatibility with current main's STORE-B2.
 * Production reference: main 8d63e481d674609f052aa4f24eec4869df94be0a,
 * src/checkout/plan-renewal/plan-renewal.service.ts:144-154.
 * The full clean main integration is independently exercised in run 40994821783.
 */
import { funnelArgFindings } from './utils/notify-sender-checks';
import { SENDERS } from './utils/notify-sender-registry';
import { scanText } from './utils/notify-sender-scan';

const file = 'src/checkout/plan-renewal/plan-renewal.service.ts';
const actualMainSendShape = `
import { NotificationKind } from '../../notifications/notification-kind';
import { RENEWAL_OFFER } from '../../notifications/push/push-preferences';
export class PlanRenewalService {
  private async advance(row, step, tx) {
    await this.notifications.sendPush({
      user_id: row.client_user_id,
      kind: NotificationKind.PLAN_RENEWAL,
      body: 'Your plan has ended.',
      deep_link: 'tgp://home',
      dedupe_key: \`plan_renewal:\${row.id}:\${step}\`,
      ...(step > 0 ? { context: RENEWAL_OFFER } : {}),
    }, tx);
  }
}`;

describe('LS-1186R2 B2: the registry must accept and model the actual main renewal sender', () => {
  it('B2 current-main Day 1/7 context must not make the architecture check red', () => {
    expect(funnelArgFindings(scanText(file, actualMainSendShape))).toEqual([]);
  });

  it('B2 an offer entry must carry the actual context and obey Mute all, rather than reuse Day 0', () => {
    const renewal = SENDERS.find((r) => r.file === file && r.fn === 'PlanRenewalService.advance');
    const offers = renewal?.funnel?.filter((e) =>
      Object.getOwnPropertyDescriptor(e.context ?? {}, 'renewalOffer')?.value === true,
    );
    expect(offers).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'plan_renewal', context: { renewalOffer: true }, muteAll: 'stops' }),
    ]));
  });
});
