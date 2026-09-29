import {
  PACKAGE_MAX_BYTES,
  buildLearnedPackage,
  canonicalPackageJson,
  packageDigest,
  packageStepKeys,
  parseLearnedPackage,
  type LearnedPackageV1,
} from '../../../src/scout/learn/package';
import { pathLiteralRefusal } from '../../../src/scout/learn/admission';
import { templateSegments } from '../../../src/scout/learn/digest-contract';
import { everyString, parsedBasic } from './helpers';
import { structureKeyString } from '../../../src/scout/learn/digest-contract';

function unwrap<T>(result: { ok: boolean; value?: T; errors?: unknown }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value as T;
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).reverse())
      out[k] = reverseKeys((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

/** The stored-package invariants (D-L0-5, r4): asserted over every string of the canonical JSON. */
export function assertPackageInvariants(pkg: LearnedPackageV1): void {
  const text = unwrap(canonicalPackageJson(pkg));
  expect(text).not.toMatch(/@/);
  // the pinned contractHash is the one hex field; every other string is digit-run free
  expect(text.replace(pkg.contractHash, '')).not.toMatch(/[0-9]{4}/);
  expect(text).not.toMatch(/authorization|cookie|bearer|x-api-key/i);
  expect(text).not.toMatch(/https?:\/\//);
  everyString(JSON.parse(text), (s) => expect(s).not.toMatch(/[\p{Cc}\p{Cf}]/u));
  for (const step of [...pkg.steps, ...pkg.unmapped]) {
    expect(step.key.template.startsWith('/')).toBe(true);
    for (const seg of templateSegments(step.key.template))
      if (!/^:[ps][0-9]+$/.test(seg)) expect(pathLiteralRefusal(seg)).toBeNull();
    for (const slot of step.key.template.match(/:s[0-9]+/g) ?? [])
      expect(slot).toMatch(/^:s[0-9]+$/);
  }
}

describe('LearnedPackageV1 (D-L0-4/5, V-L9)', () => {
  it('stores steps by template key, never by ref, and carries header names only', () => {
    const { validated } = parsedBasic();
    const pkg = buildLearnedPackage(validated);
    expect(Object.isFrozen(pkg)).toBe(true);
    expect(pkg.steps.map((s) => s.key.template)).toEqual([
      '/v2/coaches/:s1/members',
      '/v2/members/:p1/routines',
      '/v2/notes',
    ]);
    expect(pkg.steps.map((s) => s.key.origin)).toEqual([':d', 'api.:d', ':d']);
    expect(pkg.origins).toEqual([':d', 'api.:d']);
    expect(pkg.contractHash).toMatch(/^[0-9a-f]{64}$/);
    expect(pkg.steps[1].step.parentEdge).toEqual({ field: 'member_id', toStep: 'members' });
    expect(pkg.steps[2].step.family).toBe('notes');
    expect(JSON.stringify(pkg)).not.toContain('destination');
    expect(JSON.stringify(pkg)).not.toMatch(/"templateRef"|"t[0-9]"/);
    expect(pkg.constantHeaderNames).toEqual(['accept']);
    expect(pkg.manifest.verifiers).toEqual([]);
    expect(pkg.unmapped).toEqual([
      {
        key: {
          origin: ':d',
          method: 'GET',
          template: '/v2/billing/invoices',
          keyPaths: ['invoices', 'invoices[].amount', 'invoices[].id'],
        },
        reason: 'out_of_scope_billing',
      },
    ]);
    assertPackageInvariants(pkg);
  });

  it('canonical JSON and package_digest are stable and independent of key order', () => {
    const { validated } = parsedBasic();
    const pkg = buildLearnedPackage(validated);
    const digest1 = unwrap(packageDigest(pkg));
    expect(digest1).toMatch(/^[0-9a-f]{64}$/);
    const reordered = reverseKeys(JSON.parse(JSON.stringify(pkg))) as LearnedPackageV1;
    const parsed = unwrap(parseLearnedPackage(pkg));
    expect(unwrap(packageDigest(parsed))).toBe(digest1);
    expect(unwrap(packageDigest(reordered))).toBe(digest1);
    expect(unwrap(canonicalPackageJson(pkg))).toBe(unwrap(canonicalPackageJson(parsed)));
  });

  it('round-trips through the strict parser and lists step keys', () => {
    const { validated } = parsedBasic();
    const pkg = buildLearnedPackage(validated);
    const back = unwrap(parseLearnedPackage(JSON.parse(unwrap(canonicalPackageJson(pkg)))));
    expect(back).toEqual(JSON.parse(JSON.stringify(pkg)));
    expect(packageStepKeys(back)).toEqual(
      validated.steps.map((s) => structureKeyString(s.structureKey)).sort(),
    );
  });

  it('refuses a package over 64 KiB', () => {
    const { validated } = parsedBasic();
    const pkg = buildLearnedPackage(validated);
    const fat = {
      ...pkg,
      constantHeaderNames: Array.from({ length: 16 }, (_, i) => `x-${'a'.repeat(60)}-${i}`),
    } as LearnedPackageV1;
    const padded = { ...fat, unmapped: Array.from({ length: 64 }, () => fat.unmapped[0]) };
    const huge = {
      ...padded,
      mappingSpec: { ...padded.mappingSpec, sourcePlatform: 'a'.repeat(70_000) },
    } as LearnedPackageV1;
    const result = canonicalPackageJson(huge);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].code).toBe('V-L9');
    expect(unwrap(canonicalPackageJson(pkg)).length).toBeLessThan(PACKAGE_MAX_BYTES);
  });

  describe('strict stored-package parser', () => {
    function stored(): Record<string, any> {
      return JSON.parse(unwrap(canonicalPackageJson(buildLearnedPackage(parsedBasic().validated))));
    }
    it('refuses unknown keys, wrong versions and slug mismatch', () => {
      expect(parseLearnedPackage({ ...stored(), origin: 'https://x' }).ok).toBe(false);
      expect(parseLearnedPackage({ ...stored(), packageVersion: 1 }).ok).toBe(false);
      expect(parseLearnedPackage({ ...stored(), contractHash: 'f'.repeat(64) }).ok).toBe(false);
      expect(parseLearnedPackage({ ...stored(), vocabularyVersion: 9 }).ok).toBe(false);
      expect(parseLearnedPackage({ ...stored(), sourcePlatform: 'example_beta' }).ok).toBe(false);
    });
    it('refuses header values, credential header names, template refs and tenant literals', () => {
      const values = stored();
      values.constantHeaderNames = ['accept: application/json'];
      expect(parseLearnedPackage(values).ok).toBe(false);
      const cred = stored();
      cred.constantHeaderNames = ['authorization'];
      expect(parseLearnedPackage(cred).ok).toBe(false);
      const ref = stored();
      ref.steps[0].key.template = '/v2/coaches/acme-fitness/members';
      expect(parseLearnedPackage(ref).ok).toBe(false);
      const digits = stored();
      digits.steps[0].key.template = '/v2/coaches/48213/members';
      expect(parseLearnedPackage(digits).ok).toBe(false);
      const abs = stored();
      abs.steps[0].key.template = 'https://host.example/v2/members';
      expect(parseLearnedPackage(abs).ok).toBe(false);
    });
    it('refuses tampered embedded artifacts and a manifest with verifiers', () => {
      const spec = stored();
      spec.mappingSpec.families.clients.email = {
        paths: [['email']],
        coerce: 'string_or_finite_number',
      };
      expect(parseLearnedPackage(spec).ok).toBe(false);
      const manifest = stored();
      manifest.manifest.verifiers = ['x'];
      expect(parseLearnedPackage(manifest).ok).toBe(false);
      const declared = stored();
      declared.nativeRules = null;
      expect(parseLearnedPackage(declared).ok).toBe(false);
    });
    it('never throws', () => {
      for (const raw of [
        null,
        1,
        [],
        {},
        { packageVersion: 1 },
        { ...stored(), steps: 'x' },
        { ...stored(), manifest: null },
      ])
        expect(() => parseLearnedPackage(raw)).not.toThrow();
    });
  });
});
