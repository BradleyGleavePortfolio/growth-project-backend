import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { ExtensionPairService } from '../extension-pair.service';
import { asAuthDouble, asPrismaDouble, withSetupTransaction } from './test-doubles.test';

const intent = '99457965-6db2-4dcb-bde3-05c843b681fa';
const row = () => ({
  id: 'row-1', code: '123456', coach_id: 'coach-1', chosen_platform: 'truecoach',
  expires_at: new Date(Date.now() + 120000), used_at: null as Date | null,
  failed_attempts: 0, created_at: new Date(), import_intent_id: intent as string | null,
});
function setup() {
  const stored = row();
  const prisma = withSetupTransaction({
    user: { findFirst: jest.fn().mockResolvedValue({ id: 'coach-1' }) },
    extensionPairCode: {
      create: jest.fn().mockImplementation(async ({ data }: { data: Partial<ReturnType<typeof row>> }) => {
        Object.assign(stored, data);
        return stored;
      }),
      findUnique: jest.fn().mockImplementation(async () => ({ ...stored })),
      updateMany: jest.fn().mockImplementation(async ({ where }: { where: { id?: string } }) => {
        if (!where.id || stored.used_at || stored.expires_at.getTime() <= Date.now()) return { count: 0 };
        stored.used_at = new Date();
        return { count: 1 };
      }),
      update: jest.fn().mockResolvedValue({ failed_attempts: 1 }),
    },
  });
  prisma.importIntent.findFirst.mockImplementation(async () => ({
    id: stored.import_intent_id, chosen_platform: stored.chosen_platform,
    paired_at: stored.used_at, superseded_at: null, challenge: stored,
  }));
  const auth = { mintExtensionSessionForCoach: jest.fn().mockResolvedValue({
    access_token: 'access-unit', refresh_token: 'refresh-unit',
  }) };
  const svc = new ExtensionPairService(asPrismaDouble(prisma), asAuthDouble(auth));
  return { svc, prisma, auth, stored };
}

describe('C1 durable intent issuance and echo', () => {
  it('persists a fresh opaque server UUID at init, never the code or owner', async () => {
    const { svc, prisma } = setup();
    const result = await svc.init('coach-1', 'truecoach');
    expect(result).toHaveProperty('import_intent_id', expect.stringMatching(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ));
    expect(prisma.extensionPairCode.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      import_intent_id: Reflect.get(result, 'import_intent_id'), coach_id: 'coach-1',
    }) });
    expect(Object.keys(result).sort()).toEqual(['expires_at', 'import_intent_id', 'pairing_code']);
    expect(result.pairing_code).toMatch(/^[0-9]{6}$/);
  });

  it('preserves the exact init ID through status, redeem, and durable retrieval', async () => {
    const { svc, stored } = setup();
    const initialized = await svc.init('coach-1', 'truecoach');
    const id = stored.import_intent_id;
    expect(initialized).toHaveProperty('import_intent_id', id);
    expect(await svc.status('coach-1', stored.code)).toEqual({ status: 'pending', import_intent_id: id });
    expect(await svc.redeem(stored.code)).toHaveProperty('import_intent_id', id);
    stored.expires_at = new Date(0);
    expect(await svc.session('coach-1', String(id))).toEqual({
      status: 'paired', import_intent_id: id, chosen_platform: 'truecoach',
    });
  });

  it('init retries create distinct intents, never promise unknown-ID crash recovery', async () => {
    const { svc, prisma } = setup();
    const first = await svc.init('coach-1', 'truecoach');
    const second = await svc.init('coach-1', 'truecoach');
    expect(second.import_intent_id).not.toBe(first.import_intent_id);
    expect(prisma.extensionPairCode.create).toHaveBeenCalledTimes(2);
  });

  it('expiry while auth mint is pending returns no token or paired status', async () => {
    const { svc, stored, auth } = setup();
    auth.mintExtensionSessionForCoach.mockImplementation(async () => {
      stored.expires_at = new Date(0);
      return { access_token: 'access-unit', refresh_token: 'refresh-unit' };
    });
    await expect(svc.redeem('123456')).rejects.toMatchObject({ response: { code: 'already_used' } });
    expect(stored.used_at).toBeNull();
    expect(await svc.status('coach-1', '123456')).toEqual({ status: 'expired', import_intent_id: intent });
  });

  it('echoes the persisted ID through redeem and status without returning credentials on status', async () => {
    const { svc } = setup();
    expect(await svc.status('coach-1', '123456')).toEqual({ status: 'pending', import_intent_id: intent });
    expect(await svc.redeem('123456')).toEqual({
      access_token: 'access-unit', refresh_token: 'refresh-unit', chosen_platform: 'truecoach',
      import_intent_id: intent,
    });
    expect(await svc.status('coach-1', '123456')).toEqual({ status: 'paired', import_intent_id: intent });
  });

  it('retains paired identity after code expiry and never replays tokens', async () => {
    const { svc, stored, auth } = setup();
    await svc.redeem('123456');
    stored.expires_at = new Date(0);
    expect(await svc.status('coach-1', '123456')).toEqual({ status: 'paired', import_intent_id: intent });
    await expect(svc.redeem('123456')).rejects.toMatchObject({ response: { code: 'already_used' } });
    expect(auth.mintExtensionSessionForCoach).toHaveBeenCalledTimes(1);
  });

  it('does not burn or replace the intent on auth mint failure; retry preserves it', async () => {
    const { svc, stored, prisma, auth } = setup();
    auth.mintExtensionSessionForCoach.mockRejectedValueOnce(new Error('unit auth unavailable'));
    await expect(svc.redeem('123456')).rejects.toThrow('unit auth unavailable');
    expect(stored.used_at).toBeNull();
    expect(prisma.extensionPairCode.updateMany).not.toHaveBeenCalled();
    expect(await svc.status('coach-1', '123456')).toEqual({ status: 'pending', import_intent_id: intent });
    expect(await svc.redeem('123456')).toHaveProperty('import_intent_id', intent);
  });

  it('concurrent redeem yields one token-bearing winner and one unchanged intent', async () => {
    const { svc, auth, stored } = setup();
    const results = await Promise.allSettled([svc.redeem('123456'), svc.redeem('123456')]);
    const winners = results.filter(r => r.status === 'fulfilled');
    const losers = results.filter(r => r.status === 'rejected');
    expect(winners).toEqual([{ status: 'fulfilled', value: {
      access_token: 'access-unit', refresh_token: 'refresh-unit', chosen_platform: 'truecoach',
      import_intent_id: intent,
    } }]);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ reason: { response: { code: 'already_used' } } });
    expect(stored.import_intent_id).toBe(intent);
    expect(auth.mintExtensionSessionForCoach).toHaveBeenCalledTimes(2);
  });

  it('legacy rows remain unbound in redeem and status rather than inventing an ID', async () => {
    const { svc, stored } = setup();
    stored.import_intent_id = null;
    expect(await svc.status('coach-1', '123456')).toEqual({ status: 'pending' });
    expect(await svc.redeem('123456')).toEqual({
      access_token: 'access-unit', refresh_token: 'refresh-unit', chosen_platform: 'truecoach',
    });
  });

  it('foreign status does not leak an ID and the ownership predicate reaches storage', async () => {
    const { svc, prisma } = setup();
    prisma.extensionPairCode.findUnique.mockResolvedValue(null);
    expect(await svc.status('coach-2', '123456')).toEqual({ status: 'expired' });
    expect(prisma.extensionPairCode.findUnique).toHaveBeenCalledWith({ where: {
      code: '123456', coach_id: 'coach-2',
      coach: { role: { in: ['coach', 'owner'] }, deleted_at: null },
    } });
  });

  it('init denies missing, deleted or demoted owners before creating a code', async () => {
    const { svc, prisma } = setup();
    prisma.$queryRaw.mockResolvedValue([]);
    await expect(svc.init('coach-1', 'truecoach')).rejects.toMatchObject({ status: 403 });
    expect(prisma.extensionPairCode.create).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalled();
  });

  it('demotion at token mint cannot mark setup paired', async () => {
    const { svc, auth, stored } = setup();
    auth.mintExtensionSessionForCoach.mockRejectedValue(new BadRequestException({ code: 'invalid' }));
    await expect(svc.redeem('123456')).rejects.toMatchObject({ response: { code: 'invalid' } });
    expect(stored.used_at).toBeNull();
    expect(stored.import_intent_id).toBe(intent);
  });
});
