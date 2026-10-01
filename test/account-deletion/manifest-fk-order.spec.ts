/**
 * A-608-3: the erasure manifest must never delete a parent row while a child
 * row still points at it through an ON DELETE RESTRICT / NO ACTION foreign
 * key. Postgres would raise 23503, the finalization transaction would roll
 * back, and the account would never finish deleting.
 *
 * The in-memory fake used by the other suites does not model FK actions, so
 * this suite derives the real constraints from prisma/migrations/** (the SQL
 * that built the database, not schema.prisma), replaying ADD/DROP CONSTRAINT
 * and DROP TABLE in migration order. For every manifest `delete` step it
 * walks the ON DELETE CASCADE closure of the deleted model and requires each
 * RESTRICT / NO ACTION child of anything in that closure to be either
 *   - deleted by an EARLIER manifest step that reaches the parent through
 *     that relation (e.g. ExerciseSet via `workout.user_id` before
 *     WorkoutSession via `user_id`), or
 *   - deleted by a RESTRICT_CHILD_PRE_STEPS raw step (children that are not
 *     Prisma relations, e.g. wearable prompt sources -> WearableSample), or
 *   - excluded by the step's own `where` guard (e.g. a Recipe is only deleted
 *     when `saved_by: { none: {} }`), or
 *   - listed in EXEMPT with a reason that explains why no row can exist.
 */
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { Prisma } from '@prisma/client';
import {
  ERASURE_MANIFEST,
  RESTRICT_CHILD_PRE_STEPS,
  executeErasureManifest,
} from '../../src/account-deletion/account-deletion.manifest';

const ROOT = join(__dirname, '../..');

function stub<T>(value: unknown): T {
  return value as T;
}

export interface MigrationFk {
  name: string;
  table: string;
  columns: string[];
  ref: string;
  onDelete: 'CASCADE' | 'RESTRICT' | 'NO ACTION' | 'SET NULL' | 'SET DEFAULT';
}

const IDENT = String.raw`(?:public\.)?"?(\w+)"?`;

function cols(list: string): string[] {
  return list.split(',').map((c) => c.trim().replace(/"/g, ''));
}

/** Replays every migration.sql in order and returns the surviving FKs. */
export function migrationFks(dir = join(ROOT, 'prisma/migrations')): Map<string, MigrationFk> {
  const fks = new Map<string, MigrationFk>();
  const files = readdirSync(dir)
    .sort()
    .map((d) => join(dir, d, 'migration.sql'))
    .filter((f) => existsSync(f));
  const tableStmt = new RegExp(
    String.raw`(?:ALTER|CREATE)\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:ONLY\s+)?${IDENT}`,
    'gi',
  );
  for (const file of files) {
    const sql = readFileSync(file, 'utf8')
      .replace(/--[^\n]*/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ');
    type Event = { at: number; apply: () => void };
    const events: Event[] = [];
    const owners: Array<{ at: number; table: string }> = [];
    for (const m of sql.matchAll(tableStmt)) owners.push({ at: m.index ?? 0, table: m[1] });
    const ownerAt = (at: number) => {
      let table = '';
      for (const o of owners) if (o.at < at) table = o.table;
      return table;
    };

    // Table-level: [CONSTRAINT "n"] FOREIGN KEY (cols) REFERENCES "t" (cols) [ON ...]
    const tableFk = new RegExp(
      String.raw`(?:CONSTRAINT\s+"?(\w+)"?\s+)?FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+${IDENT}\s*\([^)]*\)((?:\s+ON\s+(?:DELETE|UPDATE)\s+(?:CASCADE|RESTRICT|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION))*)`,
      'gi',
    );
    const covered: Array<[number, number]> = [];
    for (const m of sql.matchAll(tableFk)) {
      const at = m.index ?? 0;
      covered.push([at, at + m[0].length]);
      const table = ownerAt(at);
      const columns = cols(m[2]);
      const name = m[1] ?? `${table}_${columns.join('_')}_fkey`;
      const onDelete = parseOnDelete(m[4]);
      events.push({
        at,
        apply: () => fks.set(name, { name, table, columns, ref: m[3], onDelete }),
      });
    }
    // Column-level: "col" type ... REFERENCES "t" (cols) [ON ...]
    const columnFk = new RegExp(
      String.raw`"(\w+)"\s+[\w\s(),]*?\bREFERENCES\s+${IDENT}\s*\([^)]*\)((?:\s+ON\s+(?:DELETE|UPDATE)\s+(?:CASCADE|RESTRICT|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION))*)`,
      'gi',
    );
    for (const m of sql.matchAll(columnFk)) {
      const at = m.index ?? 0;
      const refAt = at + m[0].search(/REFERENCES/i);
      if (covered.some(([a, b]) => refAt >= a && refAt < b)) continue;
      if (/FOREIGN\s+KEY/i.test(m[0])) continue;
      const table = ownerAt(at);
      const name = `${table}_${m[1]}_fkey`;
      const onDelete = parseOnDelete(m[3]);
      events.push({
        at,
        apply: () => fks.set(name, { name, table, columns: [m[1]], ref: m[2], onDelete }),
      });
    }
    for (const m of sql.matchAll(/DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/gi)) {
      events.push({ at: m.index ?? 0, apply: () => fks.delete(m[1]) });
    }
    for (const m of sql.matchAll(
      new RegExp(String.raw`DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${IDENT}`, 'gi'),
    )) {
      events.push({
        at: m.index ?? 0,
        apply: () => {
          for (const [n, fk] of fks) if (fk.table === m[1] || fk.ref === m[1]) fks.delete(n);
        },
      });
    }
    events.sort((a, b) => a.at - b.at).forEach((e) => e.apply());
  }
  return fks;
}

function parseOnDelete(clauses: string | undefined): MigrationFk['onDelete'] {
  const m = /ON\s+DELETE\s+(CASCADE|RESTRICT|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION)/i.exec(
    clauses ?? '',
  );
  return m ? (m[1].toUpperCase().replace(/\s+/g, ' ') as MigrationFk['onDelete']) : 'NO ACTION';
}

interface Relation {
  name: string;
  target: string;
  fk: string[];
}
interface ModelInfo {
  table: string;
  relations: Relation[];
}

function parseModels(): Map<string, ModelInfo> {
  const src = readFileSync(join(ROOT, 'prisma/schema.prisma'), 'utf8');
  const out = new Map<string, ModelInfo>();
  for (const m of src.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const relations: Relation[] = [];
    let table = m[1];
    for (const raw of m[2].split('\n')) {
      const line = raw.split('//')[0].trim();
      const map = /^@@map\("(\w+)"\)/.exec(line);
      if (map) table = map[1];
      if (!line || line.startsWith('@@')) continue;
      const [name, type] = line.split(/\s+/);
      if (!name || !type) continue;
      const fk = /fields:\s*\[([^\]]+)\]/.exec(line);
      relations.push({
        name,
        target: type.replace(/[?[\]]/g, ''),
        fk: fk ? fk[1].split(',').map((s) => s.trim()) : [],
      });
    }
    out.set(m[1], { table, relations });
  }
  return out;
}

/**
 * RESTRICT / NO ACTION children that cannot hold a row pointing at a row the
 * manifest deletes. `parent>child` -> reason. Every entry must be used.
 */
const EXEMPT: Record<string, string> = {};

const fks = migrationFks();
const models = parseModels();
const modelOfTable = new Map([...models].map(([name, info]) => [info.table, name]));
const tableOf = (model: string) => models.get(model)?.table ?? model;

function cascadeClosure(table: string): Set<string> {
  const seen = new Set([table]);
  const queue = [table];
  while (queue.length) {
    const t = queue.shift() as string;
    for (const fk of fks.values()) {
      if (fk.ref === t && fk.onDelete === 'CASCADE' && !seen.has(fk.table)) {
        seen.add(fk.table);
        queue.push(fk.table);
      }
    }
  }
  return seen;
}

interface Violation {
  step: string;
  parent: string;
  child: string;
  fk: string;
}

function violations(manifest = ERASURE_MANIFEST): { found: Violation[]; usedExempt: Set<string> } {
  const found: Violation[] = [];
  const usedExempt = new Set<string>();
  manifest.forEach((entry, index) => {
    if (entry.action.op !== 'delete') return;
    const closure = cascadeClosure(tableOf(entry.model));
    for (const fk of fks.values()) {
      if (!closure.has(fk.ref)) continue;
      if (fk.onDelete !== 'RESTRICT' && fk.onDelete !== 'NO ACTION') continue;
      if (closure.has(fk.table)) {
        // The child is removed by the same cascade. A self-reference is only
        // safe for NO ACTION (checked at statement end).
        if (fk.table !== fk.ref || fk.onDelete === 'NO ACTION') continue;
      }
      const preStep = RESTRICT_CHILD_PRE_STEPS.some(
        (p) =>
          p.childTable === fk.table &&
          p.parentTable === fk.ref &&
          sameCols([p.childColumn], fk.columns),
      );
      if (preStep) continue;
      const parentModel = modelOfTable.get(fk.ref) ?? fk.ref;
      const childModel = modelOfTable.get(fk.table) ?? fk.table;
      const key = `${parentModel}>${childModel}`;
      const childRel = models
        .get(childModel)
        ?.relations.find((r) => r.target === parentModel && sameCols(r.fk, fk.columns));
      const earlier = manifest
        .slice(0, index)
        .some(
          (e) =>
            e.model === childModel &&
            e.action.op === 'delete' &&
            !!childRel &&
            e.field.split('.')[0] === childRel.name &&
            e.where === undefined,
        );
      if (earlier) continue;
      const guard =
        fk.ref === tableOf(entry.model) &&
        entry.where !== undefined &&
        Object.keys(entry.where).some((k) =>
          models.get(entry.model)?.relations.some((r) => r.name === k && r.target === childModel),
        );
      if (guard) continue;
      if (EXEMPT[key]) {
        usedExempt.add(key);
        continue;
      }
      found.push({
        step: `#${index} ${entry.model}.${entry.field}`,
        parent: parentModel,
        child: childModel,
        fk: fk.name,
      });
    }
  });
  return { found, usedExempt };
}

function sameCols(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i]);
}

describe('erasure manifest vs. migration foreign keys (A-608-3)', () => {
  it('parses the real constraints from prisma/migrations', () => {
    expect(fks.size).toBeGreaterThan(150);
    expect(fks.get('ExerciseSet_workout_id_fkey')).toEqual(
      expect.objectContaining({
        table: 'ExerciseSet',
        ref: 'WorkoutSession',
        onDelete: 'RESTRICT',
      }),
    );
    expect(fks.get('HabitLog_habit_id_fkey')).toEqual(
      expect.objectContaining({ table: 'HabitLog', ref: 'Habit', onDelete: 'RESTRICT' }),
    );
    // A later migration that re-creates a constraint wins.
    expect(fks.get('Message_sender_id_fkey')?.onDelete).toBe('CASCADE');
  });

  it('deletes every RESTRICT / NO ACTION child before its parent', () => {
    const { found } = violations();
    expect(found).toEqual([]);
  });

  it.each([
    ['WorkoutSession', 'ExerciseSet', 'workout.user_id'],
    ['Habit', 'HabitLog', 'habit.user_id'],
  ])('%s: the RESTRICT child %s is deleted first through %s', (parent, child, field) => {
    const parentIdx = ERASURE_MANIFEST.findIndex(
      (e) => e.model === parent && e.action.op === 'delete',
    );
    const childIdx = ERASURE_MANIFEST.findIndex(
      (e) => e.model === child && e.action.op === 'delete' && e.field === field,
    );
    expect(childIdx).toBeGreaterThanOrEqual(0);
    expect(childIdx).toBeLessThan(parentIdx);
  });

  it('catches the A-608-3 defect when the child steps are removed', () => {
    const broken = ERASURE_MANIFEST.filter(
      (e) => !(e.model === 'ExerciseSet' || e.model === 'HabitLog'),
    );
    const pairs = violations(broken).found.map((v) => `${v.parent}>${v.child}`);
    expect(pairs).toEqual(expect.arrayContaining(['WorkoutSession>ExerciseSet', 'Habit>HabitLog']));
  });

  it('catches a child step placed after its parent', () => {
    const idx = ERASURE_MANIFEST.findIndex((e) => e.model === 'ExerciseSet');
    const moved = [...ERASURE_MANIFEST];
    const [step] = moved.splice(idx, 1);
    moved.push(step);
    expect(violations(moved).found.map((v) => v.child)).toContain('ExerciseSet');
  });

  it('the wearable prompt source RESTRICT FK is covered by a pre-step, not by luck', () => {
    expect(fks.get('community_wearable_prompt_sources_sampleId_fkey')?.onDelete).toBe('RESTRICT');
    const without = violations().found;
    expect(without).toEqual([]);
    expect(RESTRICT_CHILD_PRE_STEPS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          childTable: 'community_wearable_prompt_sources',
          parentTable: 'WearableSample',
        }),
      ]),
    );
  });

  it('every pre-step matches a real RESTRICT / NO ACTION constraint', () => {
    for (const p of RESTRICT_CHILD_PRE_STEPS) {
      const match = [...fks.values()].find(
        (fk) =>
          fk.table === p.childTable &&
          fk.ref === p.parentTable &&
          sameCols([p.childColumn], fk.columns),
      );
      expect(match?.onDelete).toMatch(/RESTRICT|NO ACTION/);
    }
  });

  it('every exemption is still needed', () => {
    const { usedExempt } = violations();
    expect(Object.keys(EXEMPT).filter((k) => !usedExempt.has(k))).toEqual([]);
  });

  it('executes the pre-step SQL before the manifest deletes the parent rows', async () => {
    const order: string[] = [];
    const delegate = (model: string) => ({
      findMany: async () => [],
      deleteMany: async () => {
        order.push(`${model}.deleteMany`);
        return { count: 0 };
      },
      updateMany: async () => ({ count: 0 }),
    });
    const top: Record<string, unknown> = {
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        order.push(`raw:${strings.join('?').replace(/\s+/g, ' ').trim().slice(0, 30)}`);
        values.forEach((v) => order.push(`value:${JSON.stringify(v)}`));
        return 0;
      },
      $queryRaw: async () => [{ present: false }],
    };
    const tx = new Proxy(top, {
      get: (target, prop: string) => (prop in target ? target[prop] : delegate(prop)),
    });
    await executeErasureManifest(stub<Prisma.TransactionClient>(tx), {
      userId: 'u-1',
      email: 'a@example.com',
      tombstoneEmail: 't@tombstone.invalid',
      now: new Date(),
    });
    const pre = order.findIndex((o) => o.startsWith('raw:DELETE FROM'));
    expect(pre).toBeGreaterThanOrEqual(0);
    expect(pre).toBeLessThan(order.indexOf('wearableSample.deleteMany'));
    expect(order.indexOf('exerciseSet.deleteMany')).toBeLessThan(
      order.indexOf('workoutSession.deleteMany'),
    );
    expect(order.indexOf('habitLog.deleteMany')).toBeLessThan(order.indexOf('habit.deleteMany'));
  });
});
