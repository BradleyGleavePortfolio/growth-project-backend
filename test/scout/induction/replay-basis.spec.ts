import { readFileSync } from 'fs';
import { join } from 'path';
import {
  evaluateFamilySetClosure,
  exclusionConfirmed,
  reviewedPackageClosures,
  type ClosureGap,
} from '../../../src/scout/induction/closure';
import {
  CLOSURE_EXCLUSION_REASONS,
  type ClosureExclusionReason,
  type ExclusionSignalsV1,
  type FamilySetClosureTemplateV1,
  type FamilySetClosureV1,
  type ReplayStepTerminalV1,
} from '../../../src/scout/induction/contract';
import { stagedFamilyDigests } from '../../../src/scout/induction/digest';
import {
  buildInductionRegistry,
  type InductionRegistry,
} from '../../../src/scout/induction/manifest-registry';
import { parseEvidence, parseInductionManifest } from '../../../src/scout/induction/parse';
import {
  evaluateCoverage,
  evaluateCoverageDetailed,
  type CoverageEvaluationInput,
  type StagedPlatformFacts,
  type StoredObservation,
} from '../../../src/scout/induction/verify';
import { parseSourceMappingSpec } from '../../../src/scout/reconstruct/mapping-spec';
import { familyCoverage } from '../../../src/scout/reconciliation/coverage';
import { reconcile } from '../../../src/scout/reconciliation/reconcile';
import type {
  CoverageFact,
  FamilyFacts,
  ReconciliationFacts,
} from '../../../src/scout/reconciliation/types';
import {
  evidenceFor,
  referenceIdDigest,
  S10_PURE_MANIFESTS_DIR,
  S10_PURE_SPEC_PATH,
  sha256,
  type StatementFields,
} from '../../fixtures/scout/s10_pure/s10-pure-signer';

/**
 * L3 — the `replay_terminal_enumeration` completeness basis (owner D1, 2026-09-28: "complete"
 * means "All past client and coaching records in this site are now in TGP"; L0 D-L0-6 "How a
 * learned source earns a basis") and family-set closure (D-L0-6.1 (i)). Positive case, every L0
 * negative case, the closure-null ⇒ not-complete case, and the proof that no path lets the AI's
 * classification alone produce `complete`. Pure tier: no DB, no Nest.
 */

type Family = 'clients' | 'programs' | 'workouts';
const FAMILIES: readonly Family[] = ['clients', 'programs', 'workouts'];
const IDS: Record<Family, string[]> = {
  clients: ['c1', 'c2'],
  programs: ['p1'],
  workouts: ['w1', 'w2', 'w3'],
};
/** The fixture spec's steps per family (`test/fixtures/scout/s10_pure/mapping`). */
const STEPS: Record<Family, string[]> = {
  clients: ['members'],
  programs: ['plans'],
  workouts: ['routines', 'sessions'],
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
const REPLAY = 'replay_terminal_enumeration';
const SIGNED = 'source_signed_enumeration';

const SPEC_RAW: Record<string, unknown> = JSON.parse(readFileSync(S10_PURE_SPEC_PATH, 'utf8'));
const MANIFEST_RAW: Record<string, unknown> = JSON.parse(
  readFileSync(join(S10_PURE_MANIFESTS_DIR, `${SLUG}.json`), 'utf8'),
);

/** The fixture package with every family provable by the replay kind and NO verifier (a learned package's shape). */
function replayRegistry(slug = SLUG, kinds: readonly string[] = [REPLAY]): InductionRegistry {
  const spec = parseSourceMappingSpec({ ...SPEC_RAW, sourcePlatform: slug }, `${slug}.json`);
  const manifest = parseInductionManifest(
    {
      ...MANIFEST_RAW,
      sourcePlatform: slug,
      basisKinds: { clients: kinds, programs: kinds, workouts: kinds },
      verifiers: kinds.includes(SIGNED) ? MANIFEST_RAW.verifiers : [],
    },
    `${slug}.json`,
  );
  return buildInductionRegistry({ manifests: [manifest], specs: [spec], nativeRuleSets: [] });
}

const REGISTRY = replayRegistry();
const specDigest = (registry: InductionRegistry, slug = SLUG): string =>
  registry.packages.get(slug)?.specDigest ?? 'missing';

function step(name: string, over: Partial<ReplayStepTerminalV1> = {}): ReplayStepTerminalV1 {
  return {
    step: name,
    stop: 'short_page',
    pages_fetched: 3,
    max_pages: 1000,
    refused_pages: 0,
    fan_out: null,
    ...over,
  };
}

/** One valid replay evidence object for a family (steps default to the spec's, all terminal-clean). */
function replayEvidence(
  family: Family,
  over: Record<string, unknown> = {},
  registry: InductionRegistry = REGISTRY,
  slug = SLUG,
): Record<string, unknown> {
  return {
    evidence_version: 1,
    source_platform: slug,
    account_scope_id_digest: SCOPE,
    family,
    basis_kind: REPLAY,
    mapping_spec_digest: specDigest(registry, slug),
    challenge_b64: CHALLENGE.toString('base64'),
    steps: STEPS[family].map((name) => step(name)),
    observed_unique: new Set(IDS[family]).size,
    id_set_digest: referenceIdDigest(IDS[family]),
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

function rows(replace: Partial<Record<Family, StoredObservation[]>> = {}): StoredObservation[] {
  return FAMILIES.flatMap((family) => replace[family] ?? [stored(replayEvidence(family))]);
}

function staged(ids: Partial<Record<string, string[]>> = IDS, slug = SLUG): StagedPlatformFacts {
  return {
    source_platform: slug,
    grouped_families: FAMILIES,
    families: stagedFamilyDigests(Object.entries(ids).map(([f, list]) => [f, list ?? []])),
  };
}

function input(over: Partial<CoverageEvaluationInput> = {}): CoverageEvaluationInput {
  const registry = over.registry ?? REGISTRY;
  return {
    run: RUN,
    declaration: {
      challenge: CHALLENGE,
      platforms: [{ source_platform: SLUG, account_scope_id_digests: [SCOPE] }],
    },
    registry,
    observations: rows(),
    staged: [staged()],
    closure: reviewedPackageClosures(registry),
    ...over,
  };
}

const KNOWN = (n: number, kind = REPLAY) => ({
  known: true,
  basis_kind: kind,
  observed_unique: n,
  covers_staged_identities: true,
});
const UNKNOWN: CoverageFact = { known: false };
const BASELINE = { clients: KNOWN(2), programs: KNOWN(1), workouts: KNOWN(3) };
const ALL_UNKNOWN = { clients: UNKNOWN, programs: UNKNOWN, workouts: UNKNOWN };

/** Replace one family's evidence and expect ONLY that family to become unknown (never 0). */
function expectOnlyUnknown(family: Family, evidence: Record<string, unknown>): void {
  const facts = evaluateCoverage(input({ observations: rows({ [family]: [stored(evidence)] }) }));
  expect(facts).toEqual({ ...BASELINE, [family]: UNKNOWN });
  expect(facts[family]).not.toHaveProperty('observed_unique');
  expect(familyCoverage(facts[family], 'success')).toEqual({
    known: false,
    completeness_basis: 'none',
    observed_unique: null,
  });
}

/** Native-clean S9 facts over the baseline staged ids, so only coverage can block `complete`. */
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

const verdictOf = (coverage: ReturnType<typeof evaluateCoverage>) =>
  reconcile(cleanFacts(coverage)).verdict;

// ── The kind and its manifest rules ─────────────────────────────────────────────────────

describe('L3 — replay_terminal_enumeration is a proving kind a learned package may list without a verifier', () => {
  it('a manifest listing only the replay kind loads with verifiers: [] (D-S10-1 V5, L3 reading)', () => {
    expect(REGISTRY.packages.get(SLUG)?.manifest.verifiers).toEqual([]);
    expect(REGISTRY.packages.get(SLUG)?.manifest.basisKinds.clients).toEqual([REPLAY]);
  });

  it('the source-signed kind still requires a verifier', () => {
    expect(() => replayRegistry(SLUG, [SIGNED]).packages.get(SLUG)).not.toThrow();
    expect(() =>
      parseInductionManifest(
        {
          ...MANIFEST_RAW,
          basisKinds: { clients: [SIGNED], programs: [], workouts: [] },
          verifiers: [],
        },
        't',
      ),
    ).toThrow(/at least one verifier/);
  });

  it('the package exposes the spec steps per family (the replay step cross-check input)', () => {
    const pkg = REGISTRY.packages.get(SLUG);
    expect(pkg?.stepsByFamily.get('clients')).toEqual(['members']);
    expect(pkg?.stepsByFamily.get('programs')).toEqual(['plans']);
    expect(pkg?.stepsByFamily.get('workouts')).toEqual(['routines', 'sessions']);
    expect(pkg?.stepsByFamily.get('client_history')).toBeUndefined();
  });
});

// ── Parser ──────────────────────────────────────────────────────────────────────────────

describe('L3 — parseEvidence: the replay_terminal_enumeration shape', () => {
  const reason = (raw: unknown): string => {
    const r = parseEvidence(raw);
    return r.ok ? 'ok' : r.reason;
  };

  it('parses valid replay evidence and exposes the decoded challenge', () => {
    const result = parseEvidence(replayEvidence('workouts'));
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.basis_kind !== REPLAY) throw new Error('kind');
    expect(result.value.challenge.equals(CHALLENGE)).toBe(true);
    expect(result.value.evidence.steps).toHaveLength(2);
    expect(result.value.evidence.observed_unique).toBe(3);
  });

  it('refuses the signed keys on a replay row and the replay keys on a signed row (strict per-kind key sets)', () => {
    expect(reason({ ...replayEvidence('clients'), key_id: 'k' })).toBe('unknown_key');
    const signed = evidenceFor(
      {
        statement_version: 1,
        source_platform: SLUG,
        account_scope_id_digest: SCOPE,
        family: 'clients',
        challenge_b64: CHALLENGE.toString('base64'),
        snapshot_ref_digest: sha256('s'),
        date_window: null,
        terminal: 'end_of_list',
        observed_unique: 2,
        id_set_digest: referenceIdDigest(IDS.clients),
        issued_at: '2026-09-26T10:00:00Z',
      } satisfies StatementFields,
      specDigest(REGISTRY),
    );
    expect(reason({ ...signed, steps: [] })).toBe('unknown_key');
    const missing = replayEvidence('clients');
    delete missing.id_set_digest;
    expect(reason(missing)).toBe('missing_key');
  });

  it('refuses malformed challenge, steps, counts and digests without throwing', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ challenge_b64: 'not base64!' }, 'bad_base64'],
      [{ challenge_b64: Buffer.alloc(31).toString('base64') }, 'bad_length'],
      [{ steps: [] }, 'bad_step'],
      [{ steps: 'members' }, 'bad_step'],
      [{ steps: Array.from({ length: 17 }, (_, i) => step(`s${i}`)) }, 'too_large'],
      [{ steps: [step('members'), step('members')] }, 'bad_step'],
      [{ steps: [{ ...step('members'), extra: 1 }] }, 'unknown_key'],
      [{ steps: [{ ...step('members'), stop: 'end_of_list' }] }, 'bad_terminal'],
      [{ steps: [step('members', { pages_fetched: -1 })] }, 'bad_count'],
      [{ steps: [step('members', { pages_fetched: 1.5 })] }, 'bad_count'],
      [{ steps: [step('members', { max_pages: 0 })] }, 'bad_count'],
      [{ steps: [{ ...step('members'), fan_out: { expected: 2 } }] }, 'missing_key'],
      [{ steps: [{ ...step('members'), fan_out: 'all' }] }, 'bad_step'],
      [{ steps: [step('')] }, 'bad_step'],
      [{ steps: [step('x'.repeat(257))] }, 'too_large'],
      [{ observed_unique: -1 }, 'bad_count'],
      [{ observed_unique: '2' }, 'bad_count'],
      [{ id_set_digest: 'zz' }, 'bad_digest'],
      [{ basis_kind: 'replay_page_chain' }, 'unknown_key'],
    ];
    for (const [over, expected] of cases) {
      expect([over, reason({ ...replayEvidence('clients'), ...over })]).toEqual([over, expected]);
    }
  });
});

// ── Evaluator: the positive case and every L0 negative case ────────────────────────────

describe('L3 — positive case: every step terminal-clean, digest AND count equal to staged', () => {
  it('yields known, replay_terminal_enumeration, the observed count and coverage', () => {
    const facts = evaluateCoverage(input());
    expect(facts).toEqual(BASELINE);
    expect(familyCoverage(facts.workouts, 'success')).toEqual({
      known: true,
      completeness_basis: REPLAY,
      observed_unique: 3,
    });
  });

  it('composes with the pure S9 reconciler to `complete` (owner D1: the extension-observed basis is approved)', () => {
    expect(verdictOf(evaluateCoverage(input()))).toEqual({
      outcome: 'complete',
      reason_code: null,
    });
  });

  it('a fan-out step that fetched every expected page proves; a zero-row family with the empty digest proves', () => {
    const fanned = replayEvidence('workouts', {
      steps: [
        step('routines'),
        step('sessions', { fan_out: { expected: 2, fetched: 2 }, stop: 'absent_next' }),
      ],
    });
    expect(evaluateCoverage(input({ observations: rows({ workouts: [stored(fanned)] }) }))).toEqual(
      BASELINE,
    );
    const zero = replayEvidence('programs', {
      observed_unique: 0,
      id_set_digest: referenceIdDigest([]),
    });
    const facts = evaluateCoverage(
      input({
        observations: rows({ programs: [stored(zero)] }),
        staged: [staged({ ...IDS, programs: [] })],
      }),
    );
    expect(facts.programs).toEqual(KNOWN(0));
  });

  it('the family token may accompany the spec steps (a canonical-token collection) but never replace them', () => {
    const withToken = replayEvidence('programs', { steps: [step('plans'), step('programs')] });
    expect(
      evaluateCoverage(input({ observations: rows({ programs: [stored(withToken)] }) })),
    ).toEqual(BASELINE);
    expectOnlyUnknown('programs', replayEvidence('programs', { steps: [step('programs')] }));
  });

  it('is metamorphic in the slug: a renamed package gives identical facts', () => {
    const slug = 'zz_renamed_source';
    const registry = replayRegistry(slug);
    const facts = evaluateCoverage({
      run: RUN,
      declaration: {
        challenge: CHALLENGE,
        platforms: [{ source_platform: slug, account_scope_id_digests: [SCOPE] }],
      },
      registry,
      observations: FAMILIES.map((f) => stored(replayEvidence(f, {}, registry, slug))),
      staged: [staged(IDS, slug)],
      closure: reviewedPackageClosures(registry),
    });
    expect(facts).toEqual(BASELINE);
  });
});

describe('L3 — negative cases (each alone → known: false, observed_unique: null; never 0)', () => {
  it('a truncated crawl: any step that stopped at budget_stop, refused_page, retry_exhausted or aborted', () => {
    for (const stop of ['budget_stop', 'refused_page', 'retry_exhausted', 'aborted'] as const) {
      expectOnlyUnknown(
        'clients',
        replayEvidence('clients', { steps: [step('members', { stop })] }),
      );
    }
    // One truncated step among two clean ones truncates the family.
    expectOnlyUnknown(
      'workouts',
      replayEvidence('workouts', {
        steps: [step('routines'), step('sessions', { stop: 'budget_stop' })],
      }),
    );
  });

  it('a step that hit maxPagesPerStep (pages_fetched ≥ max_pages), even with a terminal stop', () => {
    expectOnlyUnknown(
      'clients',
      replayEvidence('clients', {
        steps: [step('members', { pages_fetched: 1000, max_pages: 1000 })],
      }),
    );
    expectOnlyUnknown(
      'clients',
      replayEvidence('clients', {
        steps: [step('members', { pages_fetched: 1001, max_pages: 1000 })],
      }),
    );
  });

  it('a refused page', () => {
    expectOnlyUnknown(
      'clients',
      replayEvidence('clients', { steps: [step('members', { refused_pages: 1 })] }),
    );
  });

  it('a fan-out step short of its id set', () => {
    expectOnlyUnknown(
      'workouts',
      replayEvidence('workouts', {
        steps: [step('routines'), step('sessions', { fan_out: { expected: 3, fetched: 2 } })],
      }),
    );
  });

  it('a step set short of the spec (one of two workouts steps missing) or a step the spec does not map to the family', () => {
    expectOnlyUnknown('workouts', replayEvidence('workouts', { steps: [step('routines')] }));
    expectOnlyUnknown(
      'clients',
      replayEvidence('clients', { steps: [step('members'), step('notes')] }),
    );
    // The clients step reported under the workouts family is not a workouts step.
    expectOnlyUnknown(
      'workouts',
      replayEvidence('workouts', {
        steps: [step('routines'), step('sessions'), step('members')],
      }),
    );
  });

  it('a mismatched digest (the count agrees) or a mismatched count (the digest agrees): both unknown, count dropped', () => {
    expectOnlyUnknown(
      'clients',
      replayEvidence('clients', { id_set_digest: referenceIdDigest(['c1', 'c-unstaged']) }),
    );
    expectOnlyUnknown('clients', replayEvidence('clients', { observed_unique: 3 }));
  });

  it('a challenge that is not this run’s (replay from another run)', () => {
    expectOnlyUnknown(
      'clients',
      replayEvidence('clients', { challenge_b64: Buffer.alloc(32, 1).toString('base64') }),
    );
  });

  it('a row bound to another coach, intent or epoch; a duplicate row; a missing row', () => {
    for (const over of [
      { coach_id: 'coach-b' },
      { intent_id: 'intent-2' },
      { execution_epoch: 4 },
    ]) {
      const facts = evaluateCoverage(
        input({ observations: rows({ clients: [stored(replayEvidence('clients'), over)] }) }),
      );
      expect(facts).toEqual({ ...BASELINE, clients: UNKNOWN });
    }
    const twice = [stored(replayEvidence('clients')), stored(replayEvidence('clients'))];
    expect(evaluateCoverage(input({ observations: rows({ clients: twice }) }))).toEqual({
      ...BASELINE,
      clients: UNKNOWN,
    });
    expect(evaluateCoverage(input({ observations: rows({ clients: [] }) }))).toEqual({
      ...BASELINE,
      clients: UNKNOWN,
    });
  });

  it('a unit whose evidence names another platform, scope or family; a spec-digest mismatch', () => {
    expectOnlyUnknown(
      'clients',
      replayEvidence('clients', { account_scope_id_digest: sha256('workspace-2') }),
    );
    expectOnlyUnknown(
      'clients',
      replayEvidence('clients', { mapping_spec_digest: sha256('other spec') }),
    );
    const facts = evaluateCoverage(
      input({
        observations: rows({
          clients: [stored(replayEvidence('clients', { family: 'workouts' }))],
        }),
      }),
    );
    // The row lands on the workouts unit (which now has two rows) and the clients unit has none.
    expect(facts).toEqual({ ...BASELINE, clients: UNKNOWN, workouts: UNKNOWN });
  });

  it('a manifest that does not list the replay kind for the family (a file package without D1 opt-in)', () => {
    const signedOnly = replayRegistry(SLUG, [SIGNED]);
    const facts = evaluateCoverage(
      input({
        registry: signedOnly,
        observations: FAMILIES.map((f) => stored(replayEvidence(f, {}, signedOnly))),
      }),
    );
    expect(facts).toEqual(ALL_UNKNOWN);
  });

  it('two basis kinds proving one family across two platforms fail closed (no single truthful basis_kind)', () => {
    const other = 'zz_other_source';
    const registry = buildInductionRegistry({
      manifests: [
        parseInductionManifest(
          {
            ...MANIFEST_RAW,
            basisKinds: { clients: [REPLAY], programs: [REPLAY], workouts: [REPLAY] },
            verifiers: [],
          },
          `${SLUG}.json`,
        ),
        parseInductionManifest(
          {
            ...MANIFEST_RAW,
            sourcePlatform: other,
            basisKinds: { clients: [SIGNED], programs: [SIGNED], workouts: [SIGNED] },
          },
          `${other}.json`,
        ),
      ],
      specs: [
        parseSourceMappingSpec(SPEC_RAW, `${SLUG}.json`),
        parseSourceMappingSpec({ ...SPEC_RAW, sourcePlatform: other }, `${other}.json`),
      ],
      nativeRuleSets: [],
    });
    const signedRows = FAMILIES.map((family) =>
      stored(
        evidenceFor(
          {
            statement_version: 1,
            source_platform: other,
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
          specDigest(registry, other),
        ),
      ),
    );
    const facts = evaluateCoverage({
      run: RUN,
      declaration: {
        challenge: CHALLENGE,
        platforms: [
          { source_platform: SLUG, account_scope_id_digests: [SCOPE] },
          { source_platform: other, account_scope_id_digests: [SCOPE] },
        ],
      },
      registry,
      observations: [
        ...FAMILIES.map((f) => stored(replayEvidence(f, {}, registry))),
        ...signedRows,
      ],
      staged: [staged(), staged(IDS, other)],
      closure: reviewedPackageClosures(registry),
    });
    expect(facts).toEqual(ALL_UNKNOWN);
  });
});

// ── Family-set closure ──────────────────────────────────────────────────────────────────

const PKG = ((): NonNullable<ReturnType<InductionRegistry['packages']['get']>> => {
  const pkg = REGISTRY.packages.get(SLUG);
  if (pkg === undefined) throw new Error('fixture package missing');
  return pkg;
})();

/** The rule's signals for a genuinely out-of-scope collection: P, K and S fired, no veto, items present. */
const CONFIRMING: ExclusionSignalsV1 = {
  path: true,
  key: true,
  shape: true,
  veto: false,
  empty_shape: false,
};

const mapped = (
  template_ref: string,
  family: Family,
  unexplored_variants = 0,
): FamilySetClosureTemplateV1 => ({
  template_ref,
  disposition: 'mapped',
  family,
  unexplored_variants,
});
const excluded = (
  template_ref: string,
  reason: ClosureExclusionReason,
  signals: Partial<ExclusionSignalsV1> = {},
): FamilySetClosureTemplateV1 => ({
  template_ref,
  disposition: 'excluded',
  reason,
  signals: { ...CONFIRMING, ...signals },
});

/** A closed learned-package inventory: one mapped template per family, one rule-confirmed billing exclusion. */
const OBSERVED_TEMPLATES: readonly FamilySetClosureTemplateV1[] = [
  mapped('t.members', 'clients'),
  mapped('t.programs', 'programs'),
  mapped('t.routines', 'workouts'),
  mapped('t.sessions', 'workouts'),
  excluded('t.invoices', 'out_of_scope_billing'),
];

type ObservedClosure = Extract<FamilySetClosureV1, { origin: 'observed_templates' }>;

function observed(over: Partial<ObservedClosure> = {}): ObservedClosure {
  return {
    closure_version: 1,
    source_platform: SLUG,
    mapping_spec_digest: PKG.specDigest,
    origin: 'observed_templates',
    rule_version: 1,
    digest_truncated: false,
    refused_collections: 0,
    unexplored_targets: 0,
    templates: OBSERVED_TEMPLATES,
    ...over,
  };
}

/** The inventory with one template swapped in (same ref replaced, or appended). */
function withTemplate(template: FamilySetClosureTemplateV1): ObservedClosure {
  return observed({
    templates: [
      ...OBSERVED_TEMPLATES.filter((t) => t.template_ref !== template.template_ref),
      template,
    ],
  });
}

const PARTIAL_UNKNOWN = { outcome: 'partial', reason_code: 'coverage_basis_unknown' };

describe('L3 — family-set closure: null (the default) is NOT known and blocks `complete`', () => {
  it('closure: null → every declared family unknown → partial / coverage_basis_unknown', () => {
    const facts = evaluateCoverage(input({ closure: null }));
    expect(facts).toEqual(ALL_UNKNOWN);
    expect(verdictOf(facts)).toEqual(PARTIAL_UNKNOWN);
  });

  it('closure omitted → identical to null', () => {
    const base = input();
    const rest: CoverageEvaluationInput = {
      run: base.run,
      declaration: base.declaration,
      registry: base.registry,
      observations: base.observations,
      staged: base.staged,
    };
    expect(evaluateCoverage(rest)).toEqual(ALL_UNKNOWN);
    const detailed = evaluateCoverageDetailed(rest);
    expect(detailed.closure[SLUG]).toEqual({ closed: false, gaps: [{ code: 'closure_unknown' }] });
  });

  it('a record for another platform, a stale spec digest, or two records for one platform → unknown', () => {
    const reviewed = reviewedPackageClosures(REGISTRY)[0];
    expect(
      evaluateCoverage(input({ closure: [{ ...reviewed, source_platform: 'zz_other' }] })),
    ).toEqual(ALL_UNKNOWN);
    const stale = evaluateCoverageDetailed(
      input({ closure: [{ ...reviewed, mapping_spec_digest: sha256('v2') }] }),
    );
    expect(stale.facts).toEqual(ALL_UNKNOWN);
    expect(stale.closure[SLUG]).toEqual({
      closed: false,
      gaps: [{ code: 'closure_spec_mismatch' }],
    });
    expect(evaluateCoverage(input({ closure: [reviewed, reviewed] }))).toEqual(ALL_UNKNOWN);
  });

  it('the reviewed FILE package record closes; the detailed result names its origin', () => {
    const detailed = evaluateCoverageDetailed(input());
    expect(detailed.facts).toEqual(BASELINE);
    expect(detailed.closure[SLUG]).toEqual({ closed: true, origin: 'reviewed_package' });
  });

  it('closure alone never proves: a closed record with no evidence rows is still unknown', () => {
    expect(evaluateCoverage(input({ observations: [] }))).toEqual(ALL_UNKNOWN);
    expect(evaluateCoverage(input({ observations: [], closure: [observed()] }))).toEqual(
      ALL_UNKNOWN,
    );
  });
});

describe('L3 — family-set closure of a learned package (observed_templates)', () => {
  it('closed when discovery left nothing behind, every template is mapped or rule-confirmed, every family has a template → complete', () => {
    const detailed = evaluateCoverageDetailed(input({ closure: [observed()] }));
    expect(detailed.facts).toEqual(BASELINE);
    expect(detailed.closure[SLUG]).toEqual({ closed: true, origin: 'observed_templates' });
    expect(verdictOf(detailed.facts)).toEqual({ outcome: 'complete', reason_code: null });
  });

  it('closure is re-evaluated per run from the record: the same record under a new spec digest is not carried over', () => {
    const detailed = evaluateCoverageDetailed(
      input({ closure: [observed({ mapping_spec_digest: sha256('re-learned') })] }),
    );
    expect(detailed.closure[SLUG]).toEqual({
      closed: false,
      gaps: [{ code: 'closure_spec_mismatch' }],
    });
  });

  describe('discovery holes (review defaults L0R2-OPUS-A2 / L0R2-SOL-A1): each alone blocks `complete` with a named gap', () => {
    it.each<[string, Partial<ObservedClosure>, ClosureGap]>([
      ['a truncated digest', { digest_truncated: true }, { code: 'digest_truncated' }],
      [
        'a refused collection template',
        { refused_collections: 1 },
        { code: 'collection_refused', count: 1 },
      ],
      [
        'an unexplored navigation target',
        { unexplored_targets: 3 },
        { code: 'target_unexplored', count: 3 },
      ],
    ])('%s', (_label, over, expected) => {
      const detailed = evaluateCoverageDetailed(input({ closure: [observed(over)] }));
      expect(detailed.facts).toEqual(ALL_UNKNOWN);
      expect(detailed.closure[SLUG]).toEqual({ closed: false, gaps: [expected] });
      expect(verdictOf(detailed.facts)).toEqual(PARTIAL_UNKNOWN);
    });

    it('an unexplored filter/status variant on a mapped template (e.g. an archived list) blocks, even though the family has a template', () => {
      const detailed = evaluateCoverageDetailed(
        input({ closure: [withTemplate(mapped('t.members', 'clients', 1))] }),
      );
      expect(detailed.facts).toEqual(ALL_UNKNOWN);
      expect(detailed.closure[SLUG]).toEqual({
        closed: false,
        gaps: [{ code: 'variant_unexplored', template_ref: 't.members', count: 1 }],
      });
    });

    it('several holes at once are all named (nothing is hidden behind the first)', () => {
      const verdict = evaluateFamilySetClosure(
        observed({ digest_truncated: true, refused_collections: 2, unexplored_targets: 1 }),
        SLUG,
        PKG,
      );
      expect(verdict).toEqual({
        closed: false,
        gaps: [
          { code: 'digest_truncated' },
          { code: 'collection_refused', count: 2 },
          { code: 'target_unexplored', count: 1 },
        ],
      });
    });
  });

  describe('unmapped entries: only a rule-confirmed out_of_scope_* exclusion counts', () => {
    it.each<[string, FamilySetClosureTemplateV1, ClosureGap]>([
      [
        'unsupported_coaching_data',
        excluded('t.notes', 'unsupported_coaching_data'),
        { code: 'template_unsupported_coaching_data', template_ref: 't.notes' },
      ],
      [
        'unknown',
        excluded('t.mystery', 'unknown'),
        { code: 'template_unknown', template_ref: 't.mystery' },
      ],
    ])('%s forces partial with a named gap', (_label, template, expected) => {
      const detailed = evaluateCoverageDetailed(input({ closure: [withTemplate(template)] }));
      expect(detailed.facts).toEqual(ALL_UNKNOWN);
      expect(detailed.closure[SLUG]).toEqual({ closed: false, gaps: [expected] });
      expect(verdictOf(detailed.facts)).toEqual(PARTIAL_UNKNOWN);
    });

    it('unsupported_coaching_data and unknown are never confirmed, whatever the signals say', () => {
      for (const reason of ['unsupported_coaching_data', 'unknown'] as const) {
        expect(exclusionConfirmed(reason, CONFIRMING)).toBe(false);
      }
    });

    it.each<[string, Partial<ExclusionSignalsV1>]>([
      ['path evidence missing (key + shape only)', { path: false }],
      ['key evidence missing (path + shape only)', { key: false }],
      [
        'shape evidence missing (path + key only: the L0R2-SOL-A2 /account/profiles case)',
        { shape: false },
      ],
      [
        'the veto fired on a path token (the L0R2-OPUS-A3 /api/layout/exercises case)',
        { veto: true },
      ],
      ['an empty collection (vacuous shape, nothing for the veto to read)', { empty_shape: true }],
      [
        'no evidence at all: the AI said billing and nothing confirmed it',
        { path: false, key: false, shape: false },
      ],
    ])(
      '%s → exclusion unconfirmed → partial, gap carries reason and signals',
      (_label, signals) => {
        const template = excluded('t.invoices', 'out_of_scope_billing', signals);
        const detailed = evaluateCoverageDetailed(input({ closure: [withTemplate(template)] }));
        expect(detailed.facts).toEqual(ALL_UNKNOWN);
        expect(detailed.closure[SLUG]).toEqual({
          closed: false,
          gaps: [
            {
              code: 'template_exclusion_unconfirmed',
              template_ref: 't.invoices',
              reason: 'out_of_scope_billing',
              signals: { ...CONFIRMING, ...signals },
            },
          ],
        });
        expect(verdictOf(detailed.facts)).toEqual(PARTIAL_UNKNOWN);
      },
    );

    it('the rule needs all three classes: no two-of-three combination confirms', () => {
      const classes = ['path', 'key', 'shape'] as const;
      for (const dropped of classes) {
        expect(
          exclusionConfirmed('out_of_scope_ui_config', { ...CONFIRMING, [dropped]: false }),
        ).toBe(false);
      }
      expect(exclusionConfirmed('out_of_scope_ui_config', CONFIRMING)).toBe(true);
      expect(
        exclusionConfirmed('out_of_scope_account_settings', { ...CONFIRMING, veto: true }),
      ).toBe(false);
      expect(
        exclusionConfirmed('out_of_scope_account_settings', { ...CONFIRMING, empty_shape: true }),
      ).toBe(false);
    });
  });

  it('a family without any mapped template, a mapped template naming an undeclared family, a duplicate ref', () => {
    const noWorkouts = observed({
      templates: OBSERVED_TEMPLATES.filter(
        (t) => t.disposition !== 'mapped' || t.family !== 'workouts',
      ),
    });
    expect(evaluateFamilySetClosure(noWorkouts, SLUG, PKG)).toEqual({
      closed: false,
      gaps: [{ code: 'family_without_template', family: 'workouts' }],
    });
    const undeclared = observed({
      templates: [...OBSERVED_TEMPLATES, mapped('t.history', 'client_history' as Family)],
    });
    expect(evaluateFamilySetClosure(undeclared, SLUG, PKG)).toEqual({
      closed: false,
      gaps: [
        { code: 'template_family_undeclared', template_ref: 't.history', family: 'client_history' },
      ],
    });
    const dup = observed({ templates: [...OBSERVED_TEMPLATES, mapped('t.members', 'clients')] });
    expect(evaluateFamilySetClosure(dup, SLUG, PKG)).toEqual({
      closed: false,
      gaps: [{ code: 'template_duplicated', template_ref: 't.members' }],
    });
  });

  it('refuses malformed records without throwing: a URL-shaped ref, an unknown reason, extra or missing keys, a bad version', () => {
    const malformed = { closed: false, gaps: [{ code: 'closure_malformed' }] };
    const rawObserved = (templates: readonly unknown[]): unknown => ({ ...observed(), templates });
    const cases: unknown[] = [
      rawObserved([
        ...OBSERVED_TEMPLATES,
        {
          template_ref: 'https://x/y',
          disposition: 'mapped',
          family: 'clients',
          unexplored_variants: 0,
        },
      ]),
      rawObserved([
        ...OBSERVED_TEMPLATES,
        {
          template_ref: 't.z',
          disposition: 'excluded',
          reason: 'out_of_scope_anything',
          signals: CONFIRMING,
        },
      ]),
      // A stored verdict is not a signal set: a record that says "confirmed" instead of P/K/S
      // is malformed.
      rawObserved([
        ...OBSERVED_TEMPLATES,
        {
          template_ref: 't.z',
          disposition: 'excluded',
          reason: 'out_of_scope_billing',
          signals: { confirmed: true },
        },
      ]),
      rawObserved([
        ...OBSERVED_TEMPLATES,
        {
          template_ref: 't.z',
          disposition: 'excluded',
          reason: 'out_of_scope_billing',
          confirmed_by_rule: true,
        },
      ]),
      // A mapped template without its variant count is malformed (the producer must state it).
      rawObserved([
        ...OBSERVED_TEMPLATES,
        { template_ref: 't.extra', disposition: 'mapped', family: 'clients' },
      ]),
      { ...observed(), closure_version: 2 },
      { ...observed(), rule_version: 2 },
      { ...observed(), digest_truncated: 'no' },
      { ...observed(), refused_collections: -1 },
      { ...observed(), unexplored_targets: 1.5 },
      { ...observed(), extra: true },
      (() => {
        const rest: Record<string, unknown> = { ...observed() };
        delete rest.digest_truncated;
        return rest;
      })(),
      { ...reviewedPackageClosures(REGISTRY)[0], templates: [] },
    ];
    for (const raw of cases) {
      expect([raw, evaluateFamilySetClosure(raw, SLUG, PKG)]).toEqual([raw, malformed]);
    }
    expect(evaluateFamilySetClosure(observed({ templates: [] }), SLUG, PKG)).toEqual({
      closed: false,
      gaps: FAMILIES.map((family) => ({ code: 'family_without_template', family })),
    });
    expect(() => evaluateFamilySetClosure('garbage', SLUG, PKG)).not.toThrow();
  });
});

// ── No path lets the AI's classification alone produce `complete` ───────────────────────

describe('L3 — the AI never decides completeness', () => {
  it('an exclusion carrying only the AI’s claim (no rule signal) never closes, whatever the reason', () => {
    const none: ExclusionSignalsV1 = {
      path: false,
      key: false,
      shape: false,
      veto: false,
      empty_shape: false,
    };
    for (const reason of CLOSURE_EXCLUSION_REASONS) {
      const closure = observed({
        templates: [
          ...OBSERVED_TEMPLATES.slice(0, 4),
          { template_ref: 't.ai', disposition: 'excluded', reason, signals: none },
        ],
      });
      expect(evaluateFamilySetClosure(closure, SLUG, PKG).closed).toBe(false);
      expect(evaluateCoverage(input({ closure: [closure] }))).toEqual(ALL_UNKNOWN);
    }
  });

  it('the evaluator output carries no field the closure record could set: basis_kind and observed_unique come only from proven evidence rows', () => {
    // A closed record plus rows that prove nothing (truncated) → every family unknown; the closure
    // cannot lift a family to `known` on its own.
    const truncated = FAMILIES.map((f) =>
      stored(
        replayEvidence(f, {
          steps: STEPS[f].map((name) => step(name, { stop: 'budget_stop' })),
        }),
      ),
    );
    const detailed = evaluateCoverageDetailed(
      input({ closure: [observed()], observations: truncated }),
    );
    expect(detailed.closure[SLUG]).toEqual({ closed: true, origin: 'observed_templates' });
    expect(detailed.facts).toEqual(ALL_UNKNOWN);
    expect(verdictOf(detailed.facts)).toEqual(PARTIAL_UNKNOWN);
  });

  it('the evaluator and closure modules import nothing from an AI, gateway or learn module', () => {
    const src = join(__dirname, '../../../src/scout/induction');
    for (const file of ['closure.ts', 'verify.ts', 'parse.ts', 'contract.ts']) {
      const text = readFileSync(join(src, file), 'utf8');
      const imports = [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      expect(imports.filter((i) => /learn|ai-gateway|anthropic|provider|prompt/i.test(i))).toEqual(
        [],
      );
    }
  });

  it('`complete` requires every predicate at once: closure closed AND every family proven AND the claim success', () => {
    const proven = evaluateCoverage(input({ closure: [observed()] }));
    expect(verdictOf(proven)).toEqual({ outcome: 'complete', reason_code: null });
    expect(reconcile({ ...cleanFacts(proven), claim: 'partial' }).verdict.outcome).toBe('partial');
    expect(reconcile(cleanFacts({ ...proven, programs: UNKNOWN })).verdict).toEqual(
      PARTIAL_UNKNOWN,
    );
  });
});
