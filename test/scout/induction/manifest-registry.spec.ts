import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { InductionManifestV1 } from '../../../src/scout/induction/contract';
import { mappingSpecDigest } from '../../../src/scout/induction/digest';
import {
  buildInductionRegistry,
  INDUCTION_MANIFESTS_DIR,
  loadInductionManifests,
} from '../../../src/scout/induction/manifest-registry';
import { parseInductionManifest } from '../../../src/scout/induction/parse';
import {
  parseSourceMappingSpec,
  type SourceMappingSpec,
} from '../../../src/scout/reconstruct/mapping-spec';
import type { NativeRuleSet } from '../../../src/scout/reconstruct/native/native-rules';
import { loadNativeRuleSets } from '../../../src/scout/reconstruct/native/native-rule-registry';
import { loadSourceMappingSpecs } from '../../../src/scout/reconstruct/source-mapper-registry';
import {
  S10_PURE_MANIFESTS_DIR,
  S10_PURE_SPEC_PATH,
  TEST_KEYS,
} from '../../fixtures/scout/s10_pure/s10-pure-signer';

/**
 * S10-A R20 — the induction package loads only when every D-S10-1 rule holds (V1-V6), and each
 * rule has its own throwing case. The valid synthetic package is the positive control.
 */

const SLUG = 's10_unseen';

function specRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(S10_PURE_SPEC_PATH, 'utf8'));
}
const SPEC = parseSourceMappingSpec(specRaw(), `${SLUG}.json`);

function manifestRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...JSON.parse(readFileSync(join(S10_PURE_MANIFESTS_DIR, `${SLUG}.json`), 'utf8')),
    ...over,
  };
}
const manifest = (over: Record<string, unknown> = {}): InductionManifestV1 =>
  parseInductionManifest(manifestRaw(over), 'test');

function ruleSet(families: NativeRuleSet['families'], platform = SLUG): NativeRuleSet {
  return { specVersion: 1, sourcePlatform: platform, families };
}

function build(
  manifests: InductionManifestV1[],
  specs: SourceMappingSpec[] = [SPEC],
  nativeRuleSets: NativeRuleSet[] = [],
): ReturnType<typeof buildInductionRegistry> {
  return buildInductionRegistry({ manifests, specs, nativeRuleSets });
}

const tmp = (): string => mkdtempSync(join(tmpdir(), 's10a-manifests-'));

describe('R20 — valid synthetic package', () => {
  it('loads the fixture manifest and binds it to its spec digest', () => {
    const manifests = loadInductionManifests(S10_PURE_MANIFESTS_DIR);
    expect(manifests.map((m) => m.sourcePlatform)).toEqual([SLUG]);
    const registry = build(manifests);
    const pkg = registry.packages.get(SLUG);
    expect(pkg?.manifest.expectedFamilies).toEqual(['clients', 'programs', 'workouts']);
    expect(pkg?.manifest.verifiers.map((v) => v.key_id)).toEqual([TEST_KEYS.source.key_id]);
    expect(pkg?.specDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(pkg?.specDigest).toBe(mappingSpecDigest(SPEC));
    expect(registry.specFamilies.get(SLUG)).toEqual(['clients', 'programs', 'workouts']);
  });

  // S10-D P: invariants over WHATEVER ships (a new data-only source adds a manifest without
  // touching this spec), never "the directory is absent". Positive guard: no production platform
  // ships a manifest (no real source key is established, Q1/Q2).
  const PRODUCTION_WITHOUT_MANIFEST = ['truecoach'] as const;
  const shipped = () => ({
    manifests: loadInductionManifests(INDUCTION_MANIFESTS_DIR),
    specs: loadSourceMappingSpecs(),
    nativeRuleSets: loadNativeRuleSets(),
  });

  it('every shipped manifest is a consistent package over the shipped spec and rule sets', () => {
    const input = shipped();
    const registry = buildInductionRegistry(input); // V2/V3/V6 cross-checks throw on a defect
    expect([...registry.packages.keys()].sort()).toEqual(
      input.manifests.map((m) => m.sourcePlatform).sort(),
    );
    for (const m of input.manifests) {
      const spec = input.specs.find((s) => s.sourcePlatform === m.sourcePlatform);
      if (spec === undefined) throw new Error(`no shipped spec for ${m.sourcePlatform}`);
      expect(registry.packages.get(m.sourcePlatform)?.specDigest).toBe(mappingSpecDigest(spec));
    }
    for (const platform of PRODUCTION_WITHOUT_MANIFEST) {
      expect(registry.packages.has(platform)).toBe(false);
    }
  });

  it('the shipped-package invariant still fails on a real defect', () => {
    const input = shipped();
    // A manifest whose spec is not shipped (the orphan defect), whatever else ships.
    const orphan = manifest({ sourcePlatform: 'p-orphan-manifest' });
    expect(() =>
      buildInductionRegistry({ ...input, manifests: [...input.manifests, orphan] }),
    ).toThrow();
    // A production manifest would trip the positive guard.
    const guessed = build(
      [manifest({ sourcePlatform: 'truecoach' })],
      [{ ...SPEC, sourcePlatform: 'truecoach' }],
    );
    expect(PRODUCTION_WITHOUT_MANIFEST.filter((p) => guessed.packages.has(p))).toEqual([
      'truecoach',
    ]);
  });

  it('absent directory → empty; present-but-empty directory throws', () => {
    expect(loadInductionManifests(join(tmp(), 'missing'))).toEqual([]);
    const empty = tmp();
    writeFileSync(join(empty, 'README.txt'), 'not a manifest');
    expect(() => loadInductionManifests(empty)).toThrow(/present but has no \*\.json manifest/);
  });

  it('a mapping spec without a manifest is registered for families only (never provable)', () => {
    const registry = build([]);
    expect(registry.packages.size).toBe(0);
    expect(registry.specFamilies.get(SLUG)).toEqual(['clients', 'programs', 'workouts']);
  });

  it('empty basisKinds lists (never provable) load without a verifier', () => {
    const m = manifest({
      basisKinds: { clients: [], programs: [], workouts: [] },
      verifiers: [],
    });
    expect(m.basisKinds.clients).toEqual([]);
  });
});

describe('R20 — V1 strict keys, version, slug and file name', () => {
  it('throws on an unknown or missing key, a wrong version or a non-canonical slug', () => {
    expect(() => manifest({ extra: 1 })).toThrow(/unknown key manifest\.extra/);
    const missing = manifestRaw();
    delete missing.nativeRules;
    expect(() => parseInductionManifest(missing, 't')).toThrow(/missing key manifest\.nativeRules/);
    expect(() => manifest({ manifestVersion: 2 })).toThrow(/manifestVersion must be 1/);
    expect(() => manifest({ sourcePlatform: 'S10 Unseen' })).toThrow(/canonical platform/);
  });

  it('throws when the file is not named <sourcePlatform>.json, and on invalid JSON', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'other.json'), JSON.stringify(manifestRaw()));
    expect(() => loadInductionManifests(dir)).toThrow(/must be named <sourcePlatform>\.json/);
    const bad = tmp();
    writeFileSync(join(bad, `${SLUG}.json`), '{');
    expect(() => loadInductionManifests(bad)).toThrow(/s10_unseen\.json is not valid JSON/);
  });

  it('throws on unsorted, duplicate, empty or non-canonical expectedFamilies', () => {
    expect(() => manifest({ expectedFamilies: ['workouts', 'clients', 'programs'] })).toThrow(
      /sorted and unique/,
    );
    expect(() => manifest({ expectedFamilies: ['clients', 'clients'] })).toThrow(
      /sorted and unique/,
    );
    expect(() => manifest({ expectedFamilies: [] })).toThrow(/non-empty/);
    expect(() => manifest({ expectedFamilies: ['billing'] })).toThrow(/expectedFamilies/);
  });
});

describe('R20 — V2 exactly one mapping spec with equal families', () => {
  it('throws on a manifest without a spec', () => {
    expect(() => build([manifest()], [])).toThrow(/has no mapping spec/);
  });

  it('throws when expectedFamilies differs from the spec families keys', () => {
    const m = manifest({
      expectedFamilies: ['clients', 'workouts'],
      basisKinds: {
        clients: ['source_signed_enumeration'],
        workouts: ['source_signed_enumeration'],
      },
    });
    expect(() => build([m])).toThrow(/expectedFamilies must equal the mapping spec families/);
  });

  it('throws on two specs for the slug', () => {
    expect(() => build([manifest()], [SPEC, SPEC])).toThrow(/duplicate mapping spec/);
  });
});

describe('R20 — V3 native rules declaration', () => {
  it("'declared' loads with a rule set whose families ⊆ expectedFamilies", () => {
    const registry = build(
      [manifest({ nativeRules: 'declared' })],
      [SPEC],
      [ruleSet({ workouts: {} })],
    );
    expect(registry.packages.get(SLUG)?.manifest.nativeRules).toBe('declared');
  });

  it("throws on 'declared' without a rule set and on 'absent' with one", () => {
    expect(() => build([manifest({ nativeRules: 'declared' })])).toThrow(/contradicts/);
    expect(() => build([manifest()], [SPEC], [ruleSet({ workouts: {} })])).toThrow(/contradicts/);
    expect(() => manifest({ nativeRules: 'maybe' })).toThrow(/declared\|absent/);
  });

  it('throws on rule-set families outside expectedFamilies and on a rule set without a spec', () => {
    const raw = specRaw();
    const families = { ...(raw.families as Record<string, unknown>) };
    delete families.programs;
    const narrow = parseSourceMappingSpec(
      {
        ...raw,
        families,
        steps: { members: 'clients', routines: 'workouts', sessions: 'workouts' },
      },
      'narrow.json',
    );
    const m = manifest({
      expectedFamilies: ['clients', 'workouts'],
      basisKinds: { clients: [], workouts: [] },
      verifiers: [],
      nativeRules: 'declared',
    });
    expect(() => build([m], [narrow], [ruleSet({ programs: {} })])).toThrow(
      /family programs is not in expectedFamilies/,
    );
    expect(() => build([], [SPEC], [ruleSet({}, 'other_source')])).toThrow(
      /native rule set for other_source has no mapping spec/,
    );
  });
});

describe('R20 — V4 basisKinds', () => {
  it('throws when keys differ from expectedFamilies', () => {
    expect(() =>
      manifest({ basisKinds: { clients: ['source_signed_enumeration'], programs: [] } }),
    ).toThrow(/missing key basisKinds\.workouts/);
    expect(() =>
      manifest({
        basisKinds: { clients: [], programs: [], workouts: [], client_history: [] },
      }),
    ).toThrow(/unknown key basisKinds\.client_history/);
  });

  it("throws on 'none', a duplicate, a page-chain or any unknown kind", () => {
    for (const kinds of [
      ['none'],
      ['source_signed_enumeration', 'source_signed_enumeration'],
      ['source_signed_page_chain'],
      ['extension_asserted'],
    ]) {
      expect(() =>
        manifest({ basisKinds: { clients: kinds, programs: [], workouts: [] } }),
      ).toThrow(/unique kinds other than none/);
    }
  });
});

describe('R20 — V5 verifiers', () => {
  const verifier = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    key_id: TEST_KEYS.source.key_id,
    alg: 'ed25519',
    public_key_b64: TEST_KEYS.source.public_key_b64,
    ...over,
  });

  it('throws when basisKinds lists a kind but no verifier exists', () => {
    expect(() => manifest({ verifiers: [] })).toThrow(/requires at least one verifier/);
  });

  it('throws on duplicate key_id, a bad key_id, alg, key length or encoding, or extra keys', () => {
    expect(() => manifest({ verifiers: [verifier(), verifier()] })).toThrow(
      /key_id must be unique/,
    );
    expect(() => manifest({ verifiers: [verifier({ key_id: 'Bad Id' })] })).toThrow(/key_id/);
    expect(() => manifest({ verifiers: [verifier({ alg: 'rsa' })] })).toThrow(
      /alg must be ed25519/,
    );
    const short = Buffer.alloc(31, 1).toString('base64');
    expect(() => manifest({ verifiers: [verifier({ public_key_b64: short })] })).toThrow(
      /32-byte key/,
    );
    const unpadded = TEST_KEYS.source.public_key_b64.replace(/=+$/, '');
    expect(() => manifest({ verifiers: [verifier({ public_key_b64: unpadded })] })).toThrow(
      /32-byte key/,
    );
    expect(() => manifest({ verifiers: [verifier({ custody: 'extension' })] })).toThrow(
      /unknown key verifiers\[0\]\.custody/,
    );
  });

  it('accepts two distinct verifiers (positive control)', () => {
    const m = manifest({
      verifiers: [
        verifier(),
        verifier({ key_id: 'second.key', public_key_b64: TEST_KEYS.observer.public_key_b64 }),
      ],
    });
    expect(m.verifiers).toHaveLength(2);
  });
});

describe('R20 — V6 duplicates', () => {
  it('throws on two manifests for one slug', () => {
    expect(() => build([manifest(), manifest()])).toThrow(
      /duplicate induction manifest for s10_unseen/,
    );
  });
});
