import { scanSenders } from './utils/notify-sender-scan';
import { FIXTURE_REL, installFixture, REPO } from './utils/ls-1186-probe-fixture';

installFixture(`
import type { NotificationsService } from './notifications/notifications.service';
import { NotificationKind } from './notifications/notification-kind';
export function newSender(notices: NotificationsService) {
  return notices.sendPush({ user_id: 'ls1186-recipient', kind: NotificationKind.MESSAGE_RECEIVED, body: '' });
}
export function rawHttpSender() {
  const endpoint = 'https://exp.host/--/api/v2/push/send';
  const post = fetch;
  return post(endpoint, { method: 'POST', body: '{}' });
}
import { Expo as AliasedExpoClient } from 'expo-server-sdk';
export function rawSdkSender() {
  const client = new AliasedExpoClient();
  const send = client.sendPushNotificationsAsync.bind(client);
  return send([]);
}
`);

// The unchanged registry must be red, with the new sender and direct transport named.
require('../src/notifications/__tests__/sender-registry.spec');

it('LS-1186 positive scanner controls include file, function and line', () => {
  const hits = scanSenders(REPO).filter((h) => h.file === FIXTURE_REL);
  expect(hits).toEqual(expect.arrayContaining([
    expect.objectContaining({ file: FIXTURE_REL, fn: 'newSender', via: 'sendPush', line: 5 }),
    expect.objectContaining({ file: FIXTURE_REL, fn: 'rawHttpSender', via: 'transport', line: 8 }),
    expect.objectContaining({ file: FIXTURE_REL, fn: '<module>', via: 'transport' }),
  ]));
});
