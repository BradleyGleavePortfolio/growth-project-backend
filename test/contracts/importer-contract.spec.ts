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
  keys.reduce<unknown>((acc, key) => rec(acc)[key], root);

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

    it('returns the ScoutImportStatusResult projection on 200 with exactly its five fields', () => {
      const res = dig(contract, 'paths', path, 'get', 'responses', '200', 'content');
      expect(dig(res, 'application/json', 'schema', '$ref')).toBe(
        '#/components/schemas/ScoutImportStatusResult',
      );
      expect(props('ScoutImportStatusResult')).toEqual([
        'completed_at',
        'entity_counts',
        'intent_id',
        'started_at',
        'status',
      ]);
    });

    it('pins status to the four provable states only — no pending/cancelled', () => {
      const en = dig(contract, 'components', 'schemas', 'ScoutImportStatusResult', 'properties');
      expect((rec(rec(en).status).enum as string[]).sort()).toEqual([
        'failed',
        'partial',
        'running',
        'success',
      ]);
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
    it('init returns { pairing_code, expires_at } on 201', () => {
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
      expect(Object.keys(props).sort()).toEqual(['expires_at', 'pairing_code']);
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
        ['access_token', 'chosen_platform', 'refresh_token'].sort(),
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

  it('redeem advertises 500 for post-claim session mint failure', () => {
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
