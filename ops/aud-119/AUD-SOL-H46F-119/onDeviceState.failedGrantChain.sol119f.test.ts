/**
 * Independent C-362-13 residual: rollback must not restore another rejected
 * reservation as if it were a newer successful Connect. Synthetic disk only.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getLocalAuthorization,
  localAuthorizationSeq,
  recordLocalAuthorization,
  retireOnDeviceSource,
} from '../onDeviceState';

const old = { userId: 'failed-chain-user', source: 'HEALTH_CONNECT' as const, connectionId: 'old' };
const fresh = { ...old, connectionId: 'fresh' };
const D1 = new Date('2026-10-01T00:00:00.000Z');
const D2 = new Date('2026-10-02T00:00:00.000Z');
const D3 = new Date('2026-10-03T00:00:00.000Z');

beforeEach(async () => {
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});
afterEach(() => jest.restoreAllMocks());

it('two overlapping rejected grants must not credit a failed predecessor and preserve an old grant', async () => {
  const prior = await recordLocalAuthorization(old, D1);
  const since = localAuthorizationSeq();
  const failure = new Error('synthetic disk failure');
  jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(failure).mockRejectedValueOnce(failure);
  const a = recordLocalAuthorization(fresh, D2).then(() => null, (err: unknown) => err);
  const b = recordLocalAuthorization(fresh, D3).then(() => null, (err: unknown) => err);
  expect(await a).toBe(failure);
  expect(await b).toBe(failure);
  await retireOnDeviceSource(old.userId, old.source, prior.grantedAt, since);
  expect(await getLocalAuthorization(old.userId, old.source)).toBeNull();
});

it('control: a rejected predecessor must not discard a later grant that actually committed', async () => {
  const prior = await recordLocalAuthorization(old, D1);
  const since = localAuthorizationSeq();
  const failure = new Error('synthetic disk failure');
  jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(failure);
  const a = recordLocalAuthorization(fresh, D2).then(() => null, (err: unknown) => err);
  const b = recordLocalAuthorization(fresh, D3);
  expect(await a).toBe(failure);
  await b;
  await retireOnDeviceSource(old.userId, old.source, prior.grantedAt, since);
  expect((await getLocalAuthorization(old.userId, old.source))?.connectionId).toBe(fresh.connectionId);
});
