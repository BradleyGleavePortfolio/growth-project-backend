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
 * L3 r3 — the T4 fix-round negatives of PR #589 (R589-c7A-02…05, R589-c7B-01…06) and the L0
 * r5/r6 L15 acceptance set (D-L0-6 "Per-family counting evidence is kept", identical text in r5
 * and r6). Every behavioural test here fails on `61b0d251` (the audited head): there `short_page`
 * proved, `first_page_only` did not parse, a fan-out bound itself or a cycle, per-step digests
 * were never checked and `observed` did not exist. Pure tier: no DB, no Nest. R589-c7A-01 (an
 * unmarked signed manifest in a production runtime) is reproduced and closed in
 * `test-only-exclusion.spec.ts`.
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
const ALL_UNKNOWN = { clients: UNKNOWN, programs: UNKNOWN, workouts: UNKNOWN };
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
  return {
    claim: 'success',
    families,
    relationships: [],
    spec_families: FAMILIES,
    ledger_without_staged: 0,
    coverage,
  };
}

// ── R589-c7A-02 / R589-c7B-01 / L15: only a positive terminal proves ──────────────────────

describe('L3 r3 — stops (L0 r5/r6 D-L0-6): a short or first page is observed, never proven', () => {
  it('L15: a metadata-free 17-item first page (first_page_only) yields observed 17, never proven', () => {
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
                  stop: 'first_page_only',
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
    expect(d.families.clients).toEqual(OBSERVED(17));
    expect(d.facts.clients).toEqual(UNKNOWN);
  });

  it('L15: an early short page (short_page after 1 page) yields observed, never proven; the same list with empty_page on page 3 is proven', () => {
    const shortPage = detailed({
      observations: rows({
        clients: [
          stored(
            replayEvidence('clients', {
              steps: [step('members', { pages_fetched: 1, stop: 'short_page' })],
            }),
          ),
        ],
      }),
    });
    expect(shortPage.families.clients).toEqual(OBSERVED(2));
    const twoPages = detailed({
      observations: rows({
        clients: [
          stored(
            replayEvidence('clients', {
              steps: [step('members', { pages_fetched: 3, stop: 'empty_page' })],
            }),
          ),
        ],
      }),
    });
    expect(twoPages.families.clients).toEqual(PROVEN(2));
    expect(twoPages.facts).toEqual(ALL_UNKNOWN);
  });

  it('every stop classified: empty_page/absent_next prove; short_page/first_page_only/advertised_next observe; budget/cycle/error unknown; the r2 none_proven is not a stop', () => {
    const outcome = (over: Record<string, unknown>) =>
      detailed({
        observations: rows({
          clients: [stored(replayEvidence('clients', { steps: [step('members', over)] }))],
        }),
      }).families.clients;
    for (const stop of ['empty_page', 'absent_next']) expect(outcome({ stop })).toEqual(PROVEN(2));
    for (const stop of ['short_page', 'first_page_only', 'advertised_next']) {
      expect(outcome({ stop })).toEqual(OBSERVED(2));
    }
    expect(outcome({ advertised_next: true })).toEqual(OBSERVED(2));
    expect(outcome({ refused_pages: 2 })).toEqual(OBSERVED(2));
    for (const stop of ['budget', 'cycle', 'error']) {
      expect(outcome({ stop })).toEqual(UNCOUNTED('crawl_truncated'));
    }
    expect(outcome({ stop: 'none_proven' })).toEqual(UNCOUNTED('evidence_malformed'));
    expect([...contract.REPLAY_STEP_STOPS]).not.toContain('none_proven');
    expect([...contract.FAMILY_COUNT_BASES]).toEqual(['proven', 'observed', 'unknown']);
  });

  it('one short step among two exhausted-or-not: the family is observed with the union count; the S9 facts stay known: false and the run settles partial', () => {
    const d = detailed({
      observations: rows({
        workouts: [
          stored(
            replayEvidence('workouts', {
              steps: [step('routines'), step('sessions', { pages_fetched: 1, stop: 'short_page' })],
            }),
          ),
        ],
      }),
    });
    expect(d.families).toEqual({ ...BASELINE, workouts: OBSERVED(3) });
    expect(d.facts).toEqual(ALL_UNKNOWN);
    expect(reconcile(cleanFacts(d.facts)).verdict).toEqual({
      outcome: 'partial',
      reason_code: 'coverage_basis_unknown',
    });
  });

  it('observed still requires the identities to be the staged ones: a short page whose ids are not staged is unknown, not observed', () => {
    const d = detailed({
      observations: rows({
        clients: [
          stored(
            replayEvidence('clients', {
              steps: [step('members', { pages_fetched: 1, stop: 'short_page', id_set_digest: sha256('x') })],
              id_set_digest: sha256('x'),
            }),
          ),
        ],
      }),
    });
    expect(d.families.clients).toEqual(UNCOUNTED('step_staged_mismatch'));
  });
});

// ── R589-c7A-03 / R589-c7B-02 / L15: a fan-out binds to the parent's VERIFIED id set ─────

describe('L3 r3 — fan-out (L0 r5/r6 D-L0-6): parent_ids_digest = the parent step’s verified digest; no self, no cycle; every context exhausted', () => {
  const emptyStaged = (stepIds: Record<string, string[]>) => [stagedFromSteps(stepIds)];

  it('c7B-02 (a)/(c): a step naming itself as fan-out parent is refused by the parser (zero pages, expected 0 → never a proven 0; nonzero → never proven)', () => {
    const selfZero = replayEvidence('programs', {
      steps: [
        step('plans', {
          pages_fetched: 0,
          raw_items: 0,
          distinct_raw_ids: 0,
          fan_out: fanOver('plans', []),
          id_set_digest: referenceIdDigest([]),
        }),
      ],
      observed_unique: 0,
      id_set_digest: referenceIdDigest([]),
    });
    expect(parseEvidence(selfZero)).toEqual({ ok: false, reason: 'bad_step' });
    const d = detailed({
      observations: rows({ programs: [stored(selfZero)] }),
      staged: emptyStaged({ ...STEP_IDS, plans: [] }),
    });
    expect(d.families.programs).toEqual(UNCOUNTED('evidence_malformed'));
    const selfNonzero = replayEvidence('workouts', {
      steps: [step('routines'), step('sessions', { fan_out: fanOver('sessions', ['w3']) })],
    });
    expect(parseEvidence(selfNonzero)).toEqual({ ok: false, reason: 'bad_step' });
  });

  it('c7B-02 (b): two steps that are each other’s parent (a cycle) with zero pages never prove 0 → fan_out_cycle', () => {
    const cycle = replayEvidence('workouts', {
      steps: [
        step('routines', {
          pages_fetched: 0,
          raw_items: 0,
          distinct_raw_ids: 0,
          fan_out: fanOver('sessions', []),
          id_set_digest: referenceIdDigest([]),
        }),
        step('sessions', {
          pages_fetched: 0,
          raw_items: 0,
          distinct_raw_ids: 0,
          fan_out: fanOver('routines', []),
          id_set_digest: referenceIdDigest([]),
        }),
      ],
      observed_unique: 0,
      id_set_digest: referenceIdDigest([]),
    });
    const d = detailed({
      observations: rows({ workouts: [stored(cycle)] }),
      staged: emptyStaged({ ...STEP_IDS, routines: [], sessions: [] }),
    });
    expect(d.families.workouts).toEqual(UNCOUNTED('fan_out_cycle'));
    expect(d.families.clients).toEqual(PROVEN(2));
  });

  it('c7B-02 (d) / c7A-04: a parent inside a multi-step family with a deflated per-step count is caught against its own staged rows; the child bound to it falls with it', () => {
    // routines reports 1 id (staged: w1, w2); sessions reports w1..w3 so the union still matches.
    const deflated = replayEvidence('workouts', {
      steps: [
        step('routines', { raw_items: 1, distinct_raw_ids: 1, id_set_digest: referenceIdDigest(['w1']) }),
        step('sessions', { raw_items: 3, distinct_raw_ids: 3, id_set_digest: referenceIdDigest(IDS.workouts) }),
      ],
    });
    const child = replayEvidence('programs', {
      steps: [step('plans', { fan_out: fanOver('routines', ['w1']) })],
    });
    const d = detailed({ observations: rows({ workouts: [stored(deflated)], programs: [stored(child)] }) });
    expect(d.families.workouts).toEqual(UNCOUNTED('step_staged_mismatch'));
    expect(d.families.programs).toEqual(UNCOUNTED('fan_out_parent_unproven'));
    // The honest binding to routines' two verified ids proves.
    const honest = replayEvidence('programs', {
      // r4: `empty_page` counts the fetched empty terminal page — 2 contexts, 1 item, 3 pages.
      steps: [step('plans', { pages_fetched: 3, fan_out: fanOver('routines', STEP_IDS.routines) })],
    });
    expect(detailed({ observations: rows({ programs: [stored(honest)] }) }).families).toEqual(BASELINE);
  });

  it('c7A-04 / c7B-C4: garbage per-step digests with an inflated step sum and a correct family union no longer prove', () => {
    const garbage = replayEvidence('workouts', {
      steps: [
        step('routines', { raw_items: 4, distinct_raw_ids: 4, id_set_digest: '0'.repeat(64) }),
        step('sessions', { id_set_digest: 'f'.repeat(64) }),
      ],
    });
    expect(detailed({ observations: rows({ workouts: [stored(garbage)] }) }).families.workouts).toEqual(
      UNCOUNTED('step_staged_mismatch'),
    );
    // Correct digests with the ids swapped between the steps (a right union, wrong membership).
    const swapped = replayEvidence('workouts', {
      steps: [
        step('routines', { raw_items: 1, distinct_raw_ids: 1, id_set_digest: referenceIdDigest(['w3']) }),
        step('sessions', { raw_items: 2, distinct_raw_ids: 2, id_set_digest: referenceIdDigest(['w1', 'w2']) }),
      ],
    });
    expect(detailed({ observations: rows({ workouts: [stored(swapped)] }) }).families.workouts).toEqual(
      UNCOUNTED('step_staged_mismatch'),
    );
  });

  it('L15 duplicate-A/omitted-B: parent_ids_digest over {A} with contexts 2/2/2 ≠ the parent’s {A, B} → fan_out_parent_mismatch; an honest 1-of-2 is observed', () => {
    const sessions = (fan: Record<string, unknown>, pages = 2) =>
      replayEvidence('workouts', {
        steps: [step('routines'), step('sessions', { pages_fetched: pages, stop: 'absent_next', fan_out: fan })],
      });
    const duplicateA = sessions({ ...fanOver('members', ['c1']), contexts_expected: 2, contexts_fetched: 2, contexts_exhausted: 2 });
    expect(detailed({ observations: rows({ workouts: [stored(duplicateA)] }) }).families.workouts).toEqual(
      UNCOUNTED('fan_out_parent_mismatch'),
    );
    // A digest over {A, B} claimed while only one context was fetched is not exhausted: observed.
    const oneOfTwo = sessions({ ...fanOver('members', STEP_IDS.members), contexts_fetched: 1, contexts_exhausted: 1 }, 1);
    expect(detailed({ observations: rows({ workouts: [stored(oneOfTwo)] }) }).families.workouts).toEqual(
      OBSERVED(3),
    );
    // Both fetched, one not positively exhausted: observed.
    const oneUnexhausted = sessions({ ...fanOver('members', STEP_IDS.members), contexts_exhausted: 1 });
    expect(detailed({ observations: rows({ workouts: [stored(oneUnexhausted)] }) }).families.workouts).toEqual(
      OBSERVED(3),
    );
  });

  it('L15 expected 0 with a non-empty parent → fan_out_count_mismatch; a parent digest of the wrong step → fan_out_parent_mismatch', () => {
    const zero = replayEvidence('workouts', {
      steps: [
        step('routines'),
        step('sessions', {
          pages_fetched: 0,
          raw_items: 0,
          distinct_raw_ids: 0,
          fan_out: { ...fanOver('members', STEP_IDS.members), contexts_expected: 0, contexts_fetched: 0, contexts_exhausted: 0 },
          id_set_digest: referenceIdDigest([]),
        }),
      ],
      observed_unique: 2,
      id_set_digest: referenceIdDigest(STEP_IDS.routines),
    });
    const d = detailed({
      observations: rows({ workouts: [stored(zero)] }),
      staged: [stagedFromSteps({ ...STEP_IDS, sessions: [] })],
    });
    expect(d.families.workouts).toEqual(UNCOUNTED('fan_out_count_mismatch'));
    const wrongParentDigest = replayEvidence('workouts', {
      steps: [
        step('routines'),
        step('sessions', { pages_fetched: 3, fan_out: { ...fanOver('members', ['p1']), contexts_expected: 2, contexts_fetched: 2, contexts_exhausted: 2 } }),
      ],
    });
    expect(detailed({ observations: rows({ workouts: [stored(wrongParentDigest)] }) }).families.workouts).toEqual(
      UNCOUNTED('fan_out_parent_mismatch'),
    );
  });

  it('L15 H > 1 pages per context: 2 contexts over 5 pages proves; fewer pages than contexts is fan_out_short', () => {
    const sessions = (pages: number) =>
      replayEvidence('workouts', {
        steps: [step('routines'), step('sessions', { pages_fetched: pages, stop: 'absent_next', fan_out: fanOver('members', STEP_IDS.members) })],
      });
    expect(detailed({ observations: rows({ workouts: [stored(sessions(5))] }) }).families).toEqual(BASELINE);
    expect(detailed({ observations: rows({ workouts: [stored(sessions(1))] }) }).families.workouts).toEqual(
      UNCOUNTED('fan_out_short'),
    );
  });

  it('a fan-out over a parent that is only observed (its list not exhausted) is itself at most observed', () => {
    const shortParent = replayEvidence('clients', {
      steps: [step('members', { pages_fetched: 1, stop: 'short_page' })],
    });
    const fanned = replayEvidence('workouts', {
      steps: [step('routines'), step('sessions', { pages_fetched: 2, stop: 'absent_next', fan_out: fanOver('members', STEP_IDS.members) })],
    });
    const d = detailed({ observations: rows({ clients: [stored(shortParent)], workouts: [stored(fanned)] }) });
    expect(d.families.clients).toEqual(OBSERVED(2));
    expect(d.families.workouts).toEqual(OBSERVED(3));
    expect(d.families.programs).toEqual(PROVEN(1));
  });

  it('a fan-out whose parent chain ends in a root step through another fan-out proves; a chain to a missing step does not', () => {
    // plans fans out over sessions (1 id), which fans out over members (2 ids), a root step.
    const sessionsOverMembers = replayEvidence('workouts', {
      steps: [step('routines'), step('sessions', { pages_fetched: 2, stop: 'absent_next', fan_out: fanOver('members', STEP_IDS.members) })],
    });
    const plansOverSessions = replayEvidence('programs', {
      steps: [step('plans', { pages_fetched: 2, fan_out: fanOver('sessions', STEP_IDS.sessions) })],
    });
    expect(
      detailed({ observations: rows({ workouts: [stored(sessionsOverMembers)], programs: [stored(plansOverSessions)] }) })
        .families,
    ).toEqual(BASELINE);
    const plansOverNobody = replayEvidence('programs', {
      steps: [step('plans', { fan_out: fanOver('nobody', ['x']) })],
    });
    expect(detailed({ observations: rows({ programs: [stored(plansOverNobody)] }) }).families.programs).toEqual(
      UNCOUNTED('fan_out_parent_unproven'),
    );
  });
});

// ── R589-c7A-05 / R589-c7B-05: identity scope ────────────────────────────────────────────

describe('L3 r3 — idScope (L0 r5/r6 D-L0-6 "Identity", D-L0-4 C0): step counts and digests are over the STAGED identity', () => {
  it('two parents sharing a child raw id: a raw (collapsed) digest never verifies against the composed staged rows; the composed one proves', () => {
    // sessions is scoped to its parent member: the staged identities are `c1:s1` and `c2:s1`.
    const composed = ['c1:s1', 'c2:s1'];
    const staged = [stagedFromSteps({ ...STEP_IDS, sessions: composed })];
    const workoutsIds = [...STEP_IDS.routines, ...composed];
    const evidence = (sessionIds: string[]) =>
      replayEvidence('workouts', {
        steps: [
          step('routines'),
          step('sessions', {
            pages_fetched: 2,
            stop: 'absent_next',
            raw_items: 2,
            distinct_raw_ids: sessionIds.length,
            duplicate_ids: 2 - sessionIds.length,
            id_set_digest: referenceIdDigest(sessionIds),
            fan_out: fanOver('members', STEP_IDS.members),
          }),
        ],
        observed_unique: 2 + sessionIds.length,
        id_set_digest: referenceIdDigest([...STEP_IDS.routines, ...sessionIds]),
      });
    const raw = detailed({ observations: rows({ workouts: [stored(evidence(['s1']))] }), staged });
    expect(raw.families.workouts).toEqual(UNCOUNTED('step_staged_mismatch'));
    const scoped = detailed({ observations: rows({ workouts: [stored(evidence(composed))] }), staged });
    expect(scoped.families.workouts).toEqual(PROVEN(4));
    expect(scoped.families.workouts.source_count).toBe(workoutsIds.length);
  });
});

// ── R589-c7B-03: the family token is a step only when the spec maps no other step ──────

describe('L3 r3 — the family token rule (L0 r5/r6 D-L0-6, R589-B-C7)', () => {
  it('a spec that maps no step to programs: the token alone proves; the token beside a mapped step, or a spec step beside the token, is step_set_mismatch', () => {
    const specNoPlans = parseSourceMappingSpec(
      { ...SPEC_RAW, steps: { members: 'clients', routines: 'workouts', sessions: 'workouts' } },
      `${SLUG}.json`,
    );
    const registry = buildInductionRegistry({
      manifests: [parseInductionManifest(REPLAY_MANIFEST_RAW, `${SLUG}.json`)],
      specs: [specNoPlans],
      nativeRuleSets: [],
    });
    expect(registry.packages.get(SLUG)?.stepsByFamily.get('programs')).toBeUndefined();
    const tokenStep = step('programs', { raw_items: 1, distinct_raw_ids: 1, id_set_digest: referenceIdDigest(['p1']) });
    const tokenOnly = replayEvidence('programs', { steps: [tokenStep] }, registry);
    const staged = [stagedFromSteps({ members: STEP_IDS.members, routines: STEP_IDS.routines, sessions: STEP_IDS.sessions, programs: ['p1'] })];
    const observations = [
      stored(replayEvidence('clients', {}, registry)),
      stored(replayEvidence('workouts', {}, registry)),
      stored(tokenOnly),
    ];
    expect(detailed({ registry, observations, staged }).families).toEqual(BASELINE);
    const tokenPlusPlans = replayEvidence('programs', { steps: [tokenStep, step('plans')] }, registry);
    expect(
      detailed({ registry, observations: [observations[0], observations[1], stored(tokenPlusPlans)], staged })
        .families.programs,
    ).toEqual(UNCOUNTED('step_set_mismatch'));
    // Under the fixture spec (plans mapped) the token beside plans is an extra step.
    expect(
      detailed({
        observations: rows({
          programs: [stored(replayEvidence('programs', { steps: [step('plans'), step('programs', { raw_items: 0, distinct_raw_ids: 0 })] }))],
        }),
      }).families.programs,
    ).toEqual(UNCOUNTED('step_set_mismatch'));
  });
});

// ── R589-c7B-04: `observed` is an evaluator basis for L2d, never a run basis ─────────────

describe('L3 r3 — count_basis observed (L0 r5/r6 D-L0-6 "Family count basis", D-L0-6.3 FamilyRowV1)', () => {
  it('an observed family carries source_count, basis_kind and the closed reasons list_not_exhausted + completeness_not_proven; facts stay known: false', () => {
    const d = detailed({
      observations: rows({ programs: [stored(replayEvidence('programs', { steps: [step('plans', { stop: 'short_page' })] }))] }),
    });
    expect(d.families.programs).toEqual(OBSERVED(1));
    expect(d.facts.programs).toEqual(UNKNOWN);
    for (const reason of d.families.programs.reasons) {
      expect(contract.COVERAGE_REASON_CODES).toContain(reason.code);
    }
    expect(contract.COVERAGE_REASON_CODES).toContain('list_not_exhausted');
  });

  it('a family observed on one platform and proven on another is observed overall (the weaker basis wins)', () => {
    const other = 'zz_other_source';
    const registry = buildInductionRegistry({
      manifests: [
        parseInductionManifest(REPLAY_MANIFEST_RAW, `${SLUG}.json`),
        parseInductionManifest({ ...REPLAY_MANIFEST_RAW, sourcePlatform: other }, `${other}.json`),
      ],
      specs: [SPEC, parseSourceMappingSpec({ ...SPEC_RAW, sourcePlatform: other }, `${other}.json`)],
      nativeRuleSets: [],
    });
    const otherRows = FAMILIES.map((f) =>
      stored({
        ...replayEvidence(f, {}, registry),
        source_platform: other,
        mapping_spec_digest: registry.packages.get(other)?.specDigest,
        ...(f === 'clients' ? { steps: [step('members', { stop: 'short_page', pages_fetched: 1 })] } : {}),
      }),
    );
    const d = evaluateCoverageDetailed({
      run: RUN,
      declaration: {
        challenge: CHALLENGE,
        platforms: [
          { source_platform: SLUG, account_scope_id_digests: [SCOPE] },
          { source_platform: other, account_scope_id_digests: [SCOPE] },
        ],
      },
      registry,
      observations: [...FAMILIES.map((f) => stored(replayEvidence(f, {}, registry))), ...otherRows],
      staged: [stagedFromSteps(), stagedFromSteps(STEP_IDS, other)],
    });
    expect(d.families.clients).toEqual({
      source_count: 4,
      count_basis: 'observed',
      basis_kind: REPLAY,
      reasons: [
        { code: 'list_not_exhausted', platform: other },
        { code: 'completeness_not_proven', platform: null },
      ],
    });
    expect(d.families.programs).toEqual({ ...PROVEN(2) });
    expect(d.facts).toEqual(ALL_UNKNOWN);
  });
});

// ── The production staged side (S10-C) feeds the per-step verification ──────────────────

describe('L3 r3 — stagedPlatformFacts supplies the per-step digests the evaluator verifies against', () => {
  it('the S10-C grouping of real staged rows proves the two-step workouts union and a fan-out over members end to end', () => {
    const mappers = buildSourceMapperRegistry([SPEC]);
    const row = (entity_type: string, source_id: string) => ({ source_platform: SLUG, entity_type, source_id });
    const staged = stagedPlatformFacts(mappers, [
      row('members', 'c1'),
      row('members', 'c2'),
      row('plans', 'p1'),
      row('routines', 'w1'),
      row('routines', 'w2'),
      row('sessions', 'w3'),
    ]);
    const fanned = replayEvidence('workouts', {
      steps: [step('routines'), step('sessions', { pages_fetched: 2, stop: 'absent_next', fan_out: fanOver('members', STEP_IDS.members) })],
    });
    const d = detailed({ observations: rows({ workouts: [stored(fanned)] }), staged });
    expect(d.families).toEqual(BASELINE);
    // Drop one staged routines row: the step no longer verifies, the family is unknown (never 3).
    const short = stagedPlatformFacts(mappers, [
      row('members', 'c1'),
      row('members', 'c2'),
      row('plans', 'p1'),
      row('routines', 'w1'),
      row('sessions', 'w3'),
    ]);
    expect(detailed({ observations: rows({ workouts: [stored(fanned)] }), staged: short }).families.workouts).toEqual(
      UNCOUNTED('step_staged_mismatch'),
    );
  });

  it('a staged side without per-step digests (a caller that never supplied them) leaves every replay family unknown, never 0', () => {
    const noSteps = { ...stagedFromSteps(), steps: new Map() };
    const d = detailed({ staged: [noSteps] });
    for (const family of FAMILIES) expect(d.families[family]).toEqual(UNCOUNTED('staged_digest_missing'));
    const hostile = { ...stagedFromSteps(), steps: 'nope' as unknown as ReadonlyMap<string, never> };
    expect(() => detailed({ staged: [hostile] })).not.toThrow();
    expect(detailed({ staged: [hostile] }).families.clients.count_basis).toBe('unknown');
  });
});
