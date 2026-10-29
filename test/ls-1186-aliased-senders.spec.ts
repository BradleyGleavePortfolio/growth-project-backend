import type { NotificationsService } from '../src/notifications/notifications.service';
import type { PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import { scanSenders } from './utils/notify-sender-scan';
import { FIXTURE_REL, installFixture, REPO } from './utils/ls-1186-probe-fixture';

installFixture(`
import type { NotificationsService } from './notifications/notifications.service';
import type { PushDeliveryService } from './notifications/push/push-delivery.service';
import { NotificationKind } from './notifications/notification-kind';
export function aliasedSender(notices: Pick<NotificationsService, 'sendPush'>) {
  const deliver = notices.sendPush.bind(notices);
  return deliver({ user_id: 'ls1186-recipient', kind: NotificationKind.MESSAGE_RECEIVED, body: '' });
}
export function aliasedTransport(delivery: Pick<PushDeliveryService, 'enqueue'>) {
  return delivery.enqueue({
    userId: 'ls1186-recipient', kind: 'message_received', title: '', body: '',
    data: {}, collapseKey: 'ls1186', timeZone: 'America/New_York',
  });
}
`);

// At the reviewed head every unchanged registry case passes despite these new runtime send sites.
require('../src/notifications/__tests__/sender-registry.spec');

it('LS-1186 fixtures really invoke both send APIs without external network', async () => {
  const fixture: {
    aliasedSender: (n: Pick<NotificationsService, 'sendPush'>) => Promise<unknown>;
    aliasedTransport: (d: Pick<PushDeliveryService, 'enqueue'>) => Promise<unknown>;
  } = require(`${REPO}/${FIXTURE_REL}`);
  const sendPush = jest.fn(async () => null);
  const enqueue = jest.fn(async () => ({ code: 'queued' as const, notBefore: new Date() }));
  await fixture.aliasedSender({ sendPush });
  await fixture.aliasedTransport({ enqueue });
  expect(sendPush).toHaveBeenCalledTimes(1);
  expect(enqueue).toHaveBeenCalledTimes(1);
});

it('LS-1186 contract: both added send sites must be discovered', () => {
  const hits = scanSenders(REPO).filter((h) => h.file === FIXTURE_REL);
  expect(hits).toEqual(expect.arrayContaining([
    expect.objectContaining({ file: FIXTURE_REL, fn: 'aliasedSender', via: 'sendPush' }),
    expect.objectContaining({ file: FIXTURE_REL, fn: 'aliasedTransport', via: 'transport' }),
  ]));
});
