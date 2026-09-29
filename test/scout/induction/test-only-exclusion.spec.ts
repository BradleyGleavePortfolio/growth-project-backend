import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import type { InductionManifestV1 } from '../../../src/scout/induction/contract';
import { mappingSpecDigest, stagedFamilyDigests } from '../../../src/scout/induction/digest';
import {
  buildInductionRegistry,
  INDUCTION_MANIFESTS_DIR,
  loadInductionManifests,
  testOnlyArtifactsAllowed,
  type InductionRegistry,
} from '../../../src/scout/induction/manifest-registry';
import {
  listsVerifierBoundKind,
  parseInductionManifest,
  parseInductionManifestForRuntime,
} from '../../../src/scout/induction/parse';
import { reconcile } from '../../../src/scout/reconciliation/reconcile';
import type { FamilyFacts, ReconciliationFacts } from '../../../src/scout/reconciliation/types';
import {
  evaluateCoverage,
  type CoverageEvaluationInput,
  type StoredObservation,
} from '../../../src/scout/induction/verify';
import { parseSourceMappingSpec } from '../../../src/scout/reconstruct/mapping-spec';
import {
  buildNativeRuleRegistry,
  loadNativeRuleSets,
} from '../../../src/scout/reconstruct/native/native-rule-registry';
import {
  buildSourceMapperRegistry,
  loadSourceMappingSpecs,
} from '../../../src/scout/reconstruct/source-mapper-registry';
import {
  buildSourceRegistries,
  composeRunArtifacts,
  SourceRegistryProvider,
  type RegistryDb,
  type RunPackage,
  type SourceArtifacts,
} from '../../../src/scout/reconstruct/source-registry.provider';
import { partitionInductionRegistry } from '../../../src/scout/reconciliation/facts.service';
import {
  evidenceFor,
  referenceIdDigest,
  S10_PURE_MANIFESTS_DIR,
  S10_PURE_SPEC_PATH,
  sha256,
  TEST_KEYS,
} from '../../fixtures/scout/s10_pure/s10-pure-signer';

/**
 * S12-B2 — TEST-ONLY induction artifacts are refused outside an explicit development/test runtime
 * (closes S10-D D2 review C1). The marker is data (`"testOnly": true` on a manifest,
 * `"test_only": true` on a verifier); the loader refuses marked artifacts unless NODE_ENV is
 * exactly development|test (trimmed, case-insensitive), so an unset NODE_ENV fails closed. The
 * refusing cases are discriminating: the same signed evidence proves three known families when the
 * artifact is allowed and none when it is refused.
 *
 * L3 r3 (executive reset 2026-09-29 §1; L0 r5/r6 D-L0-6 "`complete` is unreachable until CL",
 * L14 "a `source_signed_enumeration` manifest is refused outside dev/test"; closes
 * `R589-c7A-01`): the refusal is on the KIND as well as on the markers. A manifest listing
 * `source_signed_enumeration` — the only kind the evaluator turns into `known: true`, from which
 * S9 settles `complete` — is refused in a refusing runtime whether or not it is marked. The r2
 * "positive control" (an unmarked signed manifest proves with refusal on) was exactly the path
 * `R589-c7A-01` reproduced; it is inverted below and the discriminating control moves to the
 * allowing mode.
 */

type Family = 'clients' | 'programs' | 'workouts';
const FAMILIES: readonly Family[] = ['clients', 'programs', 'workouts'];
const IDS: Record<Family, string[]> = {
  clients: ['c1', 'c2'],
  programs: ['p1'],
  workouts: ['w1', 'w2', 'w3'],
};
const SLUG = 's10_unseen';
const SCOPE = sha256('workspace-1');
const CHALLENGE = Buffer.alloc(32, 9);
const RUN = {
  coach_id: 'coach-a',
  intent_id: 'intent-1',
  execution_epoch: 3,
  accepted_start_at: new Date('2026-09-26T09:00:00Z'),
};
const RECEIVED = new Date('2026-09-26T11:00:00Z');

const SPEC = parseSourceMappingSpec(
  JSON.parse(readFileSync(S10_PURE_SPEC_PATH, 'utf8')),
  `${SLUG}.json`,
);
const FIXTURE_RAW: Record<string, unknown> = JSON.parse(
  readFileSync(join(S10_PURE_MANIFESTS_DIR, `${SLUG}.json`), 'utf8'),
);
const FIXTURE_VERIFIER = (FIXTURE_RAW.verifiers as Record<string, unknown>[])[0];
const OTHER_VERIFIER = {
  key_id: 's12b2.other.key',
  alg: 'ed25519',
  public_key_b64: TEST_KEYS.observer.public_key_b64,
};

/** The fixture manifest marked at manifest level. */
const markedManifest = (): Record<string, unknown> => ({ ...FIXTURE_RAW, testOnly: true });
/** The fixture manifest whose signing verifier is marked, plus an unmarked other key. */
const markedVerifier = (): Record<string, unknown> => ({
  ...FIXTURE_RAW,
  verifiers: [{ ...FIXTURE_VERIFIER, test_only: true }, OTHER_VERIFIER],
});
/** The same two verifiers on a manifest listing only the replay kind (no verifier-bound kind). */
const markedVerifierReplayOnly = (): Record<string, unknown> => ({
  ...markedVerifier(),
  basisKinds: { clients: [REPLAY], programs: [REPLAY], workouts: [REPLAY] },
});
const SIGNED = 'source_signed_enumeration';
const REPLAY = 'replay_terminal_enumeration';

function dirWith(raw: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 's12b2-manifests-'));
  writeFileSync(join(dir, `${SLUG}.json`), JSON.stringify(raw));
  return dir;
}

function registry(manifests: readonly InductionManifestV1[]): InductionRegistry {
  return buildInductionRegistry({ manifests, specs: [SPEC], nativeRuleSets: [] });
}

function evaluate(reg: InductionRegistry, slug = SLUG): ReturnType<typeof evaluateCoverage> {
  // The spec digest does not depend on the manifest, so the evidence is identical in every mode
  // (when the package was refused, the digest of the fixture spec keeps the evidence well-formed).
  const specDigest = reg.packages.get(slug)?.specDigest ?? mappingSpecDigest(SPEC)!;
  const observations: StoredObservation[] = FAMILIES.map((family) => ({
    coach_id: RUN.coach_id,
    intent_id: RUN.intent_id,
    execution_epoch: RUN.execution_epoch,
    received_at: RECEIVED,
    evidence: evidenceFor(
      {
        statement_version: 1,
        source_platform: slug,
        account_scope_id_digest: SCOPE,
        family,
        challenge_b64: CHALLENGE.toString('base64'),
        snapshot_ref_digest: sha256(`snapshot-${family}`),
        date_window: null,
        terminal: 'end_of_list',
        observed_unique: IDS[family].length,
        id_set_digest: referenceIdDigest(IDS[family]),
        issued_at: '2026-09-26T10:00:00Z',
      },
      specDigest,
    ),
  }));
  const input: CoverageEvaluationInput = {
    run: RUN,
    declaration: {
      challenge: CHALLENGE,
      platforms: [{ source_platform: slug, account_scope_id_digests: [SCOPE] }],
    },
    registry: reg,
    observations,
    staged: [
      {
        source_platform: slug,
        grouped_families: FAMILIES,
        families: stagedFamilyDigests(Object.entries(IDS)),
        steps: new Map(),
      },
    ],
  };
  return evaluateCoverage(input);
}

const KNOWN = (n: number) => ({
  known: true,
  basis_kind: 'source_signed_enumeration',
  observed_unique: n,
  covers_staged_identities: true,
});
const PROVEN = { clients: KNOWN(2), programs: KNOWN(1), workouts: KNOWN(3) };
const UNPROVEN = {
  clients: { known: false },
  programs: { known: false },
  workouts: { known: false },
};

/** Native-clean S9 facts over the fixture ids, so only coverage can block `complete`. */
function verdictOf(coverage: ReturnType<typeof evaluateCoverage>) {
  const kinds = { clients: 'person', programs: 'workout_program', workouts: 'workout_plan' } as const;
  const families = FAMILIES.map(
    (family): FamilyFacts => ({
      family,
      mapped: true,
      resolution_reason: null,
      client_owned: false,
      ceiling_exceeded: false,
      identities: IDS[family].map((identity): FamilyFacts['identities'][number] => ({
        token: family,
        identity,
        ledger: {
          status: 'reconstructed',
          target_kind: kinds[family],
          provenance: { outcome: 'created', native: 'present_owned', reason: null, unresolved_children: {} },
        },
        client_linked: false,
      })),
      ledger_without_staged: 0,
      qualifiers: [],
    }),
  );
  const facts: ReconciliationFacts = {
    claim: 'success',
    families,
    relationships: [],
    spec_families: FAMILIES,
    ledger_without_staged: 0,
    coverage,
  };
  return reconcile(facts).verdict;
}

function withNodeEnv<T>(value: string | undefined, run: () => T): T {
  const saved = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
  try {
    return run();
  } finally {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
  }
}

async function withNodeEnvAsync<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const saved = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
  }
}

const REFUSING_ENVS: readonly (string | undefined)[] = [
  undefined,
  '',
  '   ',
  'production',
  'PRODUCTION',
  'Production ',
  'staging',
  'Staging',
  'prod',
  'qa',
  'ci',
  'develop',
  'testing',
];
const ALLOWING_ENVS: readonly string[] = ['test', 'development', 'TEST', ' Development '];
const label = (v: string | undefined): string => (v === undefined ? 'unset' : JSON.stringify(v));

describe('positive control — the unmarked signed package proves in the allowing mode only (L3 r3)', () => {
  it('allowing, an unmarked manifest is byte-for-byte the plain manifest; refusing, it is refused for its kind', () => {
    const plain = parseInductionManifest(FIXTURE_RAW, 'plain');
    expect(parseInductionManifestForRuntime(FIXTURE_RAW, 'plain', false)).toEqual(plain);
    expect(parseInductionManifestForRuntime(FIXTURE_RAW, 'plain', true)).toBeNull();
  });

  it('allowing, the unmarked manifest yields three known families (the S10/S11 harness path)', () => {
    expect(evaluate(registry(loadInductionManifests(dirWith(FIXTURE_RAW), false)))).toEqual(PROVEN);
  });

  it('R589-c7A-01: refusing, an UNMARKED valid signed manifest with valid signed evidence is not loaded — every family unknown, the run settles partial, never complete', () => {
    const refused = loadInductionManifests(dirWith(FIXTURE_RAW), true);
    expect(refused).toEqual([]);
    const facts = evaluate(registry(refused));
    expect(facts).toEqual(UNPROVEN);
    expect(verdictOf(facts)).toEqual({ outcome: 'partial', reason_code: 'coverage_basis_unknown' });
    // The same package and evidence in the allowing mode DO reach complete: the runtime, not the
    // evidence, is what closes the path (discriminating control).
    const allowed = evaluate(registry(loadInductionManifests(dirWith(FIXTURE_RAW), false)));
    expect(verdictOf(allowed)).toEqual({ outcome: 'complete', reason_code: null });
  });

  it('R589-c7A-01: the kind rule is independent of labels — a signed kind on ONE family refuses the whole manifest; a replay-only manifest with verifiers is kept, its marked verifier dropped', () => {
    const oneSigned = {
      ...FIXTURE_RAW,
      basisKinds: { clients: [SIGNED], programs: [REPLAY], workouts: [REPLAY] },
    };
    expect(parseInductionManifestForRuntime(oneSigned, 'one', true)).toBeNull();
    expect(parseInductionManifestForRuntime(oneSigned, 'one', false)).not.toBeNull();
    const replayOnly = {
      ...FIXTURE_RAW,
      basisKinds: { clients: [REPLAY], programs: [REPLAY], workouts: [REPLAY] },
      verifiers: [{ ...FIXTURE_VERIFIER, test_only: true }, OTHER_VERIFIER],
    };
    const kept = parseInductionManifestForRuntime(replayOnly, 'replay', true);
    expect(kept?.verifiers.map((v) => v.key_id)).toEqual([OTHER_VERIFIER.key_id]);
    expect(kept?.basisKinds.clients).toEqual([REPLAY]);
    expect(listsVerifierBoundKind(parseInductionManifest(replayOnly, 'r'))).toBe(false);
    expect(listsVerifierBoundKind(parseInductionManifest(oneSigned, 'o'))).toBe(true);
  });
});

describe('R589-c7B2-01 — the kind refusal holds at the registry boundary every package passes (L3 r4)', () => {
  /** The auditor's pinned-package case: the UNMARKED signed fixture manifest as a run's `RunPackage`. */
  const PINNED: RunPackage = {
    spec: SPEC,
    nativeRuleSet: null,
    manifest: parseInductionManifest(FIXTURE_RAW, 'pin'),
  };
  /** File artifacts that do not define the slug (the pin is the only definition of it). */
  const NO_FILES: SourceArtifacts = { specs: [], nativeRuleSets: [], manifests: [] };
  const NO_DB = {} as RegistryDb;

  it('buildInductionRegistry drops a manifest listing source_signed_enumeration in a refusing runtime, whichever path supplied it; a replay-only manifest stays', () => {
    const signed = parseInductionManifest(FIXTURE_RAW, 'signed');
    const replayOnly = parseInductionManifest(
      { ...FIXTURE_RAW, basisKinds: { clients: [REPLAY], programs: [REPLAY], workouts: [REPLAY] }, verifiers: [] },
      'replay',
    );
    for (const value of REFUSING_ENVS) {
      withNodeEnv(value, () => {
        expect(registry([signed]).packages.has(SLUG)).toBe(false);
        expect(registry([replayOnly]).packages.has(SLUG)).toBe(true);
      });
    }
    for (const value of ALLOWING_ENVS) {
      withNodeEnv(value, () => {
        expect(registry([signed]).packages.get(SLUG)?.manifest).toEqual(signed);
      });
    }
    // The explicit switch overrides the runtime default both ways.
    expect(
      buildInductionRegistry({ manifests: [signed], specs: [SPEC], nativeRuleSets: [], refuseVerifierBoundKinds: true }).packages.has(SLUG),
    ).toBe(false);
    expect(
      buildInductionRegistry({ manifests: [signed], specs: [SPEC], nativeRuleSets: [], refuseVerifierBoundKinds: false }).packages.has(SLUG),
    ).toBe(true);
  });

  it('a defective signed manifest still fails loudly before it is dropped (validated, then refused)', () => {
    const mismatched = parseInductionManifest(
      { ...FIXTURE_RAW, expectedFamilies: ['clients', 'workouts'], basisKinds: { clients: [SIGNED], workouts: [SIGNED] } },
      'defective',
    );
    withNodeEnv('production', () => {
      expect(() => registry([mismatched])).toThrow(/expectedFamilies must equal the mapping spec families/);
    });
  });

  it.each(REFUSING_ENVS.map((v) => [label(v), v]))(
    'NODE_ENV %s: the auditor\'s pinned package (composeRunArtifacts → buildSourceRegistries) with valid signed evidence yields every family unknown and the run settles partial, never complete',
    (_name, value) => {
      withNodeEnv(value, () => {
        const composed = buildSourceRegistries(composeRunArtifacts(NO_FILES, PINNED));
        expect(composed.induction.packages.has(SLUG)).toBe(false);
        expect(composed.sourceMappers.has(SLUG)).toBe(true); // the spec still maps rows; only the closure is gone
        const facts = evaluate(composed.induction);
        expect(facts).toEqual(UNPROVEN);
        expect(verdictOf(facts)).toEqual({ outcome: 'partial', reason_code: 'coverage_basis_unknown' });
      });
    },
  );

  it.each(ALLOWING_ENVS.map((v) => [label(v), v]))(
    'NODE_ENV %s: the same pinned package proves and reaches complete (discriminating control: the runtime, not the evidence, closes the path)',
    (_name, value) => {
      withNodeEnv(value, () => {
        const composed = buildSourceRegistries(composeRunArtifacts(NO_FILES, PINNED));
        expect(composed.induction.packages.get(SLUG)?.manifest).toEqual(PINNED.manifest);
        const facts = evaluate(composed.induction);
        expect(facts).toEqual(PROVEN);
        expect(verdictOf(facts)).toEqual({ outcome: 'complete', reason_code: null });
      });
    },
  );

  it('through SourceRegistryProvider.forRun with an overriding RUN_PACKAGE_SOURCE (the L2b seam): refusing → partial; allowing → complete', async () => {
    // The provider composes over the REPOSITORY files, which already define the fixture slug, so
    // the pin carries the same package under a slug the files do not define.
    const learned = `${SLUG}_learned`;
    const learnedPin: RunPackage = {
      spec: parseSourceMappingSpec(
        { ...JSON.parse(readFileSync(S10_PURE_SPEC_PATH, 'utf8')), sourcePlatform: learned },
        `${learned}.json`,
      ),
      nativeRuleSet: null,
      manifest: parseInductionManifest({ ...FIXTURE_RAW, sourcePlatform: learned }, 'learned-pin'),
    };
    const provider = new SourceRegistryProvider({ forRun: () => Promise.resolve(learnedPin) });
    // The registry is composed AFTER the pin read resolves, so the runtime is held across the await.
    const refused = await withNodeEnvAsync('production', () => provider.forRun(NO_DB, RUN.coach_id, RUN.intent_id));
    expect(refused.pinned).toBe(learnedPin);
    expect(refused.sourceMappers.has(learned)).toBe(true);
    expect(refused.induction.packages.has(learned)).toBe(false);
    expect(verdictOf(evaluate(refused.induction, learned))).toEqual({ outcome: 'partial', reason_code: 'coverage_basis_unknown' });
    const allowed = await withNodeEnvAsync('test', () => provider.forRun(NO_DB, RUN.coach_id, RUN.intent_id));
    expect(allowed.induction.packages.has(learned)).toBe(true);
    expect(verdictOf(evaluate(allowed.induction, learned))).toEqual({ outcome: 'complete', reason_code: null });
  });

  it('through a mapper partition (partitionInductionRegistry): the signed manifest is dropped in a refusing runtime', () => {
    const files: SourceArtifacts = { specs: [SPEC], nativeRuleSets: [], manifests: [PINNED.manifest!] };
    const mappers = buildSourceMapperRegistry([SPEC]);
    const rules = buildNativeRuleRegistry([]);
    withNodeEnv('production', () => {
      expect(partitionInductionRegistry(files, mappers, rules).packages.has(SLUG)).toBe(false);
    });
    withNodeEnv('test', () => {
      expect(partitionInductionRegistry(files, mappers, rules).packages.has(SLUG)).toBe(true);
    });
  });
});

describe('refusal of each TEST-ONLY artifact kind (explicit refuseTestOnly)', () => {
  it('manifest: allowed → loaded and proves; refused → not loaded, every family unknown', () => {
    const dir = dirWith(markedManifest());
    const allowed = loadInductionManifests(dir, false);
    expect(allowed.map((m) => m.sourcePlatform)).toEqual([SLUG]);
    expect(evaluate(registry(allowed))).toEqual(PROVEN);

    const refused = loadInductionManifests(dir, true);
    expect(refused).toEqual([]);
    expect(evaluate(registry(refused))).toEqual(UNPROVEN);
  });

  it('verifier (key): allowed → both keys kept and proves; refused → the signed manifest is refused for its kind (L3 r3), and a replay-only manifest drops the marked key', () => {
    const dir = dirWith(markedVerifier());
    const allowed = loadInductionManifests(dir, false);
    expect(allowed[0].verifiers.map((v) => v.key_id)).toEqual([
      FIXTURE_VERIFIER.key_id,
      OTHER_VERIFIER.key_id,
    ]);
    expect(evaluate(registry(allowed))).toEqual(PROVEN);

    const refused = loadInductionManifests(dir, true);
    expect(refused).toEqual([]);
    expect(evaluate(registry(refused))).toEqual(UNPROVEN);

    const replayDir = dirWith(markedVerifierReplayOnly());
    const kept = loadInductionManifests(replayDir, true);
    expect(kept.map((m) => m.sourcePlatform)).toEqual([SLUG]);
    expect(kept[0].verifiers.map((v) => v.key_id)).toEqual([OTHER_VERIFIER.key_id]);
    expect(Object.isFrozen(kept[0].verifiers)).toBe(true);
    expect(evaluate(registry(kept))).toEqual(UNPROVEN); // signed evidence binds to no listed kind
  });

  it('allowed mode strips the marker: the result equals the unmarked manifest', () => {
    const plain = parseInductionManifest(FIXTURE_RAW, 'plain');
    expect(parseInductionManifestForRuntime(markedManifest(), 'm', false)).toEqual(plain);
    expect(parseInductionManifest(markedManifest(), 'm')).toEqual(plain);
    expect(parseInductionManifest(markedManifest(), 'm')).not.toHaveProperty('testOnly');
    const verifiers = parseInductionManifest(markedVerifier(), 'v').verifiers;
    expect(verifiers[0]).toEqual(plain.verifiers[0]);
    expect(verifiers[0]).not.toHaveProperty('test_only');
  });

  it('the caller-supplied raw object is never mutated', () => {
    const raw = markedVerifier();
    const before = JSON.stringify(raw);
    parseInductionManifestForRuntime(raw, 'r', true);
    parseInductionManifestForRuntime(raw, 'r', false);
    expect(JSON.stringify(raw)).toBe(before);
  });
});

describe('default loader — refuses unless NODE_ENV is explicitly development|test', () => {
  it.each(REFUSING_ENVS.map((v) => [label(v), v]))('NODE_ENV %s refuses', (_name, value) => {
    const manifestDir = dirWith(markedManifest());
    const verifierDir = dirWith(markedVerifier());
    const unmarkedDir = dirWith(FIXTURE_RAW);
    const replayDir = dirWith(markedVerifierReplayOnly());
    withNodeEnv(value, () => {
      expect(testOnlyArtifactsAllowed(process.env.NODE_ENV)).toBe(false);
      expect(loadInductionManifests(manifestDir)).toEqual([]);
      expect(loadInductionManifests(verifierDir)).toEqual([]);
      // L3 r3 / R589-c7A-01: the unmarked signed manifest is refused by kind in this runtime.
      expect(loadInductionManifests(unmarkedDir)).toEqual([]);
      expect(evaluate(registry(loadInductionManifests(unmarkedDir)))).toEqual(UNPROVEN);
      const kept = loadInductionManifests(replayDir);
      expect(kept[0].verifiers.map((v) => v.key_id)).toEqual([OTHER_VERIFIER.key_id]);
    });
  });

  it.each(ALLOWING_ENVS.map((v) => [label(v), v]))('NODE_ENV %s loads', (_name, value) => {
    const manifestDir = dirWith(markedManifest());
    const verifierDir = dirWith(markedVerifier());
    withNodeEnv(value, () => {
      expect(testOnlyArtifactsAllowed(process.env.NODE_ENV)).toBe(true);
      const loaded = loadInductionManifests(manifestDir);
      expect(loaded.map((m) => m.sourcePlatform)).toEqual([SLUG]);
      expect(evaluate(registry(loaded))).toEqual(PROVEN);
      expect(loadInductionManifests(verifierDir)[0].verifiers).toHaveLength(2);
    });
  });

  it('this jest process runs with NODE_ENV=test (every landed no-DB/PG proof keeps its package)', () => {
    expect(process.env.NODE_ENV).toBe('test');
  });
});

describe('the marker is strict data', () => {
  it.each([false, 'true', 1, null, 0])('testOnly %p throws in both modes', (value) => {
    const raw = { ...FIXTURE_RAW, testOnly: value };
    expect(() => parseInductionManifestForRuntime(raw, 'x', true)).toThrow(
      /manifest\.testOnly must be true when present/,
    );
    expect(() => parseInductionManifestForRuntime(raw, 'x', false)).toThrow(
      /manifest\.testOnly must be true when present/,
    );
  });

  it.each([false, 'true', 1, null])('verifier test_only %p throws in both modes', (value) => {
    const raw = { ...FIXTURE_RAW, verifiers: [{ ...FIXTURE_VERIFIER, test_only: value }] };
    for (const refuse of [true, false]) {
      expect(() => parseInductionManifestForRuntime(raw, 'x', refuse)).toThrow(
        /verifiers\[0\]\.test_only must be true when present/,
      );
    }
  });

  it('markers are per object: the other casing is an unknown key', () => {
    expect(() => parseInductionManifest({ ...FIXTURE_RAW, test_only: true }, 'x')).toThrow(
      /unknown key manifest\.test_only/,
    );
    const raw = { ...FIXTURE_RAW, verifiers: [{ ...FIXTURE_VERIFIER, testOnly: true }] };
    expect(() => parseInductionManifest(raw, 'x')).toThrow(/unknown key verifiers\[0\]\.testOnly/);
  });

  it('a defective TEST-ONLY manifest fails loudly when refusing (validated before refusal)', () => {
    const bad = { ...markedManifest(), manifestVersion: 2 };
    expect(() => parseInductionManifestForRuntime(bad, 'x', true)).toThrow(/manifestVersion/);
    expect(() => loadInductionManifests(dirWith(bad), true)).toThrow(/manifestVersion/);
    const dir = mkdtempSync(join(tmpdir(), 's12b2-name-'));
    writeFileSync(join(dir, 'wrong_name.json'), JSON.stringify(markedManifest()));
    expect(() => loadInductionManifests(dir, true)).toThrow(/must be named <sourcePlatform>\.json/);
    const badKey = {
      ...FIXTURE_RAW,
      verifiers: [{ ...FIXTURE_VERIFIER, test_only: true, alg: 'x' }],
    };
    expect(() => loadInductionManifests(dirWith(badKey), true)).toThrow(/alg must be ed25519/);
  });
});

/** Every committed fixture public key (`signer-test-key.json` anywhere under test/fixtures). */
function committedTestPublicKeys(): Set<string> {
  const keys = new Set<string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name === 'signer-test-key.json') {
        for (const pair of Object.values(JSON.parse(readFileSync(path, 'utf8')))) {
          if (pair !== null && typeof pair === 'object' && 'public_key_b64' in pair) {
            keys.add(String((pair as { public_key_b64: unknown }).public_key_b64));
          }
        }
      }
    }
  };
  walk(join(__dirname, '../../fixtures'));
  return keys;
}

describe('shipped data', () => {
  const committed = committedTestPublicKeys();
  const shippedRaw = readdirSync(INDUCTION_MANIFESTS_DIR)
    .filter((n) => n.endsWith('.json'))
    .map((n) => JSON.parse(readFileSync(join(INDUCTION_MANIFESTS_DIR, n), 'utf8')));

  it('every shipped verifier whose public key is committed under test/fixtures is marked', () => {
    let trusting = 0;
    for (const raw of shippedRaw) {
      for (const v of raw.verifiers as Record<string, unknown>[]) {
        if (committed.has(String(v.public_key_b64))) {
          trusting += 1;
          expect(raw.testOnly === true || v.test_only === true).toBe(true);
        }
      }
    }
    expect(committed.size).toBeGreaterThan(0);
    expect(trusting).toBeGreaterThan(0);
  });

  it('refusing, the shipped loader trusts no committed key and the registry still builds', () => {
    const refused = loadInductionManifests(INDUCTION_MANIFESTS_DIR, true);
    for (const m of refused) {
      for (const v of m.verifiers) expect(committed.has(v.public_key_b64)).toBe(false);
    }
    expect(refused.length).toBeLessThan(shippedRaw.length);
    expect(() =>
      buildInductionRegistry({
        manifests: refused,
        specs: loadSourceMappingSpecs(),
        nativeRuleSets: loadNativeRuleSets(),
      }),
    ).not.toThrow();
  });

  it('allowing (this jest runtime), the shipped loader keeps every shipped manifest', () => {
    expect(loadInductionManifests().length).toBe(shippedRaw.length);
    expect(loadInductionManifests(INDUCTION_MANIFESTS_DIR, false).length).toBe(shippedRaw.length);
  });
});

describe('no source slug in the touched src; PG harness env stays inherited', () => {
  const root = join(__dirname, '../../..');

  it('parse.ts and manifest-registry.ts carry no platform slug literal', () => {
    for (const file of ['parse.ts', 'manifest-registry.ts']) {
      const text = readFileSync(join(root, 'src/scout/induction', file), 'utf8');
      for (const slug of ['s10_unseen', 's11_second', 'truecoach', 'conformance_']) {
        expect(text.includes(slug)).toBe(false);
      }
    }
  });

  it('the S10-B/S11 harness and worker sources never set NODE_ENV and forks spread process.env', () => {
    const files = [
      'g2-s10b-pg-harness.ts',
      'g2-s10b-worker.cjs',
      'g2-s10b-db.ts',
      'g2-s10b-harness.ts',
      'g2-s10b-bootstrap.sh',
      'g2-s11-pg-harness.ts',
      'g2-s11-worker.cjs',
      'g2-s11-db.ts',
      'g2-s11-harness.ts',
      'g2-s11-bootstrap.sh',
    ].map((f) => join(root, 'test/utils', f));
    for (const path of files) {
      expect([relative(root, path), readFileSync(path, 'utf8').includes('NODE_ENV')]).toEqual([
        relative(root, path),
        false,
      ]);
    }
    for (const harness of ['g2-s10b-pg-harness.ts', 'g2-s11-pg-harness.ts']) {
      const text = readFileSync(join(root, 'test/utils', harness), 'utf8');
      expect(text).toMatch(
        /fork\([^)]*worker\.cjs'\), \[\], \{[\s\S]*?env: \{\s*\.\.\.process\.env,/,
      );
    }
  });
});
