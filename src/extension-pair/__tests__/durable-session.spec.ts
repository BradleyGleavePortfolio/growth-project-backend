import 'reflect-metadata';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { ExtensionPairController } from '../extension-pair.controller';
import { ExtensionPairService } from '../extension-pair.service';
import { PairCurrentDto, PairInitDto, PairRedeemDto, PairSessionDto } from '../extension-pair.dto';
import { CoachGuard } from '../../auth/coach.guard';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { featureFlagNotFoundMiddleware } from '../../common/feature-flag/feature-flag-not-found.middleware';
import { asAuthDouble, asPrismaDouble, authedRequest, executionContextFor } from './test-doubles.test';

const intent = '99457965-6db2-4dcb-bde3-05c843b681fa';
const activeCoach = { role: { in: ['coach', 'owner'] }, deleted_at: null };
function setup() {
  const stored = {
    id: intent, coach_id: 'coach-1', chosen_platform: 'truecoach',
    paired_at: new Date(1), superseded_at: null,
    challenge: { expires_at: new Date(0), failed_attempts: 0 },
  };
  const prisma = { importIntent: { findFirst: jest.fn().mockResolvedValue(stored) } };
  const auth = { mintExtensionSessionForCoach: jest.fn() };
  const svc = new ExtensionPairService(asPrismaDouble(prisma), asAuthDouble(auth));
  return { stored, prisma, auth, svc, controller: new ExtensionPairController(svc) };
}

describe('C1 durable session boundary', () => {
  it('reads the stored ID after code expiry, without any credential or Start/completion state', async () => {
    const { svc, prisma, auth } = setup();
    expect(await svc.session('coach-1', intent)).toEqual({
      status: 'paired', import_intent_id: intent, chosen_platform: 'truecoach',
    });
    expect(prisma.importIntent.findFirst).toHaveBeenCalledWith({ where: {
      id: intent, coach_id: 'coach-1', coach: activeCoach,
    }, include: { challenge: { select: { expires_at: true, failed_attempts: true } } } });
    expect(auth.mintExtensionSessionForCoach).not.toHaveBeenCalled();
  });

  it('passes the authenticated owner, never a body-supplied owner, through the controller', async () => {
    const { controller, prisma } = setup();
    expect(await controller.session(authedRequest('coach-1'), { import_intent_id: intent }))
      .toEqual({ status: 'paired', import_intent_id: intent, chosen_platform: 'truecoach' });
    expect(prisma.importIntent.findFirst).toHaveBeenCalledWith({ where: {
      id: intent, coach_id: 'coach-1', coach: activeCoach,
    }, include: { challenge: { select: { expires_at: true, failed_attempts: true } } } });
  });

  it('storage misses return identical not-found without minting or revealing ownership', async () => {
    const { svc, prisma, auth } = setup();
    prisma.importIntent.findFirst.mockResolvedValue(null);
    await expect(svc.session('coach-2', intent)).rejects.toMatchObject({
      status: 404, response: { message: 'Pairing session not found. Create a new pairing code.' },
    });
    expect(prisma.importIntent.findFirst).toHaveBeenCalledWith({ where: {
      id: intent, coach_id: 'coach-2', coach: activeCoach,
    }, include: { challenge: { select: { expires_at: true, failed_attempts: true } } } });
    expect(auth.mintExtensionSessionForCoach).not.toHaveBeenCalled();
  });

  it.each([
    ['coach-1', 'coach', null, intent, true],
    ['coach-1', 'owner', null, intent, true],
    ['coach-2', 'coach', null, intent, false],
    ['coach-1', 'student', null, intent, false],
    ['coach-1', 'coach', new Date(1), intent, false],
    ['coach-1', 'coach', null, null, false],
  ])('enforces owner/role/deletion/legacy predicates for %s %s %s %s', async (
    owner, role, deletedAt, savedId, allowed,
  ) => {
    const { svc, prisma, stored } = setup();
    prisma.importIntent.findFirst.mockImplementation(async ({ where }: {
      where: { coach_id: string; id: string; coach: typeof activeCoach },
    }) => where.coach_id === owner && where.id === savedId &&
      where.coach.role.in.includes(String(role)) && where.coach.deleted_at === deletedAt ? stored : null);
    if (allowed) {
      expect(await svc.session('coach-1', intent)).toHaveProperty('import_intent_id', intent);
    } else {
      await expect(svc.session('coach-1', intent)).rejects.toMatchObject({ status: 404 });
    }
  });

  it('reads pending versus expired unused setup truthfully, never inferring pairing', async () => {
    const { stored, svc } = setup();
    Object.assign(stored, { paired_at: null, challenge: { expires_at: new Date(Date.now() + 120000), failed_attempts: 0 } });
    expect(await svc.session('coach-1', intent)).toMatchObject({ status: 'pending', import_intent_id: intent });
    stored.challenge.expires_at = new Date(0);
    expect(await svc.session('coach-1', intent)).toMatchObject({ status: 'expired', import_intent_id: intent });
  });

  it('reconnect reads are stable and do not rotate or mint the identity', async () => {
    const { svc, auth } = setup();
    const first = await svc.session('coach-1', intent);
    expect(await svc.session('coach-1', intent)).toEqual(first);
    expect(first).toHaveProperty('import_intent_id', intent);
    expect(auth.mintExtensionSessionForCoach).not.toHaveBeenCalled();
  });

  it.each(['session', 'current'] as const)('keeps %s POST, bearer-only, coach/owner guarded with the global authenticated throttle', (route) => {
    const handler = ExtensionPairController.prototype[route];
    expect(Reflect.getMetadata('method', handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata('path', handler)).toBe(route);
    expect(Reflect.getMetadata('__guards__', handler)).toContain(CoachGuard);
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['coach', 'owner']);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).not.toBe(true);
    expect(Reflect.getMetadata('__headers__', handler)).toContainEqual({ name: 'Cache-Control', value: 'no-store' });
    expect(Reflect.getMetadata('THROTTLER:SKIPdefault', handler)).not.toBe(true);
    const guard = new CoachGuard();
    expect(guard.canActivate(executionContextFor({ role: 'owner' }))).toBe(true);
    expect(() => guard.canActivate(executionContextFor({ role: 'student' }))).toThrow('Coach access required');
    expect(() => guard.canActivate(executionContextFor(null))).toThrow('Coach access required');
  });

  it.each(['session', 'current'])('%s is dark by default before authentication or storage work', (route) => {
    delete process.env.FEATURE_EXTENSION_PAIRING;
    const next = jest.fn();
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const req = { path: `/api/extension/pair/${route}`, originalUrl: `/api/extension/pair/${route}`, headers: {} };
    const res = { setHeader: jest.fn(), status };
    // @ts-expect-error only the middleware's exercised Express properties are supplied.
    featureFlagNotFoundMiddleware(req, res, next);
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    expect(next).not.toHaveBeenCalled();
  });

  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
  it('validates the new UUID in the real request pipe', async () => {
    expect(await pipe.transform({ import_intent_id: intent }, { type: 'body', metatype: PairSessionDto }))
      .toEqual({ import_intent_id: intent });
    for (const value of [undefined, null, 42, '', 'ext-client-minted', '123456', 'x'.repeat(10000)]) {
      await expect(pipe.transform({ import_intent_id: value }, { type: 'body', metatype: PairSessionDto }))
        .rejects.toMatchObject({ status: 400 });
    }
  });

  it('rejects ownership/intent injection while preserving old init and redeem requests', async () => {
    for (const [metatype, body] of [
      [PairInitDto, { chosen_platform: 'truecoach' }], [PairRedeemDto, { code: '123456' }],
    ] as const) {
      expect(await pipe.transform(body, { type: 'body', metatype })).toEqual(body);
      await expect(pipe.transform({ ...body, import_intent_id: intent }, { type: 'body', metatype }))
        .rejects.toMatchObject({ status: 400 });
    }
    await expect(pipe.transform({ import_intent_id: intent, coach_id: 'coach-2' }, {
      type: 'body', metatype: PairSessionDto,
    })).rejects.toMatchObject({ status: 400 });
  });

  it('current reads use authenticated owner, optionally recover an older nonce, and never mint', async () => {
    const { controller, prisma, auth } = setup();
    await controller.current(authedRequest('coach-1'), {});
    expect(prisma.importIntent.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { coach_id: 'coach-1', coach: activeCoach, superseded_at: null },
    }));
    await controller.current(authedRequest('coach-1'), { setup_nonce: intent });
    expect(prisma.importIntent.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { coach_id: 'coach-1', coach: activeCoach, setup_nonce: intent },
    }));
    expect(auth.mintExtensionSessionForCoach).not.toHaveBeenCalled();
  });

  it('optional nonce is UUIDv4, not null, and current rejects authority injection', async () => {
    expect(await pipe.transform({}, { type: 'body', metatype: PairCurrentDto })).toEqual({});
    for (const setup_nonce of [null, '', '123456', 42]) {
      await expect(pipe.transform({ setup_nonce }, { type: 'body', metatype: PairCurrentDto }))
        .rejects.toMatchObject({ status: 400 });
    }
    await expect(pipe.transform({ coach_id: 'other' }, { type: 'body', metatype: PairCurrentDto }))
      .rejects.toMatchObject({ status: 400 });
    expect(await pipe.transform({ chosen_platform: 'truecoach', setup_nonce: intent },
      { type: 'body', metatype: PairInitDto })).toHaveProperty('setup_nonce', intent);
  });
});
