/**
 * AUD-SOL-W12-116: actual service, paged native-client wrapper, session fence,
 * and logger boundary. All health text is a synthetic audit marker.
 */
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { healthConnectEnabled: true } } },
}));
jest.mock('react-native-health-connect', () => ({
  readRecords: jest.fn(),
}));
jest.mock('../../../../lib/userCache', () => ({
  readUserCache: jest.fn(async () => ({ id: 'audit-user-a' })),
}));
jest.mock('../../../../utils/logger', () => ({
  logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import * as native from 'react-native-health-connect';
import { logger } from '../../../../utils/logger';
import {
  beginSessionFence,
  OnDeviceSessionChangedError,
  stopOnDeviceHealthWork,
  type SessionFence,
} from '../../sessionFence';
import { getSyncProgress, type OnDeviceScope } from '../../onDeviceState';
import { healthConnectClient } from '../healthConnectClient';
import { syncHealthConnect } from '../healthConnectSyncService';

const HEALTH_CANARY = 'AUDIT_360_PRIVATE_WEIGHT_81_6_KG';
const scope: OnDeviceScope = {
  userId: 'audit-user-a',
  connectionId: 'audit-connection-a',
  source: 'HEALTH_CONNECT',
};
const nativeRead = native.readRecords as jest.Mock;
const ingest = jest.fn().mockResolvedValue({ inserted: 0, skipped: 0 });
const client = {
  ...healthConnectClient,
  initialize: jest.fn().mockResolvedValue(true),
  getGrantedPermissions: jest.fn().mockResolvedValue([
    { accessType: 'read', recordType: 'Weight' },
  ]),
};

function loggedText(): string {
  return JSON.stringify([
    (logger.log as jest.Mock).mock.calls,
    (logger.warn as jest.Mock).mock.calls,
    (logger.error as jest.Mock).mock.calls,
  ]);
}

async function run() {
  const fence = (await beginSessionFence()) as SessionFence;
  expect(fence).not.toBeNull();
  return syncHealthConnect(scope, {
    client,
    fence,
    ingestApi: { ingest },
    now: () => new Date('2026-10-01T12:00:00.000Z'),
  });
}

beforeEach(async () => {
  jest.clearAllMocks();
  nativeRead.mockReset();
  await AsyncStorage.clear();
  Object.defineProperty(Platform, 'OS', {
    configurable: true,
    value: 'android',
  });
});

test('a native read error never forwards arbitrary health text to the logger', async () => {
  nativeRead.mockRejectedValueOnce(new Error(HEALTH_CANARY));
  const result = await run();
  expect(result.complete).toBe(false);
  expect(result.failedRecordTypes).toEqual(['Weight']);
  expect(nativeRead).toHaveBeenCalledTimes(1);
  expect(loggedText()).not.toContain(HEALTH_CANARY);
});

test('a native rejection after sign-out starts is silent, with no upload or progress', async () => {
  nativeRead.mockImplementationOnce(async () => {
    stopOnDeviceHealthWork();
    throw new Error(HEALTH_CANARY);
  });
  await expect(run()).rejects.toBeInstanceOf(OnDeviceSessionChangedError);
  expect(nativeRead).toHaveBeenCalledTimes(1);
  expect(ingest).not.toHaveBeenCalled();
  expect((await getSyncProgress(scope)).completedThrough).toEqual({});
  expect(logger.error).not.toHaveBeenCalled();
  expect(loggedText()).not.toContain(HEALTH_CANARY);
});

test('control: a successful empty native read completes with no health text logged', async () => {
  nativeRead.mockResolvedValueOnce({ records: [] });
  const result = await run();
  expect(nativeRead).toHaveBeenCalledTimes(1);
  expect(result.complete).toBe(true);
  expect(result.failedRecordTypes).toEqual([]);
  expect(logger.error).not.toHaveBeenCalled();
  expect(loggedText()).not.toContain(HEALTH_CANARY);
});
