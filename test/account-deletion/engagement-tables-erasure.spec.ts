/**
 * Backend #609 (clinic engagement, migration 20270213000000_clinic_engagement)
 * adds three tables keyed to User with ON DELETE CASCADE:
 *   CoachWelcomeMessageSetting(coach_id, updated_by)
 *   CoachWelcomeMessageJob(client_id, coach_id; rendered_body = client's first name)
 *   WorkoutReminderDelivery(client_id)
 * Account deletion tombstones the User row, so those cascades never fire and
 * the rows would outlive the account. #609 is not merged when #608 lands, so
 * the erasure lives in OPTIONAL_USER_TABLES: each step runs only when the
 * table exists (to_regclass), inside the finalization transaction.
 *
 * Before this change none of the three tables was named, so this suite fails
 * on the earlier manifest (every row survives).
 */
import { Prisma } from '@prisma/client';
import {
  OPTIONAL_USER_TABLES,
  purgeOptionalUserTables,
} from '../../src/account-deletion/account-deletion.manifest';

function stub<T>(value: unknown): T {
  return value as T;
}

const COACH = 'coach-1';
const CLIENT = 'client-1';
const OWNER = 'owner-1';
const OTHER = 'client-2';

type Row = Record<string, string | null>;

function engagementTx(present: ReadonlySet<string>) {
  const tables: Record<string, Row[]> = {
    CoachWelcomeMessageSetting: [
      { id: 'set-1', coach_id: COACH, updated_by: OWNER },
      { id: 'set-2', coach_id: 'coach-2', updated_by: OWNER },
    ],
    CoachWelcomeMessageJob: [
      { id: 'job-1', client_id: CLIENT, coach_id: COACH, rendered_body: 'Hi Sam' },
      { id: 'job-2', client_id: OTHER, coach_id: COACH, rendered_body: 'Hi Lee' },
      { id: 'job-3', client_id: OTHER, coach_id: 'coach-2', rendered_body: 'Hi Ana' },
    ],
    WorkoutReminderDelivery: [
      { id: 'rem-1', client_id: CLIENT },
      { id: 'rem-2', client_id: OTHER },
    ],
  };
  const statements: string[] = [];
  const tx = stub<Prisma.TransactionClient>({
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = Prisma.sql(strings, ...values);
      const name = String(q.values[0]).replace(/^public\."|"$/g, '');
      return [{ present: present.has(name) }];
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = Prisma.sql(strings, ...values);
      const sql = q.sql.replace(/\s+/g, ' ').trim();
      statements.push(sql);
      const del = /^DELETE FROM "(\w+)" WHERE "(\w+)" = \?$/.exec(sql);
      const upd = /^UPDATE "(\w+)" SET "(\w+)" = NULL WHERE "(\w+)" = \?$/.exec(sql);
      if (del) {
        const rows = tables[del[1]] ?? [];
        tables[del[1]] = rows.filter((r) => r[del[2]] !== q.values[0]);
        return rows.length - tables[del[1]].length;
      }
      if (upd && upd[2] === upd[3]) {
        let n = 0;
        for (const r of tables[upd[1]] ?? []) {
          if (r[upd[2]] === q.values[0]) {
            r[upd[2]] = null;
            n += 1;
          }
        }
        return n;
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  });
  return { tx, tables, statements };
}

const ALL = new Set([
  'CoachWelcomeMessageSetting',
  'CoachWelcomeMessageJob',
  'WorkoutReminderDelivery',
]);

describe('#609 engagement tables are erased with the account', () => {
  it('names every #609 user column', () => {
    for (const [table, column] of [
      ['CoachWelcomeMessageJob', 'client_id'],
      ['CoachWelcomeMessageJob', 'coach_id'],
      ['CoachWelcomeMessageSetting', 'coach_id'],
      ['WorkoutReminderDelivery', 'client_id'],
    ]) {
      expect(OPTIONAL_USER_TABLES).toContainEqual({ table, column });
    }
    expect(OPTIONAL_USER_TABLES).toContainEqual({
      table: 'CoachWelcomeMessageSetting',
      column: 'updated_by',
      op: 'detach',
    });
  });

  it('a deleted client loses their welcome job (rendered first name) and reminder ledger', async () => {
    const h = engagementTx(ALL);
    await purgeOptionalUserTables(h.tx, CLIENT);
    expect(h.tables.CoachWelcomeMessageJob.map((r) => r.id)).toEqual(['job-2', 'job-3']);
    expect(h.tables.WorkoutReminderDelivery.map((r) => r.id)).toEqual(['rem-2']);
    expect(JSON.stringify(h.tables)).not.toContain('Hi Sam');
  });

  it('a deleted coach loses their setting and every job they would have sent', async () => {
    const h = engagementTx(ALL);
    await purgeOptionalUserTables(h.tx, COACH);
    expect(h.tables.CoachWelcomeMessageSetting.map((r) => r.id)).toEqual(['set-2']);
    expect(h.tables.CoachWelcomeMessageJob.map((r) => r.id)).toEqual(['job-3']);
  });

  it('a deleted owner is detached from settings they edited; the coach keeps the setting', async () => {
    const h = engagementTx(ALL);
    const results = await purgeOptionalUserTables(h.tx, OWNER);
    expect(h.tables.CoachWelcomeMessageSetting).toEqual([
      { id: 'set-1', coach_id: COACH, updated_by: null },
      { id: 'set-2', coach_id: 'coach-2', updated_by: null },
    ]);
    expect(results).toContainEqual({
      model: 'CoachWelcomeMessageSetting',
      field: 'updated_by',
      op: 'update',
      count: 2,
    });
  });

  it('on a database without #609 nothing touches those tables', async () => {
    const h = engagementTx(new Set());
    await purgeOptionalUserTables(h.tx, CLIENT);
    expect(h.statements).toEqual([]);
    expect(h.tables.CoachWelcomeMessageJob).toHaveLength(3);
  });
});
