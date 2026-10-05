/**
 * AUD-OPUS-H7-120 probe (Claude Opus 5.5 lens, agent 120): mobile #369 @ 3252ec79.
 * A Connect whose local grant write fails on the new SecureStore authority
 * (registration already succeeded) and the copy the sheet shows for it.
 * Cases prefixed "DOCUMENTS" assert the CURRENT behaviour behind a C finding.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

const mockReportUnexpected = jest.fn();
jest.mock('../../../../lib/consultation/report', () => ({
  reportUnexpected: (...args: unknown[]) => mockReportUnexpected(...args),
}));

import { connectFailureMessage } from '../onDeviceCopy';
import { connectOnDevice, OnDeviceStepError } from '../../../../services/health/onDeviceSync';
import { getLocalAuthorization } from '../../../../services/health/onDeviceState';
import { createSessionFence } from '../../../../services/health/sessionFence';
import type { WearableConnection } from '../../../../api/wearablesConnectionsApi';

const userId = 'opus-h7-copy-user';
const row = {
  id: 'opus-h7-copy-connection',
  user_id: userId,
  provider: 'HEALTH_CONNECT',
  external_account_id: 'on-device',
  access_token_expires_at: null,
  scopes: [],
  webhook_subscription_id: null,
  channel_expires_at: null,
  status: 'connected',
  last_error: null,
  last_synced_at: null,
  backfilled_until: null,
  disconnected_at: null,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
} as WearableConnection;

beforeEach(async () => {
  await AsyncStorage.clear();
  (SecureStore as unknown as { __store: Map<string, string> }).__store.clear();
  mockReportUnexpected.mockClear();
});

it('DOCUMENTS C-369-5: an authority write failure after registration surfaces as a raw error and the copy says the source is connected', async () => {
  jest.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('synthetic keystore failure'));
  const fence = createSessionFence(userId, async () => userId);
  let syncCalls = 0;
  const err = await connectOnDevice('HEALTH_CONNECT', fence, {
    register: async () => row,
    readUserId: async () => userId,
    syncHealthConnect: async () => {
      syncCalls += 1;
      return { normalizedCount: 0, complete: true };
    },
  }).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(OnDeviceStepError); // not classified as a step
  expect(syncCalls).toBe(0); // nothing read: fail closed
  expect(await getLocalAuthorization(userId, 'HEALTH_CONNECT')).toBeNull();
  const message = connectFailureMessage(err, 'Health Connect');
  expect(message?.text).toMatch(/^Health Connect is connected, but your history didn't finish coming in/);
  expect(message?.action).toBe('resume');
});
