// Shared, deterministic extraction of the tgp-importer public contract from the
// backend's authoritative @nestjs/swagger document. Both the generator CLI
// (export-importer-contract.ts) and the drift test (test/contracts/
// importer-contract.spec.ts) import from here, so there is exactly ONE
// definition of "what the frozen contract is" (R80: the backend is the single
// source of truth; the checked-in artifact is derived, never hand-edited).
import type { OpenAPIObject } from '@nestjs/swagger';

// The importer surfaces, keyed by their BARE path as recorded in the
// OpenAPI document. setGlobalPrefix('api') is applied at runtime only, so the
// document itself records paths without the /api prefix — the extractor re-adds
// it below so the artifact matches the real HTTP routes clients call.
//
// Deliberately EXCLUDED: POST /auth/extension/login. It is extension-facing but
// a thin variant of the general /auth/login (proxies Supabase signInWithPassword,
// returns the raw Supabase session verbatim, only tagging source=extension in the
// audit log). It carries general-auth semantics, not the importer's bespoke
// pairing lifecycle; the contract governs the pairing bootstrap (redeem + refresh)
// instead. See docs/contracts/README.md § "Scope".
export const IMPORTER_BARE_PATHS = [
  '/auth/extension/refresh',
  '/extension/pair/init',
  '/extension/pair/status',
  '/extension/pair/redeem',
  '/scout/ingest',
  '/scout/progress',
  '/scout/ingest/complete',
  '/scout/import/status',
  '/scout/reconstruct',
  '/scout/reconstruct/entities',
  '/scout/reconstruct/roster',
] as const;

// Applied to every selected path so the artifact presents the real,
// externally-callable routes (/api/...).
export const API_PREFIX = '/api';

// The frozen importer contract carries its OWN version, deliberately decoupled
// from package.json / release-please. A routine app version bump must never
// change the artifact bytes (that would fail the drift test with no importer
// change and no regeneration in the release flow). Bump this by hand only when
// the importer surface itself changes in a client-visible way.
export const CONTRACT_VERSION = '1.4.0';

/** Recursively sort object keys so JSON.stringify is byte-stable across runs. */
export function stableSort<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stableSort(v)) as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = stableSort((value as Record<string, unknown>)[key]);
    }
    return out as T;
  }
  return value;
}

/** Collect every `#/components/schemas/NAME` referenced anywhere under `node`. */
function collectRefs(node: unknown, acc: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, acc);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
      if (key === '$ref' && typeof val === 'string') {
        const m = /^#\/components\/schemas\/(.+)$/.exec(val);
        if (m) acc.add(m[1]);
      } else {
        collectRefs(val, acc);
      }
    }
  }
}

/**
 * Collect every security-scheme NAME referenced by a `security` requirement
 * anywhere under `node`. A security requirement is `security: [{ <name>: [] }]`
 * on the document root or an operation; the object keys are the scheme names.
 */
function collectSecuritySchemeNames(node: unknown, acc: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectSecuritySchemeNames(item, acc);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'security' && Array.isArray(val)) {
        for (const requirement of val) {
          if (requirement && typeof requirement === 'object') {
            for (const name of Object.keys(requirement as Record<string, unknown>)) {
              acc.add(name);
            }
          }
        }
      }
      collectSecuritySchemeNames(val, acc);
    }
  }
}

/**
 * Slice the importer-only contract out of the full OpenAPI document:
 *   - keep only the importer paths, re-prefixed with /api
 *   - keep only the component schemas those paths reference (transitively)
 *   - keep only the security schemes those paths actually reference (so an
 *     unrelated global scheme cannot force a false-positive importer drift)
 * The result is deep key-sorted so the serialized bytes are deterministic.
 */
export function buildImporterContract(document: OpenAPIObject): OpenAPIObject {
  const paths: Record<string, unknown> = {};
  const refs = new Set<string>();

  for (const bare of IMPORTER_BARE_PATHS) {
    const item = document.paths?.[bare];
    if (!item) {
      throw new Error(
        `importer contract: expected path ${bare} not found in the OpenAPI document. ` +
          'Did a route move, or is a feature flag stripping it from the doc?',
      );
    }
    collectRefs(item, refs);
    paths[`${API_PREFIX}${bare}`] = item;
  }

  // Transitively pull schema dependencies (a kept schema may $ref another).
  const allSchemas = document.components?.schemas ?? {};
  const queue = [...refs];
  while (queue.length) {
    const name = queue.shift() as string;
    const schema = allSchemas[name];
    if (!schema) continue;
    const before = new Set(refs);
    collectRefs(schema, refs);
    for (const r of refs) if (!before.has(r)) queue.push(r);
  }

  const schemas: Record<string, unknown> = {};
  for (const name of refs) {
    if (allSchemas[name]) schemas[name] = allSchemas[name];
  }

  // Keep only the security schemes the selected operations (or the document
  // root) actually reference. Copying all of components.securitySchemes would
  // couple the importer artifact to unrelated global scheme additions, causing
  // false-positive drift; scoping to referenced schemes keeps the slice isolated.
  const securityNames = new Set<string>();
  collectSecuritySchemeNames(paths, securityNames);
  collectSecuritySchemeNames(document.security, securityNames);
  const allSecuritySchemes = document.components?.securitySchemes ?? {};
  const securitySchemes: Record<string, unknown> = {};
  for (const name of securityNames) {
    if (allSecuritySchemes[name]) securitySchemes[name] = allSecuritySchemes[name];
  }

  const contract: OpenAPIObject = {
    openapi: document.openapi,
    info: {
      title: `${document.info.title} — Importer Contract`,
      version: CONTRACT_VERSION,
      description:
        'Frozen public contract for the tgp-importer Chrome extension + mobile ' +
        'pairing surface. Generated from the backend @nestjs/swagger document — ' +
        'do not hand-edit. Run `npm run contract:importer` to regenerate.',
    },
    paths: paths as OpenAPIObject['paths'],
    components: {
      schemas: schemas as NonNullable<OpenAPIObject['components']>['schemas'],
      securitySchemes: securitySchemes as NonNullable<
        OpenAPIObject['components']
      >['securitySchemes'],
    },
  };

  return stableSort(contract);
}

/** Canonical on-disk serialization: sorted JSON, 2-space indent, trailing NL. */
export function serializeContract(contract: OpenAPIObject): string {
  return JSON.stringify(contract, null, 2) + '\n';
}
