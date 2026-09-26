/**
 * S9-B facts service — unit spec over an in-memory Prisma double. Every query shape the service
 * issues is served here from plain tables; any write or unknown method throws (S9 never writes).
 * The fixture platform/spec/rules mirror the S8-C G2 harness shape (`blocks` → programs,
 * `routines` → workouts) and are injected through the registry seam; the repository specs are
 * never read. The last group composes the collected facts with the frozen S9-A `reconcile`.
 */
import { parseSourceMappingSpec } from '../../../src/scout/reconstruct/mapping-spec';
import { parseNativeRuleSet } from '../../../src/scout/reconstruct/native/native-rules';
import { buildNativeRuleRegistry } from '../../../src/scout/reconstruct/native/native-rule-registry';
import { buildSourceMapperRegistry } from '../../../src/scout/reconstruct/source-mapper-registry';
import { RECONSTRUCT_MAX_ROWS } from '../../../src/scout/scout-reconstruct.dto';
import {
  identityKey,
  parentSourceIdOf,
  ReconciliationFactsService,
  type FactsDb,
} from '../../../src/scout/reconciliation/facts.service';
import { reconcile } from '../../../src/scout/reconciliation/reconcile';
import type {
  FamilyFacts,
  ReconciliationFacts,
  RelationshipFacts,
} from '../../../src/scout/reconciliation/types';

const PLATFORM = 's9b-proof';
const COACH = 'coach-a';
const OTHER = 'coach-b';
const INTENT = 'intent-1';

const SPEC = {
  specVersion: 1,
  sourcePlatform: PLATFORM,
  steps: { people: 'clients', blocks: 'programs', routines: 'workouts', log: 'client_history' },
  families: {
    clients: { displayName: { paths: [['name']], coerce: 'string' } },
    programs: {
      clientSourceId: { paths: [['client_id']], coerce: 'string_or_finite_number' },
      label: { paths: [['title']], coerce: 'string' },
    },
    workouts: {
      clientSourceId: { paths: [['client_id']], coerce: 'string_or_finite_number' },
      label: { paths: [['title']], coerce: 'string' },
    },
    client_history: {
      clientSourceId: { paths: [['client_id']], coerce: 'string_or_finite_number' },
      label: { paths: [['title']], coerce: 'string' },
    },
  },
};
const RULES = {
  specVersion: 1,
  sourcePlatform: PLATFORM,
  families: {
    programs: {
      weeks: { kind: 'integer', paths: [['weeks']] },
      daysPerWeek: { kind: 'integer', paths: [['days']] },
    },
    workouts: {
      type: { kind: 'enum', paths: [['kind']], map: { lift: 'strength' }, default: 'strength' },
      programSourceId: { kind: 'identifier', paths: [['block_id']] },
      weekIndex: { kind: 'integer', paths: [['week']], base: 1 },
      dayIndex: { kind: 'integer', paths: [['day']], base: 1 },
    },
  },
};
/** A second registered platform with NO native rules and no `programs` family. */
const SPEC_B = {
  specVersion: 1,
  sourcePlatform: 'other-proof',
  steps: { workouts: 'workouts' },
  families: {
    workouts: {
      clientSourceId: { paths: [['client_id']], coerce: 'string' },
      label: { paths: [['title']], coerce: 'string' },
    },
  },
};

// ── In-memory Prisma double ──────────────────────────────────────────────────────────────────

type Row = Record<string, any>;
const READS = new Set(['findMany', 'findUnique']);

class FakeDb {
  readonly tables: Record<string, Row[]> = {
    scoutImportCompletion: [],
    scoutIngestEntity: [],
    scoutReconstructionLedger: [],
    importNativeProvenance: [],
    person: [],
    workoutProgram: [],
    workoutPlan: [],
    workoutPlanExercise: [],
    // S10-C: the run row and the S10-B tables the coverage evaluator is fed from. Left empty
    // here (no server run row ⇒ `coverage: null`, the S9 v1 value); facts.service.coverage.spec
    // exercises them.
    scoutRunDeclaration: [],
    scoutRunObservation: [],
  };
  /** `{ model, method, where }` per call, for the aggregate/tenant assertions. */
  readonly calls: Array<{ model: string; method: string; where: Row }> = [];
  private seq = 0;

  add(model: string, row: Row): Row {
    const withId = { id: row.id ?? `${model}-${String(++this.seq).padStart(6, '0')}`, ...row };
    this.tables[model].push(withId);
    return withId;
  }

  client(): FactsDb {
    const db: Row = {};
    for (const model of Object.keys(this.tables)) {
      db[model] = new Proxy(
        {},
        {
          get: (_target, method: string) => {
            if (!READS.has(method))
              throw new Error(`S9 facts must not call ${model}.${method} (reads only)`);
            return (args: Row) => this.query(model, method, args);
          },
        },
      );
    }
    // `Row` is `Record<string, any>`; one typed assertion narrows the double to the service's seam.
    return db as FactsDb;
  }

  private matches(row: Row, where: Row): boolean {
    for (const [key, cond] of Object.entries(where)) {
      if (key === 'coach_id_intent_id') {
        if (row.coach_id !== cond.coach_id || row.intent_id !== cond.intent_id) return false;
      } else if (cond !== null && typeof cond === 'object' && 'in' in cond) {
        if (!cond.in.includes(row[key])) return false;
      } else if (row[key] !== cond) return false;
    }
    return true;
  }

  private query(model: string, method: string, args: Row): Promise<any> {
    this.calls.push({ model, method, where: args.where ?? {} });
    let rows = this.tables[model].filter((r) => this.matches(r, args.where ?? {}));
    if (method === 'findUnique') return Promise.resolve(rows[0] ?? null);
    if (args.orderBy?.id === 'asc') rows = [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
    if (args.cursor !== undefined) {
      const at = rows.findIndex((r) => r.id === args.cursor.id);
      rows = rows.slice(at + (args.skip ?? 0));
    }
    if (args.take !== undefined) rows = rows.slice(0, args.take);
    const select = args.select as Row | undefined;
    return Promise.resolve(
      rows.map((r) =>
        select === undefined
          ? { ...r }
          : Object.fromEntries(Object.keys(select).map((k) => [k, r[k] ?? null])),
      ),
    );
  }
}

// ── Fixture helpers ──────────────────────────────────────────────────────────────────────────

const service = () =>
  new ReconciliationFactsService({
    sourceMappers: buildSourceMapperRegistry([
      parseSourceMappingSpec(SPEC, 'facts.spec:spec'),
      parseSourceMappingSpec(SPEC_B, 'facts.spec:spec-b'),
    ]),
    nativeRules: buildNativeRuleRegistry([parseNativeRuleSet(RULES, 'facts.spec:rules')]),
  });

function stage(
  db: FakeDb,
  token: string,
  sourceId: string,
  payload: Row = {},
  platform = PLATFORM,
  coach = COACH,
  intent = INTENT,
) {
  return db.add('scoutIngestEntity', {
    coach_id: coach,
    intent_id: intent,
    entity_type: token,
    source_id: sourceId,
    source_platform: platform,
    payload,
  });
}
function ledger(
  db: FakeDb,
  token: string,
  sourceId: string,
  status: string,
  extra: Partial<{
    target_id: string | null;
    target_kind: string | null;
    reason: string | null;
  }> = {},
  platform = PLATFORM,
  coach = COACH,
  intent = INTENT,
) {
  return db.add('scoutReconstructionLedger', {
    coach_id: coach,
    intent_id: intent,
    entity_type: token,
    source_id: sourceId,
    source_platform: platform,
    status,
    target_id: null,
    target_kind: null,
    reason: null,
    ...extra,
  });
}
function provenance(
  db: FakeDb,
  entityType: string,
  sourceId: string,
  nativeKind: string,
  nativeId: string | null,
  outcome: string,
  reason: string | null = null,
  platform = PLATFORM,
  coach = COACH,
) {
  return db.add('importNativeProvenance', {
    coach_id: coach,
    import_intent_id: null,
    source_namespace: platform,
    entity_type: entityType,
    source_id: sourceId,
    native_kind: nativeKind,
    native_id: nativeId,
    outcome,
    reason,
  });
}
const child = (parent: string, tail: string) => `${parent.length}:${parent}#${tail}`;

const family = (facts: ReconciliationFacts, name: string, mapped = true): FamilyFacts => {
  const found = facts.families.find((f) => f.family === name && f.mapped === mapped);
  if (found === undefined) throw new Error(`no ${mapped ? 'mapped' : 'unmapped'} entry ${name}`);
  return found;
};
const identity = (f: FamilyFacts, sourceId: string, platform = PLATFORM) => {
  const found = f.identities.find((i) => i.identity === identityKey(platform, sourceId));
  if (found === undefined) throw new Error(`no identity ${sourceId} in ${f.family}`);
  return found;
};
const edges = (facts: ReconciliationFacts, edge: RelationshipFacts['edge'], from?: string) =>
  facts.relationships.filter(
    (r) =>
      r.edge === edge && (from === undefined || r.from_identity === identityKey(PLATFORM, from)),
  );

/** A verified program + program-day plan pair (bucket j on both sides). */
function verifiedPair(db: FakeDb, coach = COACH) {
  const program = db.add('workoutProgram', { coach_id: coach, archived_at: null });
  const plan = db.add('workoutPlan', {
    coach_id: coach,
    archived_at: null,
    program_id: program.id,
    week_index: 0,
    day_index: 1,
  });
  // Staged under the canonical tokens: the S8-C writer keys its ledger rows by canonical family,
  // and the D-S9-2 join is on the raw wide identity (token, platform, source_id) — see the
  // negative case under "ledger join on the wide identity".
  stage(db, 'programs', 'B1', { title: 'Block', weeks: 4, days: 3 }, PLATFORM, coach);
  stage(db, 'workouts', 'W1', { title: 'Day', block_id: 'B1', week: 1, day: 2 }, PLATFORM, coach);
  ledger(
    db,
    'programs',
    'B1',
    'reconstructed',
    { target_id: program.id, target_kind: 'workout_program' },
    PLATFORM,
    coach,
  );
  ledger(
    db,
    'workouts',
    'W1',
    'reconstructed',
    { target_id: plan.id, target_kind: 'workout_plan' },
    PLATFORM,
    coach,
  );
  provenance(db, 'programs', 'B1', 'workout_program', program.id, 'created', null, PLATFORM, coach);
  provenance(
    db,
    'workouts',
    'W1',
    'workout_plan',
    plan.id,
    'created',
    'defaulted:type',
    PLATFORM,
    coach,
  );
  return { program, plan };
}

// ── Specs ────────────────────────────────────────────────────────────────────────────────────

describe('S9-B ReconciliationFactsService', () => {
  describe('an empty run', () => {
    it('reports no families, an undeterminable spec set, coverage null and claim null', async () => {
      const db = new FakeDb();
      const facts = await service().collect(db.client(), COACH, INTENT);
      expect(facts).toEqual({
        claim: null,
        families: [],
        relationships: [],
        spec_families: null,
        ledger_without_staged: 0,
        coverage: null,
      });
    });
    it('S10-C: without a run binding, or with a legacy one, coverage stays null and no S10 table is read', async () => {
      const db = new FakeDb();
      const bare = await service().collect(db.client(), COACH, INTENT);
      expect(bare.coverage).toBeNull();
      const legacy = await service().collect(db.client(), COACH, INTENT, {
        mode: 'legacy',
        execution_epoch: 1,
        accepted_start_at: null,
      });
      expect(legacy.coverage).toBeNull();
      expect(db.calls.some((c) => c.model.startsWith('scoutRun'))).toBe(false);
      expect(db.calls.some((c) => c.model === 'scoutImport')).toBe(false);
    });
    it('reads the legacy claim only from the closed terminal set', async () => {
      const db = new FakeDb();
      db.add('scoutImportCompletion', {
        coach_id: COACH,
        intent_id: INTENT,
        terminal_status: 'success',
      });
      expect((await service().collect(db.client(), COACH, INTENT)).claim).toBe('success');
      db.tables.scoutImportCompletion[0].terminal_status = 'complete';
      expect((await service().collect(db.client(), COACH, INTENT)).claim).toBeNull();
    });
  });

  describe('grouping (D-S9-2)', () => {
    it('resolves step tokens and canonical-family tokens to ONE mapped entry per family', async () => {
      const db = new FakeDb();
      stage(db, 'routines', 'W1', { title: 'a' });
      stage(db, 'workouts', 'W2', { title: 'b' });
      stage(db, 'blocks', 'B1', { title: 'p', weeks: 1, days: 1 });
      stage(db, 'people', 'C1', { name: 'n' });
      stage(db, 'log', 'H1', { title: 'h', client_id: 'C1' });
      const facts = await service().collect(db.client(), COACH, INTENT);
      expect(facts.families.map((f) => [f.family, f.mapped])).toEqual([
        ['client_history', true],
        ['clients', true],
        ['programs', true],
        ['workouts', true],
      ]);
      const workouts = family(facts, 'workouts');
      expect(workouts.identities.map((i) => [i.token, i.ledger, i.client_linked])).toEqual([
        ['routines', null, false],
        ['workouts', null, false],
      ]);
      expect(family(facts, 'clients').qualifiers).toEqual(['roster_bridge_pending']);
      expect(family(facts, 'clients').client_owned).toBe(false);
      expect(family(facts, 'client_history').client_owned).toBe(true);
      expect(family(facts, 'client_history').qualifiers).toEqual([]);
      expect(family(facts, 'programs').resolution_reason).toBeNull();
      expect(family(facts, 'programs').ceiling_exceeded).toBe(false);
    });
    it('forms unmapped entries keyed by raw token with the accepted resolution reasons', async () => {
      const db = new FakeDb();
      stage(db, 'notes', 'N1', {});
      stage(db, 'routines', 'X1', { title: 'x' }, 'unregistered');
      stage(db, 'programs', 'P1', { title: 'p' }, 'other-proof'); // token is a family SPEC_B lacks
      const facts = await service().collect(db.client(), COACH, INTENT);
      expect(
        facts.families.filter((f) => !f.mapped).map((f) => [f.family, f.resolution_reason]),
      ).toEqual([
        ['notes', 'unresolved_family:notes'],
        ['programs', 'unresolved_family:programs'],
        ['routines', 'unsupported_platform:unregistered'],
      ]);
      for (const f of facts.families) {
        expect(f.mapped).toBe(false);
        expect(f.client_owned).toBe(false);
        expect(f.ceiling_exceeded).toBe(false);
        expect(f.qualifiers).toEqual([]);
        expect(f.identities.every((i) => i.client_linked === false)).toBe(true);
      }
      expect(facts.spec_families).toBeNull(); // an unregistered platform → undeterminable
    });
    it('keeps (mapped, family) unique when a token is mapped on one platform and not on another', async () => {
      const db = new FakeDb();
      stage(db, 'programs', 'P1', { title: 'p', weeks: 1, days: 1 });
      stage(db, 'programs', 'P2', { title: 'p' }, 'other-proof');
      const facts = await service().collect(db.client(), COACH, INTENT);
      expect(facts.families.map((f) => [f.family, f.mapped, f.identities.length])).toEqual([
        ['programs', true, 1],
        ['programs', false, 1],
      ]);
      const keys = facts.families.map((f) => `${f.mapped}:${f.family}`);
      expect(new Set(keys).size).toBe(keys.length);
    });
    it('unions the declared families of every staged platform', async () => {
      const db = new FakeDb();
      stage(db, 'routines', 'W1', { title: 'a' });
      stage(db, 'workouts', 'W2', { title: 'b' }, 'other-proof');
      const facts = await service().collect(db.client(), COACH, INTENT);
      expect(facts.spec_families).toEqual(['client_history', 'clients', 'programs', 'workouts']);
    });
    it('marks the per-token pass ceiling only when the engine would have refused the family', async () => {
      const db = new FakeDb();
      for (let n = 0; n <= RECONSTRUCT_MAX_ROWS; n++)
        stage(db, 'programs', `P${n}`, { title: 'p' });
      stage(db, 'routines', 'W1', { title: 'w' });
      const facts = await service().collect(db.client(), COACH, INTENT);
      expect(family(facts, 'programs').ceiling_exceeded).toBe(true);
      expect(family(facts, 'programs').identities).toHaveLength(RECONSTRUCT_MAX_ROWS + 1);
      expect(family(facts, 'workouts').ceiling_exceeded).toBe(false);
    });
  });

  describe('ledger join on the wide identity', () => {
    it('attaches failed / skipped / reconstructed facts and leaves the missing row null', async () => {
      const db = new FakeDb();
      stage(db, 'workouts', 'W1', { title: 'a' });
      stage(db, 'workouts', 'W2', { title: 'b' });
      stage(db, 'workouts', 'W3', { title: 'c' });
      stage(db, 'workouts', 'W4', { title: 'd' });
      ledger(db, 'workouts', 'W1', 'failed', { reason: 'error:Error' });
      ledger(db, 'workouts', 'W2', 'skipped', { reason: 'unresolved:missing_required_field:type' });
      ledger(db, 'workouts', 'W3', 'reconstructed', { target_id: 'evidence-1', target_kind: null });
      const facts = await service().collect(db.client(), COACH, INTENT);
      const w = family(facts, 'workouts');
      expect(identity(w, 'W1').ledger).toEqual({ status: 'failed' });
      expect(identity(w, 'W2').ledger).toEqual({
        status: 'skipped',
        reason: 'unresolved:missing_required_field:type',
      });
      expect(identity(w, 'W3').ledger).toEqual({
        status: 'reconstructed',
        target_kind: null,
        provenance: null,
      });
      expect(identity(w, 'W4').ledger).toBeNull();
    });
    it('joins on token + platform + source_id, never on counts', async () => {
      const db = new FakeDb();
      stage(db, 'routines', 'W1', { title: 'a' });
      ledger(db, 'routines', 'W2', 'reconstructed', {
        target_id: 'x',
        target_kind: 'scout_entity',
      });
      const facts = await service().collect(db.client(), COACH, INTENT);
      expect(identity(family(facts, 'workouts'), 'W1').ledger).toBeNull();
      expect(facts.ledger_without_staged).toBe(1);
      expect(family(facts, 'workouts').ledger_without_staged).toBe(1);
    });
    it('does NOT join a step-token staged row to a canonical-token ledger row for the same id', async () => {
      // D-S9-2 wide identity is raw: `routines/W1` and `workouts/W1` are two identities even though
      // both resolve to `workouts`. The ledger row is an orphan attributed to the family it evidences.
      const db = new FakeDb();
      stage(db, 'routines', 'W1', { title: 'a' });
      ledger(db, 'workouts', 'W1', 'reconstructed', {
        target_id: 'p-1',
        target_kind: 'workout_plan',
      });
      provenance(db, 'workouts', 'W1', 'workout_plan', 'p-1', 'created');
      const facts = await service().collect(db.client(), COACH, INTENT);
      const w = family(facts, 'workouts');
      expect(w.identities.map((i) => [i.token, i.identity, i.ledger])).toEqual([
        ['routines', identityKey(PLATFORM, 'W1'), null],
      ]);
      expect(w.ledger_without_staged).toBe(1);
      expect(facts.ledger_without_staged).toBe(1);
    });
    it('counts an orphan ledger row run-wide even when its token resolves to no family', async () => {
      const db = new FakeDb();
      stage(db, 'routines', 'W1', { title: 'a' });
      ledger(db, 'notes', 'N1', 'skipped', { reason: 'unresolved_family:notes' });
      ledger(db, 'workouts', 'Z9', 'failed', {}, 'unregistered');
      const facts = await service().collect(db.client(), COACH, INTENT);
      expect(facts.ledger_without_staged).toBe(2);
      expect(facts.families.map((f) => [f.family, f.ledger_without_staged])).toEqual([
        ['workouts', 0],
      ]);
    });
    it('attributes an orphan to a family entry the ledger alone evidences', async () => {
      const db = new FakeDb();
      stage(db, 'routines', 'W1', { title: 'a' });
      ledger(db, 'programs', 'B1', 'skipped', { reason: 'missing_source_id' });
      const facts = await service().collect(db.client(), COACH, INTENT);
      expect(family(facts, 'programs').identities).toEqual([]);
      expect(family(facts, 'programs').ledger_without_staged).toBe(1);
      expect(facts.ledger_without_staged).toBe(1);
    });
  });

  describe('provenance and native verification (buckets g–j)', () => {
    it('reports present_owned with the provenance reason tags and an empty child histogram', async () => {
      const db = new FakeDb();
      const { program, plan } = verifiedPair(db);
      const facts = await service().collect(db.client(), COACH, INTENT);
      expect(identity(family(facts, 'programs'), 'B1').ledger).toEqual({
        status: 'reconstructed',
        target_kind: 'workout_program',
        provenance: {
          outcome: 'created',
          native: 'present_owned',
          reason: null,
          unresolved_children: {},
        },
      });
      expect(identity(family(facts, 'workouts'), 'W1').ledger).toEqual({
        status: 'reconstructed',
        target_kind: 'workout_plan',
        provenance: {
          outcome: 'created',
          native: 'present_owned',
          reason: 'defaulted:type',
          unresolved_children: {},
        },
      });
      expect(program.id).not.toBe(plan.id);
    });
    it('reports removed for an archived or missing native row', async () => {
      const db = new FakeDb();
      const { plan } = verifiedPair(db);
      plan.archived_at = new Date('2026-09-25T00:00:00Z');
      db.tables.workoutProgram.length = 0; // deleted
      const facts = await service().collect(db.client(), COACH, INTENT);
      expect(identity(family(facts, 'workouts'), 'W1').ledger).toMatchObject({
        provenance: { native: 'removed' },
      });
      expect(identity(family(facts, 'programs'), 'B1').ledger).toMatchObject({
        provenance: { native: 'removed' },
      });
    });
    it('reports foreign_owner when the native row belongs to another coach', async () => {
      const db = new FakeDb();
      const { plan } = verifiedPair(db);
      plan.coach_id = OTHER;
      const facts = await service().collect(db.client(), COACH, INTENT);
      expect(identity(family(facts, 'workouts'), 'W1').ledger).toMatchObject({
        provenance: { native: 'foreign_owner' },
      });
    });
    it('reports provenance_mismatch / kind_mismatch when provenance and ledger disagree', async () => {
      const db = new FakeDb();
      verifiedPair(db);
      const prov = db.tables.importNativeProvenance;
      prov.find((p) => p.entity_type === 'workouts')!.native_id = 'someone-else';
      prov.find((p) => p.entity_type === 'programs')!.native_kind = 'workout_plan';
      const facts = await service().collect(db.client(), COACH, INTENT);
      expect(identity(family(facts, 'workouts'), 'W1').ledger).toMatchObject({
        provenance: { native: 'provenance_mismatch' },
      });
      expect(identity(family(facts, 'programs'), 'B1').ledger).toMatchObject({
        provenance: { native: 'kind_mismatch' },
      });
    });
    it('carries an unresolved top-level provenance row verbatim (outcome, reason)', async () => {
      const db = new FakeDb();
      stage(db, 'workouts', 'W1', { title: 'a', client_id: 'C7' });
      ledger(db, 'workouts', 'W1', 'reconstructed', {
        target_id: 'ev-1',
        target_kind: 'scout_entity',
      });
      provenance(
        db,
        'workouts',
        'W1',
        'workout_plan',
        null,
        'unresolved',
        'unresolved:no_native_client_principal',
      );
      const facts = await service().collect(db.client(), COACH, INTENT);
      const fact = identity(family(facts, 'workouts'), 'W1');
      expect(fact.client_linked).toBe(true);
      expect(fact.ledger).toEqual({
        status: 'reconstructed',
        target_kind: 'scout_entity',
        provenance: {
          outcome: 'unresolved',
          native: 'kind_mismatch',
          reason: 'unresolved:no_native_client_principal',
          unresolved_children: {},
        },
      });
    });
    it('histograms unresolved children by reason under their parent only', async () => {
      const db = new FakeDb();
      verifiedPair(db);
      provenance(
        db,
        'workouts.exercise',
        child('W1', 'id:e1'),
        'workout_plan_exercise',
        null,
        'unresolved',
        'unresolved:exercise_reference',
      );
      provenance(
        db,
        'workouts.exercise',
        child('W1', 'ord:1'),
        'workout_plan_exercise',
        null,
        'unresolved',
        'unresolved:exercise_reference',
      );
      provenance(
        db,
        'workouts.exercise',
        child('W1', 'ord:2'),
        'workout_plan_exercise',
        null,
        'unresolved',
        'unresolved:invalid_value:sets',
      );
      provenance(
        db,
        'workouts.exercise',
        child('W1', 'ord:3'),
        'workout_plan_exercise',
        'x-1',
        'created',
      );
      provenance(
        db,
        'workouts.exercise',
        child('W10', 'ord:0'),
        'workout_plan_exercise',
        null,
        'unresolved',
        'unresolved:exercise_reference',
      );
      const facts = await service().collect(db.client(), COACH, INTENT);
      expect(identity(family(facts, 'workouts'), 'W1').ledger).toMatchObject({
        provenance: {
          unresolved_children: {
            'unresolved:exercise_reference': 2,
            'unresolved:invalid_value:sets': 1,
          },
        },
      });
    });
    it('parses the child identity prefix exactly', () => {
      expect(parentSourceIdOf(child('W1', 'ord:3'))).toBe('W1');
      expect(parentSourceIdOf(child('a:b#c', 'id:z'))).toBe('a:b#c');
      expect(parentSourceIdOf('2:W1#ord:3')).toBe('W1');
      expect(parentSourceIdOf('3:W1#ord:3')).toBeNull();
      expect(parentSourceIdOf('W1#ord:3')).toBeNull();
      expect(parentSourceIdOf(':W1#x')).toBeNull();
    });
  });

  describe('relationship edges (B-2: one edge per declared relationship)', () => {
    it('emits program_parent even when the parent is unstaged and unresolvable', async () => {
      const db = new FakeDb();
      stage(db, 'routines', 'W1', { title: 'Day', block_id: 'B-missing', week: 1, day: 1 });
      const facts = await service().collect(db.client(), COACH, INTENT);
      expect(edges(facts, 'program_parent')).toEqual([
        {
          edge: 'program_parent',
          from_family: 'workouts',
          from_identity: identityKey(PLATFORM, 'W1'),
          to_family: 'programs',
          to_identity: identityKey(PLATFORM, 'B-missing'),
          consistent: false,
        },
      ]);
    });
    it('declares no program_parent edge for a standalone plan or a source without native rules', async () => {
      const db = new FakeDb();
      stage(db, 'routines', 'W1', { title: 'Standalone' });
      stage(db, 'workouts', 'W2', { title: 'Other', block_id: 'B1' }, 'other-proof');
      const facts = await service().collect(db.client(), COACH, INTENT);
      expect(edges(facts, 'program_parent')).toEqual([]);
    });
    it('is consistent only when program_id and (week_index, day_index) match the derivation', async () => {
      const db = new FakeDb();
      const { plan } = verifiedPair(db);
      let facts = await service().collect(db.client(), COACH, INTENT);
      expect(edges(facts, 'program_parent', 'W1')).toEqual([
        expect.objectContaining({ to_identity: identityKey(PLATFORM, 'B1'), consistent: true }),
      ]);
      plan.day_index = 0; // native drift
      facts = await service().collect(db.client(), COACH, INTENT);
      expect(edges(facts, 'program_parent', 'W1')[0].consistent).toBe(false);
      plan.day_index = 1;
      plan.program_id = 'another-program';
      facts = await service().collect(db.client(), COACH, INTENT);
      expect(edges(facts, 'program_parent', 'W1')[0].consistent).toBe(false);
    });
    it('is inconsistent when the parent program exists but is not verified (removed / unresolved)', async () => {
      const db = new FakeDb();
      const { program } = verifiedPair(db);
      program.archived_at = new Date();
      const facts = await service().collect(db.client(), COACH, INTENT);
      expect(edges(facts, 'program_parent', 'W1')).toHaveLength(1);
      expect(edges(facts, 'program_parent', 'W1')[0].consistent).toBe(false);
    });
    it('emits one child_order edge per created child and compares workout_plan_id and #ord', async () => {
      const db = new FakeDb();
      const { plan } = verifiedPair(db);
      const e1 = db.add('workoutPlanExercise', {
        workout_plan_id: plan.id,
        order: 0,
        archived_at: null,
      });
      const e2 = db.add('workoutPlanExercise', {
        workout_plan_id: plan.id,
        order: 5,
        archived_at: null,
      });
      const e3 = db.add('workoutPlanExercise', {
        workout_plan_id: 'other-plan',
        order: 2,
        archived_at: null,
      });
      provenance(
        db,
        'workouts.exercise',
        child('W1', 'ord:0'),
        'workout_plan_exercise',
        e1.id,
        'created',
      );
      provenance(
        db,
        'workouts.exercise',
        child('W1', 'ord:1'),
        'workout_plan_exercise',
        e2.id,
        'already_present',
      );
      provenance(
        db,
        'workouts.exercise',
        child('W1', 'id:abc'),
        'workout_plan_exercise',
        e3.id,
        'created',
      );
      provenance(
        db,
        'workouts.exercise',
        child('W1', 'id:gone'),
        'workout_plan_exercise',
        'missing',
        'created',
      );
      provenance(
        db,
        'workouts.exercise',
        child('W1', 'ord:9'),
        'workout_plan_exercise',
        null,
        'unresolved',
        'unresolved:exercise_reference',
      );
      const facts = await service().collect(db.client(), COACH, INTENT);
      const childEdges = edges(facts, 'child_order', 'W1');
      expect(childEdges).toHaveLength(4); // the unresolved child declares no created relationship
      for (const edge of childEdges) {
        expect(edge.to_family).toBe('workouts');
        expect(edge.to_identity).toBe(identityKey(PLATFORM, 'W1'));
      }
      expect(childEdges.map((e) => e.consistent)).toEqual([true, false, false, false]);
    });
    it('emits client_link with consistent null for every interpreter-resolved client link', async () => {
      const db = new FakeDb();
      stage(db, 'routines', 'W1', { title: 'a', client_id: 42 });
      stage(db, 'log', 'H1', { title: 'h', client_id: 'C1' });
      stage(db, 'people', 'C1', { name: 'n' });
      stage(db, 'blocks', 'B1', { title: 'p', client_id: 'C1' });
      const facts = await service().collect(db.client(), COACH, INTENT);
      expect(
        edges(facts, 'client_link').map((e) => [e.from_family, e.to_identity, e.consistent]),
      ).toEqual([
        ['client_history', identityKey(PLATFORM, 'C1'), null],
        ['programs', identityKey(PLATFORM, 'C1'), null],
        ['workouts', identityKey(PLATFORM, '42'), null],
      ]);
      expect(identity(family(facts, 'clients'), 'C1').client_linked).toBe(false);
      expect(identity(family(facts, 'workouts'), 'W1').client_linked).toBe(true);
    });
  });

  describe('tenancy, aggregation and read-only discipline', () => {
    it("never lets coach B's staging, ledger, provenance or native rows into coach A's facts", async () => {
      const db = new FakeDb();
      verifiedPair(db);
      verifiedPair(db, OTHER);
      stage(db, 'notes', 'N-b', {}, PLATFORM, OTHER);
      const facts = await service().collect(db.client(), COACH, INTENT);
      expect(facts.families.map((f) => [f.family, f.identities.length])).toEqual([
        ['programs', 1],
        ['workouts', 1],
      ]);
      expect(facts.ledger_without_staged).toBe(0);
      for (const call of db.calls) {
        if (
          ['person', 'workoutProgram', 'workoutPlan', 'workoutPlanExercise'].includes(call.model)
        ) {
          expect(Object.keys(call.where)).toEqual(['id']); // S8-C verifyTarget precedent
        } else {
          expect(call.where.coach_id ?? call.where.coach_id_intent_id?.coach_id).toBe(COACH);
        }
      }
    });
    it('issues a bounded number of queries independent of the staged row count', async () => {
      const small = new FakeDb();
      verifiedPair(small);
      await service().collect(small.client(), COACH, INTENT);
      const large = new FakeDb();
      verifiedPair(large);
      for (let n = 0; n < 499; n++) stage(large, 'routines', `X${n}`, { title: 'x' });
      await service().collect(large.client(), COACH, INTENT);
      // Same query count until paging adds one more page (500 rows per page).
      expect(large.calls.length).toBe(small.calls.length + 1);
    });
    it('never invokes a write method', async () => {
      const db = new FakeDb();
      verifiedPair(db);
      await expect(service().collect(db.client(), COACH, INTENT)).resolves.toBeDefined();
      expect(db.calls.every((c) => c.method === 'findMany' || c.method === 'findUnique')).toBe(
        true,
      );
    });
  });

  describe('composition with the frozen S9-A reconcile', () => {
    it('a fully verified program-day pair is partial/coverage_basis_unknown only (v1)', async () => {
      const db = new FakeDb();
      verifiedPair(db);
      db.add('scoutImportCompletion', {
        coach_id: COACH,
        intent_id: INTENT,
        terminal_status: 'success',
      });
      const result = reconcile(await service().collect(db.client(), COACH, INTENT));
      expect(result.verdict).toEqual({ outcome: 'partial', reason_code: 'coverage_basis_unknown' });
      expect(result.report.conditions).toEqual(['coverage_basis_unknown']);
      expect(
        result.report.families.map((f) => [
          f.family,
          f.native_present_verified,
          f.relationship_closure,
        ]),
      ).toEqual([
        ['client_history', 0, 'not_applicable'],
        ['clients', 0, 'not_applicable'],
        ['programs', 1, 'not_applicable'],
        ['workouts', 1, 'verified'],
      ]);
      expect(result.report.required_families).toEqual([
        'client_history',
        'clients',
        'programs',
        'workouts',
      ]);
    });
    it('a missing parent trips relationship_unverified through the emitted edge', async () => {
      const db = new FakeDb();
      const { plan } = verifiedPair(db);
      plan.program_id = null; // the plan was created standalone; the source declares a parent
      const result = reconcile(await service().collect(db.client(), COACH, INTENT));
      expect(result.report.conditions).toEqual([
        'relationship_unverified',
        'coverage_basis_unknown',
      ]);
      expect(result.report.families.find((f) => f.family === 'workouts')).toMatchObject({
        relationship_closure: 'unverified',
        relationship_unverified: 1,
      });
    });
    it('an orphan ledger row and a removed native row are unresolved_identities', async () => {
      const db = new FakeDb();
      const { program } = verifiedPair(db);
      program.archived_at = new Date();
      ledger(db, 'workouts', 'ghost', 'reconstructed', {
        target_id: 'g',
        target_kind: 'workout_plan',
      });
      const result = reconcile(await service().collect(db.client(), COACH, INTENT));
      expect(result.report.conditions[0]).toBe('unresolved_identities');
      expect(result.report.ledger_without_staged).toBe(1);
      expect(result.report.families.find((f) => f.family === 'programs')).toMatchObject({
        unresolved: 1,
        reasons: [{ code: 'unresolved:native_target_removed', count: 1 }],
      });
    });
  });
});
