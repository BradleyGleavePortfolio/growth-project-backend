import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { WearableMetricType, WearableProvider } from '@prisma/client';
import { PreferencesService } from '../../src/wearables/preferences/preferences.service';

// PR-HK-3a / HK-6b preferences service: idempotent upsert (#29),
// concurrent-write convergence to ONE row (#28), idempotent delete (#36 no
// silent no-op), and the HK-6b (effectiveUserId, callerId) decoupling — the
// service writes the effective row and logs actor_user_id vs subject_user_id
// distinctly (#34 auditable on-behalf trail). The Prisma fake emulates the
// UNIQUE (user_id, metric) upsert by keying a Map on (user, metric).

const USER = '11111111-1111-1111-1111-111111111111';
const CLIENT = '22222222-2222-2222-2222-222222222222';
const COACH = '33333333-3333-3333-3333-333333333333';

function buildService() {
  const store = new Map<
    string,
    { preferred_provider: WearableProvider; updated_at: Date }
  >();
  const upsert = jest.fn(async ({ where, create, update }: any) => {
    const key = `${where.WearablePref_user_metric_key.user_id}::${where.WearablePref_user_metric_key.metric}`;
    const existing = store.get(key);
    const provider = existing ? update.preferred_provider : create.preferred_provider;
    const row = { preferred_provider: provider, updated_at: new Date() };
    store.set(key, row);
    return {
      metric: where.WearablePref_user_metric_key.metric,
      preferred_provider: provider,
      updated_at: row.updated_at,
    };
  });
  const deleteMany = jest.fn(async ({ where }: any) => {
    const key = `${where.user_id}::${where.metric}`;
    const had = store.has(key);
    store.delete(key);
    return { count: had ? 1 : 0 };
  });
  const findUnique = jest.fn(async ({ where }: any) => {
    const key = `${where.WearablePref_user_metric_key.user_id}::${where.WearablePref_user_metric_key.metric}`;
    const row = store.get(key);
    return row
      ? { metric: where.WearablePref_user_metric_key.metric, preferred_provider: row.preferred_provider }
      : null;
  });

  const prisma = {
    wearableUserMetricPreference: { upsert, deleteMany, findUnique },
  };
  // Capture the structured log payloads so the actor-vs-subject audit trail
  // can be asserted without coupling to a real logger transport.
  const logged: Array<Record<string, unknown>> = [];
  const logSpy = jest
    .spyOn(Logger.prototype, 'log')
    .mockImplementation((payload: unknown) => {
      logged.push(payload as Record<string, unknown>);
      return undefined;
    });

  return {
    svc: new PreferencesService(prisma as never),
    store,
    upsert,
    deleteMany,
    logged,
    logSpy,
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('PreferencesService', () => {
  it('upsert writes the override and returns the locked shape', async () => {
    const { svc } = buildService();
    const out = await svc.upsert(USER, USER, {
      metric: WearableMetricType.STEPS,
      preferred_provider: WearableProvider.OURA,
    });
    expect(out.metric).toBe(WearableMetricType.STEPS);
    expect(out.preferred_provider).toBe(WearableProvider.OURA);
    expect(typeof out.updated_at).toBe('string');
  });

  it('self-write (effective === caller): log has matching ids, on_behalf_of=false', async () => {
    const { svc, logged, upsert } = buildService();
    await svc.upsert(USER, USER, {
      metric: WearableMetricType.STEPS,
      preferred_provider: WearableProvider.OURA,
    });
    // Row written under the caller's own id.
    expect(upsert.mock.calls[0][0].where.WearablePref_user_metric_key.user_id).toBe(
      USER,
    );
    const event = logged.find((l) => l.event === 'wearable_preference_upsert');
    expect(event).toBeDefined();
    expect(event?.subject_user_id).toBe(USER);
    expect(event?.actor_user_id).toBe(USER);
    expect(event?.on_behalf_of).toBe(false);
  });

  it('on-behalf write (effective !== caller): row on target, log captures both ids distinctly', async () => {
    const { svc, logged, upsert } = buildService();
    await svc.upsert(CLIENT, COACH, {
      metric: WearableMetricType.STEPS,
      preferred_provider: WearableProvider.WHOOP,
    });
    // Row written under the TARGET (subject), not the caller (coach).
    expect(upsert.mock.calls[0][0].where.WearablePref_user_metric_key.user_id).toBe(
      CLIENT,
    );
    expect(upsert.mock.calls[0][0].create.user_id).toBe(CLIENT);
    const event = logged.find((l) => l.event === 'wearable_preference_upsert');
    expect(event?.subject_user_id).toBe(CLIENT);
    expect(event?.actor_user_id).toBe(COACH);
    expect(event?.on_behalf_of).toBe(true);
  });

  it('idempotency/#28: two concurrent POSTs -> exactly one row', async () => {
    const { svc, store } = buildService();
    await Promise.all([
      svc.upsert(USER, USER, {
        metric: WearableMetricType.STEPS,
        preferred_provider: WearableProvider.OURA,
      }),
      svc.upsert(USER, USER, {
        metric: WearableMetricType.STEPS,
        preferred_provider: WearableProvider.WHOOP,
      }),
    ]);
    expect(store.size).toBe(1);
  });

  it('upsert is idempotent on repeat (#29): same key updates in place', async () => {
    const { svc, store } = buildService();
    await svc.upsert(USER, USER, {
      metric: WearableMetricType.STEPS,
      preferred_provider: WearableProvider.OURA,
    });
    await svc.upsert(USER, USER, {
      metric: WearableMetricType.STEPS,
      preferred_provider: WearableProvider.WHOOP,
    });
    expect(store.size).toBe(1);
    const got = await svc.get(USER, WearableMetricType.STEPS);
    expect(got?.preferred_provider).toBe(WearableProvider.WHOOP);
  });

  it('remove deletes the override (self)', async () => {
    const { svc } = buildService();
    await svc.upsert(USER, USER, {
      metric: WearableMetricType.STEPS,
      preferred_provider: WearableProvider.OURA,
    });
    await expect(
      svc.remove(USER, USER, WearableMetricType.STEPS),
    ).resolves.toBeUndefined();
    expect(await svc.get(USER, WearableMetricType.STEPS)).toBeNull();
  });

  it('on-behalf remove (effective !== caller): row on target, log captures both ids, existed=true', async () => {
    const { svc, logged, deleteMany } = buildService();
    await svc.upsert(CLIENT, COACH, {
      metric: WearableMetricType.STEPS,
      preferred_provider: WearableProvider.OURA,
    });
    await svc.remove(CLIENT, COACH, WearableMetricType.STEPS);
    const lastDeleteCall = deleteMany.mock.calls[deleteMany.mock.calls.length - 1];
    expect(lastDeleteCall[0].where.user_id).toBe(CLIENT);
    const event = logged.find((l) => l.event === 'wearable_preference_delete');
    expect(event?.subject_user_id).toBe(CLIENT);
    expect(event?.actor_user_id).toBe(COACH);
    expect(event?.on_behalf_of).toBe(true);
    expect(event?.existed).toBe(true);
  });

  it('on-behalf remove of an ABSENT override: still resolves (204), log existed=false with both ids', async () => {
    const { svc, logged } = buildService();
    await expect(
      svc.remove(CLIENT, COACH, WearableMetricType.VO2_MAX),
    ).resolves.toBeUndefined();
    const event = logged.find((l) => l.event === 'wearable_preference_delete');
    expect(event?.subject_user_id).toBe(CLIENT);
    expect(event?.actor_user_id).toBe(COACH);
    expect(event?.existed).toBe(false);
  });

  it('P2 #2: removing a non-existent override is an idempotent no-op (resolves, 204)', async () => {
    const { svc, deleteMany } = buildService();
    // DELETE is idempotent: an absent override still reaches the desired
    // end-state (no override). It must resolve (controller -> 204), not throw.
    await expect(
      svc.remove(USER, USER, WearableMetricType.VO2_MAX),
    ).resolves.toBeUndefined();
    expect(deleteMany).toHaveBeenCalledTimes(1);
  });

  it('P2 #2: DELETE is idempotent across repeated calls (both resolve)', async () => {
    const { svc } = buildService();
    await svc.upsert(USER, USER, {
      metric: WearableMetricType.STEPS,
      preferred_provider: WearableProvider.OURA,
    });
    await expect(
      svc.remove(USER, USER, WearableMetricType.STEPS),
    ).resolves.toBeUndefined();
    // Second delete of the now-absent override still resolves cleanly.
    await expect(
      svc.remove(USER, USER, WearableMetricType.STEPS),
    ).resolves.toBeUndefined();
  });
});
