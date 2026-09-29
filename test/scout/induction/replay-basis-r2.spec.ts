import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as contract from '../../../src/scout/induction/contract';
import { stagedFamilyDigests } from '../../../src/scout/induction/digest';
import {
  buildInductionRegistry,
  loadInductionManifests,
  type InductionRegistry,
} from '../../../src/scout/induction/manifest-registry';
import {
  checkObservationBodySize,
  parseEvidence,
  parseInductionManifest,
} from '../../../src/scout/induction/parse';
import {
  evaluateCoverage,
  evaluateCoverageDetailed,
  type CoverageEvaluationInput,
  type StagedPlatformFacts,
  type StoredObservation,
} from '../../../src/scout/induction/verify';
import { parseSourceMappingSpec } from '../../../src/scout/reconstruct/mapping-spec';
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
 * L3 r2 — the T4 reviewer negatives of PR #589 (R589-A, R589-B N1–N5), ported to assert the
 * CORRECT behaviour, plus the executive reset of 2026-09-29 (§1, §8): no package type has a
 * completeness closure, so no path through replay evidence reaches run-level `complete`, while
 * a family's SOURCE COUNT can be proven. Every test here fails on fe38821 (the reviewed head).
 *
 * Deliberately typed loosely (plain objects, `ReturnType` indirection) so the file compiles
 * against fe38821 too and its failures there are assertion failures, not type errors.
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

/** The learned-package shape: composed by hand, replay kind, no verifier. */
const COMPOSED: InductionRegistry = buildInductionRegistry({
  manifests: [parseInductionManifest(REPLAY_MANIFEST_RAW, `${SLUG}.json`)],
  specs: [parseSourceMappingSpec(SPEC_RAW, `${SLUG}.json`)],
  nativeRuleSets: [],
});
/** The repository-file shape: the same manifest through the real file loader. */
const FILE: InductionRegistry = ((): InductionRegistry => {
  const dir = mkdtempSync(join(tmpdir(), 'l3-r2-file-'));
  writeFileSync(join(dir, `${SLUG}.json`), JSON.stringify(REPLAY_MANIFEST_RAW), 'utf8');
  return buildInductionRegistry({
    manifests: loadInductionManifests(dir, false),
    specs: [parseSourceMappingSpec(SPEC_RAW, `${SLUG}.json`)],
    nativeRuleSets: [],
  });
})();
const specDigest = (registry: InductionRegistry): string =>
  registry.packages.get(SLUG)?.specDigest ?? 'missing';

/** L0 r5 `StepEvidenceV1` (the shape this PR accepts). */
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

/** The fe38821 step shape (`ReplayStepTerminalV1`), which the r2 parser refuses wholesale. */
function oldStep(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    step: name,
    stop: 'short_page',
    pages_fetched: 3,
    max_pages: 10,
    refused_pages: 0,
    fan_out: null,
    ...over,
  };
}

function replayEvidence(
  family: Family,
  over: Record<string, unknown> = {},
  registry: InductionRegistry = COMPOSED,
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

function rows(
  replace: Partial<Record<Family, StoredObservation[]>> = {},
  registry: InductionRegistry = COMPOSED,
): StoredObservation[] {
  return FAMILIES.flatMap(
    (family) => replace[family] ?? [stored(replayEvidence(family, {}, registry))],
  );
}

/** L3 r3: the staged rows per step token (the fixture split; family tokens have no rows). */
function stepIdsFor(ids: Partial<Record<string, string[]>>): Record<string, string[]> {
  const workouts = ids.workouts ?? [];
  const isDefault = workouts.join(',') === IDS.workouts.join(',');
  return {
    clients: [],
    programs: [],
    workouts: [],
    members: ids.clients ?? [],
    plans: ids.programs ?? [],
    routines: isDefault ? STEP_IDS.routines : workouts,
    sessions: isDefault ? STEP_IDS.sessions : [],
  };
}

function staged(ids: Partial<Record<string, string[]>> = IDS): StagedPlatformFacts {
  return {
    source_platform: SLUG,
    grouped_families: FAMILIES,
    families: stagedFamilyDigests(Object.entries(ids).map(([f, list]) => [f, list ?? []])),
    steps: stagedFamilyDigests(Object.entries(stepIdsFor(ids))),
  };
}

/** A fan-out claim over the `members` (clients) step, both parents visited and exhausted. */
const FAN_OVER_MEMBERS = {
  parent_step: 'members',
  parent_ids_digest: referenceIdDigest(STEP_IDS.members),
  contexts_expected: 2,
  contexts_fetched: 2,
  contexts_exhausted: 2,
};
/** `obj` without `key` (a genuinely absent wire key, not `undefined`). */
function without(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...obj };
  delete copy[key];
  return copy;
}

function input(over: Partial<CoverageEvaluationInput> = {}): CoverageEvaluationInput {
  const registry = over.registry ?? COMPOSED;
  return {
    run: RUN,
    declaration: {
      challenge: CHALLENGE,
      platforms: [{ source_platform: SLUG, account_scope_id_digests: [SCOPE] }],
    },
    registry,
    observations: rows({}, registry),
    staged: [staged()],
    ...over,
  };
}

/**
 * The r1 `reviewed_package` closure record for the fixture package, smuggled in through an extra
 * key. fe38821 honoured it (and so proved `complete` from observer evidence alone); r2 has no
 * closure input and ignores it. Used so the reset tests FAIL on fe38821 for the right reason.
 */
function withR1Closure(over: Partial<CoverageEvaluationInput> = {}): CoverageEvaluationInput {
  const registry = over.registry ?? COMPOSED;
  const extra: Record<string, unknown> = {
    closure: [
      {
        closure_version: 1,
        source_platform: SLUG,
        mapping_spec_digest: specDigest(registry),
        origin: 'reviewed_package',
      },
    ],
  };
  return { ...input(over), ...extra };
}

const UNKNOWN: CoverageFact = { known: false };
const ALL_UNKNOWN = { clients: UNKNOWN, programs: UNKNOWN, workouts: UNKNOWN };
const PARTIAL_UNKNOWN = { outcome: 'partial', reason_code: 'coverage_basis_unknown' };

/** The r2 detail structure, read loosely so this file compiles against fe38821. */
interface Detail {
  readonly source_count: number | null;
  readonly count_basis: string;
  readonly basis_kind: string | null;
  readonly reasons: readonly { code: string; platform: string | null }[];
}
const detailed = (
  over: Partial<CoverageEvaluationInput> = {},
): { facts: Record<string, CoverageFact>; families: Record<string, Detail> } => {
  const out: Record<string, unknown> = { ...evaluateCoverageDetailed(input(over)) };
  const facts = out.facts;
  const families = out.families;
  return {
    facts:
      facts !== null && typeof facts === 'object' ? (facts as Record<string, CoverageFact>) : {},
    families:
      families !== null && typeof families === 'object' ? (families as Record<string, Detail>) : {},
  };
};
const COUNTED = (n: number): Detail => ({
  source_count: n,
  count_basis: 'proven',
  basis_kind: REPLAY,
  reasons: [{ code: 'completeness_not_proven', platform: null }],
});
const UNCOUNTED = (...codes: string[]): Detail => ({
  source_count: null,
  count_basis: 'unknown',
  basis_kind: null,
  reasons: codes.map((code) => ({ code, platform: SLUG })),
});

/** Native-clean S9 facts over the baseline staged ids, so only coverage can block `complete`. */
function cleanFacts(
  coverage: ReturnType<typeof evaluateCoverage>,
  ids: Record<Family, string[]> = IDS,
): ReconciliationFacts {
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
    identities: ids[family].map((identity): FamilyFacts['identities'][number] => ({
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

// ── R589-A-3 / R589-B-B1 (N1): unknown is never 0 ─────────────────────────────────────────

describe('L3 r2 — N1: a crawl that fetched ZERO pages observed no terminal → unknown, never 0', () => {
  it('the fe38821 shape (pages_fetched 0, absent_next, observed 0) no longer proves 0 over an empty staged side', () => {
    const zero = (family: Family) =>
      stored(
        replayEvidence(family, {
          steps: STEPS[family].map((name) =>
            oldStep(name, { pages_fetched: 0, stop: 'absent_next' }),
          ),
          observed_unique: 0,
          id_set_digest: referenceIdDigest([]),
        }),
      );
    const facts = evaluateCoverage(
      withR1Closure({
        observations: FAMILIES.map(zero),
        staged: [staged({ clients: [], programs: [], workouts: [] })],
      }),
    );
    expect(facts).toEqual(ALL_UNKNOWN);
    expect(
      reconcile(cleanFacts(facts, { clients: [], programs: [], workouts: [] })).verdict,
    ).not.toMatchObject({ outcome: 'complete' });
  });

  it('the r5 shape: a root step with pages_fetched 0 is refused by the parser and, stored, poisons its unit', () => {
    const zero = replayEvidence('programs', {
      steps: [
        step('plans', {
          pages_fetched: 0,
          raw_items: 0,
          distinct_raw_ids: 0,
          stop: 'absent_next',
          id_set_digest: referenceIdDigest([]),
        }),
      ],
      observed_unique: 0,
      id_set_digest: referenceIdDigest([]),
    });
    const parsed = parseEvidence(zero);
    expect(parsed).toEqual({ ok: false, reason: 'bad_count' });
    const d = detailed({
      observations: rows({ programs: [stored(zero)] }),
      staged: [staged({ ...IDS, programs: [] })],
    });
    expect(d.facts.programs).toEqual(UNKNOWN);
    expect(d.families.programs).toEqual(UNCOUNTED('evidence_malformed'));
  });

  it('an empty family needs a POSITIVE terminal proof: one fetched page that came back empty counts 0; nothing else does', () => {
    const empty = (over: Record<string, unknown>) =>
      replayEvidence('programs', {
        steps: [
          step('plans', {
            pages_fetched: 1,
            raw_items: 0,
            distinct_raw_ids: 0,
            stop: 'empty_page',
            id_set_digest: referenceIdDigest([]),
            ...over,
          }),
        ],
        observed_unique: 0,
        id_set_digest: referenceIdDigest([]),
      });
    const stagedEmpty = [staged({ ...IDS, programs: [] })];
    const good = detailed({
      observations: rows({ programs: [stored(empty({}))] }),
      staged: stagedEmpty,
    });
    expect(good.families.programs).toEqual(COUNTED(0));
    expect(good.facts.programs).toEqual(UNKNOWN); // a count, never a run-level basis
    for (const over of [{ stop: 'budget' }, { stop: 'cycle' }, { stop: 'error' }]) {
      const bad = detailed({
        observations: rows({ programs: [stored(empty(over))] }),
        staged: stagedEmpty,
      });
      expect([over, bad.families.programs]).toEqual([over, UNCOUNTED('crawl_truncated')]);
    }
    // r5: a first page, an advertised next link or a refused page is observed, never proven.
    for (const over of [{ stop: 'first_page_only' }, { advertised_next: true }, { refused_pages: 1 }]) {
      const bad = detailed({
        observations: rows({ programs: [stored(empty(over))] }),
        staged: stagedEmpty,
      });
      expect([over, bad.families.programs.count_basis]).toEqual([over, 'observed']);
      expect(bad.families.programs.reasons.map((r) => r.code)).toEqual([
        'list_not_exhausted',
        'completeness_not_proven',
      ]);
    }
  });
});

// ── R589-A-4 / R589-B-B1 (N2): a fan-out is bound to its parent's proven count ───────────

describe('L3 r2 — N2: a fan-out step is bound to its parent step’s PROVEN distinct count', () => {
  const emptyWorkouts = (steps: unknown[]) =>
    replayEvidence('workouts', {
      steps,
      observed_unique: 0,
      id_set_digest: referenceIdDigest([]),
    });
  const stagedNoWorkouts = [staged({ clients: IDS.clients, programs: IDS.programs, workouts: [] })];

  it('the fe38821 shape (expected 0 / fetched 0, no parent) no longer proves the child family as 0', () => {
    const facts = evaluateCoverage(
      withR1Closure({
        observations: rows({
          workouts: [
            stored(
              emptyWorkouts([
                oldStep('routines', { pages_fetched: 0 }),
                oldStep('sessions', { pages_fetched: 0, fan_out: { expected: 0, fetched: 0 } }),
              ]),
            ),
          ],
        }),
        staged: stagedNoWorkouts,
      }),
    );
    expect(facts.workouts).toEqual(UNKNOWN);
  });

  it('r5: a fan-out that claims contexts_expected 0 while its parent (members) verified 2 → fan_out_count_mismatch', () => {
    const d = detailed({
      observations: rows({
        workouts: [
          stored(
            emptyWorkouts([
              step('routines', {
                pages_fetched: 1,
                raw_items: 0,
                distinct_raw_ids: 0,
                stop: 'empty_page',
                id_set_digest: referenceIdDigest([]),
              }),
              step('sessions', {
                pages_fetched: 0,
                raw_items: 0,
                distinct_raw_ids: 0,
                stop: 'empty_page',
                id_set_digest: referenceIdDigest([]),
                fan_out: { ...FAN_OVER_MEMBERS, contexts_expected: 0, contexts_fetched: 0, contexts_exhausted: 0 },
              }),
            ]),
          ),
        ],
      }),
      staged: stagedNoWorkouts,
    });
    expect(d.facts.workouts).toEqual(UNKNOWN);
    expect(d.families.workouts).toEqual(UNCOUNTED('fan_out_count_mismatch'));
    expect(d.families.clients).toEqual(COUNTED(2)); // the parent itself is unaffected
  });

  it('r5: contexts_expected equal to the parent’s verified count counts; a parent step nobody verified, or an unproven parent family, does not', () => {
    const sessions = (over: Record<string, unknown>) =>
      step('sessions', {
        pages_fetched: 2,
        stop: 'absent_next',
        fan_out: FAN_OVER_MEMBERS,
        ...over,
      });
    const fanned = (over: Record<string, unknown> = {}) =>
      stored(replayEvidence('workouts', { steps: [step('routines'), sessions(over)] }));
    expect(detailed({ observations: rows({ workouts: [fanned()] }) }).families.workouts).toEqual(
      COUNTED(3),
    );
    expect(
      detailed({
        observations: rows({
          workouts: [fanned({ fan_out: { ...FAN_OVER_MEMBERS, parent_step: 'nobody' } })],
        }),
      }).families.workouts,
    ).toEqual(UNCOUNTED('fan_out_parent_unproven'));
    // The parent family (clients) is truncated → its step count is not proven → the child falls.
    const truncatedParent = stored(
      replayEvidence('clients', { steps: [step('members', { stop: 'budget' })] }),
    );
    const d = detailed({
      observations: rows({ clients: [truncatedParent], workouts: [fanned()] }),
    });
    expect(d.families.clients).toEqual(UNCOUNTED('crawl_truncated'));
    expect(d.families.workouts).toEqual(UNCOUNTED('fan_out_parent_unproven'));
    // A fan-out step whose parent binding is missing altogether is malformed, not a proof.
    expect(
      parseEvidence(
        replayEvidence('workouts', {
          steps: [step('routines'), sessions({ fan_out: without(FAN_OVER_MEMBERS, 'parent_step') })],
        }),
      ),
    ).toEqual({ ok: false, reason: 'missing_key' });
  });
});

// ── R589-A-1 / R589-B-A2 (N3) + executive reset §1/§8: no closure for any package ────────

describe('L3 r2 — N3: no package type yields run-level complete through replay evidence', () => {
  it('there is no closure module and no closure record type any more', () => {
    const src = join(__dirname, '../../../src/scout/induction');
    expect(existsSync(join(src, 'closure.ts'))).toBe(false);
    expect((contract as Record<string, unknown>).CLOSURE_REVIEWED_KEYS).toBeUndefined();
    expect((contract as Record<string, unknown>).CLOSURE_TEMPLATE_KEYS).toBeUndefined();
    const text = readFileSync(join(src, 'contract.ts'), 'utf8');
    expect(text).not.toMatch(/FamilySetClosureV1|reviewed_package|RunClosureV1/);
  });

  it.each([
    ['learned-shaped (composed, verifiers: [])', COMPOSED],
    ['repository file (real file loader)', FILE],
  ])(
    '%s package with fully proven replay evidence: every family counted, none known, run partial',
    (_label, registry) => {
      const d = detailed({ registry, observations: rows({}, registry) });
      expect(d.families).toEqual({
        clients: COUNTED(2),
        programs: COUNTED(1),
        workouts: COUNTED(3),
      });
      expect(d.facts).toEqual(ALL_UNKNOWN);
      expect(verdictOf(d.facts)).toEqual(PARTIAL_UNKNOWN);
      // And with the fe38821 evidence shape (which fe38821 proved from): still unknown.
      const old = FAMILIES.map((family) =>
        stored(
          replayEvidence(family, { steps: STEPS[family].map((name) => oldStep(name)) }, registry),
        ),
      );
      expect(evaluateCoverage(withR1Closure({ registry, observations: old }))).toEqual(ALL_UNKNOWN);
    },
  );

  it('the evaluator accepts no closure input: a smuggled r1 reviewed_package record changes nothing (r1 shape or r5 shape)', () => {
    const old = FAMILIES.map((family) =>
      stored(replayEvidence(family, { steps: STEPS[family].map((name) => oldStep(name)) })),
    );
    for (const observations of [old, rows()]) {
      const facts = evaluateCoverage(withR1Closure({ observations }));
      expect(facts).toEqual(ALL_UNKNOWN);
      expect(verdictOf(facts)).toEqual(PARTIAL_UNKNOWN);
    }
  });
});

// ── R589-A-2 / R589-B-A1 (N4): no producer-asserted exclusion ────────────────────────────

describe('L3 r2 — N4: the observed_templates variant and its producer-supplied signals are gone', () => {
  it('contract exports no template or exclusion-signal vocabulary', () => {
    const exported = Object.keys(contract);
    expect(exported.filter((k) => /TEMPLATE|EXCLUSION|CLOSURE/.test(k))).toEqual([]);
    const src = join(__dirname, '../../../src/scout/induction');
    for (const file of ['contract.ts', 'verify.ts', 'parse.ts', 'manifest-registry.ts']) {
      const text = readFileSync(join(src, file), 'utf8');
      expect([file, /observed_templates|ExclusionSignals|exclusionConfirmed/.test(text)]).toEqual([
        file,
        false,
      ]);
    }
  });

  it('an observed_templates record smuggled into the input never lifts a family to known', () => {
    const rec = {
      closure_version: 1,
      source_platform: SLUG,
      mapping_spec_digest: specDigest(COMPOSED),
      origin: 'observed_templates',
      rule_version: 1,
      digest_truncated: false,
      refused_collections: 0,
      unexplored_targets: 0,
      templates: FAMILIES.map((family, i) => ({
        template_ref: `t${i}`,
        disposition: 'mapped',
        family,
        unexplored_variants: 0,
      })),
    };
    const old = FAMILIES.map((family) =>
      stored(replayEvidence(family, { steps: STEPS[family].map((name) => oldStep(name)) })),
    );
    const extra: Record<string, unknown> = { closure: [rec] };
    for (const observations of [old, rows()]) {
      const smuggled: CoverageEvaluationInput = { ...input({ observations }), ...extra };
      expect(evaluateCoverage(smuggled)).toEqual(ALL_UNKNOWN);
    }
  });
});

// ── R589-A-5 / R589-B-B2 (N5): the typed per-family structure reaches the caller ─────────

describe('L3 r2 — N5: evaluateCoverageDetailed returns a typed per-family detail for the projection', () => {
  it('every emitted family has source_count / count_basis / basis_kind / reasons, keyed like facts', () => {
    const d = detailed();
    expect(Object.keys(d.families).sort()).toEqual(Object.keys(d.facts).sort());
    for (const family of FAMILIES) {
      expect(Object.keys(d.families[family]).sort()).toEqual([
        'basis_kind',
        'count_basis',
        'reasons',
        'source_count',
      ]);
      expect(d.families[family]).toEqual(COUNTED(IDS[family].length));
    }
  });

  it('reasons are closed codes with a platform or null, never a source id, URL or free text', () => {
    const exported = (contract as Record<string, unknown>).COVERAGE_REASON_CODES;
    const codes = new Set<string>(Array.isArray(exported) ? (exported as string[]) : []);
    expect(codes.has('completeness_not_proven')).toBe(true);
    expect(codes.has('closure_open')).toBe(false);
    const d = detailed({
      observations: rows({
        clients: [],
        workouts: [stored(replayEvidence('workouts', { steps: [step('routines')] }))],
      }),
    });
    for (const family of FAMILIES) {
      for (const reason of d.families[family].reasons) {
        expect(codes.has(reason.code)).toBe(true);
        expect(reason.platform === null || reason.platform === SLUG).toBe(true);
        expect(Object.keys(reason).sort()).toEqual(['code', 'platform']);
      }
    }
    expect(d.families.clients).toEqual(UNCOUNTED('evidence_missing'));
    expect(d.families.workouts).toEqual(UNCOUNTED('step_set_mismatch'));
    expect(d.families.programs).toEqual(COUNTED(1));
  });

  it('the S9 facts path (evaluateCoverage) is the detail’s `facts`, unchanged in shape', () => {
    expect(evaluateCoverage(input())).toEqual(evaluateCoverageDetailed(input()).facts);
  });
});

// ── L0 r5 D-L0-6 cardinality: the aggregate row's body bound ────────────────────────────

describe('L3 r2 — the observation body bound is 64 KiB only for an all-replay body', () => {
  it('checkObservationBodySize takes the replay bound explicitly and keeps 32 KiB by default', () => {
    expect(checkObservationBodySize(32768)).toEqual({ ok: true, value: 32768 });
    expect(checkObservationBodySize(32769)).toEqual({ ok: false, reason: 'too_large' });
    const replayBound = (contract as Record<string, unknown>).REPLAY_OBSERVATION_BODY_MAX_BYTES;
    expect(replayBound).toBe(65536);
    // Called through a loose alias so this file also compiles against the r1 one-argument form.
    const bounded = checkObservationBodySize as (bytes: number, bound?: number) => unknown;
    expect(bounded(65536, 65536)).toEqual({ ok: true, value: 65536 });
    expect(bounded(65537, 65536)).toEqual({ ok: false, reason: 'too_large' });
    expect((contract as Record<string, unknown>).REPLAY_MAX_STEPS).toBe(64);
  });
});
