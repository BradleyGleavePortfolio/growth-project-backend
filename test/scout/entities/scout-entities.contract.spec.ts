import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { JwtAuthGuard } from '../../../src/auth/auth.guard';
import { RolesGuard } from '../../../src/auth/roles.guard';
import { ErrorEnvelope, RateLimitError } from '../../../src/common/errors/error-envelope.dto';
import { ScoutEntitiesController } from '../../../src/scout/scout-entities.controller';
import { ScoutEntitiesService } from '../../../src/scout/scout-entities.service';
import {
  ENTITIES_DEFAULT_PAGE_SIZE,
  ENTITIES_MAX_PAGE_SIZE,
  ENTITY_REVIEW_FAMILIES,
  ReconstructedEntityDto,
  ScoutEntitiesResult,
} from '../../../src/scout/scout-entities.dto';
import { RECONSTRUCT_FAMILY } from '../../../src/scout/scout-reconstruct.dto';
import { IMPORTER_BARE_PATHS } from '../../../scripts/importer-contract';

/**
 * OpenAPI shape + PR-M4 fixture-consumer contract for GET
 * /api/scout/reconstruct/entities (IMPORTER-I).
 *
 * The document is built from JUST this controller (a stub service) so the
 * assertion is fast and isolated — the full-app R80 freeze lives in
 * test/contracts/importer-contract.spec.ts. Paths are recorded WITHOUT the /api
 * prefix (setGlobalPrefix runs at runtime only), matching the sibling
 * openapi-spec.spec.ts convention.
 */

const rec = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;
const dig = (root: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>((acc, key) => rec(acc)[key], root);

const ROUTE = '/scout/reconstruct/entities';

function stubService(): ScoutEntitiesService {
  return Object.assign(
    Object.create(ScoutEntitiesService.prototype) as ScoutEntitiesService,
    {
      getEntities: async () => ({
        intent_id: 'i',
        family: ENTITY_REVIEW_FAMILIES[0],
        entities: [],
        page_count: 0,
        next_cursor: null,
      }),
    } as Partial<ScoutEntitiesService>,
  ) as ScoutEntitiesService;
}

describe('IMPORTER-I OpenAPI route shape', () => {
  jest.setTimeout(30_000);
  let document: OpenAPIObject;

  beforeAll(async () => {
    const alwaysAllow = { canActivate: () => true };
    const moduleRef = await Test.createTestingModule({
      controllers: [ScoutEntitiesController],
      providers: [{ provide: ScoutEntitiesService, useValue: stubService() }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(alwaysAllow)
      .overrideGuard(RolesGuard)
      .useValue(alwaysAllow)
      .compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    const config = new DocumentBuilder()
      .setTitle('t')
      .setVersion('0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'bearer')
      .build();
    document = SwaggerModule.createDocument(app, config, {
      extraModels: [ErrorEnvelope, RateLimitError],
    });
    await app.close();
  }, 30_000);

  it('records the route as a bare GET tagged "scout" with a summary', () => {
    const get = dig(document, 'paths', ROUTE, 'get');
    expect(get).toBeDefined();
    expect(rec(get).tags).toEqual(expect.arrayContaining(['scout']));
    expect(rec(get).summary).toBeTruthy();
  });

  it('requires intent_id and family, and leaves cursor + limit optional', () => {
    const params = dig(document, 'paths', ROUTE, 'get', 'parameters') as unknown[];
    const byName = new Map(params.map(rec).map((p) => [p.name as string, p]));
    expect(rec(byName.get('intent_id')).required).toBe(true);
    expect(rec(byName.get('family')).required).toBe(true);
    expect(rec(byName.get('cursor')).required).toBeFalsy();
    expect(rec(byName.get('limit')).required).toBeFalsy();
  });

  it('publishes the family enum as the non-person allow-list (clients excluded)', () => {
    const params = dig(document, 'paths', ROUTE, 'get', 'parameters') as unknown[];
    const family = rec(params.map(rec).find((p) => p.name === 'family'));
    const en = (rec(family.schema).enum as string[]).slice().sort();
    expect(en).toEqual([...ENTITY_REVIEW_FAMILIES].sort());
    expect(en).not.toContain(RECONSTRUCT_FAMILY.clients);
  });

  it('bounds the limit parameter to 1..MAX in the published schema', () => {
    const params = dig(document, 'paths', ROUTE, 'get', 'parameters') as unknown[];
    const limit = rec(params.map(rec).find((p) => p.name === 'limit'));
    expect(rec(limit.schema)).toMatchObject({ minimum: 1, maximum: ENTITIES_MAX_PAGE_SIZE });
  });

  it('documents 200/400/401/403/404/429 without an existence oracle on the 404', () => {
    const responses = rec(dig(document, 'paths', ROUTE, 'get', 'responses'));
    for (const status of ['200', '400', '401', '403', '404', '429']) {
      expect(responses[status]).toBeDefined();
    }
    const notFound = rec(dig(responses, '404')).description as string;
    expect(notFound).toMatch(/no existence oracle/i);
  });

  it('returns ScoutEntitiesResult on 200 with page_count + next_cursor, no full total', () => {
    const ref = dig(
      document,
      'paths',
      ROUTE,
      'get',
      'responses',
      '200',
      'content',
      'application/json',
      'schema',
      '$ref',
    );
    expect(ref).toBe('#/components/schemas/ScoutEntitiesResult');
    const props = Object.keys(
      rec(dig(document, 'components', 'schemas', 'ScoutEntitiesResult', 'properties')),
    ).sort();
    expect(props).toEqual(['entities', 'family', 'intent_id', 'next_cursor', 'page_count']);
    // No full-collection total is advertised — page_count is the only count.
    expect(props).not.toContain('total');
    expect(props).not.toContain('total_count');
  });

  it('advertises a PII-minimal entity row: no email/billing/coach_id fields', () => {
    const props = Object.keys(
      rec(dig(document, 'components', 'schemas', 'ReconstructedEntityDto', 'properties')),
    );
    expect(props.sort()).toEqual(
      [
        'client_source_id',
        'created_at',
        'entity_type',
        'id',
        'label',
        'source_id',
        'source_platform',
        'updated_at',
      ].sort(),
    );
    for (const banned of ['email', 'price', 'billing', 'coach_id', 'payload']) {
      expect(props).not.toContain(banned);
    }
  });
});

describe('IMPORTER-I frozen-slice membership (R80)', () => {
  it('is part of the frozen importer contract slice — the mobile consumer reads it', () => {
    // The entities read is the authoritative bridge PR-M4 consumes, so it MUST be
    // inside IMPORTER_BARE_PATHS and byte-pinned into importer-openapi.json. The
    // full-app drift guard (test/contracts/importer-contract.spec.ts) proves the
    // checked-in artifact matches a fresh regeneration.
    expect(IMPORTER_BARE_PATHS as readonly string[]).toContain(ROUTE);
    // Its parent /scout/reconstruct is also frozen; both coexist in the slice.
    expect(IMPORTER_BARE_PATHS as readonly string[]).toContain('/scout/reconstruct');
  });
});

/**
 * PR-M4 fixture consumer. Exercises the response contract the mobile app relies
 * on: a page is self-describing (page_count === entities.length), next_cursor
 * drives the next fetch and is null exactly once at the end, and every row is
 * PII-minimal. Using plain DTO fixtures (not the service) keeps this a pure
 * contract test the client team can copy verbatim.
 */
describe('IMPORTER-I PR-M4 fixture consumer', () => {
  function entity(sourceId: string): ReconstructedEntityDto {
    return {
      id: `id-${sourceId}`,
      source_platform: 'truecoach',
      entity_type: RECONSTRUCT_FAMILY.workouts,
      source_id: sourceId,
      client_source_id: 'tc_client_1',
      label: 'Upper Body — Week 3',
      created_at: '2026-07-18T00:00:00.000Z',
      updated_at: '2026-07-18T00:00:00.000Z',
    };
  }

  function page(
    entities: ReconstructedEntityDto[],
    nextCursor: string | null,
  ): ScoutEntitiesResult {
    return {
      intent_id: 'intent-1',
      family: RECONSTRUCT_FAMILY.workouts,
      entities,
      page_count: entities.length,
      next_cursor: nextCursor,
    };
  }

  it('treats page_count as the current page size, never a collection total', () => {
    const p = page([entity('a'), entity('b')], 'cursor-1');
    expect(p.page_count).toBe(p.entities.length);
    expect(p.page_count).toBe(2);
  });

  it('walks pages via next_cursor and terminates on the single null cursor', () => {
    const pages = [
      page([entity('a'), entity('b')], 'cur-1'),
      page([entity('c'), entity('d')], 'cur-2'),
      page([entity('e')], null),
    ];
    const byCursor = new Map<string | undefined, ScoutEntitiesResult>([
      [undefined, pages[0]],
      ['cur-1', pages[1]],
      ['cur-2', pages[2]],
    ]);

    const seen: string[] = [];
    let cursor: string | undefined;
    let nullCursors = 0;
    for (let guard = 0; guard < 50; guard++) {
      const p = byCursor.get(cursor);
      expect(p).toBeDefined();
      seen.push(...(p as ScoutEntitiesResult).entities.map((e) => e.source_id));
      const next = (p as ScoutEntitiesResult).next_cursor;
      if (next === null) {
        nullCursors += 1;
        break;
      }
      cursor = next;
    }
    expect(seen).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(new Set(seen).size).toBe(seen.length);
    expect(nullCursors).toBe(1);
  });

  it('default page size is a sane bounded value the client can pre-size buffers to', () => {
    expect(ENTITIES_DEFAULT_PAGE_SIZE).toBeGreaterThan(0);
    expect(ENTITIES_DEFAULT_PAGE_SIZE).toBeLessThanOrEqual(ENTITIES_MAX_PAGE_SIZE);
  });

  it('every row a consumer reads is PII-minimal (no email/billing/coach_id)', () => {
    const row = entity('a');
    for (const banned of ['email', 'price', 'billing', 'coach_id']) {
      expect(Object.prototype.hasOwnProperty.call(row, banned)).toBe(false);
    }
  });
});
