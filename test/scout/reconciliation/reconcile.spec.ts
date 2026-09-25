import { arbitrate } from '../../../src/scout/lifecycle/arbiter';
import {
  isRunReasonCode,
  RUN_REASON_CODES,
  type RunReasonCode,
} from '../../../src/scout/lifecycle/reason-codes';
import { familyCoverage, requiredFamilies } from '../../../src/scout/reconciliation/coverage';
import {
  classifyIdentity,
  CREATED_NATIVE_SPLIT,
  edgeVerified,
  parseLedgerReason,
  reconcile,
} from '../../../src/scout/reconciliation/reconcile';
import {
  COMPLETENESS_BASIS_NONE,
  type CoverageFact,
  type FamilyFacts,
  type IdentityFacts,
  type LedgerRowFacts,
  type NativeTargetKind,
  type ProvenanceFacts,
  type ReconciliationFacts,
  type ReconciliationFamilyV1,
  type ReconciliationResult,
  type RelationshipFacts,
  S9_REASON_CODE,
  S9_REASON_CODES,
  S9_REPORT_CODE,
  UNRESOLVED_CATALOGUE,
  WRITER_CODE,
} from '../../../src/scout/reconciliation/types';

// S9-A — table-driven spec of the pure reconciler over the S9 decision doc's A-tier acceptance
// cases (docs/decisions/2026-09-25-s9-reconciliation.md §3: R01–R08, R10, R12, R14, R17–R19, plus
// the R09 arbiter composition at the unit level) and the parent S9 decisions: F1 `complete` needs
// a per-family completeness basis, F2 split is `null`, ceiling → `partial`, `blocked` never from
// S9. R11 (tenant isolation), R13 (legacy byte identity), R15 (projection) and the PG half of R16
// belong to S9-B/S9-C and are not asserted here.

// ── Fixture builders ────────────────────────────────────────────────────────────────────

/** Identity tokens carry a sentinel that must never surface in any report (R14). */
const SENTINEL = 'never-in-report@example.com';
const ident = (n: string): string => `truecoach:${n}:${SENTINEL}`;

const provenance = (over: Partial<ProvenanceFacts> = {}): ProvenanceFacts => ({
  outcome: 'created',
  native: 'present_owned',
  reason: null,
  unresolved_children: {},
  ...over,
});

const verifiedRow = (
  kind: NativeTargetKind = 'person',
  prov: ProvenanceFacts | null = provenance(),
): LedgerRowFacts => ({ status: 'reconstructed', target_kind: kind, provenance: prov });

const evidenceRow = (kind: 'scout_entity' | null): LedgerRowFacts => ({
  status: 'reconstructed',
  target_kind: kind,
  provenance: null,
});

const skippedRow = (reason: string | null): LedgerRowFacts => ({ status: 'skipped', reason });
const failedRow: LedgerRowFacts = { status: 'failed' };

const id = (
  n: string,
  ledger: LedgerRowFacts | null,
  token?: string,
  client_linked = false,
): IdentityFacts => ({
  token: token ?? n.replace(/-.*$/, ''),
  identity: ident(n),
  ledger,
  client_linked,
});

const fam = (
  family: string,
  identities: readonly IdentityFacts[],
  over: Partial<FamilyFacts> = {},
): FamilyFacts => ({
  family,
  mapped: true,
  resolution_reason: null,
  client_owned: false,
  ceiling_exceeded: false,
  identities,
  ledger_without_staged: 0,
  qualifiers: [],
  ...over,
});

const unmapped = (
  token: string,
  n: number,
  reason: string | null = `unresolved_family:${token}`,
): FamilyFacts =>
  fam(
    token,
    Array.from({ length: n }, (_, i) => id(`${token}-${i}`, null, token)),
    { mapped: false, resolution_reason: reason },
  );

/** A mapped family with `n` bucket-j identities under token = family. */
const cleanFamily = (family: string, n: number, kind: NativeTargetKind = 'person'): FamilyFacts =>
  fam(
    family,
    Array.from({ length: n }, (_, i) => id(`${family}-${i}`, verifiedRow(kind), family)),
  );

const known = (observed_unique: number, covers = true): CoverageFact => ({
  known: true,
  basis_kind: 's10-observation',
  observed_unique,
  covers_staged_identities: covers,
});

/** Coverage that vouches for every given family at its staged size. */
const coverFor = (families: readonly FamilyFacts[]): Record<string, CoverageFact> =>
  Object.fromEntries(families.map((f) => [f.family, known(f.identities.length)]));

/** The mapping spec declares exactly the mapped staged families unless a case says otherwise. */
const specOf = (families: readonly FamilyFacts[]): string[] =>
  families.filter((f) => f.mapped).map((f) => f.family);

const facts = (
  families: readonly FamilyFacts[],
  over: Partial<ReconciliationFacts> = {},
): ReconciliationFacts => ({
  claim: 'success',
  families,
  relationships: [],
  spec_families: specOf(families),
  ledger_without_staged: families.reduce((sum, f) => sum + f.ledger_without_staged, 0),
  coverage: null,
  ...over,
});

/** Clean facts with a basis for every family: the R01(a) baseline. */
const covered = (
  families: readonly FamilyFacts[],
  over: Partial<ReconciliationFacts> = {},
): ReconciliationFacts => facts(families, { coverage: coverFor(families), ...over });

const edge = (over: Partial<RelationshipFacts> = {}): RelationshipFacts => ({
  edge: 'client_link',
  from_family: 'workouts',
  from_identity: ident('workouts-0'),
  to_family: 'clients',
  to_identity: ident('clients-0'),
  consistent: null,
  ...over,
});

const row = (result: ReconciliationResult, family: string): ReconciliationFamilyV1 => {
  const found = result.report.families.find((f) => f.family === family);
  if (!found) throw new Error(`no report row for ${family}`);
  return found;
};

const counts = (pairs: Record<string, number>) =>
  Object.keys(pairs)
    .sort()
    .map((code) => ({ code, count: pairs[code] }));

const S9_CODES: readonly string[] = Object.values(S9_REASON_CODE);

/** D-S9-7: is this histogram key in the closed catalogue? */
const inCatalogue = (key: string): boolean => {
  if ((Object.values(S9_REPORT_CODE) as readonly string[]).includes(key)) return true;
  if (key === 'missing_source_id') return true;
  if (/^(unsupported_platform|unresolved_family):[A-Za-z0-9_.-]{1,64}$/.test(key)) return true;
  const m = /^unresolved:([a-z_]+)(?::([A-Za-z0-9_.-]{1,64}))?$/.exec(key);
  if (!m) return false;
  const shape = UNRESOLVED_CATALOGUE[m[1]];
  return shape === (m[2] === undefined ? 'bare' : 'qualified');
};

/** Invariants every verdict/report pair must satisfy (D-S9-1 outcome set, R12, R14, R17). */
function expectWellFormed(result: ReconciliationResult): void {
  const { verdict, report } = result;
  expect(['complete', 'partial']).toContain(verdict.outcome);
  if (verdict.outcome === 'complete') {
    expect(verdict.reason_code).toBeNull();
    expect(report.conditions).toEqual([]);
  } else {
    expect(S9_CODES).toContain(verdict.reason_code);
    expect(report.conditions[0]).toBe(verdict.reason_code);
    // conditions follow the D-S9-2 order and are unique
    const order = report.conditions.map((c) => S9_REASON_CODES.indexOf(c));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(report.conditions).size).toBe(report.conditions.length);
  }
  expect(report.report_version).toBe(1);
  expect(report.basis).toBe('recomputed');
  if (report.required_families === null) {
    expect(report.conditions).toContain(S9_REASON_CODE.coverage_basis_unknown);
  } else {
    expect(report.required_families).toEqual([...new Set(report.required_families)].sort());
    const reported = new Set(report.families.map((f) => f.family));
    for (const f of report.required_families) expect(reported.has(f)).toBe(true);
  }
  const attributed = report.families.reduce((acc, f) => acc + f.ledger_without_staged, 0);
  expect(report.ledger_without_staged).toBeGreaterThanOrEqual(attributed);
  const json = JSON.stringify(report);
  expect(json).not.toContain(SENTINEL);
  expect(json).not.toContain('truecoach:');
  // families sorted by (mapped desc, family)
  const keys = report.families.map((f) => `${f.mapped ? 0 : 1}:${f.family}`);
  expect(keys).toEqual([...keys].sort());
  for (const f of report.families) {
    expect(f.created_native).toBe(CREATED_NATIVE_SPLIT);
    expect(f.already_present_verified).toBe(CREATED_NATIVE_SPLIT);
    // partition invariant
    expect(f.native_present_verified + f.rejected + f.unresolved + f.failed).toBe(f.staged_unique);
    const tokenSum = f.tokens.reduce((acc, t) => acc + t.staged_unique, 0);
    expect(tokenSum).toBe(f.staged_unique);
    for (const t of f.tokens) {
      expect(t.native_present_verified + t.rejected + t.unresolved + t.failed).toBe(
        t.staged_unique,
      );
    }
    expect(f.tokens.map((t) => t.token)).toEqual([...f.tokens.map((t) => t.token)].sort());
    const reasonSum = f.reasons.reduce((acc, r) => acc + r.count, 0);
    expect(reasonSum).toBe(f.rejected + f.unresolved + f.failed);
    const childSum = f.child_reasons.reduce((acc, r) => acc + r.count, 0);
    expect(childSum).toBe(f.unresolved_children);
    for (const r of [...f.reasons, ...f.child_reasons]) {
      expect(inCatalogue(r.code)).toBe(true);
      expect(r.count).toBeGreaterThan(0);
    }
    expect(f.reasons.map((r) => r.code)).toEqual([...f.reasons.map((r) => r.code)].sort());
    if (!f.mapped) expect(f.native_present_verified).toBe(0);
    // With a known basis the count is a number; with `none` it may still be a counted fact from a
    // non-vouching observation, but it is never invented.
    if (f.completeness_basis !== COMPLETENESS_BASIS_NONE)
      expect(typeof f.observed_unique).toBe('number');
    expect(f.pagination_terminal_evidence).toBeNull();
    expect(f.date_window).toBeNull();
    expect(f.media_policy).toBeNull();
  }
}

// ── 1. parseLedgerReason (D-S9-7 key rules) ─────────────────────────────────────────────

describe('S9-A parseLedgerReason — closed grammar, never echo free text', () => {
  it.each<[string, string | null, string, string]>([
    ['null reason', null, 'unresolved', S9_REPORT_CODE.reason_unrecognised],
    ['missing_source_id → rejected verbatim', 'missing_source_id', 'rejected', 'missing_source_id'],
    [
      'unsupported_platform:<p> → rejected verbatim',
      'unsupported_platform:acme',
      'rejected',
      'unsupported_platform:acme',
    ],
    [
      'unsupported_platform with a non-token → unrecognised',
      'unsupported_platform:Bob Smith',
      'unresolved',
      S9_REPORT_CODE.reason_unrecognised,
    ],
    [
      'unresolved_family:<token> → unresolved verbatim',
      'unresolved_family:notes',
      'unresolved',
      'unresolved_family:notes',
    ],
    [
      'unresolved_family with an email → unrecognised',
      `unresolved_family:${SENTINEL}`,
      'unresolved',
      S9_REPORT_CODE.reason_unrecognised,
    ],
    [
      'bare catalogue code',
      'unresolved:no_native_client_principal',
      'unresolved',
      'unresolved:no_native_client_principal',
    ],
    [
      'bare code given a qualifier → unrecognised',
      'unresolved:identity_conflict:x',
      'unresolved',
      S9_REPORT_CODE.reason_unrecognised,
    ],
    [
      'qualified catalogue code',
      'unresolved:missing_required_field:name',
      'unresolved',
      'unresolved:missing_required_field:name',
    ],
    [
      'qualified code without a qualifier → unrecognised',
      'unresolved:relationship_missing',
      'unresolved',
      S9_REPORT_CODE.reason_unrecognised,
    ],
    [
      'qualified code, dotted qualifier',
      'unresolved:native_uniqueness:CheckIn.date',
      'unresolved',
      'unresolved:native_uniqueness:CheckIn.date',
    ],
    [
      'no_native_destination:<family>',
      'unresolved:no_native_destination:exercises',
      'unresolved',
      'unresolved:no_native_destination:exercises',
    ],
    [
      'code outside the catalogue → unrecognised, not echoed',
      'unresolved:something_new',
      'unresolved',
      S9_REPORT_CODE.reason_unrecognised,
    ],
    [
      'writer text with a space → unrecognised',
      'unresolved:invalid_value:weight lbs',
      'unresolved',
      S9_REPORT_CODE.reason_unrecognised,
    ],
    [
      'S9 report keys are not writer reasons → unrecognised',
      S9_REPORT_CODE.not_reconstructed,
      'unresolved',
      S9_REPORT_CODE.reason_unrecognised,
    ],
    [
      'arbitrary text → unrecognised',
      `Error: ${SENTINEL}`,
      'unresolved',
      S9_REPORT_CODE.reason_unrecognised,
    ],
  ])('%s', (_label, reason, bucket, code) => {
    expect(parseLedgerReason(reason)).toEqual({ bucket, code });
  });

  it('every catalogue entry round-trips in its own shape and fails in the other', () => {
    for (const [code, shape] of Object.entries(UNRESOLVED_CATALOGUE)) {
      const bare = `unresolved:${code}`;
      const qualified = `unresolved:${code}:field_name`;
      const ok = shape === 'bare' ? bare : qualified;
      const bad = shape === 'bare' ? qualified : bare;
      expect(parseLedgerReason(ok)).toEqual({ bucket: 'unresolved', code: ok });
      expect(parseLedgerReason(bad)).toEqual({
        bucket: 'unresolved',
        code: S9_REPORT_CODE.reason_unrecognised,
      });
    }
  });
});

// ── 2. classifyIdentity (D-S9-2 buckets a–k) ─────────────────────────────────────────────

describe('S9-A classifyIdentity — every ledger/provenance/native combination', () => {
  const mapped = fam('clients', []);
  const clientOwned = fam('client_history', [], { client_owned: true });
  const ceiling = fam('clients', [], { ceiling_exceeded: true });

  it.each<[string, LedgerRowFacts | null, FamilyFacts, string, string | null]>([
    ['(b) staged, no ledger row', null, mapped, 'unresolved', S9_REPORT_CODE.not_reconstructed],
    [
      '(b) staged, no ledger row, ceiling exceeded (R08)',
      null,
      ceiling,
      'unresolved',
      S9_REPORT_CODE.pass_ceiling_exceeded,
    ],
    ['(c) ledger failed → `failed`, no text', failedRow, mapped, 'failed', S9_REPORT_CODE.failed],
    [
      '(d) rejected missing_source_id',
      skippedRow('missing_source_id'),
      mapped,
      'rejected',
      'missing_source_id',
    ],
    [
      '(d) rejected unsupported_platform',
      skippedRow('unsupported_platform:x'),
      mapped,
      'rejected',
      'unsupported_platform:x',
    ],
    [
      '(e) §3.7 unresolved reason verbatim',
      skippedRow('unresolved:relationship_missing:clients'),
      mapped,
      'unresolved',
      'unresolved:relationship_missing:clients',
    ],
    [
      '(e) writer-recorded native_target_removed',
      skippedRow('unresolved:native_target_removed'),
      mapped,
      'unresolved',
      WRITER_CODE.native_target_removed,
    ],
    [
      '(e) skipped with unparseable reason',
      skippedRow('oops'),
      mapped,
      'unresolved',
      S9_REPORT_CODE.reason_unrecognised,
    ],
    [
      '(e) skipped without reason',
      skippedRow(null),
      mapped,
      'unresolved',
      S9_REPORT_CODE.reason_unrecognised,
    ],
    [
      '(f) target_kind NULL, coach-owned family → evidence_only',
      evidenceRow(null),
      mapped,
      'unresolved',
      S9_REPORT_CODE.evidence_only,
    ],
    [
      '(f) scout_entity, coach-owned family → evidence_only',
      evidenceRow('scout_entity'),
      mapped,
      'unresolved',
      S9_REPORT_CODE.evidence_only,
    ],
    [
      '(f) scout_entity, client-owned family → no_native_client_principal (D-S8-2)',
      evidenceRow('scout_entity'),
      clientOwned,
      'unresolved',
      WRITER_CODE.no_native_client_principal,
    ],
    [
      '(f) NULL kind, client-owned family → no_native_client_principal',
      evidenceRow(null),
      clientOwned,
      'unresolved',
      WRITER_CODE.no_native_client_principal,
    ],
    [
      '(g) native kind, no provenance row',
      verifiedRow('person', null),
      mapped,
      'unresolved',
      S9_REPORT_CODE.provenance_missing,
    ],
    [
      '(g) native kind, provenance outcome unresolved (native_id null)',
      verifiedRow('workout_plan', provenance({ outcome: 'unresolved' })),
      mapped,
      'unresolved',
      S9_REPORT_CODE.provenance_missing,
    ],
    [
      '(h) native row owned by another coach',
      verifiedRow('person', provenance({ native: 'foreign_owner' })),
      mapped,
      'unresolved',
      WRITER_CODE.identity_conflict,
    ],
    [
      '(h) native row of another kind',
      verifiedRow('workout_plan', provenance({ native: 'kind_mismatch' })),
      mapped,
      'unresolved',
      WRITER_CODE.identity_conflict,
    ],
    [
      '(h) provenance differs from ledger target',
      verifiedRow('workout_program', provenance({ native: 'provenance_mismatch' })),
      mapped,
      'unresolved',
      WRITER_CODE.identity_conflict,
    ],
    [
      '(i) native row archived/deleted (C4; R04)',
      verifiedRow('workout_program', provenance({ native: 'removed' })),
      mapped,
      'unresolved',
      WRITER_CODE.native_target_removed,
    ],
    [
      '(j) person, created, present+owned',
      verifiedRow('person'),
      mapped,
      'native_present_verified',
      null,
    ],
    [
      '(j) workout_program, already_present (replay)',
      verifiedRow('workout_program', provenance({ outcome: 'already_present' })),
      mapped,
      'native_present_verified',
      null,
    ],
    [
      '(j) workout_plan, created',
      verifiedRow('workout_plan'),
      mapped,
      'native_present_verified',
      null,
    ],
    [
      '(j) plan with unresolved children stays a verified parent (§4.4)',
      verifiedRow(
        'workout_plan',
        provenance({ unresolved_children: { 'unresolved:exercise_reference': 3 } }),
      ),
      mapped,
      'native_present_verified',
      null,
    ],
    [
      '(j) native kind in a client-owned family still counts when verified',
      verifiedRow('person'),
      clientOwned,
      'native_present_verified',
      null,
    ],
  ])('%s', (_label, ledger, family, bucket, code) => {
    expect(classifyIdentity(id('x', ledger, 't'), family)).toEqual({ bucket, code });
  });

  it('(a) unmapped entry: resolution reason decides; ledger is ignored', () => {
    const notes = unmapped('notes', 0);
    for (const ledger of [
      null,
      verifiedRow('person'),
      skippedRow('missing_source_id'),
      failedRow,
    ]) {
      expect(classifyIdentity(id('n', ledger, 'notes'), notes)).toEqual({
        bucket: 'unresolved',
        code: 'unresolved_family:notes',
      });
    }
    const foreign = unmapped('clients', 0, 'unsupported_platform:acme');
    expect(classifyIdentity(id('n', null, 'clients'), foreign)).toEqual({
      bucket: 'rejected',
      code: 'unsupported_platform:acme',
    });
    const odd = unmapped(`Bob ${SENTINEL}`, 0, null);
    expect(classifyIdentity(id('n', null, 'x'), odd)).toEqual({
      bucket: 'unresolved',
      code: S9_REPORT_CODE.reason_unrecognised,
    });
  });

  it('(f) is keyed per row (S8-DOC L148-149): a client-linked evidence row in a coach-owned family', () => {
    const workouts = fam('workouts', []);
    const linked = id('w', evidenceRow('scout_entity'), 'workouts', true);
    expect(classifyIdentity(linked, workouts)).toEqual({
      bucket: 'unresolved',
      code: WRITER_CODE.no_native_client_principal,
    });
    const said: LedgerRowFacts = {
      status: 'reconstructed',
      target_kind: 'scout_entity',
      provenance: provenance({
        outcome: 'unresolved',
        native: 'removed',
        reason: WRITER_CODE.no_native_client_principal,
      }),
    };
    expect(classifyIdentity(id('w', said, 'workouts'), workouts)).toEqual({
      bucket: 'unresolved',
      code: WRITER_CODE.no_native_client_principal,
    });
    const other: LedgerRowFacts = {
      status: 'reconstructed',
      target_kind: 'scout_entity',
      provenance: provenance({
        outcome: 'unresolved',
        native: 'removed',
        reason: 'unresolved:source_archived',
      }),
    };
    expect(classifyIdentity(id('w', other, 'workouts'), workouts)).toEqual({
      bucket: 'unresolved',
      code: S9_REPORT_CODE.evidence_only,
    });
  });

  it('(k) catch-all: data outside the type still lands in exactly one bucket, never echoed', () => {
    // Values a DB CHECK would normally forbid; parsed from JSON so the type is not asserted away.
    const weirdStatus: LedgerRowFacts = JSON.parse('{"status":"weird","reason":"x"}');
    expect(classifyIdentity(id('x', weirdStatus, 't'), mapped)).toEqual({
      bucket: 'unresolved',
      code: S9_REPORT_CODE.reason_unrecognised,
    });
    const weirdNative: ProvenanceFacts = JSON.parse(
      '{"outcome":"created","native":"weird","reason":null,"unresolved_children":{}}',
    );
    expect(classifyIdentity(id('x', verifiedRow('person', weirdNative), 't'), mapped)).toEqual({
      bucket: 'unresolved',
      code: S9_REPORT_CODE.reason_unrecognised,
    });
  });
});

// ── 3. Coverage predicate (D-S9-3 / F1) ─────────────────────────────────────────────────

describe('S9-A familyCoverage (F1)', () => {
  it.each<
    [
      string,
      CoverageFact | undefined,
      'success' | 'partial' | 'failed' | null,
      boolean,
      string,
      number | null,
    ]
  >([
    ['no record → unknown', undefined, 'success', false, COMPLETENESS_BASIS_NONE, null],
    ['known:false → unknown', { known: false }, 'success', false, COMPLETENESS_BASIS_NONE, null],
    ['known, covers, claim success → known', known(5), 'success', true, 's10-observation', 5],
    [
      'known, does not cover staged identities → unknown, count shown',
      known(5, false),
      'success',
      false,
      COMPLETENESS_BASIS_NONE,
      5,
    ],
    [
      'known, covers, claim partial → unknown (R01c)',
      known(5),
      'partial',
      false,
      COMPLETENESS_BASIS_NONE,
      5,
    ],
    [
      'known, covers, claim failed → unknown',
      known(5),
      'failed',
      false,
      COMPLETENESS_BASIS_NONE,
      5,
    ],
    ['known, covers, no claim → unknown', known(5), null, false, COMPLETENESS_BASIS_NONE, 5],
  ])('%s', (_label, fact, claim, isKnown, basis, observed) => {
    expect(familyCoverage(fact, claim)).toEqual({
      known: isKnown,
      completeness_basis: basis,
      observed_unique: observed,
    });
  });

  it('required_families = mapped staged ∪ coverage map ∪ mapping spec, sorted (R-A1)', () => {
    const f = facts([cleanFamily('workouts', 1), cleanFamily('clients', 1), unmapped('notes', 1)], {
      coverage: { programs: known(0), clients: known(1) },
      spec_families: ['clients', 'client_history'],
    });
    expect(requiredFamilies(f)).toEqual(['client_history', 'clients', 'programs', 'workouts']);
  });

  it.each<[string, ReconciliationFacts]>([
    ['zero staged rows, coverage null', facts([])],
    ['zero staged rows, coverage {} (R18b)', facts([], { coverage: {} })],
    [
      'zero staged rows, a spec and a known basis',
      facts([], { spec_families: ['clients'], coverage: { clients: known(0) } }),
    ],
    ['zero staged rows in a mapped entry only', facts([fam('clients', [])])],
    [
      'no registered platform (spec_families null)',
      facts([unmapped('clients', 2, 'unsupported_platform:acme')], { spec_families: null }),
    ],
  ])('required_families is undeterminable: %s', (_label, f) => {
    expect(requiredFamilies(f)).toBeNull();
  });
});

// ── 4. Verdict table ────────────────────────────────────────────────────────────────────

interface VerdictCase {
  label: string;
  input: ReconciliationFacts;
  outcome: 'complete' | 'partial';
  reason: string | null;
  conditions?: readonly string[];
  check?: (result: ReconciliationResult) => void;
}

const cases: readonly VerdictCase[] = [
  {
    label: 'R01(a) native-clean, basis known for every family, claim success → complete / null',
    input: covered([cleanFamily('clients', 3), cleanFamily('workouts', 2, 'workout_plan')]),
    outcome: 'complete',
    reason: null,
    check: (r) => {
      expect(row(r, 'clients')).toEqual({
        family: 'clients',
        mapped: true,
        tokens: [
          {
            token: 'clients',
            staged_unique: 3,
            native_present_verified: 3,
            rejected: 0,
            unresolved: 0,
            failed: 0,
          },
        ],
        staged_unique: 3,
        native_present_verified: 3,
        created_native: null,
        already_present_verified: null,
        rejected: 0,
        unresolved: 0,
        failed: 0,
        ledger_without_staged: 0,
        unresolved_children: 0,
        relationship_closure: 'not_applicable',
        relationship_unverified: 0,
        reasons: [],
        child_reasons: [],
        qualifiers: [],
        completeness_basis: 's10-observation',
        observed_unique: 3,
        pagination_terminal_evidence: null,
        date_window: null,
        media_policy: null,
      });
      expect(r.report.families.map((f) => f.family)).toEqual(['clients', 'workouts']);
    },
  },
  {
    label:
      'R01(b) native-clean, coverage null (today) → partial / coverage_basis_unknown, never complete',
    input: facts([cleanFamily('clients', 3), cleanFamily('workouts', 2, 'workout_plan')]),
    outcome: 'partial',
    reason: S9_REASON_CODE.coverage_basis_unknown,
    check: (r) =>
      expect(row(r, 'clients')).toMatchObject({
        completeness_basis: COMPLETENESS_BASIS_NONE,
        observed_unique: null,
        native_present_verified: 3,
      }),
  },
  {
    label: 'R01(b) basis known for one family only → partial / coverage_basis_unknown',
    input: facts([cleanFamily('clients', 3), cleanFamily('workouts', 2, 'workout_plan')], {
      coverage: { clients: known(3) },
    }),
    outcome: 'partial',
    reason: S9_REASON_CODE.coverage_basis_unknown,
    check: (r) => {
      expect(row(r, 'clients').completeness_basis).toBe('s10-observation');
      expect(row(r, 'workouts').completeness_basis).toBe(COMPLETENESS_BASIS_NONE);
    },
  },
  {
    label: 'R01(c) as (a) but claim partial → partial / coverage_basis_unknown',
    input: covered([cleanFamily('clients', 3)], { claim: 'partial' }),
    outcome: 'partial',
    reason: S9_REASON_CODE.coverage_basis_unknown,
    check: (r) =>
      expect(row(r, 'clients')).toMatchObject({
        completeness_basis: COMPLETENESS_BASIS_NONE,
        observed_unique: 3,
      }),
  },
  {
    label: 'R01(c) as (a) but no claim stored → partial / coverage_basis_unknown',
    input: covered([cleanFamily('clients', 3)], { claim: null }),
    outcome: 'partial',
    reason: S9_REASON_CODE.coverage_basis_unknown,
  },
  {
    label: 'F1 basis known but covers_staged_identities false → partial / coverage_basis_unknown',
    input: facts([cleanFamily('clients', 3)], { coverage: { clients: known(3, false) } }),
    outcome: 'partial',
    reason: S9_REASON_CODE.coverage_basis_unknown,
  },
  {
    label: 'F1 a basis recorded for a family with no entry must itself be known',
    input: facts([cleanFamily('clients', 1)], {
      coverage: { clients: known(1), programs: { known: false } },
    }),
    outcome: 'partial',
    reason: S9_REASON_CODE.coverage_basis_unknown,
  },
  {
    label: 'F1 a known basis for a family with no entry does not block complete',
    input: facts([cleanFamily('clients', 1)], {
      coverage: { clients: known(1), programs: known(0) },
    }),
    outcome: 'complete',
    reason: null,
  },
  {
    label:
      'R18 empty run, claim success, coverage null → partial / coverage_basis_unknown, never vacuously complete',
    input: facts([]),
    outcome: 'partial',
    reason: S9_REASON_CODE.coverage_basis_unknown,
    check: (r) => expect(r.report.families).toEqual([]),
  },
  {
    label: 'R18b empty run, coverage {} , claim success → partial / coverage_basis_unknown (R-A1)',
    input: facts([], { coverage: {} }),
    outcome: 'partial',
    reason: S9_REASON_CODE.coverage_basis_unknown,
    check: (r) => expect(r.report.required_families).toBeNull(),
  },
  {
    label:
      'R18b zero staged rows with a declared spec and a known basis → still partial / coverage_basis_unknown',
    input: facts([], { spec_families: ['clients'], coverage: { clients: known(0) } }),
    outcome: 'partial',
    reason: S9_REASON_CODE.coverage_basis_unknown,
  },
  {
    label:
      'R01d every staged family covered but a spec-declared family missing from the map → partial / coverage_basis_unknown (R-A1)',
    input: covered([cleanFamily('clients', 1)], { spec_families: ['clients', 'workouts'] }),
    outcome: 'partial',
    reason: S9_REASON_CODE.coverage_basis_unknown,
    check: (r) => {
      expect(r.report.required_families).toEqual(['clients', 'workouts']);
      expect(row(r, 'workouts')).toMatchObject({
        mapped: true,
        staged_unique: 0,
        tokens: [],
        completeness_basis: COMPLETENESS_BASIS_NONE,
        observed_unique: null,
      });
    },
  },
  {
    label:
      'R01d a spec-declared family with no staged row and a known basis does not block complete',
    input: covered([cleanFamily('clients', 1)], {
      spec_families: ['clients', 'workouts'],
      coverage: { clients: known(1), workouts: known(0) },
    }),
    outcome: 'complete',
    reason: null,
    check: (r) => {
      expect(r.report.families.map((f) => f.family)).toEqual(['clients', 'workouts']);
      expect(row(r, 'workouts')).toMatchObject({ staged_unique: 0, observed_unique: 0 });
    },
  },
  {
    label: 'R-A1 staged rows but no registered platform (spec undeterminable) → C-FAM and C-COV',
    input: facts([unmapped('clients', 2, 'unsupported_platform:acme')], {
      spec_families: null,
      coverage: { clients: known(2) },
    }),
    outcome: 'partial',
    reason: S9_REASON_CODE.unresolved_family,
    conditions: [S9_REASON_CODE.unresolved_family, S9_REASON_CODE.coverage_basis_unknown],
    check: (r) => expect(r.report.required_families).toBeNull(),
  },
  {
    label:
      'C-2 run-wide ledger_without_staged with no family attribution → partial / unresolved_identities',
    input: covered([cleanFamily('clients', 1)], { ledger_without_staged: 1 }),
    outcome: 'partial',
    reason: S9_REASON_CODE.unresolved_identities,
    check: (r) => {
      expect(r.report.ledger_without_staged).toBe(1);
      expect(row(r, 'clients').ledger_without_staged).toBe(0);
    },
  },
  {
    label: 'R02 staged identity absent from the ledger → bucket b, partial / unresolved_identities',
    input: covered([fam('clients', [id('clients-0', verifiedRow()), id('clients-1', null)])]),
    outcome: 'partial',
    reason: S9_REASON_CODE.unresolved_identities,
    check: (r) =>
      expect(row(r, 'clients')).toMatchObject({
        native_present_verified: 1,
        unresolved: 1,
        reasons: counts({ [S9_REPORT_CODE.not_reconstructed]: 1 }),
        completeness_basis: 's10-observation',
      }),
  },
  {
    label: 'R03 staged `notes` (unmapped) beside a clean family → partial / unresolved_family',
    input: covered([cleanFamily('clients', 2), unmapped('notes', 3)]),
    outcome: 'partial',
    reason: S9_REASON_CODE.unresolved_family,
    // C-ID does not fire: the unmapped entry is outside "any mapped family".
    conditions: [S9_REASON_CODE.unresolved_family],
    check: (r) => {
      expect(row(r, 'notes')).toEqual({
        family: 'notes',
        mapped: false,
        tokens: [
          {
            token: 'notes',
            staged_unique: 3,
            native_present_verified: 0,
            rejected: 0,
            unresolved: 3,
            failed: 0,
          },
        ],
        staged_unique: 3,
        native_present_verified: 0,
        created_native: null,
        already_present_verified: null,
        rejected: 0,
        unresolved: 3,
        failed: 0,
        ledger_without_staged: 0,
        unresolved_children: 0,
        relationship_closure: 'not_applicable',
        relationship_unverified: 0,
        reasons: [{ code: 'unresolved_family:notes', count: 3 }],
        child_reasons: [],
        qualifiers: [],
        completeness_basis: 's10-observation',
        observed_unique: 3,
        pagination_terminal_evidence: null,
        date_window: null,
        media_policy: null,
      });
      expect(r.report.families.map((f) => f.family)).toEqual(['clients', 'notes']);
    },
  },
  {
    label:
      'R03b a staged row on an unregistered platform → bucket a rejected, partial / unresolved_family',
    input: covered([
      cleanFamily('clients', 1),
      unmapped('workouts', 2, 'unsupported_platform:acme'),
    ]),
    outcome: 'partial',
    reason: S9_REASON_CODE.unresolved_family,
    check: (r) =>
      expect(row(r, 'workouts')).toMatchObject({
        mapped: false,
        rejected: 2,
        unresolved: 0,
        reasons: [{ code: 'unsupported_platform:acme', count: 2 }],
      }),
  },
  {
    label:
      'C-FAM a mapped family whose rows have no native destination → partial / unresolved_family',
    input: covered([
      fam('exercises', [
        id('exercises-0', skippedRow('unresolved:no_native_destination:exercises')),
        id('exercises-1', skippedRow('unresolved:no_native_destination:exercises')),
      ]),
    ]),
    outcome: 'partial',
    reason: S9_REASON_CODE.unresolved_family,
    conditions: [S9_REASON_CODE.unresolved_family, S9_REASON_CODE.unresolved_identities],
  },
  {
    label:
      'R04 ledger reconstructed, native row removed → bucket i, partial / unresolved_identities',
    input: covered([
      fam('programs', [
        id('programs-0', verifiedRow('workout_program', provenance({ native: 'removed' }))),
      ]),
    ]),
    outcome: 'partial',
    reason: S9_REASON_CODE.unresolved_identities,
    check: (r) =>
      expect(row(r, 'programs')).toMatchObject({
        native_present_verified: 0,
        unresolved: 1,
        reasons: [{ code: WRITER_CODE.native_target_removed, count: 1 }],
      }),
  },
  {
    label: 'R04 another coach owns the row → bucket h, partial / unresolved_identities',
    input: covered([
      fam('clients', [
        id('clients-0', verifiedRow('person', provenance({ native: 'foreign_owner' }))),
        id('clients-1', verifiedRow('person', provenance({ native: 'kind_mismatch' }))),
        id('clients-2', verifiedRow('person', provenance({ native: 'provenance_mismatch' }))),
      ]),
    ]),
    outcome: 'partial',
    reason: S9_REASON_CODE.unresolved_identities,
    check: (r) =>
      expect(row(r, 'clients').reasons).toEqual([
        { code: WRITER_CODE.identity_conflict, count: 3 },
      ]),
  },
  {
    label:
      'R05 equal counts, different identity sets → ledger_without_staged and bucket b; partial / unresolved_identities',
    // staged {a,b,c}; ledger {a,b,d}: 3 = 3 but c is missing and d has no staged identity.
    input: covered([
      fam(
        'clients',
        [id('clients-a', verifiedRow()), id('clients-b', verifiedRow()), id('clients-c', null)],
        {
          ledger_without_staged: 1,
        },
      ),
    ]),
    outcome: 'partial',
    reason: S9_REASON_CODE.unresolved_identities,
    check: (r) =>
      expect(row(r, 'clients')).toMatchObject({
        staged_unique: 3,
        native_present_verified: 2,
        unresolved: 1,
        ledger_without_staged: 1,
        reasons: [{ code: S9_REPORT_CODE.not_reconstructed, count: 1 }],
      }),
  },
  {
    label:
      'R05 every staged identity verified but a ledger row has no staged identity → partial / unresolved_identities',
    input: covered([
      fam('clients', [id('clients-0', verifiedRow())], { ledger_without_staged: 2 }),
    ]),
    outcome: 'partial',
    reason: S9_REASON_CODE.unresolved_identities,
    check: (r) => expect(row(r, 'clients').reasons).toEqual([]),
  },
  {
    label: 'R06 E-R1 program parent mismatch → partial / relationship_unverified',
    input: covered(
      [cleanFamily('programs', 1, 'workout_program'), cleanFamily('workouts', 1, 'workout_plan')],
      {
        relationships: [
          edge({
            edge: 'program_parent',
            to_family: 'programs',
            to_identity: ident('programs-0'),
            consistent: false,
          }),
        ],
      },
    ),
    outcome: 'partial',
    reason: S9_REASON_CODE.relationship_unverified,
    check: (r) => {
      expect(row(r, 'workouts')).toMatchObject({
        relationship_closure: 'unverified',
        relationship_unverified: 1,
      });
      expect(row(r, 'programs')).toMatchObject({
        relationship_closure: 'not_applicable',
        relationship_unverified: 0,
      });
    },
  },
  {
    label:
      'R06 E-R1 parent order not compared (null) is never assumed → partial / relationship_unverified',
    input: covered(
      [cleanFamily('programs', 1, 'workout_program'), cleanFamily('workouts', 1, 'workout_plan')],
      {
        relationships: [
          edge({
            edge: 'program_parent',
            to_family: 'programs',
            to_identity: ident('programs-0'),
            consistent: null,
          }),
        ],
      },
    ),
    outcome: 'partial',
    reason: S9_REASON_CODE.relationship_unverified,
  },
  {
    label:
      'R06 E-R1 parent program itself unresolved → partial / unresolved_identities first, relationship also unverified',
    input: covered(
      [
        fam('programs', [
          id('programs-0', verifiedRow('workout_program', provenance({ native: 'removed' }))),
        ]),
        cleanFamily('workouts', 1, 'workout_plan'),
      ],
      {
        relationships: [
          edge({
            edge: 'program_parent',
            to_family: 'programs',
            to_identity: ident('programs-0'),
            consistent: true,
          }),
        ],
      },
    ),
    outcome: 'partial',
    reason: S9_REASON_CODE.unresolved_identities,
    conditions: [S9_REASON_CODE.unresolved_identities, S9_REASON_CODE.relationship_unverified],
    check: (r) => expect(row(r, 'workouts').relationship_unverified).toBe(1),
  },
  {
    label: 'R06 E-R2 child order mismatch → partial / relationship_unverified',
    input: covered([cleanFamily('workouts', 1, 'workout_plan')], {
      relationships: [
        edge({
          edge: 'child_order',
          to_family: 'workouts',
          to_identity: ident('workouts-0'),
          consistent: false,
        }),
      ],
    }),
    outcome: 'partial',
    reason: S9_REASON_CODE.relationship_unverified,
  },
  {
    label:
      'R06 a bucket-f client-linked workout stays unresolved_identities; its edge is not counted twice',
    input: covered(
      [
        cleanFamily('clients', 1),
        fam('workouts', [id('workouts-0', evidenceRow('scout_entity'), 'workouts', true)]),
      ],
      { relationships: [edge({ to_identity: ident('clients-404') })] },
    ),
    outcome: 'partial',
    reason: S9_REASON_CODE.unresolved_identities,
    conditions: [S9_REASON_CODE.unresolved_identities],
    check: (r) =>
      expect(row(r, 'workouts')).toMatchObject({
        relationship_closure: 'not_applicable',
        relationship_unverified: 0,
        reasons: [{ code: WRITER_CODE.no_native_client_principal, count: 1 }],
      }),
  },
  {
    label:
      'R06 E-R3 client link to an identity that is not bucket j → partial / relationship_unverified',
    input: covered([cleanFamily('clients', 1), cleanFamily('workouts', 1, 'workout_plan')], {
      relationships: [edge({ to_identity: ident('clients-404') })],
    }),
    outcome: 'partial',
    reason: S9_REASON_CODE.relationship_unverified,
  },
  {
    label:
      'R06 two mapped entries sharing a family name: a failing edge from the first is still counted → partial / relationship_unverified (review B-1)',
    input: covered(
      [
        cleanFamily('programs', 1, 'workout_program'),
        fam('workouts', [id('workouts-first', verifiedRow('workout_plan'), 'workouts')]),
        fam('workouts', [id('workouts-second', verifiedRow('workout_plan'), 'workout_templates')]),
      ],
      {
        relationships: [
          edge({
            edge: 'program_parent',
            from_identity: ident('workouts-first'),
            to_family: 'programs',
            to_identity: ident('programs-0'),
            consistent: false,
          }),
        ],
      },
    ),
    outcome: 'partial',
    reason: S9_REASON_CODE.relationship_unverified,
    conditions: [S9_REASON_CODE.relationship_unverified],
    check: (r) => {
      const workouts = r.report.families.filter((f) => f.family === 'workouts');
      expect(workouts).toHaveLength(2);
      for (const w of workouts) expect(w.relationship_unverified).toBe(1);
    },
  },
  {
    label: 'R06 an identity with two failing edges counts once',
    input: covered(
      [cleanFamily('programs', 1, 'workout_program'), cleanFamily('workouts', 1, 'workout_plan')],
      {
        relationships: [
          edge({
            edge: 'program_parent',
            to_family: 'programs',
            to_identity: ident('programs-0'),
            consistent: false,
          }),
          edge({
            edge: 'child_order',
            to_family: 'workouts',
            to_identity: ident('workouts-0'),
            consistent: false,
          }),
        ],
      },
    ),
    outcome: 'partial',
    reason: S9_REASON_CODE.relationship_unverified,
    check: (r) => expect(row(r, 'workouts').relationship_unverified).toBe(1),
  },
  {
    label: 'R06 closure holds (E-R1 consistent, E-R2 consistent, E-R3 resolved) → complete / null',
    input: covered(
      [
        cleanFamily('clients', 1),
        cleanFamily('programs', 1, 'workout_program'),
        cleanFamily('workouts', 1, 'workout_plan'),
      ],
      {
        relationships: [
          edge(),
          edge({
            edge: 'program_parent',
            to_family: 'programs',
            to_identity: ident('programs-0'),
            consistent: true,
          }),
          edge({
            edge: 'child_order',
            to_family: 'workouts',
            to_identity: ident('workouts-0'),
            consistent: true,
          }),
        ],
      },
    ),
    outcome: 'complete',
    reason: null,
    check: (r) => {
      expect(row(r, 'workouts')).toMatchObject({
        relationship_closure: 'verified',
        relationship_unverified: 0,
      });
      expect(row(r, 'clients').relationship_closure).toBe('not_applicable');
    },
  },
  {
    label:
      'R07 evidence rows never count native; a client-owned family → at most partial (D-S8-2); keyed per row',
    input: covered([
      cleanFamily('clients', 1),
      fam(
        'client_history',
        [
          id('client_history-0', evidenceRow('scout_entity')),
          id('client_history-1', evidenceRow(null)),
          id('client_history-2', skippedRow('unresolved:no_native_client_principal')),
        ],
        { client_owned: true },
      ),
    ]),
    outcome: 'partial',
    reason: S9_REASON_CODE.unresolved_identities,
    check: (r) =>
      expect(row(r, 'client_history')).toMatchObject({
        native_present_verified: 0,
        unresolved: 3,
        rejected: 0,
        reasons: [{ code: WRITER_CODE.no_native_client_principal, count: 3 }],
      }),
  },
  {
    label:
      'R07 evidence rows in a coach-owned family → evidence_only per row; a client-linked row → no_native_client_principal (L149)',
    input: covered([
      fam('workouts', [
        id('workouts-0', evidenceRow('scout_entity')),
        id('workouts-1', evidenceRow(null)),
        id('workouts-2', evidenceRow('scout_entity'), 'workouts', true),
      ]),
    ]),
    outcome: 'partial',
    reason: S9_REASON_CODE.unresolved_identities,
    check: (r) =>
      expect(row(r, 'workouts').reasons).toEqual(
        counts({ [S9_REPORT_CODE.evidence_only]: 2, [WRITER_CODE.no_native_client_principal]: 1 }),
      ),
  },
  {
    label:
      'R02b ledger skipped missing_source_id / unsupported_platform → bucket d rejected, partial / unresolved_identities',
    input: covered([
      fam('clients', [
        id('clients-0', verifiedRow()),
        id('clients-1', skippedRow('unsupported_platform:acme')),
        id('clients-2', skippedRow('missing_source_id')),
      ]),
    ]),
    outcome: 'partial',
    reason: S9_REASON_CODE.unresolved_identities,
    check: (r) =>
      expect(row(r, 'clients')).toMatchObject({
        native_present_verified: 1,
        rejected: 2,
        unresolved: 0,
        reasons: counts({ 'unsupported_platform:acme': 1, missing_source_id: 1 }),
      }),
  },
  {
    label:
      'ledger failed rows block complete; the reason text is never echoed → partial / unresolved_identities',
    input: covered([fam('clients', [id('clients-0', verifiedRow()), id('clients-1', failedRow)])]),
    outcome: 'partial',
    reason: S9_REASON_CODE.unresolved_identities,
    check: (r) =>
      expect(row(r, 'clients')).toMatchObject({
        failed: 1,
        unresolved: 0,
        reasons: [{ code: 'failed', count: 1 }],
      }),
  },
  {
    label:
      'R19 already_present plan with a persisted unresolved exercise → unresolved_children, partial / unresolved_identities',
    input: covered([
      fam('workouts', [
        id(
          'workouts-0',
          verifiedRow(
            'workout_plan',
            provenance({
              outcome: 'already_present',
              unresolved_children: { 'unresolved:exercise_reference': 4 },
            }),
          ),
        ),
        id(
          'workouts-1',
          verifiedRow(
            'workout_plan',
            provenance({
              unresolved_children: {
                'unresolved:exercise_reference': 1,
                'unresolved:prescription_not_integral:reps_or_duration_seconds': 2,
              },
            }),
          ),
        ),
      ]),
    ]),
    outcome: 'partial',
    reason: S9_REASON_CODE.unresolved_identities,
    check: (r) =>
      expect(row(r, 'workouts')).toMatchObject({
        native_present_verified: 2,
        unresolved: 0,
        unresolved_children: 7,
        reasons: [],
        child_reasons: counts({
          'unresolved:exercise_reference': 5,
          'unresolved:prescription_not_integral:reps_or_duration_seconds': 2,
        }),
      }),
  },
  {
    label:
      'R08 ceiling leaves rows staged → pass_ceiling_exceeded, partial / unresolved_identities, never blocked',
    input: covered([
      fam(
        'clients',
        [
          ...Array.from({ length: 10_000 }, (_, i) => id(`clients-c${i}`, verifiedRow())),
          ...Array.from({ length: 250 }, (_, i) => id(`clients-rest${i}`, null)),
        ],
        { ceiling_exceeded: true },
      ),
    ]),
    outcome: 'partial',
    reason: S9_REASON_CODE.unresolved_identities,
    check: (r) =>
      expect(row(r, 'clients')).toMatchObject({
        staged_unique: 10_250,
        native_present_verified: 10_000,
        unresolved: 250,
        reasons: [{ code: S9_REPORT_CODE.pass_ceiling_exceeded, count: 250 }],
      }),
  },
  {
    label: 'R10 replayed intent converged already_present → same shape, split null',
    input: covered([
      fam('programs', [
        id(
          'programs-0',
          verifiedRow('workout_program', provenance({ outcome: 'already_present' })),
        ),
        id(
          'programs-1',
          verifiedRow('workout_program', provenance({ outcome: 'already_present' })),
        ),
      ]),
    ]),
    outcome: 'complete',
    reason: null,
    check: (r) =>
      expect(row(r, 'programs')).toMatchObject({
        native_present_verified: 2,
        created_native: null,
        already_present_verified: null,
      }),
  },
  {
    label:
      'R12 a mapped family with zero staged rows and a known basis beside a staged one → complete; 0 is a counted fact, null only for D-S9-3/4 fields',
    input: covered([cleanFamily('workouts', 1, 'workout_plan'), fam('clients', [])]),
    outcome: 'complete',
    reason: null,
    check: (r) =>
      expect(row(r, 'clients')).toMatchObject({
        staged_unique: 0,
        observed_unique: 0,
        native_present_verified: 0,
        rejected: 0,
        unresolved: 0,
        failed: 0,
        tokens: [],
        created_native: null,
        already_present_verified: null,
      }),
  },
  {
    label: 'D-S8-1 two staged tokens in one canonical family report per token and in total',
    input: covered([
      fam('workouts', [
        id('a1', verifiedRow('workout_plan'), 'workouts'),
        id('a2', null, 'workouts'),
        id('b1', verifiedRow('workout_plan'), 'workout_templates'),
      ]),
    ]),
    outcome: 'partial',
    reason: S9_REASON_CODE.unresolved_identities,
    check: (r) =>
      expect(row(r, 'workouts')).toMatchObject({
        staged_unique: 3,
        native_present_verified: 2,
        unresolved: 1,
        tokens: [
          {
            token: 'workout_templates',
            staged_unique: 1,
            native_present_verified: 1,
            rejected: 0,
            unresolved: 0,
            failed: 0,
          },
          {
            token: 'workouts',
            staged_unique: 2,
            native_present_verified: 1,
            rejected: 0,
            unresolved: 1,
            failed: 0,
          },
        ],
      }),
  },
  {
    label: 'qualifiers pass through sorted (S8-DOC §4.1 roster_bridge_pending)',
    input: covered([
      fam('clients', [id('clients-0', verifiedRow())], { qualifiers: ['roster_bridge_pending'] }),
    ]),
    outcome: 'complete',
    reason: null,
    check: (r) => expect(row(r, 'clients').qualifiers).toEqual(['roster_bridge_pending']),
  },
  {
    label:
      'R17 every condition at once → reason_code is the first; conditions lists all four in order',
    input: facts(
      [
        unmapped('notes', 1),
        fam('clients', [id('clients-0', verifiedRow()), id('clients-1', null)]),
        cleanFamily('workouts', 1, 'workout_plan'),
      ],
      { relationships: [edge({ to_identity: ident('clients-404') })] },
    ),
    outcome: 'partial',
    reason: S9_REASON_CODE.unresolved_family,
    conditions: [...S9_REASON_CODES],
  },
  {
    label: 'R17 C-ID + C-COV → unresolved_identities first',
    input: facts([fam('clients', [id('clients-0', null)])]),
    outcome: 'partial',
    reason: S9_REASON_CODE.unresolved_identities,
    conditions: [S9_REASON_CODE.unresolved_identities, S9_REASON_CODE.coverage_basis_unknown],
  },
  {
    label: 'R17 C-REL + C-COV → relationship_unverified first',
    input: facts([cleanFamily('clients', 1), cleanFamily('workouts', 1, 'workout_plan')], {
      relationships: [edge({ to_identity: ident('clients-404') })],
    }),
    outcome: 'partial',
    reason: S9_REASON_CODE.relationship_unverified,
    conditions: [S9_REASON_CODE.relationship_unverified, S9_REASON_CODE.coverage_basis_unknown],
  },
];

describe('S9-A reconcile — verdict table', () => {
  it.each(cases.map((c): [string, VerdictCase] => [c.label, c]))('%s', (_label, c) => {
    const result = reconcile(c.input);
    expect(result.verdict).toEqual({ outcome: c.outcome, reason_code: c.reason });
    if (c.conditions) expect(result.report.conditions).toEqual(c.conditions);
    expectWellFormed(result);
    c.check?.(result);
  });

  it('never emits blocked, failed, cancelled or timed_out (D-S9-1, D-S9-6)', () => {
    for (const c of cases) {
      const outcome: string = reconcile(c.input).verdict.outcome;
      expect(['blocked', 'failed', 'cancelled', 'timed_out']).not.toContain(outcome);
    }
  });

  it('complete appears only when the report lists no condition, and only with a known basis on every family', () => {
    for (const c of cases) {
      const { verdict, report } = reconcile(c.input);
      if (verdict.outcome !== 'complete') continue;
      expect(report.conditions).toEqual([]);
      expect(c.input.coverage).not.toBeNull();
      expect(c.input.claim).toBe('success');
      for (const f of report.families)
        expect(f.completeness_basis).not.toBe(COMPLETENESS_BASIS_NONE);
    }
  });
});

// ── 5. edgeVerified table ───────────────────────────────────────────────────────────────

describe('S9-A edgeVerified', () => {
  const verified = new Map<string, ReadonlySet<string>>([
    ['clients', new Set([ident('clients-0')])],
    ['programs', new Set([ident('programs-0')])],
    ['workouts', new Set([ident('workouts-0')])],
  ]);
  const toProgram = {
    edge: 'program_parent' as const,
    to_family: 'programs',
    to_identity: ident('programs-0'),
  };
  const toPlan = {
    edge: 'child_order' as const,
    to_family: 'workouts',
    to_identity: ident('workouts-0'),
  };

  it.each<[string, RelationshipFacts, boolean]>([
    ['E-R3 client_link, target j, not compared → verified (no native attribute)', edge(), true],
    ['E-R3 client_link, target j, consistent true → verified', edge({ consistent: true }), true],
    [
      'E-R3 client_link, target j, consistent false → unverified',
      edge({ consistent: false }),
      false,
    ],
    [
      'E-R3 client_link, target not j → unverified',
      edge({ to_identity: ident('clients-1') }),
      false,
    ],
    ['E-R3 client_link, target family unknown → unverified', edge({ to_family: 'people' }), false],
    [
      'E-R1 program_parent, target j, consistent true → verified',
      edge({ ...toProgram, consistent: true }),
      true,
    ],
    [
      'E-R1 program_parent, target j, not compared → unverified',
      edge({ ...toProgram, consistent: null }),
      false,
    ],
    [
      'E-R1 program_parent, target j, consistent false → unverified',
      edge({ ...toProgram, consistent: false }),
      false,
    ],
    [
      'E-R1 program_parent, target not j, consistent true → unverified',
      edge({ ...toProgram, to_identity: ident('programs-9'), consistent: true }),
      false,
    ],
    [
      'E-R2 child_order, parent j, consistent true → verified',
      edge({ ...toPlan, consistent: true }),
      true,
    ],
    [
      'E-R2 child_order, parent j, not compared → unverified',
      edge({ ...toPlan, consistent: null }),
      false,
    ],
    [
      'E-R2 child_order, parent j, consistent false → unverified',
      edge({ ...toPlan, consistent: false }),
      false,
    ],
  ])('%s', (_label, rel, expected) => {
    expect(edgeVerified(rel, verified)).toBe(expected);
  });
});

// ── 6. Determinism (R10) ────────────────────────────────────────────────────────────────

describe('S9-A reconcile — determinism (R10)', () => {
  const a = fam('clients', [
    id('clients-0', verifiedRow()),
    id('clients-1', null),
    id('clients-2', skippedRow('missing_source_id')),
  ]);
  const b = fam('workouts', [
    id(
      'workouts-0',
      verifiedRow(
        'workout_plan',
        provenance({ unresolved_children: { 'unresolved:exercise_reference': 1 } }),
      ),
    ),
  ]);
  const n = unmapped('notes', 2);
  const rel = edge();
  const base = covered([a, b, n], { relationships: [rel] });

  it('identical facts → byte-identical verdict and report', () => {
    expect(JSON.stringify(reconcile(base))).toBe(JSON.stringify(reconcile(base)));
  });

  it('family and identity input order does not change the report bytes', () => {
    const permutedA = fam(a.family, [...a.identities].reverse());
    const permuted = covered([n, b, permutedA], { relationships: [rel] });
    expect(JSON.stringify(reconcile(permuted))).toBe(JSON.stringify(reconcile(base)));
    expect(reconcile(permuted).report.families.map((f) => f.family)).toEqual([
      'clients',
      'workouts',
      'notes',
    ]);
  });

  it('histogram codes are emitted in code-point order regardless of encounter order', () => {
    const f = fam('clients', [
      id('clients-z', skippedRow('unresolved:source_archived')),
      id('clients-a', skippedRow('unresolved:exercise_reference')),
      id('clients-m', null),
    ]);
    expect(row(reconcile(covered([f])), 'clients').reasons.map((r) => r.code)).toEqual([
      'unresolved:exercise_reference',
      S9_REPORT_CODE.not_reconstructed,
      'unresolved:source_archived',
    ]);
  });

  it('does not mutate its input', () => {
    const before = JSON.stringify(base);
    reconcile(base);
    expect(JSON.stringify(base)).toBe(before);
  });
});

// ── 7. Arbiter composition (R09 at the unit level) ──────────────────────────────────────

describe('S9-A verdict feeds S7-L arbiter step 3 (R09 precedence preserved)', () => {
  /** Narrow a v1 verdict to the landed `ReconciliationVerdict`; S9-C appends the S9 codes to the enum. */
  const asLanded = (v: ReconciliationResult['verdict']) => {
    const reason: RunReasonCode | null = isRunReasonCode(v.reason_code) ? v.reason_code : null;
    if (v.reason_code !== null && reason === null)
      throw new Error('S9 code not yet in RUN_REASON_CODES');
    return { outcome: v.outcome, reason_code: reason };
  };
  const complete = asLanded(reconcile(covered([cleanFamily('clients', 2)])).verdict);
  const unresolvedFamily = asLanded(reconcile(covered([unmapped('notes', 1)])).verdict);
  const arbiterBase = {
    claim: 'success' as const,
    staged_by_family: { clients: 2 },
    ledger_by_family: {},
    unmapped_families: [],
  };

  it('step 3: the verdict is taken verbatim when no fence and no failing empty claim apply', () => {
    expect(arbitrate({ ...arbiterBase, fence: null, reconciliation: complete })).toEqual({
      terminal_status: 'complete',
      reason_code: null,
    });
    expect(
      arbitrate({
        ...arbiterBase,
        fence: null,
        staged_by_family: { notes: 1 },
        unmapped_families: ['notes'],
        reconciliation: unresolvedFamily,
      }),
    ).toEqual({ terminal_status: 'partial', reason_code: 'unresolved_family' });
  });

  it('step 1: a fence ignores the S9 verdict; revoked → blocked comes from the fence, never from S9', () => {
    expect(arbitrate({ ...arbiterBase, fence: 'cancelled', reconciliation: complete })).toEqual({
      terminal_status: 'cancelled',
      reason_code: 'cancelled_by_coach',
    });
    expect(arbitrate({ ...arbiterBase, fence: 'timed_out', reconciliation: complete })).toEqual({
      terminal_status: 'timed_out',
      reason_code: 'deadline_exceeded',
    });
    expect(arbitrate({ ...arbiterBase, fence: 'revoked', reconciliation: complete })).toEqual({
      terminal_status: 'blocked',
      reason_code: 'revoked',
    });
  });

  it('step 2: claim failed with zero staged rows → failed / transfer_failed regardless of S9', () => {
    expect(
      arbitrate({
        ...arbiterBase,
        fence: null,
        claim: 'failed',
        staged_by_family: {},
        reconciliation: complete,
      }),
    ).toEqual({ terminal_status: 'failed', reason_code: 'transfer_failed' });
  });

  it('R14: every S9 code is a low-cardinality snake_case identifier; unresolved_family is reused from the landed enum', () => {
    for (const code of S9_CODES) expect(code).toMatch(/^[a-z][a-z_]*$/);
    expect(new Set(S9_CODES).size).toBe(S9_CODES.length);
    expect(S9_REASON_CODES).toEqual([
      'unresolved_family',
      'unresolved_identities',
      'relationship_unverified',
      'coverage_basis_unknown',
    ]);
    expect(RUN_REASON_CODES).toContain('unresolved_family');
  });
});
