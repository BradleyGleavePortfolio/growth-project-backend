import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type {
  CoverageReasonCode,
  ReplayStepEvidenceV1,
} from '../../../src/scout/induction/contract';
import { stagedFamilyDigests } from '../../../src/scout/induction/digest';
import {
  buildInductionRegistry,
  loadInductionManifests,
  type InductionRegistry,
} from '../../../src/scout/induction/manifest-registry';
import { parseEvidence, parseInductionManifest } from '../../../src/scout/induction/parse';
import {
  evaluateCoverage,
  evaluateCoverageDetailed,
  type CoverageEvaluationInput,
  type FamilyCoverageDetail,
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
 * L3 — the `replay_terminal_enumeration` evidence (owner D1, 2026-09-28; L0 r4 D-L0-6
 * "Pagination exhaustion is proven per endpoint, positively") under the executive reset of
 * 2026-09-29 (§1, §8): NO package has a run-level completeness closure yet, so this evidence
 * proves a family's SOURCE COUNT (`evaluateCoverageDetailed().families`, for the run-status
 * projection) and never a run-level basis — `evaluateCoverage` reports every replay family
 * `known: false`, the run settles `partial/coverage_basis_unknown`, and `complete` is unreachable
 * through it for every package type. Positive case, every L0 negative case, and the proof that no
 * path lets the AI's classification alone produce `complete`. Pure tier: no DB, no Nest. The r2
 * reviewer negatives (R589-A/B) live in `replay-basis-r2.spec.ts`.
 */

type Family = 'clients' | 'programs' | 'workouts';
const FAMILIES: readonly Family[] = ['clients', 'programs', 'workouts'];
/** Ids per STEP (`test/fixtures/scout/s10_pure/mapping`): workouts is the union of two steps. */
const STEP_IDS: Record<string, string[]> = {
  members: ['c1', 'c2'],
  plans: ['p1'],
  routines: ['w1', 'w2'],
  sessions: ['w3'],
};
const IDS: Record<Family, string[]> = {
  clients: ['c1', 'c2'],
  programs: ['p1'],
  workouts: ['w1', 'w2', 'w3'],
};
/** The fixture spec's steps per family. */
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

/**
 * The fixture package with every family listing the replay kind and NO verifier: the shape a
 * learned (derived) package has. Whether a package came from a repository file or was composed
 * makes no difference any more (executive reset §1: no package type has a closure).
 */
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

/** One exhausted root step evidence with the fixture ids of `step_key`. */
function step(step_key: string, over: Partial<ReplayStepEvidenceV1> = {}): ReplayStepEvidenceV1 {
  const ids = STEP_IDS[step_key] ?? [];
  return {
    step_key,
    pages_fetched: 3,
    raw_items: ids.length,
    distinct_raw_ids: ids.length,
    duplicate_ids: 0,
    synthetic_ids: 0,
    missing_id_items: 0,
    stop: 'short_page',
    advertised_next: false,
    refused_pages: 0,
    fan_out: null,
    id_set_digest: referenceIdDigest(ids),
    ...over,
  };
}

/** One valid replay evidence object for a family (steps default to the spec's, all exhausted). */
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
    ...over,
  };
}

const UNKNOWN: CoverageFact = { known: false };
const ALL_UNKNOWN = { clients: UNKNOWN, programs: UNKNOWN, workouts: UNKNOWN };
/** A replay-proven family: the source count is known, the run-level basis is not (reset §1). */
const COUNTED = (n: number): FamilyCoverageDetail => ({
  source_count: n,
  count_basis: 'proven',
  basis_kind: REPLAY,
  reasons: [{ code: 'completeness_not_proven', platform: null }],
});
const BASELINE_COUNTS = { clients: COUNTED(2), programs: COUNTED(1), workouts: COUNTED(3) };
const UNCOUNTED = (...codes: CoverageReasonCode[]): FamilyCoverageDetail => ({
  source_count: null,
  count_basis: 'unknown',
  basis_kind: null,
  reasons: codes.map((code) => ({ code, platform: SLUG })),
});
const PARTIAL_UNKNOWN = { outcome: 'partial', reason_code: 'coverage_basis_unknown' };

/** Replace one family's evidence and expect ONLY that family's count to become unknown (never 0). */
function expectOnlyUnknown(
  family: Family,
  evidence: Record<string, unknown>,
  ...codes: CoverageReasonCode[]
): void {
  const detailed = evaluateCoverageDetailed(
    input({ observations: rows({ [family]: [stored(evidence)] }) }),
  );
  expect(detailed.facts).toEqual(ALL_UNKNOWN);
  const expected: Record<string, FamilyCoverageDetail> = { ...BASELINE_COUNTS };
  if (codes.length > 0) expected[family] = UNCOUNTED(...codes);
  else {
    expect(detailed.families[family]).toMatchObject({ source_count: null, count_basis: 'unknown' });
    expected[family] = detailed.families[family];
  }
  expect(detailed.families).toEqual(expected);
  expect(familyCoverage(detailed.facts[family], 'success')).toEqual({
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

describe('L3 — replay_terminal_enumeration is a proving kind a package may list without a verifier', () => {
  it('a manifest listing only the replay kind parses with verifiers: [] (D-S10-1 V5, L3 reading)', () => {
    const pkg = REGISTRY.packages.get(SLUG);
    expect(pkg?.manifest.verifiers).toEqual([]);
    expect(pkg?.manifest.basisKinds.clients).toEqual([REPLAY]);
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

describe('L3 — parseEvidence: the replay_terminal_enumeration shape (r4 StepEvidenceV1)', () => {
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
    const fan = { expected: 2, fetched: 2, parent_step: 'members' };
    const cases: [Record<string, unknown>, string][] = [
      [{ challenge_b64: 'not base64!' }, 'bad_base64'],
      [{ challenge_b64: Buffer.alloc(31).toString('base64') }, 'bad_length'],
      [{ steps: [] }, 'bad_step'],
      [{ steps: 'members' }, 'bad_step'],
      [{ steps: Array.from({ length: 65 }, (_, i) => step(`s${i}`)) }, 'too_large'],
      [{ steps: [step('members'), step('members')] }, 'bad_step'],
      [{ steps: [{ ...step('members'), extra: 1 }] }, 'unknown_key'],
      [{ steps: [{ ...step('members'), step: 'members' }] }, 'unknown_key'],
      [{ steps: [{ ...step('members'), stop: 'end_of_list' }] }, 'bad_terminal'],
      [{ steps: [{ ...step('members'), advertised_next: 'no' }] }, 'bad_terminal'],
      [{ steps: [step('members', { pages_fetched: -1 })] }, 'bad_count'],
      [{ steps: [step('members', { pages_fetched: 1.5 })] }, 'bad_count'],
      // r4 "unknown is never 0": a root step that fetched nothing is not even evidence.
      [{ steps: [step('members', { pages_fetched: 0 })] }, 'bad_count'],
      [{ steps: [step('members', { raw_items: -1 })] }, 'bad_count'],
      [{ steps: [{ ...step('members'), synthetic_ids: '0' }] }, 'bad_count'],
      [{ steps: [step('members', { id_set_digest: 'zz' })] }, 'bad_digest'],
      [{ steps: [{ ...step('members'), fan_out: { expected: 2, fetched: 2 } }] }, 'missing_key'],
      [{ steps: [{ ...step('members'), fan_out: { ...fan, parent_step: '' } }] }, 'bad_step'],
      [{ steps: [{ ...step('members'), fan_out: { ...fan, extra: 1 } }] }, 'unknown_key'],
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

  it('a fan-out step may report pages_fetched 0 when it had nothing to visit (the parent decides)', () => {
    const fanned = replayEvidence('workouts', {
      steps: [
        step('routines'),
        step('sessions', {
          pages_fetched: 0,
          fan_out: { expected: 0, fetched: 0, parent_step: 'members' },
        }),
      ],
    });
    expect(reason(fanned)).toBe('ok');
  });
});

// ── Evaluator: the positive case and every L0 negative case ────────────────────────────

describe('L3 — positive case: every step exhausted, digest AND count equal to staged → a PROVEN source count', () => {
  it('yields count_basis proven with the observed count per family, and NO run-level basis (reset §1)', () => {
    const detailed = evaluateCoverageDetailed(input());
    expect(detailed.families).toEqual(BASELINE_COUNTS);
    expect(detailed.facts).toEqual(ALL_UNKNOWN);
    expect(evaluateCoverage(input())).toEqual(ALL_UNKNOWN);
    expect(familyCoverage(detailed.facts.workouts, 'success')).toEqual({
      known: false,
      completeness_basis: 'none',
      observed_unique: null,
    });
  });

  it('composes with the pure S9 reconciler to partial / coverage_basis_unknown — never `complete`', () => {
    expect(verdictOf(evaluateCoverage(input()))).toEqual(PARTIAL_UNKNOWN);
  });

  it('every r4 terminal stop counts after ≥ 1 page: absent_next, empty_page, short_page (next_url style stops at absent_next)', () => {
    for (const stop of ['absent_next', 'empty_page', 'short_page'] as const) {
      const detailed = evaluateCoverageDetailed(
        input({
          observations: rows({
            clients: [stored(replayEvidence('clients', { steps: [step('members', { stop })] }))],
          }),
        }),
      );
      expect(detailed.families).toEqual(BASELINE_COUNTS);
    }
  });

  it('a fan-out step bound to its parent step’s proven count counts; an empty family counts only by a positive probe', () => {
    // sessions fans out over the members (clients) step: 2 parent contexts, 2 visited, 2 pages.
    const fanned = replayEvidence('workouts', {
      steps: [
        step('routines'),
        step('sessions', {
          pages_fetched: 2,
          stop: 'absent_next',
          fan_out: { expected: 2, fetched: 2, parent_step: 'members' },
        }),
      ],
    });
    expect(
      evaluateCoverageDetailed(input({ observations: rows({ workouts: [stored(fanned)] }) }))
        .families,
    ).toEqual(BASELINE_COUNTS);
    // L0 r4 D-L0-6: an empty collection is closed by ONE GET that returned an empty page.
    const probe = replayEvidence('programs', {
      steps: [
        step('plans', {
          pages_fetched: 1,
          raw_items: 0,
          distinct_raw_ids: 0,
          stop: 'empty_page',
          id_set_digest: referenceIdDigest([]),
        }),
      ],
      observed_unique: 0,
      id_set_digest: referenceIdDigest([]),
    });
    const detailed = evaluateCoverageDetailed(
      input({
        observations: rows({ programs: [stored(probe)] }),
        staged: [staged({ ...IDS, programs: [] })],
      }),
    );
    expect(detailed.families.programs).toEqual(COUNTED(0));
    expect(detailed.facts.programs).toEqual(UNKNOWN);
  });

  it('the family token may accompany the spec steps (a canonical-token collection) but never replace them', () => {
    const withToken = replayEvidence('programs', {
      steps: [step('plans'), step('programs', { raw_items: 0, distinct_raw_ids: 0 })],
    });
    expect(
      evaluateCoverageDetailed(input({ observations: rows({ programs: [stored(withToken)] }) }))
        .families,
    ).toEqual(BASELINE_COUNTS);
    expectOnlyUnknown(
      'programs',
      replayEvidence('programs', { steps: [step('programs')] }),
      'step_set_mismatch',
    );
  });

  it('is metamorphic in the slug: a renamed package gives identical detail', () => {
    const slug = 'zz_renamed_source';
    const registry = replayRegistry(slug);
    const detailed = evaluateCoverageDetailed({
      run: RUN,
      declaration: {
        challenge: CHALLENGE,
        platforms: [{ source_platform: slug, account_scope_id_digests: [SCOPE] }],
      },
      registry,
      observations: FAMILIES.map((f) => stored(replayEvidence(f, {}, registry, slug))),
      staged: [staged(IDS, slug)],
    });
    expect(detailed.families).toEqual(BASELINE_COUNTS);
    expect(detailed.facts).toEqual(ALL_UNKNOWN);
  });
});

describe('L3 — negative cases (each alone → source_count null, count_basis unknown; never 0)', () => {
  it('a non-terminal stop: none_proven, budget, cycle, error or advertised_next (r4 D-L0-6)', () => {
    for (const stop of ['none_proven', 'budget', 'cycle', 'error', 'advertised_next'] as const) {
      expectOnlyUnknown(
        'clients',
        replayEvidence('clients', { steps: [step('members', { stop })] }),
        'crawl_truncated',
      );
    }
    // One truncated step among two clean ones truncates the family.
    expectOnlyUnknown(
      'workouts',
      replayEvidence('workouts', {
        steps: [step('routines'), step('sessions', { stop: 'budget' })],
      }),
      'crawl_truncated',
    );
  });

  it('a terminal stop with an advertised next link the step did not follow (a first page is never certified)', () => {
    expectOnlyUnknown(
      'clients',
      replayEvidence('clients', { steps: [step('members', { advertised_next: true })] }),
      'crawl_truncated',
    );
  });

  it('a refused page', () => {
    expectOnlyUnknown(
      'clients',
      replayEvidence('clients', { steps: [step('members', { refused_pages: 1 })] }),
      'crawl_truncated',
    );
  });

  it('a synthetic or missing id (a fabricated identity never proves; r4 D-L0-6)', () => {
    expectOnlyUnknown(
      'clients',
      replayEvidence('clients', { steps: [step('members', { synthetic_ids: 1 })] }),
      'identity_unproven',
    );
    expectOnlyUnknown(
      'clients',
      replayEvidence('clients', { steps: [step('members', { missing_id_items: 1 })] }),
      'identity_unproven',
    );
  });

  it('step counters that contradict the family totals (a single step IS the family)', () => {
    expectOnlyUnknown(
      'clients',
      replayEvidence('clients', {
        steps: [step('members', { distinct_raw_ids: 3, raw_items: 3 })],
      }),
      'evidence_inconsistent',
    );
    expectOnlyUnknown(
      'clients',
      replayEvidence('clients', { steps: [step('members', { id_set_digest: sha256('other') })] }),
      'evidence_inconsistent',
    );
    expectOnlyUnknown(
      'clients',
      replayEvidence('clients', { steps: [step('members', { distinct_raw_ids: 5 })] }), // > raw_items
      'evidence_inconsistent',
    );
    // Two steps whose distinct counts cannot reach the family's union.
    expectOnlyUnknown(
      'workouts',
      replayEvidence('workouts', {
        steps: [step('routines', { distinct_raw_ids: 1, raw_items: 1 }), step('sessions')],
      }),
      'evidence_inconsistent',
    );
  });

  it('a fan-out step short of its parent set, or whose pages differ from the contexts it visited', () => {
    expectOnlyUnknown(
      'workouts',
      replayEvidence('workouts', {
        steps: [
          step('routines'),
          step('sessions', {
            pages_fetched: 2,
            fan_out: { expected: 3, fetched: 2, parent_step: 'members' },
          }),
        ],
      }),
      'fan_out_short',
    );
    expectOnlyUnknown(
      'workouts',
      replayEvidence('workouts', {
        steps: [
          step('routines'),
          step('sessions', {
            pages_fetched: 3,
            fan_out: { expected: 2, fetched: 2, parent_step: 'members' },
          }),
        ],
      }),
      'fan_out_short',
    );
  });

  it('a step set short of the spec (one of two workouts steps missing) or a step the spec does not map to the family', () => {
    expectOnlyUnknown(
      'workouts',
      replayEvidence('workouts', { steps: [step('routines')] }),
      'step_set_mismatch',
    );
    expectOnlyUnknown(
      'clients',
      replayEvidence('clients', { steps: [step('members'), step('notes')] }),
      'step_set_mismatch',
    );
    // The clients step reported under the workouts family is not a workouts step.
    expectOnlyUnknown(
      'workouts',
      replayEvidence('workouts', {
        steps: [step('routines'), step('sessions'), step('members')],
      }),
      'step_set_mismatch',
    );
  });

  it('a mismatched digest (the count agrees) or a mismatched count (the digest agrees): both unknown, count dropped', () => {
    expectOnlyUnknown(
      'workouts',
      replayEvidence('workouts', { id_set_digest: referenceIdDigest(['w1', 'w2', 'w-unstaged']) }),
      'staged_mismatch',
    );
    expectOnlyUnknown(
      'workouts',
      replayEvidence('workouts', { observed_unique: 2 }),
      'staged_mismatch',
    );
    expectOnlyUnknown(
      'clients',
      replayEvidence('clients', {
        observed_unique: 3,
        steps: [step('members', { raw_items: 3, distinct_raw_ids: 3 })],
      }),
      'staged_mismatch',
    );
  });

  it('a challenge that is not this run’s (replay from another run)', () => {
    expectOnlyUnknown(
      'clients',
      replayEvidence('clients', { challenge_b64: Buffer.alloc(32, 1).toString('base64') }),
      'evidence_unbound',
    );
  });

  it('a row bound to another coach, intent or epoch; a duplicate row; a missing row', () => {
    for (const over of [
      { coach_id: 'coach-b' },
      { intent_id: 'intent-2' },
      { execution_epoch: 4 },
    ]) {
      const detailed = evaluateCoverageDetailed(
        input({ observations: rows({ clients: [stored(replayEvidence('clients'), over)] }) }),
      );
      expect(detailed.families).toEqual({
        ...BASELINE_COUNTS,
        clients: UNCOUNTED('evidence_unbound'),
      });
    }
    const twice = [stored(replayEvidence('clients')), stored(replayEvidence('clients'))];
    expect(
      evaluateCoverageDetailed(input({ observations: rows({ clients: twice }) })).families,
    ).toEqual({ ...BASELINE_COUNTS, clients: UNCOUNTED('evidence_duplicate') });
    expect(
      evaluateCoverageDetailed(input({ observations: rows({ clients: [] }) })).families,
    ).toEqual({ ...BASELINE_COUNTS, clients: UNCOUNTED('evidence_missing') });
  });

  it('a unit whose evidence names another platform, scope or family; a spec-digest mismatch', () => {
    expectOnlyUnknown(
      'clients',
      replayEvidence('clients', { account_scope_id_digest: sha256('workspace-2') }),
      'evidence_missing',
    );
    expectOnlyUnknown(
      'clients',
      replayEvidence('clients', { mapping_spec_digest: sha256('other spec') }),
      'evidence_unbound',
    );
    const detailed = evaluateCoverageDetailed(
      input({
        observations: rows({
          clients: [stored(replayEvidence('clients', { family: 'workouts' }))],
        }),
      }),
    );
    // The row lands on the workouts unit (which now has two rows) and the clients unit has none.
    expect(detailed.families).toEqual({
      ...BASELINE_COUNTS,
      clients: UNCOUNTED('evidence_missing'),
      workouts: UNCOUNTED('evidence_duplicate'),
    });
  });

  it('a manifest that does not list the replay kind for the family (no D1 opt-in)', () => {
    const signedOnly = replayRegistry(SLUG, [SIGNED]);
    const detailed = evaluateCoverageDetailed(
      input({
        registry: signedOnly,
        observations: FAMILIES.map((f) => stored(replayEvidence(f, {}, signedOnly))),
      }),
    );
    expect(detailed.facts).toEqual(ALL_UNKNOWN);
    for (const family of FAMILIES) {
      expect(detailed.families[family]).toEqual(UNCOUNTED('evidence_unbound'));
    }
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
    const detailed = evaluateCoverageDetailed({
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
    });
    expect(detailed.facts).toEqual(ALL_UNKNOWN);
    for (const family of FAMILIES) {
      expect(detailed.families[family]).toEqual({
        source_count: null,
        count_basis: 'unknown',
        basis_kind: null,
        reasons: [{ code: 'basis_kind_conflict', platform: other }],
      });
    }
    expect(verdictOf(detailed.facts)).toEqual(PARTIAL_UNKNOWN);
  });
});

// ── No closure exists: run-level `complete` is unreachable through this evidence ────────

describe('L3 — executive reset §1/§8: no package type has a completeness closure', () => {
  it('a learned-shaped package (composed, verifiers: []) with fully proven replay evidence settles partial', () => {
    const detailed = evaluateCoverageDetailed(input());
    expect(detailed.families).toEqual(BASELINE_COUNTS);
    expect(verdictOf(detailed.facts)).toEqual(PARTIAL_UNKNOWN);
  });

  it('a repository FILE package (loaded by the real file loader) with fully proven replay evidence settles partial too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'l3-file-package-'));
    writeFileSync(
      join(dir, `${SLUG}.json`),
      JSON.stringify({
        ...MANIFEST_RAW,
        basisKinds: { clients: [REPLAY], programs: [REPLAY], workouts: [REPLAY] },
        verifiers: [],
      }),
      'utf8',
    );
    const registry = buildInductionRegistry({
      manifests: loadInductionManifests(dir, false),
      specs: [parseSourceMappingSpec(SPEC_RAW, `${SLUG}.json`)],
      nativeRuleSets: [],
    });
    const detailed = evaluateCoverageDetailed(
      input({
        registry,
        observations: FAMILIES.map((f) => stored(replayEvidence(f, {}, registry))),
      }),
    );
    expect(detailed.families).toEqual(BASELINE_COUNTS);
    expect(detailed.facts).toEqual(ALL_UNKNOWN);
    expect(verdictOf(detailed.facts)).toEqual(PARTIAL_UNKNOWN);
  });

  it('the evaluator input has no closure field and the induction modules export no closure record', () => {
    const base = input();
    expect(Object.keys(base).sort()).toEqual([
      'declaration',
      'observations',
      'registry',
      'run',
      'staged',
    ]);
    const src = join(__dirname, '../../../src/scout/induction');
    expect(existsSync(join(src, 'closure.ts'))).toBe(false);
    for (const file of ['contract.ts', 'verify.ts', 'manifest-registry.ts']) {
      const text = readFileSync(join(src, file), 'utf8');
      expect(text).not.toMatch(
        /FamilySetClosureV1|RunClosureV1|reviewed_package|observed_templates/,
      );
      expect(text).not.toMatch(/ExclusionSignals|exclusionConfirmed|repository_file/);
    }
  });

  it('the source-signed (test-only) basis alone still reaches `complete`, with count_basis proven and no reason', () => {
    const registry = replayRegistry(SLUG, [SIGNED]);
    const signedRows = FAMILIES.map((family) =>
      stored(
        evidenceFor(
          {
            statement_version: 1,
            source_platform: SLUG,
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
          specDigest(registry),
        ),
      ),
    );
    const detailed = evaluateCoverageDetailed(input({ registry, observations: signedRows }));
    expect(detailed.families.workouts).toEqual({
      source_count: 3,
      count_basis: 'proven',
      basis_kind: SIGNED,
      reasons: [],
    });
    expect(detailed.facts.workouts).toEqual({
      known: true,
      basis_kind: SIGNED,
      observed_unique: 3,
      covers_staged_identities: true,
    });
    expect(verdictOf(detailed.facts)).toEqual({ outcome: 'complete', reason_code: null });
  });
});

// ── No path lets the AI's classification alone produce `complete` ───────────────────────

describe('L3 — the AI never decides completeness', () => {
  it('the evaluator output carries no field a producer could set to `known`: a proven count is never a basis, a truncated crawl is not even a count', () => {
    const truncated = FAMILIES.map((f) =>
      stored(
        replayEvidence(f, {
          steps: STEPS[f].map((name) => step(name, { stop: 'budget' })),
        }),
      ),
    );
    const detailed = evaluateCoverageDetailed(input({ observations: truncated }));
    expect(detailed.facts).toEqual(ALL_UNKNOWN);
    for (const family of FAMILIES) {
      expect(detailed.families[family]).toEqual(UNCOUNTED('crawl_truncated'));
    }
    expect(verdictOf(detailed.facts)).toEqual(PARTIAL_UNKNOWN);
  });

  it('the evaluator and parser modules import nothing from an AI, gateway or learn module', () => {
    const src = join(__dirname, '../../../src/scout/induction');
    for (const file of ['verify.ts', 'parse.ts', 'contract.ts']) {
      const text = readFileSync(join(src, file), 'utf8');
      const imports = [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      expect(imports.filter((i) => /learn|ai-gateway|anthropic|provider|prompt/i.test(i))).toEqual(
        [],
      );
    }
  });

  it('`complete` requires every predicate at once: a known covering basis for every family AND the claim success', () => {
    const registry = replayRegistry(SLUG, [SIGNED]);
    const proven = evaluateCoverage(
      input({
        registry,
        observations: FAMILIES.map((family) =>
          stored(
            evidenceFor(
              {
                statement_version: 1,
                source_platform: SLUG,
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
              specDigest(registry),
            ),
          ),
        ),
      }),
    );
    expect(verdictOf(proven)).toEqual({ outcome: 'complete', reason_code: null });
    expect(reconcile({ ...cleanFacts(proven), claim: 'partial' }).verdict.outcome).toBe('partial');
    expect(reconcile(cleanFacts({ ...proven, programs: UNKNOWN })).verdict).toEqual(
      PARTIAL_UNKNOWN,
    );
  });
});
