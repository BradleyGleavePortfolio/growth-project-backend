import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { OpenAPIObject } from '@nestjs/swagger';
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
// (status codes, the SHARED truthful error envelope, camelCase provenance in a
// snake_case envelope, strict ISO-8601 capturedAt) so a well-meaning
// regeneration that quietly changes them is caught in review rather than in the
// field.

// Terse, `any`-free navigation of the OpenAPI tree: `dig` walks a dotted key
// path and returns `unknown`, which jest matchers accept directly; `rec`
// narrows a node to an indexable record for Object.keys(). Neither uses the
// `any` token (the sibling test/openapi-spec.spec.ts predates this cleanup).
const rec = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
const dig = (root: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>(
    (acc, key) => (acc !== null && typeof acc === 'object' ? rec(acc)[key] : undefined),
    root,
  );

describe('importer contract (R80 freeze)', () => {
  jest.setTimeout(60_000);

  let contract: OpenAPIObject;
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
    it('exposes exactly the importer routes, /api-prefixed', () => {
      const expected = IMPORTER_BARE_PATHS.map((p) => `${API_PREFIX}${p}`).sort();
      expect(Object.keys(rec(contract.paths)).sort()).toEqual(expected);
    });

    it('carries the bearer security scheme referenced by guarded routes', () => {
      const schemes = rec(dig(contract, 'components', 'securitySchemes'));
      expect(schemes.bearer).toMatchObject({ type: 'http', scheme: 'bearer' });
    });

    it('inlines every schema its paths reference (no dangling $refs)', () => {
      const schemas = rec(dig(contract, 'components', 'schemas'));
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

  // The two shared, truthful error schemas replace the old per-route
  // { code, message } DTOs. ErrorEnvelope mirrors src/filters/
  // not-found-envelope.ts buildErrorEnvelope() (the global HttpExceptionFilter
  // body); RateLimitError mirrors src/filters/throttler-exception.filter.ts.
  describe('shared error schemas mirror the runtime envelopes', () => {
    it('ErrorEnvelope pins the always-present keys and keeps code/request_id optional', () => {
      const env = rec(dig(contract, 'components', 'schemas', 'ErrorEnvelope'));
      expect(Object.keys(rec(env.properties)).sort()).toEqual(
        ['code', 'error', 'message', 'path', 'request_id', 'statusCode', 'timestamp'].sort(),
      );
      // statusCode/message/error/timestamp/path are always emitted by
      // buildErrorEnvelope; code + request_id are conditional.
      expect(env.required).toEqual(
        expect.arrayContaining(['statusCode', 'message', 'error', 'timestamp', 'path']),
      );
      expect(env.required).not.toContain('code');
      expect(env.required).not.toContain('request_id');
      // message is string | string[] (ValidationPipe emits an array).
      expect(dig(env, 'properties', 'message', 'oneOf')).toEqual([
        { type: 'string' },
        { type: 'array', items: { type: 'string' } },
      ]);
      expect(dig(env, 'properties', 'timestamp', 'format')).toBe('date-time');
    });

    it('RateLimitError models the distinct 429 body (retryAfter, no timestamp/path)', () => {
      const rl = rec(dig(contract, 'components', 'schemas', 'RateLimitError'));
      expect(Object.keys(rec(rl.properties)).sort()).toEqual(
        ['error', 'message', 'retryAfter', 'statusCode'].sort(),
      );
      expect(rl.required).toEqual(
        expect.arrayContaining(['statusCode', 'error', 'message', 'retryAfter']),
      );
    });
  });

  describe('read: GET /api/scout/import/status', () => {
    const path = '/api/scout/import/status';
    // Sorted own-property names of a named component schema.
    const props = (name: string): string[] =>
      Object.keys(rec(dig(contract, 'components', 'schemas', name, 'properties'))).sort();

    it('requires the intent_id query parameter with a 1..128 bounded string schema', () => {
      const params = dig(contract, 'paths', path, 'get', 'parameters') as unknown[];
      const intent = rec(params.map(rec).find((p) => p.name === 'intent_id'));
      expect(intent).toMatchObject({ in: 'query', required: true });
      // minLength must be emitted (not just maxLength) so a client generator
      // rejects an empty intent_id the way the server's @Length(1,128) does.
      expect(rec(intent.schema)).toMatchObject({
        type: 'string',
        minLength: 1,
        maxLength: 128,
      });
    });

    it('documents 400 and 404 without an existence oracle (flag-off ≡ not-found)', () => {
      const g = dig(contract, 'paths', path, 'get', 'responses');
      // The bodyless GET rejects a bad QUERY, never a "Malformed body".
      expect(rec(dig(g, '400')).description as string).toMatch(/query/i);
      expect(rec(dig(g, '400')).description as string).not.toMatch(/malformed body/i);
      // Flag-off and no-evidence must be a single indistinguishable 404.
      const notFound = rec(dig(g, '404')).description as string;
      expect(notFound).toMatch(/FEATURE_SCOUT_INGEST/);
      expect(notFound).toMatch(/no existence oracle/i);
    });

    it('returns the ScoutImportStatusResult projection on 200: the five legacy fields plus the S7-L additive lifecycle fields', () => {
      const res = dig(contract, 'paths', path, 'get', 'responses', '200', 'content');
      expect(dig(res, 'application/json', 'schema', '$ref')).toBe(
        '#/components/schemas/ScoutImportStatusResult',
      );
      expect(props('ScoutImportStatusResult')).toEqual([
        'accepted_start_at',
        'claimed_status',
        'completed_at',
        'deadline_at',
        'entity_counts',
        'execution_epoch',
        'families',
        'intent_id',
        'last_observed_at',
        'mode',
        'phase',
        'reason_code',
        'started_at',
        'status',
      ]);
    });

    it('pins status to the provable states: running, the legacy terminals and the S7-L server terminals — no pending', () => {
      const en = dig(contract, 'components', 'schemas', 'ScoutImportStatusResult', 'properties');
      expect((rec(rec(en).status).enum as string[]).sort()).toEqual([
        'blocked',
        'cancelled',
        'complete',
        'failed',
        'partial',
        'running',
        'success',
        'timed_out',
      ]);
    });

    it('S7-L lifecycle fields carry the reason-code catalog as enums and nullable server clocks', () => {
      const en = rec(
        dig(contract, 'components', 'schemas', 'ScoutImportStatusResult', 'properties'),
      );
      expect((rec(en.mode).enum as string[]).sort()).toEqual(['legacy', 'server']);
      expect((rec(en.phase).enum as string[]).sort()).toEqual([
        'discovering',
        'reconciling',
        'transferring',
      ]);
      expect(rec(en.phase).nullable).toBe(true);
      // S7-L's six codes plus the three S9 reconciliation codes (S9-C, D-S9-7; append-only).
      expect((rec(en.reason_code).enum as string[]).sort()).toEqual([
        'cancelled_by_coach',
        'coverage_basis_unknown',
        'deadline_exceeded',
        'reconciliation_not_performed',
        'relationship_unverified',
        'revoked',
        'transfer_failed',
        'unresolved_family',
        'unresolved_identities',
      ]);
      expect((rec(en.claimed_status).enum as string[]).sort()).toEqual([
        'failed',
        'partial',
        'success',
      ]);
      for (const clock of ['accepted_start_at', 'deadline_at', 'last_observed_at']) {
        expect(rec(en[clock])).toMatchObject({
          type: 'string',
          format: 'date-time',
          nullable: true,
        });
      }
      expect(rec(en.execution_epoch)).toMatchObject({ type: 'number', minimum: 1 });
      expect(dig(en, 'families', 'items', '$ref')).toBe(
        '#/components/schemas/ScoutImportFamilyDto',
      );
      // The eight S7-L keys plus the six S9-C additive (optional) keys of D-S9-5.
      expect(props('ScoutImportFamilyDto')).toEqual([
        'already_present_verified',
        'canonical_family',
        'completeness_basis',
        'created_native',
        'family',
        'ledger',
        'native_present_verified',
        'observed_unique',
        'qualifiers',
        'reasons',
        'rejected',
        'relationship_closure',
        'staged_unique',
        'unresolved',
      ]);
      expect(props('ScoutImportFamilyLedgerDto')).toEqual(['failed', 'reconstructed', 'skipped']);
    });

    it('S9-C: the additive family fields are optional, closed where the doc closes them, and additive only', () => {
      const family = rec(dig(contract, 'components', 'schemas', 'ScoutImportFamilyDto'));
      // The S7-L required set is unchanged: none of the S9 fields is required (R13/R15 absence).
      expect((family.required as string[]).slice().sort()).toEqual([
        'already_present_verified',
        'created_native',
        'family',
        'ledger',
        'observed_unique',
        'rejected',
        'staged_unique',
        'unresolved',
      ]);
      const fp = rec(family.properties);
      expect(rec(fp.canonical_family)).toMatchObject({ type: 'string', nullable: true });
      expect(rec(fp.native_present_verified)).toMatchObject({ type: 'number', minimum: 0 });
      expect(rec(fp.completeness_basis)).toMatchObject({ type: 'string' });
      expect((rec(fp.relationship_closure).enum as string[]).sort()).toEqual([
        'not_applicable',
        'unverified',
        'verified',
      ]);
      expect(dig(fp, 'reasons', 'items', '$ref')).toBe(
        '#/components/schemas/ScoutImportReasonCountDto',
      );
      expect(props('ScoutImportReasonCountDto')).toEqual(['code', 'count']);
      // Addendum C-7: `qualifiers[]` is a closed enum, never string[].
      expect(rec(fp.qualifiers).type).toBe('array');
      expect(dig(fp, 'qualifiers', 'items', 'enum')).toEqual(['roster_bridge_pending']);
    });

    it('reports committed counts as proof — the two-field DTO omits total_estimated', () => {
      expect(props('ScoutImportEntityCountDto')).toEqual(['committed', 'entity_type']);
    });

    it('pins started_at and completed_at as nullable date-time strings (not object)', () => {
      const p = rec(
        dig(contract, 'components', 'schemas', 'ScoutImportStatusResult', 'properties'),
      );
      for (const field of ['started_at', 'completed_at']) {
        expect(rec(p[field])).toMatchObject({
          type: 'string',
          format: 'date-time',
          nullable: true,
        });
        // Guards the reflector regression where a `string | null` union emitted
        // `type: object`, which degrades client codegen to `any`/`object`.
        expect(rec(p[field]).type).not.toBe('object');
      }
    });
  });

  describe('read: GET /api/scout/reconstruct/entities (IMPORTER-I)', () => {
    const path = '/api/scout/reconstruct/entities';
    const props = (name: string): string[] =>
      Object.keys(rec(dig(contract, 'components', 'schemas', name, 'properties'))).sort();

    it('requires a bounded intent_id and a non-person family query param', () => {
      const params = dig(contract, 'paths', path, 'get', 'parameters') as unknown[];
      const intent = rec(params.map(rec).find((p) => p.name === 'intent_id'));
      expect(intent).toMatchObject({ in: 'query', required: true });
      expect(rec(intent.schema)).toMatchObject({ type: 'string', minLength: 1, maxLength: 256 });
      const family = rec(params.map(rec).find((p) => p.name === 'family'));
      expect(family).toMatchObject({ in: 'query', required: true });
      // The family allow-list is the non-person canonical families; `clients`
      // (the roster Person read) must never be selectable here.
      const familyEnum = dig(family.schema, 'enum') as string[];
      expect(familyEnum).not.toContain('clients');
      expect(familyEnum.length).toBeGreaterThan(0);
    });

    it('returns the ScoutEntitiesResult page projection on 200', () => {
      const res = dig(contract, 'paths', path, 'get', 'responses', '200', 'content');
      expect(dig(res, 'application/json', 'schema', '$ref')).toBe(
        '#/components/schemas/ScoutEntitiesResult',
      );
      // page metadata only — deliberately NOT a full-collection total.
      expect(props('ScoutEntitiesResult')).toEqual([
        'entities',
        'family',
        'intent_id',
        'next_cursor',
        'page_count',
      ]);
    });

    it('advertises a PII-minimal ReconstructedEntityDto row (no email/billing/coach_id)', () => {
      const row = props('ReconstructedEntityDto');
      // S8-F adds exactly two additive fields: the materialized `target_kind` and the
      // nullable owned `native_id`. Every legacy field keeps its meaning.
      expect(row).toEqual([
        'client_source_id',
        'created_at',
        'entity_type',
        'id',
        'label',
        'native_id',
        'source_id',
        'source_platform',
        'target_kind',
        'updated_at',
      ]);
      for (const banned of ['email', 'price', 'billing', 'coach_id', 'payload']) {
        expect(row).not.toContain(banned);
      }
    });

    it('documents 400 (bad query) and a no-oracle 404 (flag-off ≡ no-evidence)', () => {
      const g = dig(contract, 'paths', path, 'get', 'responses');
      expect(rec(dig(g, '400')).description as string).toMatch(/query/i);
      const notFound = rec(dig(g, '404')).description as string;
      expect(notFound).toMatch(/no existence oracle/i);
      expect(
        dig(g, '400', 'content', 'application/json', 'schema') ?? dig(g, '400', 'schema'),
      ).toBeDefined();
    });

    it('models the reachable 401/403/404 as the shared envelope and 429 as the rate-limit body', () => {
      for (const status of ['401', '403', '404']) {
        expect(
          dig(
            contract,
            'paths',
            path,
            'get',
            'responses',
            status,
            'content',
            'application/json',
            'schema',
            '$ref',
          ),
        ).toBe('#/components/schemas/ErrorEnvelope');
      }
      expect(
        dig(
          contract,
          'paths',
          path,
          'get',
          'responses',
          '429',
          'content',
          'application/json',
          'schema',
          '$ref',
        ),
      ).toBe('#/components/schemas/RateLimitError');
    });
  });

  describe('auth: POST /api/auth/extension/refresh', () => {
    const path = '/api/auth/extension/refresh';

    it('returns the rotated Supabase session on 200', () => {
      expect(
        dig(
          contract,
          'paths',
          path,
          'post',
          'responses',
          '200',
          'content',
          'application/json',
          'schema',
          '$ref',
        ),
      ).toBe('#/components/schemas/ExtensionRefreshResult');
      const props = rec(
        dig(contract, 'components', 'schemas', 'ExtensionRefreshResult', 'properties'),
      );
      expect(Object.keys(props).sort()).toEqual(
        ['access_token', 'expires_at', 'expires_in', 'refresh_token'].sort(),
      );
      const required = dig(contract, 'components', 'schemas', 'ExtensionRefreshResult', 'required');
      expect(required).toEqual(
        expect.arrayContaining(['access_token', 'refresh_token', 'expires_in']),
      );
    });

    it('returns the shared ErrorEnvelope with a required code enum on 401', () => {
      const schema = rec(
        dig(
          contract,
          'paths',
          path,
          'post',
          'responses',
          '401',
          'content',
          'application/json',
          'schema',
        ),
      );
      const allOf = schema.allOf as unknown[];
      expect(rec(allOf[0]).$ref).toBe('#/components/schemas/ErrorEnvelope');
      expect(rec(allOf[1]).required).toEqual(['code']);
      expect(dig(allOf[1], 'properties', 'code', 'enum')).toEqual(['extension_refresh_invalid']);
    });

    it('advertises ValidationPipe 400 as the shared ErrorEnvelope (no domain code)', () => {
      const resp = dig(contract, 'paths', path, 'post', 'responses', '400');
      expect(resp).toBeDefined();
      // shared envelope — no required code enum on pure ValidationPipe failures
      const schema = dig(resp, 'content', 'application/json', 'schema') ?? dig(resp, 'schema');
      expect(schema).toBeDefined();
    });

    it('advertises the rate-limit status as the RateLimitError body', () => {
      expect(
        dig(
          contract,
          'paths',
          path,
          'post',
          'responses',
          '429',
          'content',
          'application/json',
          'schema',
          '$ref',
        ),
      ).toBe('#/components/schemas/RateLimitError');
    });
  });

  describe('pairing: POST /api/extension/pair/*', () => {
    it('init returns code, expiry and server intent on 201', () => {
      expect(
        dig(
          contract,
          'paths',
          '/api/extension/pair/init',
          'post',
          'responses',
          '201',
          'content',
          'application/json',
          'schema',
          '$ref',
        ),
      ).toBe('#/components/schemas/PairInitResult');
      const props = rec(dig(contract, 'components', 'schemas', 'PairInitResult', 'properties'));
      expect(Object.keys(props).sort()).toEqual(['expires_at', 'import_intent_id', 'pairing_code']);
    });

    it('durable session is bearer-only POST with validated UUID and credential-free response', () => {
      const route = rec(dig(contract, 'paths', '/api/extension/pair/session', 'post'));
      expect(route.security).toEqual([{ bearer: [] }]);
      expect(dig(route, 'requestBody', 'content', 'application/json', 'schema', '$ref')).toBe(
        '#/components/schemas/PairSessionDto',
      );
      const dto = rec(dig(contract, 'components', 'schemas', 'PairSessionDto'));
      expect(dto.required).toEqual(['import_intent_id']);
      expect(dig(dto, 'properties', 'import_intent_id', 'format')).toBe('uuid');
      const result = rec(dig(contract, 'components', 'schemas', 'PairSessionResult'));
      expect(Object.keys(rec(result.properties)).sort()).toEqual([
        'chosen_platform',
        'import_intent_id',
        'status',
      ]);
      expect(result.required).toContain('import_intent_id');
      expect(Object.keys(rec(route.responses)).sort()).toEqual([
        '200',
        '400',
        '401',
        '403',
        '404',
        '429',
      ]);
    });

    it('intent echoes remain optional for legacy redeem/status responses', () => {
      for (const name of ['PairRedeemResult', 'PairStatusResult']) {
        const schema = rec(dig(contract, 'components', 'schemas', name));
        expect(dig(schema, 'properties', 'import_intent_id', 'format')).toBe('uuid');
        expect(schema.required).not.toContain('import_intent_id');
      }
    });

    it('setup recovery is an unfrozen 2.x prerelease, with optional nonce and current lookup', () => {
      expect(contract.info.version).toBe('2.0.0-c1-s2.0');
      const dto = rec(dig(contract, 'components', 'schemas', 'PairInitDto'));
      expect(dto.required).toEqual(['chosen_platform']);
      expect(dig(dto, 'properties', 'setup_nonce', 'format')).toBe('uuid');
      const current = rec(dig(contract, 'paths', '/api/extension/pair/current', 'post'));
      expect(current.security).toEqual([{ bearer: [] }]);
      expect(dig(current, 'requestBody', 'content', 'application/json', 'schema', '$ref')).toBe(
        '#/components/schemas/PairCurrentDto',
      );
      expect(
        dig(current, 'responses', '200', 'content', 'application/json', 'schema', '$ref'),
      ).toBe('#/components/schemas/PairSessionResult');
      expect(Object.keys(rec(current.responses)).sort()).toEqual([
        '200',
        '400',
        '401',
        '403',
        '404',
        '429',
      ]);
      for (const [status, code] of [
        ['409', 'setup_nonce_conflict'],
        ['410', 'setup_challenge_unavailable'],
      ]) {
        expect(
          dig(
            contract,
            'paths',
            '/api/extension/pair/init',
            'post',
            'responses',
            status,
            'content',
            'application/json',
            'schema',
          ),
        ).toEqual({
          allOf: [
            { $ref: '#/components/schemas/ErrorEnvelope' },
            {
              type: 'object',
              properties: { code: { type: 'string', enum: [code] } },
              required: ['code'],
            },
          ],
        });
      }
    });

    it('init 400 is the shared envelope; code is OPTIONAL and pinned to `code_mint_failed` when present', () => {
      // Like redeem, init 400 has two sources: the domain `code_mint_failed`
      // path (mint-retry budget exhausted, sets code) and the code-less
      // ValidationPipe array (a chosen_platform failing the slug/length rules).
      const schema = rec(
        dig(
          contract,
          'paths',
          '/api/extension/pair/init',
          'post',
          'responses',
          '400',
          'content',
          'application/json',
          'schema',
        ),
      );
      const allOf = schema.allOf as unknown[];
      expect(rec(allOf[0]).$ref).toBe('#/components/schemas/ErrorEnvelope');
      expect(rec(allOf[1]).required).toBeUndefined();
      expect(dig(allOf[1], 'properties', 'code', 'enum')).toEqual(['code_mint_failed']);
    });

    it('init advertises the reachable 429 (global authed throttle)', () => {
      // init carries no explicit @Throttle, so it is governed by the global
      // authenticated default (UserThrottlerGuard). Documented for parity.
      expect(
        dig(
          contract,
          'paths',
          '/api/extension/pair/init',
          'post',
          'responses',
          '429',
          'content',
          'application/json',
          'schema',
          '$ref',
        ),
      ).toBe('#/components/schemas/RateLimitError');
    });

    it('status returns the pending|paired|expired enum on 200', () => {
      expect(
        dig(
          contract,
          'paths',
          '/api/extension/pair/status',
          'post',
          'responses',
          '200',
          'content',
          'application/json',
          'schema',
          '$ref',
        ),
      ).toBe('#/components/schemas/PairStatusResult');
      expect(
        dig(contract, 'components', 'schemas', 'PairStatusResult', 'properties', 'status', 'enum'),
      ).toEqual(['pending', 'paired', 'expired']);
    });

    it('status advertises ValidationPipe 400 (same 6-digit code rule as redeem)', () => {
      expect(
        dig(contract, 'paths', '/api/extension/pair/status', 'post', 'responses', '400'),
      ).toBeDefined();
    });

    it('status advertises JwtAuth 401 before role 403', () => {
      expect(
        dig(contract, 'paths', '/api/extension/pair/status', 'post', 'responses', '401'),
      ).toBeDefined();
    });

    it('init advertises JwtAuth 401 before role 403', () => {
      expect(
        dig(contract, 'paths', '/api/extension/pair/init', 'post', 'responses', '401'),
      ).toBeDefined();
    });

    it('status advertises the reachable 429 (global authed throttle)', () => {
      // Same global-throttle parity as init: no explicit @Throttle → governed by
      // the global authenticated default (UserThrottlerGuard).
      expect(
        dig(
          contract,
          'paths',
          '/api/extension/pair/status',
          'post',
          'responses',
          '429',
          'content',
          'application/json',
          'schema',
          '$ref',
        ),
      ).toBe('#/components/schemas/RateLimitError');
    });

    it('redeem returns the token pair + chosen_platform on 200', () => {
      expect(
        dig(
          contract,
          'paths',
          '/api/extension/pair/redeem',
          'post',
          'responses',
          '200',
          'content',
          'application/json',
          'schema',
          '$ref',
        ),
      ).toBe('#/components/schemas/PairRedeemResult');
      const props = rec(dig(contract, 'components', 'schemas', 'PairRedeemResult', 'properties'));
      expect(Object.keys(props).sort()).toEqual(
        ['access_token', 'chosen_platform', 'import_intent_id', 'refresh_token'].sort(),
      );
    });

    it('redeem 400 is the shared envelope; code is OPTIONAL and pinned to `invalid` when present', () => {
      // 400 has two runtime sources: the domain `invalid` path (sets code) and
      // the code-less ValidationPipe array. So `code` is pinned by enum but NOT
      // required.
      const schema = rec(
        dig(
          contract,
          'paths',
          '/api/extension/pair/redeem',
          'post',
          'responses',
          '400',
          'content',
          'application/json',
          'schema',
        ),
      );
      const allOf = schema.allOf as unknown[];
      expect(rec(allOf[0]).$ref).toBe('#/components/schemas/ErrorEnvelope');
      expect(rec(allOf[1]).required).toBeUndefined();
      expect(dig(allOf[1], 'properties', 'code', 'enum')).toEqual(['invalid']);
    });

    it('redeem 410 is the shared envelope with a REQUIRED code from the 410 enum', () => {
      const schema = rec(
        dig(
          contract,
          'paths',
          '/api/extension/pair/redeem',
          'post',
          'responses',
          '410',
          'content',
          'application/json',
          'schema',
        ),
      );
      const allOf = schema.allOf as unknown[];
      expect(rec(allOf[0]).$ref).toBe('#/components/schemas/ErrorEnvelope');
      expect(rec(allOf[1]).required).toEqual(['code']);
      expect(dig(allOf[1], 'properties', 'code', 'enum')).toEqual([
        'expired',
        'already_used',
        'locked',
      ]);
    });

    it('redeem advertises the dark-route 404 (envelope) and the per-IP 429 (rate-limit)', () => {
      expect(
        dig(
          contract,
          'paths',
          '/api/extension/pair/redeem',
          'post',
          'responses',
          '404',
          'content',
          'application/json',
          'schema',
          '$ref',
        ),
      ).toBe('#/components/schemas/ErrorEnvelope');
      expect(
        dig(
          contract,
          'paths',
          '/api/extension/pair/redeem',
          'post',
          'responses',
          '429',
          'content',
          'application/json',
          'schema',
          '$ref',
        ),
      ).toBe('#/components/schemas/RateLimitError');
    });
  });

  it('redeem advertises 500 for pre-claim session mint failure', () => {
    expect(
      dig(contract, 'paths', '/api/extension/pair/redeem', 'post', 'responses', '500'),
    ).toBeDefined();
  });

  describe('scout: POST /api/scout/*', () => {
    it('ingest returns { received, deduped } on 202', () => {
      expect(
        dig(
          contract,
          'paths',
          '/api/scout/ingest',
          'post',
          'responses',
          '202',
          'content',
          'application/json',
          'schema',
          '$ref',
        ),
      ).toBe('#/components/schemas/ScoutIngestResult');
      const props = rec(dig(contract, 'components', 'schemas', 'ScoutIngestResult', 'properties'));
      expect(Object.keys(props).sort()).toEqual(['deduped', 'received']);
    });

    it('ingest keeps provenance camelCase at the top of a snake_case envelope', () => {
      const envelope = rec(dig(contract, 'components', 'schemas', 'ScoutIngestDto', 'properties'));
      // Outer envelope: snake_case.
      expect(envelope.intent_id).toBeDefined();
      expect(envelope.entity_type).toBeDefined();
      expect(
        dig(
          contract,
          'components',
          'schemas',
          'ScoutIngestDto',
          'properties',
          'entities',
          'items',
          '$ref',
        ),
      ).toBe('#/components/schemas/ScoutEntityDto');
      // Inner record provenance: camelCase, top-level (not nested in payload).
      const entity = rec(dig(contract, 'components', 'schemas', 'ScoutEntityDto', 'properties'));
      expect(Object.keys(entity).sort()).toEqual(
        ['capturedAt', 'payload', 'sourceId', 'sourcePlatform'].sort(),
      );
    });

    it('ingest pins capturedAt to a strict date-time string', () => {
      expect(
        dig(contract, 'components', 'schemas', 'ScoutEntityDto', 'properties', 'capturedAt'),
      ).toMatchObject({
        type: 'string',
        format: 'date-time',
      });
    });

    it('ingest models its 4xx as the shared envelope and 429 as the rate-limit body', () => {
      for (const status of ['400', '401', '403', '404']) {
        expect(
          dig(
            contract,
            'paths',
            '/api/scout/ingest',
            'post',
            'responses',
            status,
            'content',
            'application/json',
            'schema',
            '$ref',
          ),
        ).toBe('#/components/schemas/ErrorEnvelope');
      }
      expect(
        dig(
          contract,
          'paths',
          '/api/scout/ingest',
          'post',
          'responses',
          '429',
          'content',
          'application/json',
          'schema',
          '$ref',
        ),
      ).toBe('#/components/schemas/RateLimitError');
    });

    it('progress requires deviceId and returns 204', () => {
      expect(
        dig(contract, 'paths', '/api/scout/progress', 'post', 'responses', '204'),
      ).toBeDefined();
      const required = dig(contract, 'components', 'schemas', 'ScoutProgressDto', 'required');
      expect(required).toEqual(expect.arrayContaining(['deviceId', 'intent_id', 'progress']));
    });

    it('progress advertises ValidationPipe 400', () => {
      expect(
        dig(contract, 'paths', '/api/scout/progress', 'post', 'responses', '400'),
      ).toBeDefined();
    });

    it('progress advertises the reachable 403 (role) and 429 (throttle)', () => {
      // Both are enforced by global guards (RolesGuard + UserThrottlerGuard),
      // so the contract must document them for parity with /api/scout/ingest.
      expect(
        dig(
          contract,
          'paths',
          '/api/scout/progress',
          'post',
          'responses',
          '403',
          'content',
          'application/json',
          'schema',
          '$ref',
        ),
      ).toBe('#/components/schemas/ErrorEnvelope');
      expect(
        dig(
          contract,
          'paths',
          '/api/scout/progress',
          'post',
          'responses',
          '429',
          'content',
          'application/json',
          'schema',
          '$ref',
        ),
      ).toBe('#/components/schemas/RateLimitError');
    });

    it('complete acknowledges the settled intent on 200', () => {
      expect(
        dig(
          contract,
          'paths',
          '/api/scout/ingest/complete',
          'post',
          'responses',
          '200',
          'content',
          'application/json',
          'schema',
          '$ref',
        ),
      ).toBe('#/components/schemas/ScoutCompleteResult');
      const props = rec(
        dig(contract, 'components', 'schemas', 'ScoutCompleteResult', 'properties'),
      );
      expect(Object.keys(props).sort()).toEqual(['acknowledged', 'intent_id']);
      expect(
        dig(
          contract,
          'components',
          'schemas',
          'ScoutCompleteDto',
          'properties',
          'terminal_status',
          'enum',
        ),
      ).toEqual(['success', 'partial', 'failed']);
    });

    it('complete advertises ValidationPipe 400', () => {
      expect(
        dig(contract, 'paths', '/api/scout/ingest/complete', 'post', 'responses', '400'),
      ).toBeDefined();
    });

    it('complete advertises the reachable 403 (role) and 429 (throttle)', () => {
      expect(
        dig(
          contract,
          'paths',
          '/api/scout/ingest/complete',
          'post',
          'responses',
          '403',
          'content',
          'application/json',
          'schema',
          '$ref',
        ),
      ).toBe('#/components/schemas/ErrorEnvelope');
      expect(
        dig(
          contract,
          'paths',
          '/api/scout/ingest/complete',
          'post',
          'responses',
          '429',
          'content',
          'application/json',
          'schema',
          '$ref',
        ),
      ).toBe('#/components/schemas/RateLimitError');
    });
  });

  describe('S7-L run lifecycle: POST /api/scout/runs/start + /api/scout/runs/cancel', () => {
    const start = () => rec(dig(contract, 'paths', '/api/scout/runs/start', 'post'));
    const cancel = () => rec(dig(contract, 'paths', '/api/scout/runs/cancel', 'post'));

    it('both routes are bearer-guarded POSTs answering 200 with their typed result', () => {
      for (const [op, result] of [
        [start(), 'ScoutRunStartResult'],
        [cancel(), 'ScoutRunCancelResult'],
      ] as const) {
        expect(op.security).toEqual([{ bearer: [] }]);
        expect(dig(op, 'responses', '200', 'content', 'application/json', 'schema', '$ref')).toBe(
          `#/components/schemas/${result}`,
        );
        expect(Object.keys(rec(op.responses)).sort()).toEqual([
          '200',
          '400',
          '401',
          '403',
          '404',
          '409',
          '429',
        ]);
      }
    });

    it('start takes only a uuid import_intent_id and returns the server-owned clock once', () => {
      const dto = rec(dig(contract, 'components', 'schemas', 'ScoutRunStartDto'));
      expect(Object.keys(rec(dto.properties))).toEqual(['import_intent_id']);
      expect(dig(dto, 'properties', 'import_intent_id', 'format')).toBe('uuid');
      expect(dto.required).toEqual(['import_intent_id']);
      const res = rec(dig(contract, 'components', 'schemas', 'ScoutRunStartResult', 'properties'));
      expect(Object.keys(res).sort()).toEqual([
        'accepted_start_at',
        'deadline_at',
        'execution_epoch',
        'intent_id',
        'mode',
        'phase',
      ]);
      expect(rec(res.mode).enum).toEqual(['server']);
      expect(rec(res.phase).enum).toEqual(['discovering']);
      expect(rec(res.accepted_start_at)).toMatchObject({ type: 'string', format: 'date-time' });
      expect(rec(res.deadline_at)).toMatchObject({ type: 'string', format: 'date-time' });
    });

    it('cancel takes the intent_id and returns { intent_id, status: cancelled, execution_epoch }', () => {
      const dto = rec(dig(contract, 'components', 'schemas', 'ScoutRunCancelDto'));
      expect(Object.keys(rec(dto.properties))).toEqual(['intent_id']);
      expect(dto.required).toEqual(['intent_id']);
      const res = rec(dig(contract, 'components', 'schemas', 'ScoutRunCancelResult', 'properties'));
      expect(Object.keys(res).sort()).toEqual(['execution_epoch', 'intent_id', 'status']);
      expect(rec(res.status).enum).toEqual(['cancelled']);
      expect(rec(res.execution_epoch)).toMatchObject({ minimum: 2 });
    });

    it('409 bodies pin the D-S7L-5 conflict codes as enums (no free text)', () => {
      const codes = (op: Record<string, unknown>): string[] => {
        const schema = rec(dig(op, 'responses', '409', 'content', 'application/json', 'schema'));
        const all = (schema.allOf as unknown[]).map(rec);
        const withCode = all.find((s) => dig(s, 'properties', 'code', 'enum') !== undefined);
        return (dig(withCode, 'properties', 'code', 'enum') as string[]).slice().sort();
      };
      expect(codes(start())).toEqual([
        'intent_not_paired',
        'intent_superseded',
        'legacy_run',
        'run_terminal',
      ]);
      expect(codes(cancel())).toEqual(['legacy_run', 'run_terminal']);
      const complete = rec(dig(contract, 'paths', '/api/scout/ingest/complete', 'post'));
      expect(codes(complete)).toEqual(['run_not_started']);
      // The batch receiver's writer gate (D-S7L-5 §3): a closed gate rolls the batch back and
      // answers with one of exactly these two fixed codes; both are members of RUN_CONFLICT_CODES.
      const ingest = rec(dig(contract, 'paths', '/api/scout/ingest', 'post'));
      expect(codes(ingest)).toEqual(['run_fenced', 'run_not_started']);
      const ingest409 = rec(dig(ingest, 'responses', '409'));
      expect(ingest409.description).toMatch(/run_not_started/);
      expect(ingest409.description).toMatch(/run_fenced/);
      expect(ingest409.description).toMatch(/Legacy intents never 409/);
    });

    it('both routes share the uniform FEATURE_SCOUT_INGEST / not-found 404 wording', () => {
      for (const op of [start(), cancel()]) {
        const notFound = rec(dig(op, 'responses', '404')).description as string;
        expect(notFound).toMatch(/FEATURE_SCOUT_INGEST/);
        expect(notFound).toMatch(/R-DARK-1/);
      }
    });
  });

  describe('S10-B induction: POST /api/scout/runs/declaration + /runs/observation', () => {
    const declaration = () => rec(dig(contract, 'paths', '/api/scout/runs/declaration', 'post'));
    const observation = () => rec(dig(contract, 'paths', '/api/scout/runs/observation', 'post'));
    const schema = (name: string) => rec(dig(contract, 'components', 'schemas', name));
    const props = (name: string) => rec(schema(name).properties);
    const codes = (op: Record<string, unknown>): string[] => {
      const body = rec(dig(op, 'responses', '409', 'content', 'application/json', 'schema'));
      const all = (body.allOf as unknown[]).map(rec);
      const withCode = all.find((s) => dig(s, 'properties', 'code', 'enum') !== undefined);
      return (dig(withCode, 'properties', 'code', 'enum') as string[]).slice().sort();
    };

    it('both routes are bearer-guarded POSTs taking and answering their typed bodies', () => {
      for (const [op, dto, result] of [
        [declaration(), 'ScoutRunDeclarationDto', 'ScoutRunDeclarationResult'],
        [observation(), 'ScoutRunObservationDto', 'ScoutRunObservationResult'],
      ] as const) {
        expect(op.security).toEqual([{ bearer: [] }]);
        expect(dig(op, 'requestBody', 'content', 'application/json', 'schema', '$ref')).toBe(
          `#/components/schemas/${dto}`,
        );
        expect(dig(op, 'responses', '200', 'content', 'application/json', 'schema', '$ref')).toBe(
          `#/components/schemas/${result}`,
        );
        expect(Object.keys(rec(op.responses)).sort()).toEqual([
          '200',
          '400',
          '401',
          '403',
          '404',
          '409',
          '429',
        ]);
      }
    });

    it('declaration: intent_id + platforms of digest scopes; returns the ONE challenge', () => {
      expect(Object.keys(props('ScoutRunDeclarationDto')).sort()).toEqual([
        'intent_id',
        'platforms',
      ]);
      expect([...(schema('ScoutRunDeclarationDto').required as string[])].sort()).toEqual([
        'intent_id',
        'platforms',
      ]);
      expect(rec(props('ScoutRunDeclarationDto').platforms)).toMatchObject({
        type: 'array',
        minItems: 1,
        items: { $ref: '#/components/schemas/ScoutRunDeclarationPlatformDto' },
      });
      const platform = props('ScoutRunDeclarationPlatformDto');
      expect(Object.keys(platform).sort()).toEqual(['account_scope_id_digests', 'source_platform']);
      expect(rec(platform.account_scope_id_digests)).toMatchObject({
        type: 'array',
        minItems: 1,
        uniqueItems: true,
        items: { type: 'string' },
      });
      const result = props('ScoutRunDeclarationResult');
      expect(Object.keys(result).sort()).toEqual(['challenge_b64', 'declared_at', 'intent_id']);
      expect(rec(result.challenge_b64)).toMatchObject({ minLength: 44, maxLength: 44 });
      expect(rec(result.declared_at)).toMatchObject({ type: 'string', format: 'date-time' });
    });

    it('observation: intent_id + ObservationEvidenceV1 entries; stored/replayed counts', () => {
      expect(Object.keys(props('ScoutRunObservationDto')).sort()).toEqual([
        'intent_id',
        'observations',
      ]);
      expect(rec(props('ScoutRunObservationDto').observations)).toMatchObject({
        type: 'array',
        minItems: 1,
        items: { $ref: '#/components/schemas/ScoutRunObservationEvidenceSchema' },
      });
      expect(Object.keys(props('ScoutRunObservationEvidenceSchema')).sort()).toEqual([
        'account_scope_id_digest',
        'basis_kind',
        'evidence_version',
        'family',
        'key_id',
        'mapping_spec_digest',
        'signature_b64',
        'source_platform',
        'statement_b64',
      ]);
      expect(rec(props('ScoutRunObservationEvidenceSchema').basis_kind).enum).toEqual([
        'source_signed_enumeration',
      ]);
      const result = props('ScoutRunObservationResult');
      expect(Object.keys(result).sort()).toEqual([
        'execution_epoch',
        'intent_id',
        'replayed',
        'stored',
      ]);
      expect(rec(result.execution_epoch)).toMatchObject({ minimum: 1 });
      expect(rec(result.stored)).toMatchObject({ minimum: 0 });
      expect(rec(result.replayed)).toMatchObject({ minimum: 0 });
    });

    it('409 bodies pin the D-S10-4 refusal codes plus the run lifecycle codes as enums', () => {
      expect(codes(declaration())).toEqual([
        'declaration_after_ingest',
        'declaration_conflict',
        'legacy_run',
        'run_fenced',
        'run_not_started',
        'run_terminal',
      ]);
      expect(codes(observation())).toEqual([
        'declaration_missing',
        'legacy_run',
        'observation_after_claim',
        'observation_conflict',
        'observation_not_declared',
        'run_fenced',
        'run_not_started',
        'run_terminal',
      ]);
    });

    it('both routes share the uniform FEATURE_SCOUT_INGEST / not-found 404 wording', () => {
      for (const op of [declaration(), observation()]) {
        const notFound = rec(dig(op, 'responses', '404')).description as string;
        expect(notFound).toMatch(/FEATURE_SCOUT_INGEST/);
        expect(notFound).toMatch(/R-DARK-1/);
      }
    });
  });

  // The in-process determinism checks (stableSort idempotence, repeated
  // serializeContract) live in importer-contract-extraction.spec.ts. This one is
  // stronger: it regenerates the artifact from a COLD, SEPARATE Node process (a
  // full fresh Nest boot via the real `npm run contract:importer` CLI) and
  // asserts the bytes are identical to the committed file. That catches any
  // nondeterminism the same-process path cannot — Set/Map iteration order,
  // env-dependent output, or absolute-path leakage that only differs across
  // process boundaries. The child writes to a scratch path via
  // IMPORTER_CONTRACT_OUT so the committed artifact is never touched; the var is
  // scoped to the child env and never leaks into this (parent) process, so the
  // drift check above still reads the canonical location.
  describe('cross-process determinism', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const scratch = path.join(os.tmpdir(), `importer-contract-xproc-${process.pid}.json`);

    afterAll(() => {
      try {
        fs.unlinkSync(scratch);
      } catch {
        // best-effort cleanup; a leftover temp file is harmless.
      }
    });

    it('a fresh subprocess regeneration is byte-identical to the committed artifact', () => {
      execFileSync('npm', ['run', 'contract:importer'], {
        cwd: repoRoot,
        env: {
          ...process.env,
          IMPORTER_CONTRACT_OUT: scratch,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=6144`.trim(),
        },
        stdio: 'ignore',
      });
      const fromSubprocess = fs.readFileSync(scratch, 'utf8');
      const committed = fs.readFileSync(contractOutPath(), 'utf8');
      expect(fromSubprocess).toBe(committed);
    }, 180_000);
  });
});
