import { readFileSync } from 'fs';
import { join } from 'path';
import * as contract from '../../../src/scout/induction/contract';
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
  type FamilyCoverageDetail,
  type StagedPlatformFacts,
  type StoredObservation,
} from '../../../src/scout/induction/verify';
import { parseSourceMappingSpec } from '../../../src/scout/reconstruct/mapping-spec';
import { buildSourceMapperRegistry } from '../../../src/scout/reconstruct/source-mapper-registry';
import { stagedPlatformFacts } from '../../../src/scout/reconciliation/facts.service';
import { reconcile } from '../../../src/scout/reconciliation/reconcile';
import type {
  CoverageFact,
  FamilyFacts,
  ReconciliationFacts,
} from '../../../src/scout/reconciliation/types';
import {
  referenceIdDigest,
  S10_PURE_MANIFESTS_DIR,
  S10_PURE_SPEC_PATH,
  sha256,
} from '../../fixtures/scout/s10_pure/s10-pure-signer';

/**
 * L3 r4 — the T4 fix-round negatives of PR #589 round 4: `R589-c7A2-01` (a reported item with no
 * accounted identity could still be certified `proven`) and `R589-c7B2-02` (`empty_page` proved on
 * page counts that cannot contain a fetched empty terminal page: the auditor's T19/T20). Every
 * behavioural test marked "fails on e5b990b6" does so on the audited head: there
 * `distinct + duplicate < raw_items` passed and a single non-empty page labelled `empty_page`
 * proved. The positives pin what stays proven (a two-page list whose page 3 is empty, an empty
 * collection proven by one positive GET, a cursor list on one page). Pure tier: no DB, no Nest.
 * `R589-c7B2-01` (the pinned/learned package path) is reproduced and closed in
 * `test-only-exclusion.spec.ts`; `R589-c7A2-02` (the OpenAPI union) in
 * `test/contracts/importer-contract.spec.ts`.
 */

type Family = 'clients' | 'programs' | 'workouts';
const FAMILIES: readonly Family[] = ['clients', 'programs', 'workouts'];
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

const SPEC_RAW: Record<string, unknown> = JSON.parse(readFileSync(S10_PURE_SPEC_PATH, 'utf8'));
const MANIFEST_RAW: Record<string, unknown> = JSON.parse(
  readFileSync(join(S10_PURE_MANIFESTS_DIR, `${SLUG}.json`), 'utf8'),
);
const REPLAY_MANIFEST_RAW = {
  ...MANIFEST_RAW,
  basisKinds: { clients: [REPLAY], programs: [REPLAY], workouts: [REPLAY] },
  verifiers: [],
};
const SPEC = parseSourceMappingSpec(SPEC_RAW, `${SLUG}.json`);
const REGISTRY: InductionRegistry = buildInductionRegistry({
  manifests: [parseInductionManifest(REPLAY_MANIFEST_RAW, `${SLUG}.json`)],
  specs: [SPEC],
  nativeRuleSets: [],
});
const specDigest = (registry: InductionRegistry = REGISTRY): string =>
  registry.packages.get(SLUG)?.specDigest ?? 'missing';

/** One exhausted root step (a two-page list whose page 3 came back empty; L15 positive). */
function step(step_key: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const ids = STEP_IDS[step_key] ?? [];
  return {
    step_key,
    pages_fetched: 3,
    raw_items: ids.length,
    distinct_raw_ids: ids.length,
    duplicate_ids: 0,
    synthetic_ids: 0,
    missing_id_items: 0,
    stop: 'empty_page',
    advertised_next: false,
    refused_pages: 0,
    fan_out: null,
    id_set_digest: referenceIdDigest(ids),
    ...over,
  };
}

/** A fan-out claim over `parent` with the given visited id set, all contexts exhausted. */
function fanOver(parent: string, visited: string[], over: Record<string, unknown> = {}) {
  return {
    parent_step: parent,
    parent_ids_digest: referenceIdDigest(visited),
    contexts_expected: visited.length,
    contexts_fetched: visited.length,
    contexts_exhausted: visited.length,
    ...over,
  };
}

function replayEvidence(
  family: Family,
  over: Record<string, unknown> = {},
  registry: InductionRegistry = REGISTRY,
): Record<string, unknown> {
  return {
    evidence_version: 1,
    source_platform: SLUG,
    account_scope_id_digest: SCOPE,
    family,
    basis_kind: REPLAY,
    mapping_spec_digest: specDigest(registry),
    challenge_b64: CHALLENGE.toString('base64'),
    steps: STEPS[family].map((name) => step(name)),
    observed_unique: new Set(IDS[family]).size,
    id_set_digest: referenceIdDigest(IDS[family]),
    ...over,
  };
}

function stored(evidence: unknown): StoredObservation {
  return {
    coach_id: RUN.coach_id,
    intent_id: RUN.intent_id,
    execution_epoch: RUN.execution_epoch,
    received_at: RECEIVED,
    evidence,
  };
}

function rows(replace: Partial<Record<Family, StoredObservation[]>> = {}): StoredObservation[] {
  return FAMILIES.flatMap((family) => replace[family] ?? [stored(replayEvidence(family))]);
}

/** The staged side from explicit per-step ids (families are the union of their steps). */
function stagedFromSteps(
  stepIds: Record<string, string[]> = STEP_IDS,
  slug = SLUG,
): StagedPlatformFacts {
  const families: Record<string, string[]> = { clients: [], programs: [], workouts: [] };
  const steps: Record<string, string[]> = { clients: [], programs: [], workouts: [] };
  for (const [stepKey, ids] of Object.entries(stepIds)) {
    steps[stepKey] = ids;
    const family = FAMILIES.find((f) => STEPS[f].includes(stepKey) || f === stepKey);
    if (family !== undefined) families[family] = [...families[family], ...ids];
  }
  return {
    source_platform: slug,
    grouped_families: FAMILIES,
    families: stagedFamilyDigests(Object.entries(families)),
    steps: stagedFamilyDigests(Object.entries(steps)),
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
    staged: [stagedFromSteps()],
    ...over,
  };
}
const detailed = (over: Partial<CoverageEvaluationInput> = {}) =>
  evaluateCoverageDetailed(input(over));

const UNKNOWN: CoverageFact = { known: false };
const PROVEN = (n: number): FamilyCoverageDetail => ({
  source_count: n,
  count_basis: 'proven',
  basis_kind: REPLAY,
  reasons: [{ code: 'completeness_not_proven', platform: null }],
});
const OBSERVED = (n: number): FamilyCoverageDetail => ({
  source_count: n,
  count_basis: 'observed',
  basis_kind: REPLAY,
  reasons: [
    { code: 'list_not_exhausted', platform: SLUG },
    { code: 'completeness_not_proven', platform: null },
  ],
});
const UNCOUNTED = (...codes: contract.CoverageReasonCode[]): FamilyCoverageDetail => ({
  source_count: null,
  count_basis: 'unknown',
  basis_kind: null,
  reasons: codes.map((code) => ({ code, platform: SLUG })),
});
const BASELINE = { clients: PROVEN(2), programs: PROVEN(1), workouts: PROVEN(3) };

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

// ── R589-c7A2-01: exact accounting of raw items ───────────────────────────────────────────

describe('L3 r4 — R589-c7A2-01: every reported item must be accounted for before a count is proven', () => {
  /** The auditor's exact counterexample: 2 items reported, 1 identity, nothing else accounted. */
  const unaccounted = (over: Record<string, unknown> = {}) =>
    replayEvidence('programs', {
      steps: [
        step('plans', {
          pages_fetched: 2,
          raw_items: 2,
          distinct_raw_ids: 1,
          duplicate_ids: 0,
          synthetic_ids: 0,
          missing_id_items: 0,
          stop: 'empty_page',
          ...over,
        }),
      ],
      observed_unique: 1,
      id_set_digest: referenceIdDigest(['p1']),
    });

  it('fails on e5b990b6: raw_items 2 with distinct 1 and no duplicate/synthetic/missing is evidence_inconsistent (unknown), never proven 1', () => {
    const d = detailed({ observations: rows({ programs: [stored(unaccounted())] }) });
    expect(d.families.programs).toEqual(UNCOUNTED('evidence_inconsistent'));
    expect(d.facts.programs).toEqual(UNKNOWN);
    expect(d.families.clients).toEqual(PROVEN(2));
    expect(d.families.workouts).toEqual(PROVEN(3));
    // The run still settles partial; nothing here is a closure.
    expect(reconcile(cleanFacts(d.facts)).verdict).toEqual({
      outcome: 'partial',
      reason_code: 'coverage_basis_unknown',
    });
  });

  it('ordinary duplicates account exactly: 3 items, 1 identity seen 3 times → proven 1; 3 items with 2 distinct and 1 duplicate → proven 2 when staged agrees', () => {
    const tripled = unaccounted({ raw_items: 3, distinct_raw_ids: 1, duplicate_ids: 2 });
    expect(
      detailed({ observations: rows({ programs: [stored(tripled)] }) }).families.programs,
    ).toEqual(PROVEN(1));
    const ids = ['p1', 'p2'];
    const twoOfThree = replayEvidence('programs', {
      steps: [
        step('plans', {
          pages_fetched: 2,
          raw_items: 3,
          distinct_raw_ids: 2,
          duplicate_ids: 1,
          id_set_digest: referenceIdDigest(ids),
        }),
      ],
      observed_unique: 2,
      id_set_digest: referenceIdDigest(ids),
    });
    const d = detailed({
      observations: rows({ programs: [stored(twoOfThree)] }),
      staged: [stagedFromSteps({ ...STEP_IDS, plans: ids })],
    });
    expect(d.families.programs).toEqual(PROVEN(2));
  });

  it.each([
    [
      'one item short of the partition (raw 2, distinct 1, duplicate 0)',
      { raw_items: 2, distinct_raw_ids: 1, duplicate_ids: 0 },
    ],
    ['many items short (raw 17, distinct 1)', { raw_items: 17, distinct_raw_ids: 1 }],
    [
      'over-accounted (raw 1, distinct 1, duplicate 1)',
      { raw_items: 1, distinct_raw_ids: 1, duplicate_ids: 1 },
    ],
    ['distinct exceeds raw (raw 0, distinct 1)', { raw_items: 0, distinct_raw_ids: 1 }],
    ['raw 0 with a duplicate', { raw_items: 0, distinct_raw_ids: 0, duplicate_ids: 1 }],
  ])('%s → evidence_inconsistent', (_name, over) => {
    const d = detailed({ observations: rows({ programs: [stored(unaccounted(over))] }) });
    expect(d.families.programs.count_basis).toBe('unknown');
    expect(d.families.programs.source_count).toBeNull();
    expect(d.families.programs.reasons).toEqual([
      { code: 'evidence_inconsistent', platform: SLUG },
    ]);
  });

  it('a synthetic or missing id is still identity_unproven first, whether or not the partition sums (order unchanged)', () => {
    const synthetic = unaccounted({ raw_items: 2, distinct_raw_ids: 1, synthetic_ids: 1 });
    expect(
      detailed({ observations: rows({ programs: [stored(synthetic)] }) }).families.programs,
    ).toEqual(UNCOUNTED('identity_unproven'));
    const missing = unaccounted({ raw_items: 5, distinct_raw_ids: 1, missing_id_items: 1 });
    expect(
      detailed({ observations: rows({ programs: [stored(missing)] }) }).families.programs,
    ).toEqual(UNCOUNTED('identity_unproven'));
  });

  it('the partition is per step: one unaccounted step unproves a multi-step family even when the union matches staging', () => {
    const leaky = replayEvidence('workouts', {
      steps: [
        step('routines', { raw_items: 3, distinct_raw_ids: 2, duplicate_ids: 0 }),
        step('sessions'),
      ],
    });
    expect(
      detailed({ observations: rows({ workouts: [stored(leaky)] }) }).families.workouts,
    ).toEqual(UNCOUNTED('evidence_inconsistent'));
  });

  it('an observed (short page) count is held to the same accounting: unaccounted items make it unknown, not observed', () => {
    const shortLeaky = unaccounted({ pages_fetched: 1, stop: 'short_page' });
    expect(
      detailed({ observations: rows({ programs: [stored(shortLeaky)] }) }).families.programs,
    ).toEqual(UNCOUNTED('evidence_inconsistent'));
    const shortHonest = unaccounted({ pages_fetched: 1, stop: 'short_page', raw_items: 1 });
    expect(
      detailed({ observations: rows({ programs: [stored(shortHonest)] }) }).families.programs,
    ).toEqual(OBSERVED(1));
  });
});

// ── R589-c7B2-02: `empty_page` needs room for the fetched empty terminal page ─────────────

describe('L3 r4 — R589-c7B2-02: empty_page proves only when the evidence holds a fetched empty terminal page', () => {
  it('fails on e5b990b6 (T19): a 17-item SINGLE page labelled empty_page is evidence_inconsistent — unknown, not proven, not even observed', () => {
    const ids = Array.from({ length: 17 }, (_, i) => `m${i}`);
    const d = detailed({
      observations: rows({
        clients: [
          stored(
            replayEvidence('clients', {
              steps: [
                step('members', {
                  pages_fetched: 1,
                  raw_items: 17,
                  distinct_raw_ids: 17,
                  stop: 'empty_page',
                  id_set_digest: referenceIdDigest(ids),
                }),
              ],
              observed_unique: 17,
              id_set_digest: referenceIdDigest(ids),
            }),
          ),
        ],
      }),
      staged: [stagedFromSteps({ ...STEP_IDS, members: ids })],
    });
    expect(d.families.clients).toEqual(UNCOUNTED('evidence_inconsistent'));
    expect(d.facts.clients).toEqual(UNKNOWN);
    expect(reconcile(cleanFacts(d.facts)).verdict).toEqual({
      outcome: 'partial',
      reason_code: 'coverage_basis_unknown',
    });
  });

  it('the same 17 items on 2 pages (data page + fetched empty page 2) prove 17; on 3 pages too', () => {
    const ids = Array.from({ length: 17 }, (_, i) => `m${i}`);
    const on = (pages: number) =>
      replayEvidence('clients', {
        steps: [
          step('members', {
            pages_fetched: pages,
            raw_items: 17,
            distinct_raw_ids: 17,
            stop: 'empty_page',
            id_set_digest: referenceIdDigest(ids),
          }),
        ],
        observed_unique: 17,
        id_set_digest: referenceIdDigest(ids),
      });
    for (const pages of [2, 3]) {
      const d = detailed({
        observations: rows({ clients: [stored(on(pages))] }),
        staged: [stagedFromSteps({ ...STEP_IDS, members: ids })],
      });
      expect(d.families.clients).toEqual(PROVEN(17));
      expect(d.facts.clients).toEqual(UNKNOWN);
    }
  });

  it('the T0 baseline shape (pages_fetched 1, items, empty_page) on every step is unknown on every family', () => {
    const d = detailed({
      observations: FAMILIES.map((family) =>
        stored(
          replayEvidence(family, {
            steps: STEPS[family].map((name) => step(name, { pages_fetched: 1 })),
          }),
        ),
      ),
    });
    expect(d.families).toEqual({
      clients: UNCOUNTED('evidence_inconsistent'),
      programs: UNCOUNTED('evidence_inconsistent'),
      workouts: UNCOUNTED('evidence_inconsistent'),
    });
  });

  it('an EMPTY collection is proven by one positive GET: raw_items 0, pages_fetched 1, empty_page → proven 0 over an empty staged step', () => {
    const empty = replayEvidence('programs', {
      steps: [
        step('plans', {
          pages_fetched: 1,
          raw_items: 0,
          distinct_raw_ids: 0,
          id_set_digest: referenceIdDigest([]),
        }),
      ],
      observed_unique: 0,
      id_set_digest: referenceIdDigest([]),
    });
    const d = detailed({
      observations: rows({ programs: [stored(empty)] }),
      staged: [stagedFromSteps({ ...STEP_IDS, plans: [] })],
    });
    expect(d.families.programs).toEqual(PROVEN(0));
  });

  it('cursor / next_url style is unchanged: absent_next after a single data page proves; short_page on one page stays observed', () => {
    const cursor = replayEvidence('clients', {
      steps: [step('members', { pages_fetched: 1, stop: 'absent_next' })],
    });
    expect(
      detailed({ observations: rows({ clients: [stored(cursor)] }) }).families.clients,
    ).toEqual(PROVEN(2));
    const short = replayEvidence('clients', {
      steps: [step('members', { pages_fetched: 1, stop: 'short_page' })],
    });
    expect(detailed({ observations: rows({ clients: [stored(short)] }) }).families.clients).toEqual(
      OBSERVED(2),
    );
  });

  it("fails on e5b990b6 (T20): a fan-out over 2 contexts with 2 pages in total, items and empty_page is evidence_inconsistent (each context's only page would have been the empty one)", () => {
    const fanned = replayEvidence('programs', {
      steps: [
        step('plans', {
          pages_fetched: 2,
          stop: 'empty_page',
          fan_out: fanOver('members', STEP_IDS.members),
        }),
      ],
    });
    const d = detailed({ observations: rows({ programs: [stored(fanned)] }) });
    expect(d.families.programs).toEqual(UNCOUNTED('evidence_inconsistent'));
    expect(d.families.clients).toEqual(PROVEN(2));
  });

  it('the honest fan-out shapes prove: 2 contexts over 3 pages with items; 2 contexts over 2 pages with no items; absent_next over 2 pages', () => {
    const threePages = replayEvidence('programs', {
      steps: [
        step('plans', {
          pages_fetched: 3,
          stop: 'empty_page',
          fan_out: fanOver('members', STEP_IDS.members),
        }),
      ],
    });
    expect(detailed({ observations: rows({ programs: [stored(threePages)] }) }).families).toEqual(
      BASELINE,
    );
    const noItems = replayEvidence('programs', {
      steps: [
        step('plans', {
          pages_fetched: 2,
          raw_items: 0,
          distinct_raw_ids: 0,
          stop: 'empty_page',
          fan_out: fanOver('members', STEP_IDS.members),
          id_set_digest: referenceIdDigest([]),
        }),
      ],
      observed_unique: 0,
      id_set_digest: referenceIdDigest([]),
    });
    expect(
      detailed({
        observations: rows({ programs: [stored(noItems)] }),
        staged: [stagedFromSteps({ ...STEP_IDS, plans: [] })],
      }).families.programs,
    ).toEqual(PROVEN(0));
    const cursorFan = replayEvidence('programs', {
      steps: [
        step('plans', {
          pages_fetched: 2,
          stop: 'absent_next',
          fan_out: fanOver('members', STEP_IDS.members),
        }),
      ],
    });
    expect(
      detailed({ observations: rows({ programs: [stored(cursorFan)] }) }).families.programs,
    ).toEqual(PROVEN(1));
  });

  it('a fan-out with fewer pages than contexts is still fan_out_short (checked before the empty-page rule)', () => {
    const short = replayEvidence('programs', {
      steps: [
        step('plans', {
          pages_fetched: 1,
          stop: 'empty_page',
          fan_out: fanOver('members', STEP_IDS.members),
        }),
      ],
    });
    expect(
      detailed({ observations: rows({ programs: [stored(short)] }) }).families.programs,
    ).toEqual(UNCOUNTED('fan_out_short'));
  });

  it("the parser accepts the T19/T20 rows (the contradiction is the evaluator's, so a stored row answers unknown, not evidence_malformed)", () => {
    const t19 = replayEvidence('clients', { steps: [step('members', { pages_fetched: 1 })] });
    expect(parseEvidence(t19).ok).toBe(true);
    const t20 = replayEvidence('programs', {
      steps: [step('plans', { pages_fetched: 2, fan_out: fanOver('members', STEP_IDS.members) })],
    });
    expect(parseEvidence(t20).ok).toBe(true);
  });
});

// ── The r4 rules over real staged rows (stagedPlatformFacts) ──────────────────────────────

describe('L3 r4 — end to end over stagedPlatformFacts rows', () => {
  const rowsFor = (stepIds: Record<string, string[]>) =>
    Object.entries(stepIds).flatMap(([entity_type, ids]) =>
      ids.map((source_id) => ({ source_platform: SLUG, entity_type, source_id })),
    );
  const stagedReal = (stepIds: Record<string, string[]> = STEP_IDS) =>
    stagedPlatformFacts(buildSourceMapperRegistry([SPEC]), rowsFor(stepIds));

  it("the auditor's counterexample against real per-step digests: unknown; the honest row: proven", () => {
    const leaky = replayEvidence('programs', {
      steps: [step('plans', { pages_fetched: 2, raw_items: 2, distinct_raw_ids: 1 })],
    });
    expect(
      detailed({ observations: rows({ programs: [stored(leaky)] }), staged: stagedReal() }).families
        .programs,
    ).toEqual(UNCOUNTED('evidence_inconsistent'));
    expect(detailed({ staged: stagedReal() }).families).toEqual(BASELINE);
  });
});
