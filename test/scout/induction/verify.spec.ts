import { readFileSync } from 'fs';
import { join } from 'path';
import { stagedFamilyDigests } from '../../../src/scout/induction/digest';
import {
  buildInductionRegistry,
  loadInductionManifests,
  type InductionRegistry,
} from '../../../src/scout/induction/manifest-registry';
import { parseInductionManifest } from '../../../src/scout/induction/parse';
import {
  evaluateCoverage,
  type CoverageEvaluationInput,
  type StagedPlatformFacts,
  type StoredObservation,
} from '../../../src/scout/induction/verify';
import { parseSourceMappingSpec } from '../../../src/scout/reconstruct/mapping-spec';
import { reconcile } from '../../../src/scout/reconciliation/reconcile';
import {
  coverageConditionHolds,
  familyCoverage,
  requiredFamilies,
} from '../../../src/scout/reconciliation/coverage';
import type { FamilyFacts, ReconciliationFacts } from '../../../src/scout/reconciliation/types';
import {
  canonicalStatementBytes,
  evidenceFor,
  OBSERVER_KEY,
  referenceIdDigest,
  S10_PURE_MANIFESTS_DIR,
  S10_PURE_SPEC_PATH,
  sha256,
  signBytes,
  TEST_KEYS,
  type StatementFields,
} from '../../fixtures/scout/s10_pure/s10-pure-signer';

/**
 * S10-A R21-R28 (evaluator tier) — D-S10-3 E1-E6 over the synthetic s10_unseen package and a
 * synthetic source signer. Every negative case changes exactly one thing from the proven
 * baseline (R22) and asserts that ONLY the affected family drops to `{known: false}`, so no
 * refusal is vacuous.
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
const SCOPE_2 = sha256('workspace-2');
const CHALLENGE = Buffer.alloc(32, 9);
const RUN = {
  coach_id: 'coach-a',
  intent_id: 'intent-1',
  execution_epoch: 3,
  accepted_start_at: new Date('2026-09-26T09:00:00Z'),
};
const RECEIVED = new Date('2026-09-26T11:00:00Z');

const SPEC_RAW: Record<string, unknown> = JSON.parse(readFileSync(S10_PURE_SPEC_PATH, 'utf8'));
const MANIFEST_RAW: Record<string, unknown> = JSON.parse(
  readFileSync(join(S10_PURE_MANIFESTS_DIR, `${SLUG}.json`), 'utf8'),
);

/** The fixture package under a (possibly renamed) slug, with optional manifest overrides. */
function registryFor(slug: string, manifestOver: Record<string, unknown> = {}): InductionRegistry {
  const spec = parseSourceMappingSpec({ ...SPEC_RAW, sourcePlatform: slug }, `${slug}.json`);
  const manifest = parseInductionManifest(
    { ...MANIFEST_RAW, sourcePlatform: slug, ...manifestOver },
    `${slug}.json`,
  );
  return buildInductionRegistry({ manifests: [manifest], specs: [spec], nativeRuleSets: [] });
}

const REGISTRY = buildInductionRegistry({
  manifests: loadInductionManifests(S10_PURE_MANIFESTS_DIR),
  specs: [parseSourceMappingSpec(SPEC_RAW, `${SLUG}.json`)],
  nativeRuleSets: [],
});

function digestOf(registry: InductionRegistry, slug: string): string {
  return registry.packages.get(slug)?.specDigest ?? 'missing';
}

function statementFields(
  family: string,
  ids: readonly string[],
  over: StatementFields = {},
  slug = SLUG,
): StatementFields {
  return {
    statement_version: 1,
    source_platform: slug,
    account_scope_id_digest: SCOPE,
    family,
    challenge_b64: CHALLENGE.toString('base64'),
    snapshot_ref_digest: sha256(`snapshot-${family}`),
    date_window: null,
    terminal: 'end_of_list',
    observed_unique: new Set(ids).size,
    id_set_digest: referenceIdDigest(ids),
    issued_at: '2026-09-26T10:00:00Z',
    ...over,
  };
}

function stored(evidence: unknown, over: Partial<StoredObservation> = {}): StoredObservation {
  return {
    coach_id: RUN.coach_id,
    intent_id: RUN.intent_id,
    execution_epoch: RUN.execution_epoch,
    received_at: RECEIVED,
    evidence,
    ...over,
  };
}

/** One valid row per family, with per-family replacements. */
function rows(
  replace: Partial<Record<Family, StoredObservation[]>> = {},
  slug = SLUG,
  registry: InductionRegistry = REGISTRY,
  scope = SCOPE,
): StoredObservation[] {
  return FAMILIES.flatMap(
    (family) =>
      replace[family] ?? [
        stored(
          evidenceFor(
            statementFields(family, IDS[family], { account_scope_id_digest: scope }, slug),
            digestOf(registry, slug),
          ),
        ),
      ],
  );
}

function staged(
  slug = SLUG,
  ids: Partial<Record<string, string[]>> = IDS,
  grouped: readonly string[] = FAMILIES,
): StagedPlatformFacts {
  return {
    source_platform: slug,
    grouped_families: grouped,
    families: stagedFamilyDigests(Object.entries(ids).map(([f, list]) => [f, list ?? []])),
  };
}

function input(over: Partial<CoverageEvaluationInput> = {}): CoverageEvaluationInput {
  return {
    run: RUN,
    declaration: {
      challenge: CHALLENGE,
      platforms: [{ source_platform: SLUG, account_scope_id_digests: [SCOPE] }],
    },
    registry: REGISTRY,
    observations: rows(),
    staged: [staged()],
    ...over,
  };
}

const KNOWN = (n: number, covers = true) => ({
  known: true,
  basis_kind: 'source_signed_enumeration',
  observed_unique: n,
  covers_staged_identities: covers,
});
const UNKNOWN = { known: false };
const BASELINE = { clients: KNOWN(2), programs: KNOWN(1), workouts: KNOWN(3) };

/** Replace one family's row and expect only that family to become unknown. */
function expectOnlyUnknown(family: Family, facts: ReturnType<typeof evaluateCoverage>): void {
  expect(facts).toEqual({ ...BASELINE, [family]: UNKNOWN });
  expect(facts[family]).not.toHaveProperty('observed_unique');
  expect(familyCoverage(facts[family], 'success')).toEqual({
    known: false,
    completeness_basis: 'none',
    observed_unique: null,
  });
}

const clientsRow = (
  statementOver: StatementFields = {},
  parts: Parameters<typeof evidenceFor>[2] = {},
  rowOver: Partial<StoredObservation> = {},
): StoredObservation[] => [
  stored(
    evidenceFor(
      statementFields('clients', IDS.clients, statementOver),
      digestOf(REGISTRY, SLUG),
      parts,
    ),
    rowOver,
  ),
];

describe('R22 — every declared unit verified and covering', () => {
  it('yields known, source_signed_enumeration, the statement count and coverage', () => {
    const facts = evaluateCoverage(input());
    expect(facts).toEqual(BASELINE);
    expect(familyCoverage(facts.clients, 'success')).toEqual({
      known: true,
      completeness_basis: 'source_signed_enumeration',
      observed_unique: 2,
    });
  });
});

describe('R23 — valid statement, identity digest ≠ staged', () => {
  it('is known with covers_staged_identities false and never counts as covered', () => {
    const other = ['c1', 'c-unstaged'];
    const facts = evaluateCoverage(
      input({
        observations: rows({
          clients: [
            stored(evidenceFor(statementFields('clients', other), digestOf(REGISTRY, SLUG))),
          ],
        }),
      }),
    );
    expect(facts).toEqual({ ...BASELINE, clients: KNOWN(2, false) });
    // S9 shows the count with 'none' and C-COV holds → partial/coverage_basis_unknown.
    expect(familyCoverage(facts.clients, 'success')).toEqual({
      known: false,
      completeness_basis: 'none',
      observed_unique: 2,
    });
  });

  it('composes with the pure S9 reconciler: otherwise complete facts → partial / coverage_basis_unknown', () => {
    const other = ['c1', 'c-unstaged'];
    const r23 = evaluateCoverage(
      input({
        observations: rows({
          clients: [
            stored(evidenceFor(statementFields('clients', other), digestOf(REGISTRY, SLUG))),
          ],
        }),
      }),
    );
    expect(r23.clients).toEqual(KNOWN(2, false));
    // Positive control: the same clean facts with the R22 (covering) evaluator output are complete.
    expect(reconcile(cleanFacts(evaluateCoverage(input()))).verdict).toEqual({
      outcome: 'complete',
      reason_code: null,
    });
    const result = reconcile(cleanFacts(r23));
    expect(result.verdict).toEqual({ outcome: 'partial', reason_code: 'coverage_basis_unknown' });
    expect(result.report.conditions).toEqual(['coverage_basis_unknown']);
    // lifecycle/arbiter.ts takes this verdict verbatim at step 3, but the landed RunReasonCode
    // enum does not yet carry the S9 codes: the arbiter/terminal half of R23 is allocated to S10-C.
  });
});

describe('R24 — each alone → known: false, observed_unique: null', () => {
  it('(a) no signature, a non-verifier key_id, or an observer-held key', () => {
    const noSig = evidenceFor(statementFields('clients', IDS.clients), digestOf(REGISTRY, SLUG));
    delete noSig.signature_b64;
    expectOnlyUnknown(
      'clients',
      evaluateCoverage(input({ observations: rows({ clients: [stored(noSig)] }) })),
    );
    const zeroSig = { signature: Buffer.alloc(64) };
    expectOnlyUnknown(
      'clients',
      evaluateCoverage(input({ observations: rows({ clients: clientsRow({}, zeroSig) }) })),
    );
    const bytes = canonicalStatementBytes(statementFields('clients', IDS.clients));
    const observerSigned = { signature: signBytes(bytes, OBSERVER_KEY) };
    expectOnlyUnknown(
      'clients',
      evaluateCoverage(
        input({
          observations: rows({
            clients: clientsRow({}, { ...observerSigned, key_id: TEST_KEYS.observer.key_id }),
          }),
        }),
      ),
    );
    expectOnlyUnknown(
      'clients',
      evaluateCoverage(input({ observations: rows({ clients: clientsRow({}, observerSigned) }) })),
    );
  });

  it('(b) no manifest, or basis_kind ∉ basisKinds[family]', () => {
    const noManifest = buildInductionRegistry({
      manifests: [],
      specs: [parseSourceMappingSpec(SPEC_RAW, `${SLUG}.json`)],
      nativeRuleSets: [],
    });
    expect(evaluateCoverage(input({ registry: noManifest }))).toEqual({
      clients: UNKNOWN,
      programs: UNKNOWN,
      workouts: UNKNOWN,
    });
    const narrow = registryFor(SLUG, {
      basisKinds: {
        clients: [],
        programs: ['source_signed_enumeration'],
        workouts: ['source_signed_enumeration'],
      },
    });
    expectOnlyUnknown('clients', evaluateCoverage(input({ registry: narrow })));
  });

  it('(c) one altered byte of the decoded statement', () => {
    const fields = statementFields('clients', IDS.clients);
    const signature = signBytes(canonicalStatementBytes(fields));
    const altered = canonicalStatementBytes(fields);
    const at = altered.indexOf(Buffer.from(String(fields.snapshot_ref_digest)));
    altered[at] = altered[at] === 0x61 ? 0x62 : 0x61; // still canonical, still 64 hex
    expectOnlyUnknown(
      'clients',
      evaluateCoverage(
        input({
          observations: rows({ clients: clientsRow({}, { statementBytes: altered, signature }) }),
        }),
      ),
    );
  });

  it('(d) challenge ≠ the run challenge (replay from another run)', () => {
    const replay = { challenge_b64: Buffer.alloc(32, 1).toString('base64') };
    expectOnlyUnknown(
      'clients',
      evaluateCoverage(input({ observations: rows({ clients: clientsRow(replay) }) })),
    );
  });

  it('(e) evidence row bound to another coach, intent or epoch', () => {
    for (const rowOver of [
      { coach_id: 'coach-b' },
      { intent_id: 'intent-2' },
      { execution_epoch: 2 },
    ]) {
      expectOnlyUnknown(
        'clients',
        evaluateCoverage(input({ observations: rows({ clients: clientsRow({}, {}, rowOver) }) })),
      );
    }
  });

  it('(f) statement platform, scope (incl. narrower) or family ≠ the unit', () => {
    for (const over of [
      { source_platform: 'other_source' },
      { account_scope_id_digest: sha256('workspace-1/sub-team') },
      { family: 'programs' },
    ]) {
      const fields = statementFields('clients', IDS.clients, over);
      const ev = evidenceFor(fields, digestOf(REGISTRY, SLUG), {
        overrides: { source_platform: SLUG, account_scope_id_digest: SCOPE, family: 'clients' },
      });
      expectOnlyUnknown(
        'clients',
        evaluateCoverage(input({ observations: rows({ clients: [stored(ev)] }) })),
      );
    }
  });

  it('(g) issued_at outside [accepted_start_at, received_at]', () => {
    for (const issued_at of ['2026-09-26T08:59:59.999Z', '2026-09-26T11:00:00.0001Z']) {
      expectOnlyUnknown(
        'clients',
        evaluateCoverage(input({ observations: rows({ clients: clientsRow({ issued_at }) }) })),
      );
    }
    // Boundaries are inclusive (positive control).
    for (const issued_at of ['2026-09-26T09:00:00Z', '2026-09-26T11:00:00.000Z']) {
      expect(
        evaluateCoverage(input({ observations: rows({ clients: clientsRow({ issued_at }) }) })),
      ).toEqual(BASELINE);
    }
  });

  it("(h) non-null date_window or terminal ≠ 'end_of_list'", () => {
    for (const over of [
      { date_window: { from: '2026-01-01T00:00:00Z' } },
      { terminal: 'page_end' },
    ]) {
      expectOnlyUnknown(
        'clients',
        evaluateCoverage(input({ observations: rows({ clients: clientsRow(over) }) })),
      );
    }
  });

  it('(i) mapping_spec_digest mismatch', () => {
    const ev = evidenceFor(statementFields('clients', IDS.clients), sha256('another spec'));
    expectOnlyUnknown(
      'clients',
      evaluateCoverage(input({ observations: rows({ clients: [stored(ev)] }) })),
    );
  });

  it('(j) equal digest with count ≠ staged', () => {
    expectOnlyUnknown(
      'clients',
      evaluateCoverage(
        input({ observations: rows({ clients: clientsRow({ observed_unique: 3 }) }) }),
      ),
    );
  });

  it('(k) any page-chain payload (unknown basis_kind)', () => {
    const chain = { overrides: { basis_kind: 'source_signed_page_chain' } };
    expectOnlyUnknown(
      'clients',
      evaluateCoverage(input({ observations: rows({ clients: clientsRow({}, chain) }) })),
    );
  });

  it('E2: two rows for one unit, or no row, is unknown (never 0)', () => {
    const twice = [
      ...clientsRow(),
      ...clientsRow({ snapshot_ref_digest: sha256('other snapshot') }),
    ];
    expectOnlyUnknown(
      'clients',
      evaluateCoverage(input({ observations: rows({ clients: twice }) })),
    );
    expectOnlyUnknown('clients', evaluateCoverage(input({ observations: rows({ clients: [] }) })));
  });
});

describe('R21 — signature over the base64 text is refused', () => {
  it('verifies only over the decoded canonical bytes', () => {
    const bytes = canonicalStatementBytes(statementFields('clients', IDS.clients));
    const overText = { signature: signBytes(Buffer.from(bytes.toString('base64'), 'utf8')) };
    expectOnlyUnknown(
      'clients',
      evaluateCoverage(input({ observations: rows({ clients: clientsRow({}, overText) }) })),
    );
  });
});

// A second, differently shaped package for multi-platform cases.
const BETA = 's10_beta';
const BETA_SPEC = parseSourceMappingSpec(
  {
    specVersion: 1,
    sourcePlatform: BETA,
    steps: { people: 'clients', log: 'client_history' },
    families: {
      clients: (SPEC_RAW.families as Record<string, unknown>).clients,
      client_history: (SPEC_RAW.families as Record<string, unknown>).workouts,
    },
  },
  `${BETA}.json`,
);
const MULTI = buildInductionRegistry({
  manifests: [
    ...loadInductionManifests(S10_PURE_MANIFESTS_DIR),
    parseInductionManifest(
      {
        ...MANIFEST_RAW,
        sourcePlatform: BETA,
        expectedFamilies: ['client_history', 'clients'],
        basisKinds: {
          client_history: ['source_signed_enumeration'],
          clients: ['source_signed_enumeration'],
        },
      },
      `${BETA}.json`,
    ),
  ],
  specs: [parseSourceMappingSpec(SPEC_RAW, `${SLUG}.json`), BETA_SPEC],
  nativeRuleSets: [],
});

function reconFacts(coverage: ReturnType<typeof evaluateCoverage>): ReconciliationFacts {
  const family: FamilyFacts = {
    family: 'clients',
    mapped: true,
    resolution_reason: null,
    client_owned: false,
    ceiling_exceeded: false,
    identities: [{ token: 'members', identity: 'opaque-1', ledger: null, client_linked: false }],
    ledger_without_staged: 0,
    qualifiers: [],
  };
  return {
    claim: 'success',
    families: [family],
    relationships: [],
    spec_families: FAMILIES,
    ledger_without_staged: 0,
    coverage,
  };
}

/** Native-clean S9 facts matching the baseline staged ids, so only coverage can block `complete`. */
function cleanFacts(coverage: ReturnType<typeof evaluateCoverage>): ReconciliationFacts {
  const kinds = {
    clients: 'person',
    programs: 'workout_program',
    workouts: 'workout_plan',
  } as const;
  const families = FAMILIES.map((family): FamilyFacts => ({
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
        provenance: {
          outcome: 'created',
          native: 'present_owned',
          reason: null,
          unresolved_children: {},
        },
      },
      client_linked: false,
    })),
    ledger_without_staged: 0,
    qualifiers: [],
  }));
  return {
    claim: 'success',
    families,
    relationships: [],
    spec_families: FAMILIES,
    ledger_without_staged: 0,
    coverage,
  };
}

describe('R25 — declaration (E1) and scope rules', () => {
  it('no declaration → every staged family unknown', () => {
    expect(evaluateCoverage(input({ declaration: null }))).toEqual({
      clients: UNKNOWN,
      programs: UNKNOWN,
      workouts: UNKNOWN,
    });
  });

  it('a malformed declaration (wrong challenge length, empty scopes) counts as none', () => {
    const short = {
      challenge: Buffer.alloc(31),
      platforms: [{ source_platform: SLUG, account_scope_id_digests: [SCOPE] }],
    };
    const empty = {
      challenge: CHALLENGE,
      platforms: [{ source_platform: SLUG, account_scope_id_digests: [] }],
    };
    for (const declaration of [short, empty]) {
      expect(Object.values(evaluateCoverage(input({ declaration })))).toEqual([
        UNKNOWN,
        UNKNOWN,
        UNKNOWN,
      ]);
    }
  });

  it('single scope: one declared unit without valid evidence → only that family unknown', () => {
    // One declared scope, so the v1 multi-scope refusal is not the cause; the other units are proven.
    const missing = evaluateCoverage(input({ observations: rows({ programs: [] }) }));
    expect(missing).toEqual({ clients: KNOWN(2), programs: UNKNOWN, workouts: KNOWN(3) });
    const badSig = [
      stored(
        evidenceFor(statementFields('programs', IDS.programs), digestOf(REGISTRY, SLUG), {
          signature: Buffer.alloc(64),
        }),
      ),
    ];
    const invalid = evaluateCoverage(input({ observations: rows({ programs: badSig }) }));
    expect(invalid).toEqual({ clients: KNOWN(2), programs: UNKNOWN, workouts: KNOWN(3) });
    expect(invalid.programs).not.toHaveProperty('observed_unique');
  });

  it('a platform with two declared scopes is unknown in v1, even with every unit proven', () => {
    const declaration = {
      challenge: CHALLENGE,
      platforms: [{ source_platform: SLUG, account_scope_id_digests: [SCOPE, SCOPE_2] }],
    };
    const both = [...rows(), ...rows({}, SLUG, REGISTRY, SCOPE_2)];
    expect(evaluateCoverage(input({ declaration, observations: both }))).toEqual({
      clients: UNKNOWN,
      programs: UNKNOWN,
      workouts: UNKNOWN,
    });
  });

  it('evidence for an undeclared scope never proves the declared one', () => {
    const facts = evaluateCoverage(input({ observations: rows({}, SLUG, REGISTRY, SCOPE_2) }));
    expect(facts).toEqual({ clients: UNKNOWN, programs: UNKNOWN, workouts: UNKNOWN });
  });

  it('a staged row of an undeclared platform makes its families unknown', () => {
    const facts = evaluateCoverage(
      input({
        registry: MULTI,
        staged: [staged(), staged(BETA, { clients: ['b1'] }, ['client_history', 'clients'])],
      }),
    );
    expect(facts).toEqual({ ...BASELINE, clients: UNKNOWN, client_history: UNKNOWN });
  });

  it('a declared, unstaged, unproven platform stays emitted and enters required_families', () => {
    const declaration = {
      challenge: CHALLENGE,
      platforms: [
        { source_platform: SLUG, account_scope_id_digests: [SCOPE] },
        { source_platform: BETA, account_scope_id_digests: [SCOPE_2] },
      ],
    };
    const facts = evaluateCoverage(input({ registry: MULTI, declaration }));
    expect(facts).toEqual({ ...BASELINE, clients: UNKNOWN, client_history: UNKNOWN });
    const recon = reconFacts(facts);
    expect(requiredFamilies(recon)).toEqual(['client_history', 'clients', 'programs', 'workouts']);
    expect(coverageConditionHolds(recon)).toBe(true);
  });

  it('sums counts over platforms when every declared unit of every platform is proven', () => {
    const declaration = {
      challenge: CHALLENGE,
      platforms: [
        { source_platform: SLUG, account_scope_id_digests: [SCOPE] },
        { source_platform: BETA, account_scope_id_digests: [SCOPE] },
      ],
    };
    const betaDigest = digestOf(MULTI, BETA);
    const betaRows = ['clients', 'client_history'].map((family) =>
      stored(evidenceFor(statementFields(family, ['b1'], {}, BETA), betaDigest)),
    );
    const facts = evaluateCoverage(
      input({
        registry: MULTI,
        declaration,
        observations: [...rows({}, SLUG, MULTI), ...betaRows],
        staged: [
          staged(),
          staged(BETA, { clients: ['b1'], client_history: ['b1'] }, ['client_history', 'clients']),
        ],
      }),
    );
    expect(facts).toEqual({ ...BASELINE, clients: KNOWN(3), client_history: KNOWN(1) });
  });
});

describe('R26 — declared family with zero staged rows', () => {
  const zero = (): StoredObservation[] =>
    FAMILIES.map((family) =>
      stored(evidenceFor(statementFields(family, []), digestOf(REGISTRY, SLUG))),
    );

  it('verified observed_unique 0 with the empty-set digest → known and covered', () => {
    const facts = evaluateCoverage(input({ observations: zero(), staged: [] }));
    expect(facts).toEqual({ clients: KNOWN(0), programs: KNOWN(0), workouts: KNOWN(0) });
  });

  it('no evidence → known: false (never 0) → coverage_basis_unknown', () => {
    const facts = evaluateCoverage(input({ observations: [], staged: [] }));
    expect(facts).toEqual({ clients: UNKNOWN, programs: UNKNOWN, workouts: UNKNOWN });
    expect(coverageConditionHolds(reconFacts(facts))).toBe(true);
  });
});

describe('R27 (evaluator half) — evaluator family-set agreement given the caller-supplied grouped_families', () => {
  // Proves only the evaluator side of R27: given a caller-supplied `grouped_families` partition
  // (here a hand-written model of S9-B resolveFamily, facts.service.ts L484-493), the staged digest
  // is taken per that partition and any family-set disagreement is known: false.
  // The production-grouping half of R27 (the real facts.service grouping) is proved in S10-C.
  const steps: Record<string, string> = { plans: 'programs', members: 'clients' };
  const group = (tokens: [string, string][]): [string, string[]][] => {
    const out = new Map<string, string[]>();
    for (const [token, id] of tokens) {
      const family = steps[token] ?? token;
      out.set(family, [...(out.get(family) ?? []), id]);
    }
    return [...out];
  };

  it('a canonical-family token staged without a steps entry is counted in its family digest', () => {
    const grouped = group([
      ['plans', 'p1'],
      ['programs', 'p2'],
      ['members', 'c1'],
      ['members', 'c2'],
    ]);
    const stagedFacts: StagedPlatformFacts = {
      source_platform: SLUG,
      grouped_families: FAMILIES,
      families: stagedFamilyDigests([...grouped, ['workouts', IDS.workouts]]),
    };
    const programs = [
      stored(evidenceFor(statementFields('programs', ['p1', 'p2']), digestOf(REGISTRY, SLUG))),
    ];
    const facts = evaluateCoverage(
      input({ staged: [stagedFacts], observations: rows({ programs }) }),
    );
    expect(facts).toEqual({ ...BASELINE, programs: KNOWN(2) });
  });

  it('a family-set disagreement between the manifest and the caller-supplied grouped_families → known: false', () => {
    const all = { clients: UNKNOWN, programs: UNKNOWN, workouts: UNKNOWN };
    expect(
      evaluateCoverage(input({ staged: [staged(SLUG, IDS, ['clients', 'workouts'])] })),
    ).toEqual(all);
    expect(
      evaluateCoverage(input({ staged: [staged(SLUG, { ...IDS, client_history: ['h1'] })] })),
    ).toEqual(all);
    expect(evaluateCoverage(input({ staged: [staged(), staged()] }))).toEqual(all);
  });

  it('a grouped family missing from the staged digest map is unknown, never the empty set', () => {
    // (a) programs is in grouped_families but has no digest entry; its statement is the
    // empty-set statement, so removing the guard would turn it into known/covered 0.
    const missing: StagedPlatformFacts = {
      ...staged(),
      families: stagedFamilyDigests([
        ['clients', IDS.clients],
        ['workouts', IDS.workouts],
      ]),
    };
    const programs = [
      stored(evidenceFor(statementFields('programs', []), digestOf(REGISTRY, SLUG))),
    ];
    expect(
      evaluateCoverage(input({ staged: [missing], observations: rows({ programs }) })),
    ).toEqual({ ...BASELINE, programs: UNKNOWN });
  });

  it('a family grouped twice on top of the full baseline map is unknown', () => {
    // (b) stagedFamilyDigests takes pairs, so a duplicate is representable; it poisons (null).
    const poisoned: StagedPlatformFacts = {
      ...staged(),
      families: stagedFamilyDigests([
        ['clients', IDS.clients],
        ['clients', ['c9']],
        ['programs', IDS.programs],
        ['workouts', IDS.workouts],
      ]),
    };
    expect(poisoned.families.get('clients')).toBeNull();
    expect(evaluateCoverage(input({ staged: [poisoned] }))).toEqual({
      ...BASELINE,
      clients: UNKNOWN,
    });
  });
});

describe('R28 — metamorphic slug rename', () => {
  const renamed = 'renamed_source_x';
  const renamedRegistry = registryFor(renamed);
  const renamedInput = (replaceClients?: StoredObservation[]): CoverageEvaluationInput =>
    input({
      registry: renamedRegistry,
      declaration: {
        challenge: CHALLENGE,
        platforms: [{ source_platform: renamed, account_scope_id_digests: [SCOPE] }],
      },
      observations: rows(
        replaceClients === undefined ? {} : { clients: replaceClients },
        renamed,
        renamedRegistry,
      ),
      staged: [staged(renamed)],
    });

  it('gives identical facts for the proven baseline and for a failing unit', () => {
    expect(evaluateCoverage(renamedInput())).toEqual(evaluateCoverage(input()));
    expect(evaluateCoverage(renamedInput())).toEqual(BASELINE);
    const mismatched = [
      stored(
        evidenceFor(
          statementFields('clients', ['zz'], {}, renamed),
          digestOf(renamedRegistry, renamed),
        ),
      ),
    ];
    const original = [
      stored(evidenceFor(statementFields('clients', ['zz']), digestOf(REGISTRY, SLUG))),
    ];
    expect(evaluateCoverage(renamedInput(mismatched))).toEqual(
      evaluateCoverage(input({ observations: rows({ clients: original }) })),
    );
  });
});

describe('totality — hostile input never throws', () => {
  it('returns known: false instead of throwing', () => {
    const hostile: unknown[] = [null, 42, 'x', [], { evidence_version: 1 }];
    const facts = evaluateCoverage(
      input({ observations: hostile.map((evidence) => stored(evidence)) }),
    );
    expect(facts).toEqual({ clients: UNKNOWN, programs: UNKNOWN, workouts: UNKNOWN });
    const broken = { source_platform: SLUG, grouped_families: FAMILIES, families: new Map() };
    const badDates = { ...RUN, accepted_start_at: new Date('not a date') };
    expect(() => evaluateCoverage(input({ staged: [broken], run: badDates }))).not.toThrow();
    expect(evaluateCoverage(input({ run: badDates }))).toEqual({
      clients: UNKNOWN,
      programs: UNKNOWN,
      workouts: UNKNOWN,
    });
  });
});
