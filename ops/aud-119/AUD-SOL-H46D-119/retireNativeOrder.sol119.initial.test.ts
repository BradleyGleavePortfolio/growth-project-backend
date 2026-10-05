/**
 * Exact H6 top, real authorization/retirement helpers, synthetic storage scheduler.
 * Android AsyncStorage 3.1.1 launches each legacy operation on Dispatchers.IO:
 * JS invocation order is not the order those coroutines enter Room transactions.
 * Hold an already-invoked removal before its native effect; complete a later
 * authorization write, then let the removal commit. No native build/network.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  getLocalAuthorization,
  localAuthorizationSeq,
  recordLocalAuthorization,
  retireOnDeviceSource,
  setSyncProgress,
  getSyncProgress,
  emptyProgress,
} from '../onDeviceState';

const source = 'HEALTH_CONNECT' as const;
const old = { userId: 'order-user', source, connectionId: 'old-connection' };
const fresh = { ...old, connectionId: 'fresh-connection' };

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((yes) => (resolve = yes));
  return { resolve, promise };
}

beforeEach(async () => {
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});
afterEach(() => jest.restoreAllMocks());

it('the pinned default Android backend launches independent IO coroutines, not a JS-call-order queue', () => {
  const root = join(process.cwd(), 'node_modules/@react-native-async-storage/async-storage');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
  expect(pkg.version).toBe('3.1.1');
  expect(readFileSync(join(root, 'src/index.tsx'), 'utf8')).toContain('export default getLegacyStorage()');
  const native = readFileSync(
    join(root, 'android/src/main/kotlin/org/asyncstorage/legacy_storage/LegacyStorageModule.kt'),
    'utf8',
  );
  expect(native).toContain('Dispatchers.IO + CoroutineName("AsyncStorageScope") + SupervisorJob()');
  expect(native).toMatch(/fun multiRemove[\s\S]*?launch\(createExceptionHandler\(promise\)\)/);
  expect(native).toMatch(/fun multiSet[\s\S]*?launch\(createExceptionHandler\(promise\)\)/);
  expect(native).not.toMatch(/Mutex|SerialExecutor|limitedParallelism\(1\)/);
});

it.each([old.userId, null])(
  'native removal already invoked, owner=%p: a later completed Connect must survive its late commit',
  async (userId) => {
    const prior = await recordLocalAuthorization(old, new Date('2026-10-01T00:00:00.000Z'));
    const since = localAuthorizationSeq();
    const invoked = deferred();
    const nativeCommit = deferred();
    const remove = AsyncStorage.removeMany.bind(AsyncStorage);
    jest.spyOn(AsyncStorage, 'removeMany').mockImplementationOnce(async (keys) => {
      invoked.resolve();
      await nativeCommit.promise;
      await remove(keys);
    });
    const retiring = retireOnDeviceSource(userId, source, prior.grantedAt, since);
    await invoked.promise;
    // This write starts AFTER both the sequence test and the native remove call.
    await recordLocalAuthorization(fresh, new Date('2026-10-02T00:00:00.000Z'));
    await setSyncProgress(fresh, {
      ...emptyProgress(),
      completedThrough: { Steps: '2026-10-02T00:00:00.000Z' },
    });
    expect((await getLocalAuthorization(old.userId, source))?.connectionId).toBe(fresh.connectionId);
    nativeCommit.resolve();
    await retiring;
    // A new grant cannot be revoked by cleanup belonging to the old Disconnect.
    expect((await getLocalAuthorization(old.userId, source))?.connectionId).toBe(fresh.connectionId);
    expect((await getSyncProgress(fresh)).completedThrough.Steps).toBe('2026-10-02T00:00:00.000Z');
  },
);

it.each([old.userId, null])(
  'ordered-native control, owner=%p: old removal commits before the next grant and the next grant survives',
  async (userId) => {
    const prior = await recordLocalAuthorization(old);
    await retireOnDeviceSource(userId, source, prior.grantedAt, localAuthorizationSeq());
    expect(await getLocalAuthorization(old.userId, source)).toBeNull();
    await recordLocalAuthorization(fresh);
    expect((await getLocalAuthorization(old.userId, source))?.connectionId).toBe(fresh.connectionId);
  },
);

it('held-native control without reconnect: the old grant is removed normally', async () => {
  const prior = await recordLocalAuthorization(old);
  const invoked = deferred();
  const nativeCommit = deferred();
  const remove = AsyncStorage.removeMany.bind(AsyncStorage);
  jest.spyOn(AsyncStorage, 'removeMany').mockImplementationOnce(async (keys) => {
    invoked.resolve();
    await nativeCommit.promise;
    await remove(keys);
  });
  const retiring = retireOnDeviceSource(old.userId, source, prior.grantedAt, localAuthorizationSeq());
  await invoked.promise;
  nativeCommit.resolve();
  await retiring;
  expect(await getLocalAuthorization(old.userId, source)).toBeNull();
});
