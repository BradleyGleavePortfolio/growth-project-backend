import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { AuthedRequest } from '../../src/auth/auth-request';
import { RolesGuard } from '../../src/auth/roles.guard';
import { ROLES_KEY } from '../../src/common/decorators/roles.decorator';
import { ScoutIngestController } from '../../src/scout/scout-ingest.controller';
import { ScoutIngestService } from '../../src/scout/scout-ingest.service';
import { SCOUT_INGEST_MAX_ENTITIES, ScoutIngestDto } from '../../src/scout/scout-ingest.dto';

/**
 * Controller + DTO unit tests for POST /api/scout/ingest.
 *
 * Covers: valid-envelope validation, invalid shapes (missing intent_id /
 * entity_type / entities, empty entities, oversized batch, bad nested payload),
 * the coach-only auth gate, and coach_id
 * derivation from the token identity. The FEATURE_SCOUT_INGEST kill switch is
 * enforced by the global featureFlagNotFoundMiddleware (R-DARK-1), proven at
 * bootstrap in test/common/feature-flag-not-found.bootstrap.spec.ts. The
 * entity shape mirrors the extension's
 * makeEntity() exactly: sourceId / sourcePlatform / capturedAt live at the TOP
 * LEVEL (camelCase) alongside the opaque payload — provenance is DTO-validated
 * here, not nested inside payload.
 */

function makeEntity(overrides: Record<string, unknown> = {}) {
  return {
    sourceId: 's1',
    sourcePlatform: 'auto:coachrx.example.com',
    capturedAt: '2026-07-07T00:00:00.000Z',
    payload: { plan: 'gold' },
    ...overrides,
  };
}

const validEnvelope = {
  intent_id: 'intent-1',
  entity_type: 'lead',
  entities: [makeEntity()],
};

async function validationErrors(body: unknown): Promise<string[]> {
  const dto = plainToInstance(ScoutIngestDto, body);
  const errors = await validate(dto, { whitelist: false });
  // Flatten top-level + nested property names that failed.
  const props: string[] = [];
  const walk = (es: typeof errors): void => {
    for (const e of es) {
      props.push(e.property);
      if (e.children?.length) walk(e.children);
    }
  };
  walk(errors);
  return props;
}

// An ExecutionContext whose handler/class point at the real controller route,
// so RolesGuard reads the actual @Roles('coach') metadata via the Reflector.
function makeRolesCtx(user: unknown): ExecutionContext {
  return {
    getHandler: () => ScoutIngestController.prototype.ingest,
    getClass: () => ScoutIngestController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as object as ExecutionContext;
}

function makeService(ingest: jest.Mock): ScoutIngestService {
  return Object.assign(
    Object.create(ScoutIngestService.prototype) as ScoutIngestService,
    { ingest } as Partial<ScoutIngestService>,
  ) as ScoutIngestService;
}

function makeReq(id: string): AuthedRequest {
  return { user: { id } } as object as AuthedRequest;
}

describe('ScoutIngestDto validation', () => {
  it('accepts a well-formed envelope', async () => {
    expect(await validationErrors(validEnvelope)).toEqual([]);
  });

  it('rejects a missing intent_id', async () => {
    const { intent_id: _omit, ...rest } = validEnvelope;
    expect(await validationErrors(rest)).toContain('intent_id');
  });

  it('rejects a missing entity_type', async () => {
    const { entity_type: _omit, ...rest } = validEnvelope;
    expect(await validationErrors(rest)).toContain('entity_type');
  });

  it('rejects a missing entities array', async () => {
    const { entities: _omit, ...rest } = validEnvelope;
    expect(await validationErrors(rest)).toContain('entities');
  });

  it('rejects an empty entities array', async () => {
    expect(await validationErrors({ ...validEnvelope, entities: [] })).toContain('entities');
  });

  it('rejects an oversized batch above the entity ceiling', async () => {
    const entities = Array.from({ length: SCOUT_INGEST_MAX_ENTITIES + 1 }, (_, i) =>
      makeEntity({ sourceId: `s${i}` }),
    );
    expect(await validationErrors({ ...validEnvelope, entities })).toContain('entities');
  });

  it('rejects an entity missing sourceId', async () => {
    const { sourceId: _omit, ...rest } = makeEntity();
    expect(await validationErrors({ ...validEnvelope, entities: [rest] })).toContain('sourceId');
  });

  it('rejects an entity missing sourcePlatform', async () => {
    const { sourcePlatform: _omit, ...rest } = makeEntity();
    expect(await validationErrors({ ...validEnvelope, entities: [rest] })).toContain(
      'sourcePlatform',
    );
  });

  it('rejects an entity missing capturedAt', async () => {
    const { capturedAt: _omit, ...rest } = makeEntity();
    expect(await validationErrors({ ...validEnvelope, entities: [rest] })).toContain('capturedAt');
  });

  it('rejects a capturedAt that is not an ISO8601 timestamp', async () => {
    const bad = { ...validEnvelope, entities: [makeEntity({ capturedAt: 'not-an-iso' })] };
    expect(await validationErrors(bad)).toContain('capturedAt');
  });

  it('rejects a capturedAt missing the strict "T" date/time separator', async () => {
    const bad = { ...validEnvelope, entities: [makeEntity({ capturedAt: '2026-07-08 12:00:00' })] };
    expect(await validationErrors(bad)).toContain('capturedAt');
  });

  it('accepts a strict ISO8601 capturedAt', async () => {
    const ok = {
      ...validEnvelope,
      entities: [makeEntity({ capturedAt: '2026-07-08T12:00:00.000Z' })],
    };
    expect(await validationErrors(ok)).toEqual([]);
  });

  it('rejects an empty-string intent_id', async () => {
    expect(await validationErrors({ ...validEnvelope, intent_id: '' })).toContain('intent_id');
  });

  it('rejects an empty-string entity_type', async () => {
    expect(await validationErrors({ ...validEnvelope, entity_type: '' })).toContain('entity_type');
  });

  it('rejects a non-string intent_id', async () => {
    expect(await validationErrors({ ...validEnvelope, intent_id: 123 })).toContain('intent_id');
  });

  it('rejects a payload that is not an object', async () => {
    const bad = { ...validEnvelope, entities: [makeEntity({ payload: 'not-an-object' })] };
    expect(await validationErrors(bad)).toContain('payload');
  });

  it('rejects an empty-string sourceId', async () => {
    const bad = { ...validEnvelope, entities: [makeEntity({ sourceId: '' })] };
    expect(await validationErrors(bad)).toContain('sourceId');
  });

  it('rejects a sourceId past the length ceiling', async () => {
    const bad = { ...validEnvelope, entities: [makeEntity({ sourceId: 'x'.repeat(257) })] };
    expect(await validationErrors(bad)).toContain('sourceId');
  });

  it('accepts a batch of exactly the maximum allowed entities', async () => {
    const entities = Array.from({ length: SCOUT_INGEST_MAX_ENTITIES }, (_, i) =>
      makeEntity({ sourceId: `s${i}` }),
    );
    expect(await validationErrors({ ...validEnvelope, entities })).toEqual([]);
  });

  it('accepts a payload carrying extra extractor-specific fields', async () => {
    const body = {
      ...validEnvelope,
      entities: [makeEntity({ payload: { name: 'kept-verbatim', plan: 'gold' } })],
    };
    expect(await validationErrors(body)).toEqual([]);
  });

  it('accepts multiple valid entities in one envelope', async () => {
    const body = {
      ...validEnvelope,
      entities: [
        makeEntity({ sourceId: 's1', sourcePlatform: 'auto:a.com' }),
        makeEntity({ sourceId: 's2', sourcePlatform: 'auto:b.com' }),
      ],
    };
    expect(await validationErrors(body)).toEqual([]);
  });

  it('rejects an entity_type past the length ceiling', async () => {
    expect(await validationErrors({ ...validEnvelope, entity_type: 'x'.repeat(129) })).toContain(
      'entity_type',
    );
  });

  it('rejects an intent_id past the length ceiling', async () => {
    expect(await validationErrors({ ...validEnvelope, intent_id: 'x'.repeat(257) })).toContain(
      'intent_id',
    );
  });

  it('rejects entities that is not an array', async () => {
    expect(await validationErrors({ ...validEnvelope, entities: 'nope' })).toContain('entities');
  });
});

describe('role gate on the ingest surface', () => {
  it('declares @Roles("coach") on the route handler (roles-enforced governance)', () => {
    expect(Reflect.getMetadata(ROLES_KEY, ScoutIngestController.prototype.ingest)).toEqual([
      'coach',
    ]);
  });

  it('rejects a non-coach principal (wrong auth role)', () => {
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

describe('ScoutIngestController', () => {
  it('delegates to the service using coach_id from the token identity', async () => {
    const ingest = jest.fn(async () => ({ received: 1, deduped: 0 }));
    const controller = new ScoutIngestController(makeService(ingest));
    const req = makeReq('coach-99');

    const dto = plainToInstance(ScoutIngestDto, validEnvelope);
    const result = await controller.ingest(req, dto);

    expect(result).toEqual({ received: 1, deduped: 0 });
    expect(ingest).toHaveBeenCalledWith('coach-99', dto);
  });

  it('returns the service dedup counts unchanged to the caller', async () => {
    const ingest = jest.fn(async () => ({ received: 5, deduped: 3 }));
    const controller = new ScoutIngestController(makeService(ingest));
    const req = makeReq('coach-1');
    const dto = plainToInstance(ScoutIngestDto, validEnvelope);
    await expect(controller.ingest(req, dto)).resolves.toEqual({ received: 5, deduped: 3 });
  });
});
