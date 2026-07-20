import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext, Type } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { User } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { AuthedRequest } from '../../../src/auth/auth-request';
import { RolesGuard } from '../../../src/auth/roles.guard';
import { ROLES_KEY } from '../../../src/common/decorators/roles.decorator';
import { ScoutEntitiesController } from '../../../src/scout/scout-entities.controller';
import { ScoutEntitiesService } from '../../../src/scout/scout-entities.service';
import {
  ENTITIES_MAX_PAGE_SIZE,
  ENTITY_REVIEW_FAMILIES,
  ScoutEntitiesQueryDto,
  ScoutEntitiesResult,
} from '../../../src/scout/scout-entities.dto';
import { RECONSTRUCT_FAMILY } from '../../../src/scout/scout-reconstruct.dto';

/**
 * Controller + query-DTO unit tests for GET /api/scout/reconstruct/entities
 * (IMPORTER-I). Covers query validation (intent_id, family allow-list, limit
 * bounds, cursor), the coach-only auth gate, and coach_id derivation from the
 * token identity (never the query/body). The FEATURE_SCOUT_* kill switch is
 * proven in scout-entities.flag.spec.ts.
 */

const FAM = ENTITY_REVIEW_FAMILIES[0];

async function validationErrors(query: unknown): Promise<string[]> {
  const dto = plainToInstance(ScoutEntitiesQueryDto, query);
  const errors = await validate(dto);
  return errors.map((e) => e.property);
}

// The RolesGuard reads only getHandler/getClass (for the @Roles metadata) and
// switchToHttp().getRequest().user, so the double implements exactly that
// surface. getClass is typed to Type<unknown> — which a concrete class
// constructor satisfies directly — so no `as unknown`/`as object` laundering is
// needed; a single widening cast to the full interface closes it out.
type RolesCtxDouble = Pick<ExecutionContext, 'getHandler' | 'switchToHttp'> & {
  getClass: () => Type<unknown>;
};

function makeRolesCtx(user: unknown): ExecutionContext {
  const ctx: RolesCtxDouble = {
    getHandler: () => ScoutEntitiesController.prototype.getEntities,
    getClass: () => ScoutEntitiesController,
    switchToHttp: () =>
      ({ getRequest: () => ({ user }) }) as ReturnType<ExecutionContext['switchToHttp']>,
  };
  return ctx as ExecutionContext;
}

function makeService(getEntities: jest.Mock): ScoutEntitiesService {
  return Object.assign(
    Object.create(ScoutEntitiesService.prototype) as ScoutEntitiesService,
    { getEntities } as Partial<ScoutEntitiesService>,
  ) as ScoutEntitiesService;
}

function makeReq(id: string): AuthedRequest {
  // The controller reads only req.user.id, so the double populates just that.
  // A single widening cast suffices (AuthedRequest is assignable to this subset
  // shape), keeping the test free of `as unknown`/`as object` laundering.
  const req: { user: Pick<User, 'id'> } = { user: { id } };
  return req as AuthedRequest;
}

const emptyResult: ScoutEntitiesResult = {
  intent_id: 'intent-1',
  family: FAM,
  entities: [],
  page_count: 0,
  next_cursor: null,
};

describe('ScoutEntitiesQueryDto validation', () => {
  it('accepts a minimal well-formed query', async () => {
    expect(await validationErrors({ intent_id: 'intent_2026_07_18_abc', family: FAM })).toEqual([]);
  });

  it('accepts cursor + limit', async () => {
    expect(
      await validationErrors({ intent_id: 'i', family: FAM, cursor: 'abc', limit: 10 }),
    ).toEqual([]);
  });

  it('rejects a missing intent_id', async () => {
    expect(await validationErrors({ family: FAM })).toContain('intent_id');
  });

  it('rejects a missing family', async () => {
    expect(await validationErrors({ intent_id: 'i' })).toContain('family');
  });

  it('rejects the person family (served by the roster read, not this endpoint)', async () => {
    expect(
      await validationErrors({ intent_id: 'i', family: RECONSTRUCT_FAMILY.clients }),
    ).toContain('family');
  });

  it('rejects an unregistered family (e.g. billing)', async () => {
    expect(await validationErrors({ intent_id: 'i', family: 'billing' })).toContain('family');
  });

  it('accepts every reviewable family', async () => {
    for (const family of ENTITY_REVIEW_FAMILIES) {
      expect(await validationErrors({ intent_id: 'i', family })).toEqual([]);
    }
  });

  it('rejects an empty-string intent_id', async () => {
    expect(await validationErrors({ intent_id: '', family: FAM })).toContain('intent_id');
  });

  it('rejects an intent_id past the length ceiling', async () => {
    expect(await validationErrors({ intent_id: 'x'.repeat(257), family: FAM })).toContain(
      'intent_id',
    );
  });

  it('rejects limit below 1', async () => {
    expect(await validationErrors({ intent_id: 'i', family: FAM, limit: 0 })).toContain('limit');
  });

  it('rejects limit above the ceiling', async () => {
    expect(
      await validationErrors({ intent_id: 'i', family: FAM, limit: ENTITIES_MAX_PAGE_SIZE + 1 }),
    ).toContain('limit');
  });

  it('accepts limit at exactly the ceiling', async () => {
    expect(
      await validationErrors({ intent_id: 'i', family: FAM, limit: ENTITIES_MAX_PAGE_SIZE }),
    ).toEqual([]);
  });

  it('rejects a non-integer limit', async () => {
    expect(await validationErrors({ intent_id: 'i', family: FAM, limit: 1.5 })).toContain('limit');
  });

  it('coerces a numeric-string limit (query params arrive as strings)', async () => {
    const dto = plainToInstance(ScoutEntitiesQueryDto, {
      intent_id: 'i',
      family: FAM,
      limit: '25',
    });
    expect(await validate(dto)).toEqual([]);
    expect(dto.limit).toBe(25);
  });
});

describe('role gate on the entities surface', () => {
  it('declares @Roles("coach") on the route handler', () => {
    expect(Reflect.getMetadata(ROLES_KEY, ScoutEntitiesController.prototype.getEntities)).toEqual([
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

describe('ScoutEntitiesController', () => {
  it('delegates using coach_id from the token identity, not the query', async () => {
    const getEntities = jest.fn(async () => emptyResult);
    const controller = new ScoutEntitiesController(makeService(getEntities));
    const dto = plainToInstance(ScoutEntitiesQueryDto, {
      intent_id: 'intent-1',
      family: FAM,
      cursor: 'cur',
      limit: 10,
    });

    await controller.getEntities(makeReq('coach-77'), dto);

    expect(getEntities).toHaveBeenCalledWith('coach-77', 'intent-1', FAM, 'cur', 10);
  });

  it('returns the service result unchanged to the caller', async () => {
    const controller = new ScoutEntitiesController(makeService(jest.fn(async () => emptyResult)));
    const dto = plainToInstance(ScoutEntitiesQueryDto, { intent_id: 'intent-1', family: FAM });
    await expect(controller.getEntities(makeReq('coach-1'), dto)).resolves.toEqual(emptyResult);
  });
});
