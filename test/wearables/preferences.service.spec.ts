import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { WearableMetricType, WearableProvider } from '@prisma/client';
import { PreferencesService } from '../../src/wearables/preferences/preferences.service';

// PR-HK-3a preferences service: idempotent upsert (#29), concurrent-write
// convergence to ONE row (#28), and the 404-on-missing-delete (#36 no silent
// no-op). The Prisma fake emulates the UNIQUE (user_id, metric) upsert by
// keying a Map on (user, metric).

const USER = '11111111-1111-1111-1111-111111111111';

function buildService() {
  const store = new Map<string, { preferred_provider: WearableProvider; updated_at: Date }>();
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
  return {
    svc: new PreferencesService(prisma as never),
    store,
    upsert,
    deleteMany,
  };
}

describe('PreferencesService', () => {
  it('upsert writes the override and returns the locked shape', async () => {
    const { svc } = buildService();
    const out = await svc.upsert(USER, {
      metric: WearableMetricType.STEPS,
      preferred_provider: WearableProvider.OURA,
    });
    expect(out.metric).toBe(WearableMetricType.STEPS);
    expect(out.preferred_provider).toBe(WearableProvider.OURA);
    expect(typeof out.updated_at).toBe('string');
  });

  it('idempotency/#28: two concurrent POSTs -> exactly one row', async () => {
    const { svc, store } = buildService();
    await Promise.all([
      svc.upsert(USER, { metric: WearableMetricType.STEPS, preferred_provider: WearableProvider.OURA }),
      svc.upsert(USER, { metric: WearableMetricType.STEPS, preferred_provider: WearableProvider.WHOOP }),
    ]);
    expect(store.size).toBe(1);
  });

  it('upsert is idempotent on repeat (#29): same key updates in place', async () => {
    const { svc, store } = buildService();
    await svc.upsert(USER, { metric: WearableMetricType.STEPS, preferred_provider: WearableProvider.OURA });
    await svc.upsert(USER, { metric: WearableMetricType.STEPS, preferred_provider: WearableProvider.WHOOP });
    expect(store.size).toBe(1);
    const got = await svc.get(USER, WearableMetricType.STEPS);
    expect(got?.preferred_provider).toBe(WearableProvider.WHOOP);
  });

  it('remove deletes the override', async () => {
    const { svc } = buildService();
    await svc.upsert(USER, { metric: WearableMetricType.STEPS, preferred_provider: WearableProvider.OURA });
    await expect(svc.remove(USER, WearableMetricType.STEPS)).resolves.toBeUndefined();
    expect(await svc.get(USER, WearableMetricType.STEPS)).toBeNull();
  });

  it('#36: removing a non-existent override -> 404 (not a silent no-op)', async () => {
    const { svc } = buildService();
    await expect(svc.remove(USER, WearableMetricType.VO2_MAX)).rejects.toThrow(NotFoundException);
  });
});
