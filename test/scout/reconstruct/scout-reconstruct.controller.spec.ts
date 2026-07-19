import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { AuthedRequest } from '../../../src/auth/auth-request';
import { RolesGuard } from '../../../src/auth/roles.guard';
import { ROLES_KEY } from '../../../src/common/decorators/roles.decorator';
import { ScoutReconstructController } from '../../../src/scout/scout-reconstruct.controller';
import { ScoutReconstructService } from '../../../src/scout/scout-reconstruct.service';
import { ScoutReconstructDto } from '../../../src/scout/scout-reconstruct.dto';

/**
 * Controller + DTO unit tests for POST /api/scout/reconstruct (IMPORTER-F).
 *
 * Covers: intent_id validation, the coach-only auth gate, and coach_id
 * derivation from the token identity (never the body). The
 * FEATURE_SCOUT_RECONSTRUCT kill switch is enforced by the global
 * featureFlagNotFoundMiddleware (R-DARK-1), proven in
 * scout-reconstruct.flag.spec.ts.
 */

const validBody = { intent_id: 'intent_2026_07_16_abc' };

async function validationErrors(body: unknown): Promise<string[]> {
  const dto = plainToInstance(ScoutReconstructDto, body);
  const errors = await validate(dto);
  return errors.map((e) => e.property);
}

function makeRolesCtx(user: unknown): ExecutionContext {
  return {
    getHandler: () => ScoutReconstructController.prototype.run,
    getClass: () => ScoutReconstructController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as object as ExecutionContext;
}

function makeService(reconstruct: jest.Mock): ScoutReconstructService {
  return Object.assign(
    Object.create(ScoutReconstructService.prototype) as ScoutReconstructService,
    { reconstruct } as Partial<ScoutReconstructService>,
  ) as ScoutReconstructService;
}

function makeReq(id: string): AuthedRequest {
  return { user: { id } } as object as AuthedRequest;
}

describe('ScoutReconstructDto validation', () => {
  it('accepts a well-formed body', async () => {
    expect(await validationErrors(validBody)).toEqual([]);
  });

  it('rejects a missing intent_id', async () => {
    expect(await validationErrors({})).toContain('intent_id');
  });

  it('rejects an empty-string intent_id', async () => {
    expect(await validationErrors({ intent_id: '' })).toContain('intent_id');
  });

  it('rejects a non-string intent_id', async () => {
    expect(await validationErrors({ intent_id: 123 })).toContain('intent_id');
  });

  it('rejects an intent_id past the length ceiling', async () => {
    expect(await validationErrors({ intent_id: 'x'.repeat(257) })).toContain('intent_id');
  });

  it('accepts an intent_id at exactly the length ceiling', async () => {
    expect(await validationErrors({ intent_id: 'x'.repeat(256) })).toEqual([]);
  });

  it('accepts an omitted entity_type (defaults to clients downstream)', async () => {
    expect(await validationErrors(validBody)).toEqual([]);
  });

  it('accepts each supported entity_type family', async () => {
    for (const entity_type of ['clients', 'workouts', 'client_history']) {
      expect(await validationErrors({ ...validBody, entity_type })).toEqual([]);
    }
  });

  it('rejects an unsupported entity_type family (fail closed at validation)', async () => {
    expect(await validationErrors({ ...validBody, entity_type: 'billing' })).toContain(
      'entity_type',
    );
  });
});

describe('role gate on the reconstruct surface', () => {
  it('declares @Roles("coach") on the route handler', () => {
    expect(Reflect.getMetadata(ROLES_KEY, ScoutReconstructController.prototype.run)).toEqual([
      'coach',
    ]);
  });

  it('rejects a non-coach principal', () => {
    const guard = new RolesGuard(new Reflector());
    expect(() => guard.canActivate(makeRolesCtx({ role: 'student' }))).toThrow(ForbiddenException);
  });

  it('rejects a request with no authenticated user', () => {
    const guard = new RolesGuard(new Reflector());
    expect(() => guard.canActivate(makeRolesCtx(undefined))).toThrow(ForbiddenException);
  });

  it('admits a coach, and an owner via the hierarchy bypass', () => {
    const guard = new RolesGuard(new Reflector());
    expect(guard.canActivate(makeRolesCtx({ role: 'coach' }))).toBe(true);
    expect(guard.canActivate(makeRolesCtx({ role: 'owner' }))).toBe(true);
  });
});

describe('ScoutReconstructController', () => {
  it('delegates to the service using coach_id from the token identity, not the body', async () => {
    const reconstruct = jest.fn(async () => ({
      intent_id: 'intent_2026_07_16_abc',
      staged: 2,
      reconstructed: 2,
      skipped: 0,
      failed: 0,
    }));
    const controller = new ScoutReconstructController(makeService(reconstruct));
    const dto = plainToInstance(ScoutReconstructDto, validBody);

    const result = await controller.run(makeReq('coach-77'), dto);

    expect(reconstruct).toHaveBeenCalledWith('coach-77', 'intent_2026_07_16_abc', undefined);
    expect(result.reconstructed).toBe(2);
  });

  it('forwards an explicit entity_type family to the service', async () => {
    const reconstruct = jest.fn(async () => ({
      intent_id: 'intent_2026_07_16_abc',
      staged: 1,
      reconstructed: 1,
      skipped: 0,
      failed: 0,
    }));
    const controller = new ScoutReconstructController(makeService(reconstruct));
    const dto = plainToInstance(ScoutReconstructDto, {
      intent_id: 'intent_2026_07_16_abc',
      entity_type: 'workouts',
    });

    await controller.run(makeReq('coach-77'), dto);

    expect(reconstruct).toHaveBeenCalledWith('coach-77', 'intent_2026_07_16_abc', 'workouts');
  });

  it('returns the service reconciliation unchanged to the caller', async () => {
    const payload = {
      intent_id: 'intent-1',
      staged: 5,
      reconstructed: 3,
      skipped: 1,
      failed: 1,
    };
    const controller = new ScoutReconstructController(makeService(jest.fn(async () => payload)));
    const dto = plainToInstance(ScoutReconstructDto, { intent_id: 'intent-1' });
    await expect(controller.run(makeReq('coach-1'), dto)).resolves.toEqual(payload);
  });
});
