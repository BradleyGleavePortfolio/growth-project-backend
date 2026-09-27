import type { MappedClient } from '../../../../src/scout/reconstruct/mapping-spec';
import type { PersistOutcome } from '../../../../src/scout/reconstruct/native/persist-outcome';
import { persistPerson } from '../../../../src/scout/reconstruct/native/person-writer';
import { FakeNativeTx } from './fake-native-tx';

/**
 * S8-D1 typed `person` handoff — writer logic on the in-memory transaction fake
 * (contract `docs/decisions/2026-09-26-s8d-person-link.md` §5.1 steps 1–3).
 * Real atomicity / CHECKs / RLS are the parent's PostgreSQL lanes
 * (`test/scout/s10/s10-unseen.pg.spec.ts` case (h), the S11 journey lanes).
 */

const COACH = 'coach-a';
const PLATFORM = 'd1-proof';
/** Staged raw id (S9's provenance join key) deliberately differs from the trimmed mapper id. */
const ROW = { source_platform: PLATFORM, source_id: ' c-1 ' };
const client = (displayName: string | null = 'Ada'): MappedClient => ({
  sourcePersonId: 'c-1',
  sourcePlatform: PLATFORM,
  displayName,
});

const run = (tx: FakeNativeTx, c: MappedClient = client(), coach = COACH) =>
  persistPerson(tx.asTx(), coach, ROW, 'clients', c);

const okOutcome = (targetId: string): PersistOutcome => ({
  ok: true,
  targetId,
  targetKind: 'person',
  unresolvedChildren: 0,
});

describe('persistPerson — step 3 create', () => {
  it('creates the Person (InvitePending, no User) then its provenance, target before provenance', async () => {
    const tx = new FakeNativeTx();
    const out = await run(tx);
    expect(out).toEqual(okOutcome(expect.any(String)));
    expect(tx.calls).toEqual([
      'importNativeProvenance.findUnique',
      'person.findUnique',
      'person.create',
      'importNativeProvenance.create',
    ]);
    const person = [...tx.persons.values()][0];
    expect(person).toEqual({
      id: (out as { targetId: string }).targetId,
      coach_id: COACH,
      source_platform: PLATFORM,
      source_person_id: 'c-1', // mapper-trimmed external ref
      display_name: 'Ada',
      state: 'InvitePending',
    });
    // Provenance: raw staged source_id under the canonical family (S9 join key), kind `person`.
    expect([...tx.provenance.values()]).toEqual([
      {
        id: expect.any(String),
        coach_id: COACH,
        source_namespace: PLATFORM,
        entity_type: 'clients',
        source_id: ' c-1 ',
        native_kind: 'person',
        native_id: person.id,
        outcome: 'created',
        reason: null,
      },
    ]);
  });

  it('maps a nameless client to a null display_name (never an email or a synthetic name)', async () => {
    const tx = new FakeNativeTx();
    await run(tx, client(null));
    expect([...tx.persons.values()][0].display_name).toBeNull();
  });
});

describe('persistPerson — step 1 verify (provenance is the identity)', () => {
  it('a coach-edited display_name survives replay: zero writes, same target', async () => {
    const tx = new FakeNativeTx();
    const first = await run(tx, client('Ada'));
    const person = [...tx.persons.values()][0];
    person.display_name = 'Ada (edited by coach)';
    tx.calls = [];
    const second = await run(tx, client('Ada Lovelace'));
    expect(second).toEqual(first);
    expect(tx.calls).toEqual(['importNativeProvenance.findUnique', 'person.findUnique']);
    expect(person.display_name).toBe('Ada (edited by coach)');
    expect(tx.persons.size).toBe(1);
    expect(tx.provenance.size).toBe(1);
  });

  it.each(['Deleted' as const, 'vanished' as const])(
    'a %s target is unresolved:native_target_removed — stays as is, no new Person, no write',
    async (mode) => {
      const tx = new FakeNativeTx();
      await run(tx);
      const person = [...tx.persons.values()][0];
      if (mode === 'Deleted') person.state = 'Deleted';
      else tx.persons.delete(person.id);
      const before = {
        persons: JSON.stringify([...tx.persons]),
        provenance: JSON.stringify([...tx.provenance]),
      };
      tx.calls = [];
      const out = await run(tx);
      expect(out).toEqual({ ok: false, reason: 'unresolved:native_target_removed' });
      expect(tx.calls).toEqual(['importNativeProvenance.findUnique', 'person.findUnique']);
      expect(JSON.stringify([...tx.persons])).toBe(before.persons);
      expect(JSON.stringify([...tx.provenance])).toBe(before.provenance);
      if (mode === 'Deleted') expect(person.state).toBe('Deleted');
    },
  );

  it('a provenance target owned by another coach is unresolved:identity_conflict; a wrong native_kind is decided from provenance alone', async () => {
    const tx = new FakeNativeTx();
    await run(tx);
    const prov = [...tx.provenance.values()][0];
    const person = [...tx.persons.values()][0];
    person.coach_id = 'coach-z';
    tx.calls = [];
    expect(await run(tx)).toEqual({ ok: false, reason: 'unresolved:identity_conflict' });
    expect(tx.calls).toEqual(['importNativeProvenance.findUnique', 'person.findUnique']);

    person.coach_id = COACH;
    prov.native_kind = 'workout_program';
    tx.calls = [];
    expect(await run(tx)).toEqual({ ok: false, reason: 'unresolved:identity_conflict' });
    expect(tx.calls).toEqual(['importNativeProvenance.findUnique']);
    expect(tx.persons.size).toBe(1);
  });

  it('two coaches importing the same external ref get two isolated Persons and two provenance rows', async () => {
    const tx = new FakeNativeTx();
    const a = await run(tx, client(), 'coach-a');
    const b = await run(tx, client(), 'coach-b');
    expect(a.ok && b.ok && a.targetId !== b.targetId).toBe(true);
    expect([...tx.persons.values()].map((p) => p.coach_id).sort()).toEqual(['coach-a', 'coach-b']);
    expect([...tx.provenance.values()].map((p) => p.coach_id).sort()).toEqual([
      'coach-a',
      'coach-b',
    ]);
    // Replays stay on their own row.
    expect(await run(tx, client(), 'coach-a')).toEqual(a);
    expect(await run(tx, client(), 'coach-b')).toEqual(b);
  });
});

describe('persistPerson — step 2 adopt a pre-D1 Person', () => {
  const legacy = (tx: FakeNativeTx, state: 'InvitePending' | 'Deleted' = 'InvitePending') =>
    tx.seedPerson({
      coach_id: COACH,
      source_platform: PLATFORM,
      source_person_id: 'c-1',
      display_name: 'Legacy Name',
      state,
    });

  it('adopts once (already_present, name untouched), then every later run is the step-1 verify path', async () => {
    const tx = new FakeNativeTx();
    const row = legacy(tx);
    const first = await run(tx, client('Mapped Name'));
    expect(first).toEqual(okOutcome(row.id));
    // Locate → lock the row (`FOR UPDATE`) → A1 claim check → adopt.
    expect(tx.calls).toEqual([
      'importNativeProvenance.findUnique',
      'person.findUnique',
      '$queryRaw',
      'importNativeProvenance.findFirst',
      'importNativeProvenance.create',
    ]);
    expect([...tx.provenance.values()]).toEqual([
      expect.objectContaining({
        source_id: ' c-1 ',
        native_kind: 'person',
        native_id: row.id,
        outcome: 'already_present',
        reason: null,
      }),
    ]);
    expect(row.display_name).toBe('Legacy Name');

    tx.calls = [];
    const second = await run(tx, client('Mapped Name'));
    expect(second).toEqual(first);
    expect(tx.calls).toEqual(['importNativeProvenance.findUnique', 'person.findUnique']);
    expect(tx.persons.size).toBe(1);
    expect(tx.provenance.size).toBe(1);
  });

  it('a Deleted pre-D1 match is native_target_removed: not adopted, no provenance row, no re-create', async () => {
    const tx = new FakeNativeTx();
    const row = legacy(tx, 'Deleted');
    expect(await run(tx)).toEqual({ ok: false, reason: 'unresolved:native_target_removed' });
    expect(tx.calls).toEqual([
      'importNativeProvenance.findUnique',
      'person.findUnique',
      '$queryRaw',
    ]);
    expect(tx.provenance.size).toBe(0);
    expect(tx.persons.size).toBe(1);
    expect(row.state).toBe('Deleted');
  });

  it('an unresolved provenance row plus a pre-D1 Person is promoted in place to already_present (one row)', async () => {
    const tx = new FakeNativeTx();
    const row = legacy(tx);
    await tx.importNativeProvenance.create({
      data: {
        coach_id: COACH,
        source_namespace: PLATFORM,
        entity_type: 'clients',
        source_id: ' c-1 ',
        native_kind: 'person',
        native_id: null,
        outcome: 'unresolved',
        reason: 'unresolved:native_target_removed',
      },
    });
    tx.calls = [];
    expect(await run(tx)).toEqual(okOutcome(row.id));
    expect(tx.calls).toEqual([
      'importNativeProvenance.findUnique',
      'person.findUnique',
      '$queryRaw',
      'importNativeProvenance.findFirst',
      'importNativeProvenance.update',
    ]);
    expect([...tx.provenance.values()]).toEqual([
      expect.objectContaining({ native_id: row.id, outcome: 'already_present', reason: null }),
    ]);
  });
});

describe('persistPerson — A1: one Person per accepted source identity', () => {
  /** A second staged row whose RAW id differs from ROW's but trims to the same external ref. */
  const ALIAS = { source_platform: PLATFORM, source_id: 'c-1' };
  const runAlias = (tx: FakeNativeTx) =>
    persistPerson(tx.asTx(), COACH, ALIAS, 'clients', client());
  const provenanceOf = (tx: FakeNativeTx) =>
    [...tx.provenance.values()].map((r) => [r.source_id, r.outcome, r.native_id]);

  it('sequential: the second raw id that maps to an already-claimed Person is identity_conflict — no adoption, no second provenance row, first row untouched', async () => {
    const tx = new FakeNativeTx();
    const first = await run(tx);
    const person = [...tx.persons.values()][0];
    const before = JSON.stringify([...tx.provenance.values()]);
    tx.calls = [];
    expect(await runAlias(tx)).toEqual({ ok: false, reason: 'unresolved:identity_conflict' });
    expect(tx.calls).toEqual([
      'importNativeProvenance.findUnique',
      'person.findUnique',
      '$queryRaw',
      'importNativeProvenance.findFirst',
    ]);
    expect(tx.persons.size).toBe(1);
    expect(JSON.stringify([...tx.provenance.values()])).toBe(before);
    expect(provenanceOf(tx)).toEqual([[' c-1 ', 'created', person.id]]);
    // The first identity keeps verifying; the alias keeps being refused, replay after replay.
    expect(await run(tx)).toEqual(first);
    expect(await runAlias(tx)).toEqual({ ok: false, reason: 'unresolved:identity_conflict' });
    expect(tx.provenance.size).toBe(1);
  });

  it('the refusal also holds when the claim is an adoption (already_present) rather than a create', async () => {
    const tx = new FakeNativeTx();
    const row = tx.seedPerson({
      coach_id: COACH,
      source_platform: PLATFORM,
      source_person_id: 'c-1',
      display_name: 'Legacy',
      state: 'InvitePending',
    });
    expect(await runAlias(tx)).toEqual(okOutcome(row.id));
    expect(await run(tx)).toEqual({ ok: false, reason: 'unresolved:identity_conflict' });
    expect(provenanceOf(tx)).toEqual([['c-1', 'already_present', row.id]]);
  });

  it('an UNRESOLVED row for the other raw id is not a claim: the Person is still adoptable once', async () => {
    const tx = new FakeNativeTx();
    const row = tx.seedPerson({
      coach_id: COACH,
      source_platform: PLATFORM,
      source_person_id: 'c-1',
      display_name: 'Legacy',
      state: 'InvitePending',
    });
    await tx.importNativeProvenance.create({
      data: {
        coach_id: COACH,
        source_namespace: PLATFORM,
        entity_type: 'clients',
        source_id: 'c-1',
        native_kind: 'person',
        native_id: null,
        outcome: 'unresolved',
        reason: 'unresolved:native_target_removed',
      },
    });
    expect(await run(tx)).toEqual(okOutcome(row.id));
    expect(await runAlias(tx)).toEqual({ ok: false, reason: 'unresolved:identity_conflict' });
  });

  it('a claim under another family, namespace or coach does not block adoption', async () => {
    const tx = new FakeNativeTx();
    const row = tx.seedPerson({
      coach_id: COACH,
      source_platform: PLATFORM,
      source_person_id: 'c-1',
      display_name: 'Legacy',
      state: 'InvitePending',
    });
    for (const [coach_id, source_namespace, entity_type] of [
      [COACH, PLATFORM, 'workouts'],
      [COACH, 'other-ns', 'clients'],
      ['coach-b', PLATFORM, 'clients'],
    ]) {
      await tx.importNativeProvenance.create({
        data: {
          coach_id,
          source_namespace,
          entity_type,
          source_id: 'c-1',
          native_kind: 'person',
          native_id: row.id,
          outcome: 'created',
          reason: null,
        },
      });
    }
    expect(await run(tx)).toEqual(okOutcome(row.id));
  });

  it('concurrent adopters of one unclaimed Person: the row lock serialises them, exactly one adopts, the other is identity_conflict', async () => {
    const tx = new FakeNativeTx();
    const row = tx.seedPerson({
      coach_id: COACH,
      source_platform: PLATFORM,
      source_person_id: 'c-1',
      display_name: 'Legacy',
      state: 'InvitePending',
    });
    const outcomes = await Promise.all([
      tx.$transaction((t) => persistPerson(t.asTx(), COACH, ROW, 'clients', client())),
      tx.$transaction((t) => persistPerson(t.asTx(), COACH, ALIAS, 'clients', client())),
    ]);
    expect(outcomes).toEqual([
      okOutcome(row.id),
      { ok: false, reason: 'unresolved:identity_conflict' },
    ]);
    expect(provenanceOf(tx)).toEqual([[' c-1 ', 'already_present', row.id]]);
    // Both located the Person and both asked for the lock before either claim check ran; the
    // loser's claim check ran only after the holder's adoption was written (its transaction end).
    expect(tx.calls).toEqual([
      'importNativeProvenance.findUnique',
      'importNativeProvenance.findUnique',
      'person.findUnique',
      'person.findUnique',
      '$queryRaw',
      '$queryRaw',
      'importNativeProvenance.findFirst',
      'importNativeProvenance.create',
      'importNativeProvenance.findFirst',
    ]);
  });

  it("C1: another coach's Deleted Person is identity_conflict (ownership before state), on both the provenance and the external-ref path", async () => {
    const tx = new FakeNativeTx();
    const foreign = tx.seedPerson({
      coach_id: 'coach-b',
      source_platform: PLATFORM,
      source_person_id: 'c-1',
      display_name: 'Theirs',
      state: 'Deleted',
    });
    await tx.importNativeProvenance.create({
      data: {
        coach_id: COACH,
        source_namespace: PLATFORM,
        entity_type: 'clients',
        source_id: ' c-1 ',
        native_kind: 'person',
        native_id: foreign.id,
        outcome: 'created',
        reason: null,
      },
    });
    expect(await run(tx)).toEqual({ ok: false, reason: 'unresolved:identity_conflict' });
    // External-ref path: the ref includes coach_id, so a foreign row is never located there;
    // seed a same-coach Deleted row to pin that state still yields native_target_removed.
    tx.seedPerson({
      coach_id: COACH,
      source_platform: PLATFORM,
      source_person_id: 'c-1',
      display_name: 'Mine',
      state: 'Deleted',
    });
    expect(await runAlias(tx)).toEqual({ ok: false, reason: 'unresolved:native_target_removed' });
  });
});

describe('persistPerson — convergence and atomicity', () => {
  it('five repeated runs with changing mapped names: one Person, one provenance row, identical outcomes, first name kept', async () => {
    const tx = new FakeNativeTx();
    const outcomes: PersistOutcome[] = [];
    for (let i = 0; i < 5; i += 1) outcomes.push(await run(tx, client(`Name v${i}`)));
    expect(new Set(outcomes.map((o) => JSON.stringify(o))).size).toBe(1);
    expect(tx.persons.size).toBe(1);
    expect(tx.provenance.size).toBe(1);
    expect([...tx.persons.values()][0].display_name).toBe('Name v0');
    expect([...tx.provenance.values()][0].outcome).toBe('created');
  });

  it('an unresolved provenance row is promoted in place on create (never a second row)', async () => {
    const tx = new FakeNativeTx();
    await tx.importNativeProvenance.create({
      data: {
        coach_id: COACH,
        source_namespace: PLATFORM,
        entity_type: 'clients',
        source_id: ' c-1 ',
        native_kind: 'person',
        native_id: null,
        outcome: 'unresolved',
        reason: 'unresolved:native_target_removed',
      },
    });
    tx.calls = [];
    const out = await run(tx);
    expect(out.ok).toBe(true);
    expect(tx.calls).toEqual([
      'importNativeProvenance.findUnique',
      'person.findUnique',
      'person.create',
      'importNativeProvenance.update',
    ]);
    expect(tx.provenance.size).toBe(1);
    expect([...tx.provenance.values()][0]).toMatchObject({
      outcome: 'created',
      native_id: [...tx.persons.keys()][0],
      reason: null,
    });
  });

  it('a provenance failure rolls the Person back (target and provenance commit together)', async () => {
    const tx = new FakeNativeTx();
    tx.failAt = 'importNativeProvenance.create';
    await expect(tx.$transaction((t) => run(t))).rejects.toThrow(
      'injected failure at importNativeProvenance.create',
    );
    expect(tx.persons.size).toBe(0);
    expect(tx.provenance.size).toBe(0);
    // The replay after the rollback creates cleanly.
    expect((await tx.$transaction((t) => run(t))).ok).toBe(true);
    expect(tx.persons.size).toBe(1);
    expect(tx.provenance.size).toBe(1);
  });
});
