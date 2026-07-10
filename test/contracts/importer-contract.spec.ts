import * as fs from 'fs';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { buildOpenApiDocument } from '../../src/common/openapi';
import {
  API_PREFIX,
  IMPORTER_BARE_PATHS,
  buildImporterContract,
  serializeContract,
} from '../../scripts/importer-contract';
import { contractOutPath } from '../../scripts/export-importer-contract';

// R80 contract-freeze guard. This suite is the drift check: it re-derives the
// importer contract from the LIVE @nestjs/swagger document and asserts the
// checked-in docs/contracts/importer-openapi.json is byte-identical. Any change
// to an importer DTO, response type, enum, or route that is NOT reflected in a
// regenerated artifact fails CI — so the frozen contract can never silently
// drift from the code, and the artifact can never be hand-edited into a shape
// the backend does not actually serve.
//
// It also pins the semantic invariants the extension + mobile clients depend on
// (status codes, error-body enums, camelCase provenance in a snake_case
// envelope, strict ISO-8601 capturedAt) so a well-meaning regeneration that
// quietly changes them is caught in review rather than in the field.

describe('importer contract (R80 freeze)', () => {
  jest.setTimeout(60_000);

  // Typed `any` for terse navigation of the OpenAPI tree in assertions, the
  // same pattern as test/openapi-spec.spec.ts.
  let contract: any;
  let serialized: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    const document = buildOpenApiDocument(app);
    await app.close();
    contract = buildImporterContract(document);
    serialized = serializeContract(contract);
  }, 60_000);

  describe('drift check', () => {
    it('the checked-in artifact exists', () => {
      expect(fs.existsSync(contractOutPath())).toBe(true);
    });

    it('the checked-in artifact is byte-identical to a fresh regeneration', () => {
      const committed = fs.readFileSync(contractOutPath(), 'utf8');
      // If this fails, run `npm run contract:importer` and commit the result.
      expect(serialized).toBe(committed);
    });

    it('serialization is deterministic (stable key order across runs)', () => {
      expect(serializeContract(contract)).toBe(serialized);
    });
  });

  describe('surface completeness', () => {
    it('exposes exactly the seven importer routes, /api-prefixed', () => {
      const expected = IMPORTER_BARE_PATHS.map((p) => `${API_PREFIX}${p}`).sort();
      expect(Object.keys(contract.paths).sort()).toEqual(expected);
    });

    it('carries the bearer security scheme referenced by guarded routes', () => {
      const schemes = contract.components?.securitySchemes ?? {};
      expect((schemes as Record<string, unknown>).bearer).toMatchObject({
        type: 'http',
        scheme: 'bearer',
      });
    });

    it('inlines every schema its paths reference (no dangling $refs)', () => {
      const schemas = contract.components?.schemas ?? {};
      const names = new Set(Object.keys(schemas));
      const refs: string[] = [];
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (node && typeof node === 'object') {
          for (const [k, v] of Object.entries(node)) {
            if (k === '$ref' && typeof v === 'string') {
              const m = /^#\/components\/schemas\/(.+)$/.exec(v);
              if (m) refs.push(m[1]);
            } else walk(v);
          }
        }
      };
      walk(contract.paths);
      walk(schemas);
      for (const ref of refs) expect(names.has(ref)).toBe(true);
    });
  });

  describe('auth: POST /api/auth/extension/refresh', () => {
    const path = '/api/auth/extension/refresh';

    it('returns the rotated Supabase session on 200', () => {
      const ok = contract.paths[path].post.responses['200'];
      expect(ok.content['application/json'].schema.$ref).toBe(
        '#/components/schemas/ExtensionRefreshResult',
      );
      const props = contract.components!.schemas!.ExtensionRefreshResult;
      expect(Object.keys(props.properties).sort()).toEqual(
        ['access_token', 'expires_at', 'expires_in', 'refresh_token'].sort(),
      );
      expect(props.required).toEqual(
        expect.arrayContaining(['access_token', 'refresh_token', 'expires_in']),
      );
    });

    it('returns a structured error body on 401', () => {
      const err = contract.paths[path].post.responses['401'];
      expect(err.content['application/json'].schema.$ref).toBe(
        '#/components/schemas/ExtensionRefreshErrorDto',
      );
      const dto = contract.components!.schemas!.ExtensionRefreshErrorDto;
      expect(Object.keys(dto.properties).sort()).toEqual(['code', 'message']);
    });

    it('advertises the rate-limit status', () => {
      expect(contract.paths[path].post.responses['429']).toBeDefined();
    });
  });

  describe('pairing: POST /api/extension/pair/*', () => {
    it('init returns { pairing_code, expires_at } on 201', () => {
      const ok = contract.paths['/api/extension/pair/init'].post.responses['201'];
      expect(ok.content['application/json'].schema.$ref).toBe(
        '#/components/schemas/PairInitResult',
      );
      const dto = contract.components!.schemas!.PairInitResult;
      expect(Object.keys(dto.properties).sort()).toEqual(['expires_at', 'pairing_code']);
    });

    it('status returns the pending|paired|expired enum on 200', () => {
      const ok = contract.paths['/api/extension/pair/status'].post.responses['200'];
      expect(ok.content['application/json'].schema.$ref).toBe(
        '#/components/schemas/PairStatusResult',
      );
      const dto = contract.components!.schemas!.PairStatusResult;
      expect(dto.properties.status.enum).toEqual(['pending', 'paired', 'expired']);
    });

    it('redeem returns the token pair + chosen_platform on 200', () => {
      const ok = contract.paths['/api/extension/pair/redeem'].post.responses['200'];
      expect(ok.content['application/json'].schema.$ref).toBe(
        '#/components/schemas/PairRedeemResult',
      );
      const dto = contract.components!.schemas!.PairRedeemResult;
      expect(Object.keys(dto.properties).sort()).toEqual(
        ['access_token', 'chosen_platform', 'refresh_token'].sort(),
      );
    });

    it('redeem pins the structured failure enum on 400 and 410', () => {
      const responses = contract.paths['/api/extension/pair/redeem'].post.responses;
      for (const status of ['400', '410']) {
        expect(responses[status].content['application/json'].schema.$ref).toBe(
          '#/components/schemas/PairRedeemErrorDto',
        );
      }
      const dto = contract.components!.schemas!.PairRedeemErrorDto;
      expect(dto.properties.code.enum).toEqual(['expired', 'already_used', 'invalid', 'locked']);
    });

    it('redeem advertises the dark-route 404 and the per-IP 429', () => {
      const responses = contract.paths['/api/extension/pair/redeem'].post.responses;
      expect(responses['404']).toBeDefined();
      expect(responses['429']).toBeDefined();
    });
  });

  describe('scout: POST /api/scout/*', () => {
    it('ingest returns { received, deduped } on 202', () => {
      const ok = contract.paths['/api/scout/ingest'].post.responses['202'];
      expect(ok.content['application/json'].schema.$ref).toBe(
        '#/components/schemas/ScoutIngestResult',
      );
      const dto = contract.components!.schemas!.ScoutIngestResult;
      expect(Object.keys(dto.properties).sort()).toEqual(['deduped', 'received']);
    });

    it('ingest keeps provenance camelCase at the top of a snake_case envelope', () => {
      const envelope = contract.components!.schemas!.ScoutIngestDto;
      // Outer envelope: snake_case.
      expect(envelope.properties.intent_id).toBeDefined();
      expect(envelope.properties.entity_type).toBeDefined();
      expect(envelope.properties.entities.items.$ref).toBe('#/components/schemas/ScoutEntityDto');
      // Inner record provenance: camelCase, top-level (not nested in payload).
      const entity = contract.components!.schemas!.ScoutEntityDto;
      expect(Object.keys(entity.properties).sort()).toEqual(
        ['capturedAt', 'payload', 'sourceId', 'sourcePlatform'].sort(),
      );
    });

    it('ingest pins capturedAt to a strict date-time string', () => {
      const entity = contract.components!.schemas!.ScoutEntityDto;
      expect(entity.properties.capturedAt).toMatchObject({
        type: 'string',
        format: 'date-time',
      });
    });

    it('progress requires deviceId and returns 204', () => {
      const post = contract.paths['/api/scout/progress'].post;
      expect(post.responses['204']).toBeDefined();
      const dto = contract.components!.schemas!.ScoutProgressDto;
      expect(dto.required).toEqual(expect.arrayContaining(['deviceId', 'intent_id', 'progress']));
    });

    it('progress advertises the reachable 403 (role) and 429 (throttle)', () => {
      // Both are enforced by global guards (RolesGuard + UserThrottlerGuard),
      // so the contract must document them for parity with /api/scout/ingest.
      const responses = contract.paths['/api/scout/progress'].post.responses;
      expect(responses['403']).toBeDefined();
      expect(responses['429']).toBeDefined();
    });

    it('complete acknowledges the settled intent on 200', () => {
      const ok = contract.paths['/api/scout/ingest/complete'].post.responses['200'];
      expect(ok.content['application/json'].schema.$ref).toBe(
        '#/components/schemas/ScoutCompleteResult',
      );
      const dto = contract.components!.schemas!.ScoutCompleteResult;
      expect(Object.keys(dto.properties).sort()).toEqual(['acknowledged', 'intent_id']);
      const body = contract.components!.schemas!.ScoutCompleteDto;
      expect(body.properties.terminal_status.enum).toEqual(['success', 'partial', 'failed']);
    });

    it('complete advertises the reachable 403 (role) and 429 (throttle)', () => {
      const responses = contract.paths['/api/scout/ingest/complete'].post.responses;
      expect(responses['403']).toBeDefined();
      expect(responses['429']).toBeDefined();
    });
  });
});
