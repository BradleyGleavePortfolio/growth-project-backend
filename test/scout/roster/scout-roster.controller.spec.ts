import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { AuthedRequest } from '../../../src/auth/auth-request';
import { RolesGuard } from '../../../src/auth/roles.guard';
import { ROLES_KEY } from '../../../src/common/decorators/roles.decorator';
import { ScoutRosterController } from '../../../src/scout/scout-roster.controller';
import { ScoutRosterService } from '../../../src/scout/scout-roster.service';
import {
  ROSTER_MAX_PAGE_SIZE,
  ScoutRosterQueryDto,
  ScoutRosterResult,
} from '../../../src/scout/scout-roster.dto';

/**
 * Controller + query-DTO unit tests for GET /api/scout/reconstruct/roster
 * (IMPORTER-G). Covers query validation (intent_id, limit bounds, cursor),
 * the coach-only auth gate, and coach_id derivation from the token identity
 * (never the query/body). The FEATURE_SCOUT_* kill switch is enforced by the
 * global featureFlagNotFoundMiddleware (R-DARK-1), proven in
 * scout-roster.flag.spec.ts.
 */

async function validationErrors(query: unknown): Promise<string[]> {
  const dto = plainToInstance(ScoutRosterQueryDto, query);
  const errors = await validate(dto);
  return errors.map((e) => e.property);
}

function makeRolesCtx(user: unknown): ExecutionContext {
  return {
    getHandler: () => ScoutRosterController.prototype.getRoster,
    getClass: () => ScoutRosterController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as object as ExecutionContext;
}

function makeService(getRoster: jest.Mock): ScoutRosterService {
  return Object.assign(
    Object.create(ScoutRosterService.prototype) as ScoutRosterService,
    { getRoster } as Partial<ScoutRosterService>,
  ) as ScoutRosterService;
}

function makeReq(id: string): AuthedRequest {
  return { user: { id } } as object as AuthedRequest;
}

const emptyResult: ScoutRosterResult = {
  intent_id: 'intent-1',
  accounting: { staged: 0, reconstructed: 0, skipped: 0, failed: 0 },
  persons: [],
  page: { limit: 50, next_cursor: null, has_more: false },
};

describe('ScoutRosterQueryDto validation', () => {
  it('accepts a minimal well-formed query', async () => {
    expect(await validationErrors({ intent_id: 'intent_2026_07_16_abc' })).toEqual([]);
  });

  it('accepts cursor + limit', async () => {
    expect(await validationErrors({ intent_id: 'i', cursor: 'abc', limit: 10 })).toEqual([]);
  });

  it('rejects a missing intent_id', async () => {
    expect(await validationErrors({})).toContain('intent_id');
  });

  it('rejects an empty-string intent_id', async () => {
    expect(await validationErrors({ intent_id: '' })).toContain('intent_id');
  });

  it('rejects an intent_id past the length ceiling', async () => {
    expect(await validationErrors({ intent_id: 'x'.repeat(257) })).toContain('intent_id');
  });

  it('rejects limit below 1', async () => {
    expect(await validationErrors({ intent_id: 'i', limit: 0 })).toContain('limit');
  });

  it('rejects limit above the ceiling', async () => {
    expect(await validationErrors({ intent_id: 'i', limit: ROSTER_MAX_PAGE_SIZE + 1 })).toContain(
      'limit',
    );
  });

  it('accepts limit at exactly the ceiling', async () => {
    expect(await validationErrors({ intent_id: 'i', limit: ROSTER_MAX_PAGE_SIZE })).toEqual([]);
  });

  it('rejects a non-integer limit', async () => {
    expect(await validationErrors({ intent_id: 'i', limit: 1.5 })).toContain('limit');
  });

  it('coerces a numeric-string limit (query params arrive as strings)', async () => {
    const dto = plainToInstance(ScoutRosterQueryDto, { intent_id: 'i', limit: '25' });
    expect(await validate(dto)).toEqual([]);
    expect(dto.limit).toBe(25);
  });
});

describe('role gate on the roster surface', () => {
  it('declares @Roles("coach") on the route handler', () => {
    expect(Reflect.getMetadata(ROLES_KEY, ScoutRosterController.prototype.getRoster)).toEqual([
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

describe('ScoutRosterController', () => {
  it('delegates using coach_id from the token identity, not the query', async () => {
    const getRoster = jest.fn(async () => emptyResult);
    const controller = new ScoutRosterController(makeService(getRoster));
    const dto = plainToInstance(ScoutRosterQueryDto, {
      intent_id: 'intent-1',
      cursor: 'cur',
      limit: 10,
    });

    await controller.getRoster(makeReq('coach-77'), dto);

    expect(getRoster).toHaveBeenCalledWith('coach-77', 'intent-1', 'cur', 10);
  });

  it('returns the service result unchanged to the caller', async () => {
    const controller = new ScoutRosterController(makeService(jest.fn(async () => emptyResult)));
    const dto = plainToInstance(ScoutRosterQueryDto, { intent_id: 'intent-1' });
    await expect(controller.getRoster(makeReq('coach-1'), dto)).resolves.toEqual(emptyResult);
  });
});
