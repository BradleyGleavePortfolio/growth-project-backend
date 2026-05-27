/**
 * test/expo-sdk-v6-smoke.spec.ts
 *
 * Regression guard for the expo-server-sdk v3 -> v6 upgrade.
 *
 * v6 is published as pure ESM. Loading it under Jest (ts-jest + CJS)
 * requires three coupled transforms configured in jest.config.js +
 * babel.config.js:
 *   1. transformIgnorePatterns allow-lists `expo-server-sdk` for babel-jest.
 *   2. babel-preset-env lowers ESM import/export to CJS.
 *   3. An inline babel plugin replaces `import.meta.url` and renames the
 *      SDK's local `createRequire`-bound `require` so it does not shadow
 *      the CJS `require` injected by preset-env (TDZ otherwise).
 *
 * If any of those slip, the SDK fails to import at all and the import
 * below throws. We therefore exercise every method we actually consume:
 * `isExpoPushToken`, `new Expo()`, `chunkPushNotifications`,
 * `chunkPushNotificationReceiptIds`, plus presence checks on the two
 * async network methods (we don't hit Expo's servers from CI).
 *
 * Keep this lightweight — it's a config canary, not an SDK conformance
 * suite. Real push delivery is covered by the integration tests in
 * coach-alerts-push-delivery.spec.ts via the mocked NotificationsService.
 */
import { Expo } from 'expo-server-sdk';

describe('expo-server-sdk v6 — module-load + API smoke', () => {
  it('class loads, instantiates, and exposes the v3/v6 API surface', () => {
    const expo = new Expo();
    expect(typeof expo.chunkPushNotifications).toBe('function');
    expect(typeof expo.sendPushNotificationsAsync).toBe('function');
    expect(typeof expo.chunkPushNotificationReceiptIds).toBe('function');
    expect(typeof expo.getPushNotificationReceiptsAsync).toBe('function');
  });

  it('isExpoPushToken accepts ExponentPushToken[..] and rejects garbage', () => {
    expect(Expo.isExpoPushToken('ExponentPushToken[abc]')).toBe(true);
    expect(Expo.isExpoPushToken('ExpoPushToken[def]')).toBe(true);
    expect(Expo.isExpoPushToken('not-a-token')).toBe(false);
    expect(Expo.isExpoPushToken(null as unknown as string)).toBe(false);
  });

  it('chunkPushNotifications returns chunks of the messages it was given', () => {
    const expo = new Expo();
    const chunks = expo.chunkPushNotifications([
      { to: 'ExponentPushToken[a]', title: 't', body: 'b' },
    ]);
    expect(Array.isArray(chunks)).toBe(true);
    expect(chunks[0]).toHaveLength(1);
  });

  it('chunkPushNotificationReceiptIds returns chunks of ids', () => {
    const expo = new Expo();
    const chunks = expo.chunkPushNotificationReceiptIds(['r1', 'r2']);
    expect(Array.isArray(chunks)).toBe(true);
    expect(chunks.flat()).toEqual(['r1', 'r2']);
  });
});
