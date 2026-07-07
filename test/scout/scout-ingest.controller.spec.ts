import { NotFoundException, ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { AuthedRequest } from '../../src/auth/auth-request';
import { CoachGuard } from '../../src/auth/coach.guard';
import { ScoutIngestController } from '../../src/scout/scout-ingest.controller';
import { ScoutIngestService } from '../../src/scout/scout-ingest.service';
import { ScoutIngestFeatureGuard } from '../../src/scout/scout-ingest-feature.guard';
import {
  FEATURE_SCOUT_INGEST,
  SCOUT_INGEST_MAX_ENTITIES,
  ScoutIngestDto,
} from '../../src/scout/scout-ingest.dto';

/**
 * Controller + DTO + guard unit tests for POST /api/scout/ingest.
 *
 * Covers: valid-envelope validation, invalid shapes (missing intent_id /
 * entity_type / entities, empty entities, oversized batch, bad nested payload),
 * the FEATURE_SCOUT_INGEST kill switch, the coach-only auth gate, and coach_id
 * derivation from the token identity. Provenance (sourcePlatform / capturedAt)
 * is a service-level contract, not a DTO shape rule (payload is a free-form
 * leaf object so the whitelist pipe can't strip extractor fields), so those
 * assertions live in scout-ingest.service.spec.ts.
 */

const validEnvelope = {
  intent_id: 'intent-1',
  entity_type: 'lead',
  entities: [
    {
      source_id: 's1',
      payload: {
        sourcePlatform: 'auto:coachrx.example.com',
        capturedAt: '2026-07-07T00:00:00.000Z',
      },
    },
  ],
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

function makeGuardCtx(user: unknown): ExecutionContext {
  return {
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
    const entities = Array.from({ length: SCOUT_INGEST_MAX_ENTITIES + 1 }, (_, i) => ({
      source_id: `s${i}`,
      payload: { sourcePlatform: 'auto:a.com', capturedAt: '2026-07-07T00:00:00.000Z' },
    }));
    expect(await validationErrors({ ...validEnvelope, entities })).toContain('entities');
  });

  it('rejects an entity missing source_id', async () => {
    const bad = {
      ...validEnvelope,
      entities: [
        { payload: { sourcePlatform: 'auto:a.com', capturedAt: '2026-07-07T00:00:00.000Z' } },
      ],
    };
    expect(await validationErrors(bad)).toContain('source_id');
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
    const bad = {
      ...validEnvelope,
      entities: [{ source_id: 's1', payload: 'not-an-object' }],
    };
    const props = await validationErrors(bad);
    expect(props).toContain('payload');
  });

  it('rejects an empty-string source_id', async () => {
    const bad = {
      ...validEnvelope,
      entities: [
        {
          source_id: '',
          payload: { sourcePlatform: 'auto:a.com', capturedAt: '2026-07-07T00:00:00.000Z' },
        },
      ],
    };
    expect(await validationErrors(bad)).toContain('source_id');
  });

  it('rejects a source_id past the length ceiling', async () => {
    const bad = {
      ...validEnvelope,
      entities: [
        {
          source_id: 'x'.repeat(257),
          payload: { sourcePlatform: 'auto:a.com', capturedAt: '2026-07-07T00:00:00.000Z' },
        },
      ],
    };
    expect(await validationErrors(bad)).toContain('source_id');
  });

  it('accepts a batch of exactly the maximum allowed entities', async () => {
    const entities = Array.from({ length: SCOUT_INGEST_MAX_ENTITIES }, (_, i) => ({
      source_id: `s${i}`,
      payload: { sourcePlatform: 'auto:a.com', capturedAt: '2026-07-07T00:00:00.000Z' },
    }));
    expect(await validationErrors({ ...validEnvelope, entities })).toEqual([]);
  });

  it('accepts a payload carrying extra extractor-specific fields', async () => {
    const body = {
      ...validEnvelope,
      entities: [
        {
          source_id: 's1',
          payload: {
            sourcePlatform: 'auto:a.com',
            capturedAt: '2026-07-07T00:00:00.000Z',
            name: 'redacted-by-posthog-not-here',
            plan: 'gold',
          },
        },
      ],
    };
    expect(await validationErrors(body)).toEqual([]);
  });

  it('accepts multiple valid entities in one envelope', async () => {
    const body = {
      ...validEnvelope,
      entities: [
        {
          source_id: 's1',
          payload: { sourcePlatform: 'auto:a.com', capturedAt: '2026-07-07T00:00:00.000Z' },
        },
        {
          source_id: 's2',
          payload: { sourcePlatform: 'auto:b.com', capturedAt: '2026-07-07T00:00:00.000Z' },
        },
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

describe('ScoutIngestFeatureGuard', () => {
  const saved = process.env[FEATURE_SCOUT_INGEST];
  afterEach(() => {
    if (saved === undefined) delete process.env[FEATURE_SCOUT_INGEST];
    else process.env[FEATURE_SCOUT_INGEST] = saved;
  });

  it('throws 404 when the flag is unset (off by default)', () => {
    delete process.env[FEATURE_SCOUT_INGEST];
    expect(() => new ScoutIngestFeatureGuard().canActivate()).toThrow(NotFoundException);
  });

  it('throws 404 when the flag is any value other than the literal "true"', () => {
    process.env[FEATURE_SCOUT_INGEST] = '1';
    expect(() => new ScoutIngestFeatureGuard().canActivate()).toThrow(NotFoundException);
  });

  it('allows the request when the flag is exactly "true"', () => {
    process.env[FEATURE_SCOUT_INGEST] = 'true';
    expect(new ScoutIngestFeatureGuard().canActivate()).toBe(true);
  });
});

describe('CoachGuard on the ingest surface', () => {
  it('rejects a non-coach principal (wrong auth role)', () => {
    const guard = new CoachGuard();
    expect(() => guard.canActivate(makeGuardCtx({ role: 'student' }))).toThrow(ForbiddenException);
  });

  it('rejects a request with no authenticated user', () => {
    const guard = new CoachGuard();
    expect(() => guard.canActivate(makeGuardCtx(undefined))).toThrow(ForbiddenException);
  });

  it('admits a coach and an owner', () => {
    const guard = new CoachGuard();
    expect(guard.canActivate(makeGuardCtx({ role: 'coach' }))).toBe(true);
    expect(guard.canActivate(makeGuardCtx({ role: 'owner' }))).toBe(true);
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
