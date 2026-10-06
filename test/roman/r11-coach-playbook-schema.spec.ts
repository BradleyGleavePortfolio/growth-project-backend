/**
 * Roman v1.1 slice R11-P1: CoachPlaybook schema, validator, RLS, deletion.
 *
 *   1. validateCoachPlaybook accepts a full playbook, normalises it, and
 *      rejects unknown keys, oversize text, oversize lists and red lines
 *      outside the closed kinds, with issue codes that never echo the text.
 *   2. The migration is service_role only: RLS enabled and forced, every
 *      table grant revoked from anon and authenticated, no coach, client or
 *      owner policy, and CHECKs that match the closed sets in code.
 *   3. Account deletion: a client's deletion removes only that client's
 *      source rows; a coach's deletion removes the coach's playbooks and
 *      sources and nobody else's. Whole-schema coverage stays with
 *      test/account-deletion/erasure-manifest-coverage.spec.ts.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Prisma } from '@prisma/client';
import {
  ERASURE_MANIFEST,
  executeErasureManifest,
} from '../../src/account-deletion/account-deletion.manifest';
import {
  PLAYBOOK_ITEM_TEXT_MAX,
  PLAYBOOK_LIST_MAX,
  PLAYBOOK_RED_LINE_KINDS,
  PLAYBOOK_SECTION_KEYS,
  PLAYBOOK_SOURCE_KINDS,
  PLAYBOOK_STATUSES,
  emptyCoachPlaybookSections,
  validateCoachPlaybook,
} from '../../src/roman/playbook/coach-playbook.schema';

const item = (text: string) => ({ text, basis: 'observed', evidence_count: 3 });

function fullPlaybook() {
  return {
    sections: {
      exercises: {
        go_to: [item('Trap-bar deadlift as the main hinge')],
        avoid: [item('Behind-the-neck press')],
        substitutions: [
          {
            for: 'Back squat',
            use: 'Goblet squat',
            when: 'Knee pain',
            basis: 'observed',
            evidence_count: 5,
          },
        ],
        cues: [item('Brace before each rep')],
        warm_up: [item('Five minutes of easy cardio, then ramp-up sets')],
      },
      training: {
        split: [item('Upper / lower, four days')],
        progression: [item('Add a rep each week, then load')],
        failure: [item('Stop one to two reps short of failure')],
      },
      diet: {
        protein: [item('About 1 g of protein per lb of goal weight')],
        supplements_reject: [{ text: 'Fat burners', basis: 'stated', evidence_count: 1 }],
      },
      recovery: { sleep_target: [item('Seven to nine hours')] },
    },
    red_lines: [
      {
        kind: 'no_exercise',
        value: 'Behind-the-neck press',
        text: 'Never program it',
        basis: 'stated',
        evidence_count: 1,
      },
      {
        kind: 'no_train_through_pain',
        text: 'Stop on joint pain',
        basis: 'stated',
        evidence_count: 2,
      },
      {
        kind: 'min_kcal',
        value: 1400,
        text: 'Never under 1,400 kcal',
        basis: 'stated',
        evidence_count: 1,
      },
      { kind: 'custom', text: 'No two-a-days', basis: 'stated', evidence_count: 1 },
    ],
  };
}

describe('R11-P1 validateCoachPlaybook', () => {
  it('accepts a full playbook and fills every list key', () => {
    const res = validateCoachPlaybook(fullPlaybook());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    for (const [section, keys] of Object.entries(PLAYBOOK_SECTION_KEYS)) {
      const lists = (res.value.sections as unknown as Record<string, Record<string, unknown[]>>)[
        section
      ];
      expect(Object.keys(lists)).toEqual([...keys]);
    }
    expect(res.value.sections.training.deload).toEqual([]);
    expect(res.value.sections.exercises.substitutions[0]).toMatchObject({
      for: 'Back squat',
      use: 'Goblet squat',
    });
    expect(res.value.red_lines.map((r) => r.kind)).toEqual([
      'no_exercise',
      'no_train_through_pain',
      'min_kcal',
      'custom',
    ]);
  });

  it('accepts an empty playbook and trims text', () => {
    const empty = validateCoachPlaybook({ sections: {}, red_lines: [] });
    expect(empty).toEqual({
      ok: true,
      value: { sections: emptyCoachPlaybookSections(), red_lines: [] },
    });
    const trimmed = validateCoachPlaybook({
      sections: { recovery: { rest_days: [item('  Two rest days  ')] } },
      red_lines: [],
    });
    expect(trimmed.ok && trimmed.value.sections.recovery.rest_days[0].text).toBe('Two rest days');
  });

  it('accepts every closed red-line kind in its own shape', () => {
    const base = { text: 'A rule', basis: 'stated', evidence_count: 1 };
    const withValue: Record<string, unknown> = {
      no_exercise: 'Dips',
      no_supplement: 'Creatine',
      min_kcal: 1500,
    };
    const red_lines = PLAYBOOK_RED_LINE_KINDS.map((kind) =>
      kind in withValue ? { kind, value: withValue[kind], ...base } : { kind, ...base },
    );
    expect(validateCoachPlaybook({ sections: {}, red_lines }).ok).toBe(true);
  });

  const rejected: Array<[string, (p: ReturnType<typeof fullPlaybook>) => unknown, RegExp]> = [
    [
      'an unknown section',
      (p) => ({ ...p, sections: { ...p.sections, mindset: {} } }),
      /^sections:unrecognized_keys$/,
    ],
    [
      'an unknown list key',
      (p) => ({ ...p, sections: { ...p.sections, diet: { fasting: [item('x')] } } }),
      /^sections\.diet:unrecognized_keys$/,
    ],
    [
      'an unknown item key',
      (p) => ({
        ...p,
        sections: { recovery: { rest_days: [{ ...item('Rest'), client_name: 'Sam' }] } },
      }),
      /^sections\.recovery\.rest_days\.0:unrecognized_keys$/,
    ],
    [
      'text over the cap',
      (p) => ({
        ...p,
        sections: { training: { split: [item('x'.repeat(PLAYBOOK_ITEM_TEXT_MAX + 1))] } },
      }),
      /^sections\.training\.split\.0\.text:too_big$/,
    ],
    [
      'a list over the cap',
      (p) => ({
        ...p,
        sections: {
          exercises: {
            cues: Array.from({ length: PLAYBOOK_LIST_MAX + 1 }, (_, i) => item(`Cue ${i}`)),
          },
        },
      }),
      /^sections\.exercises\.cues:too_big$/,
    ],
    [
      'a multi-line item',
      (p) => ({ ...p, sections: { diet: { bad_day: [item('Line one\nLine two')] } } }),
      /^sections\.diet\.bad_day\.0\.text:/,
    ],
    [
      'an unknown basis',
      (p) => ({ ...p, sections: { diet: { protein: [{ ...item('x'), basis: 'guessed' }] } } }),
      /^sections\.diet\.protein\.0\.basis:/,
    ],
    [
      'a red-line kind outside the closed set',
      (p) => ({
        ...p,
        red_lines: [{ kind: 'no_running', text: 'x', basis: 'stated', evidence_count: 1 }],
      }),
      /^red_lines\.0/,
    ],
    [
      'no_exercise without the exercise',
      (p) => ({
        ...p,
        red_lines: [{ kind: 'no_exercise', text: 'x', basis: 'stated', evidence_count: 1 }],
      }),
      /^red_lines\.0\.value:/,
    ],
    [
      'min_kcal with text for a number',
      (p) => ({
        ...p,
        red_lines: [
          { kind: 'min_kcal', value: '1200', text: 'x', basis: 'stated', evidence_count: 1 },
        ],
      }),
      /^red_lines\.0\.value:/,
    ],
    [
      'a value on a kind that takes none',
      (p) => ({
        ...p,
        red_lines: [
          {
            kind: 'no_failure_training',
            value: 'x',
            text: 'x',
            basis: 'stated',
            evidence_count: 1,
          },
        ],
      }),
      /^red_lines\.0:unrecognized_keys$/,
    ],
    [
      'more red lines than the cap',
      (p) => ({
        ...p,
        red_lines: Array.from({ length: PLAYBOOK_LIST_MAX + 1 }, () => p.red_lines[3]),
      }),
      /^red_lines:too_big$/,
    ],
    ['sections that are not an object', (p) => ({ ...p, sections: [] }), /^sections:invalid_type$/],
    ['red lines that are not a list', (p) => ({ ...p, red_lines: {} }), /^red_lines:invalid_type$/],
  ];

  it.each(rejected)('rejects %s', (_label, mutate, issue) => {
    const res = validateCoachPlaybook(
      mutate(fullPlaybook()) as { sections: unknown; red_lines: unknown },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.issues).toEqual(expect.arrayContaining([expect.stringMatching(issue)]));
  });

  it('never echoes the rejected text or an unknown key in its issues', () => {
    const res = validateCoachPlaybook({
      sections: {
        diet: { protein: [{ ...item('Private detail '.repeat(20)), client_name: 'Sam Example' }] },
      },
      red_lines: [
        { kind: 'secret_kind', text: 'Another private detail', basis: 'stated', evidence_count: 1 },
      ],
    });
    expect(res.ok).toBe(false);
    const text = JSON.stringify(res);
    expect(text).not.toContain('Private detail');
    expect(text).not.toContain('Sam Example');
    expect(text).not.toContain('client_name');
    expect(text).not.toContain('secret_kind');
  });
});

describe('R11-P1 migration 20270402000000_coach_playbook', () => {
  const dir = join(__dirname, '../../prisma/migrations/20270402000000_coach_playbook');
  const sql = readFileSync(join(dir, 'migration.sql'), 'utf8');
  const code = sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  const tables = ['CoachPlaybook', 'CoachPlaybookSource'];
  const quoted = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');
  const flat = code.replace(/\s+/g, ' ');

  it.each(tables)('%s: RLS enabled and forced, every API-role grant revoked', (table) => {
    expect(code).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`);
    expect(code).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`);
    expect(code).toContain(`REVOKE ALL ON TABLE "${table}" FROM anon, authenticated;`);
  });

  it.each(tables)('%s: only the service_role policy and the anon deny exist', (table) => {
    const policies = [
      ...flat.matchAll(/CREATE POLICY "([^"]+)" ON "(\w+)" AS (\w+) FOR (\w+) TO (\w+)/g),
    ]
      .filter((m) => m[2] === table)
      .map((m) => ({ name: m[1], kind: m[3], cmd: m[4], role: m[5] }));
    const lower = table.toLowerCase();
    expect(policies).toEqual([
      { name: `p_${lower}_service_role_all`, kind: 'PERMISSIVE', cmd: 'ALL', role: 'service_role' },
      { name: `deny_all_anon_${lower}`, kind: 'RESTRICTIVE', cmd: 'ALL', role: 'anon' },
    ]);
  });

  it('grants nothing and has no coach, client or owner branch', () => {
    expect(code).not.toMatch(/\bGRANT\b/);
    expect(code).not.toMatch(/current_user_id|is_owner|auth\.uid|TO (public|authenticated)\b/i);
  });

  it('allows one active playbook per coach and versions unique per coach', () => {
    expect(flat).toContain(
      `CREATE UNIQUE INDEX "CoachPlaybook_one_active_per_coach" ON "CoachPlaybook"("coach_id") WHERE "status" = 'active';`,
    );
    expect(flat).toContain(
      `CREATE UNIQUE INDEX "CoachPlaybook_coach_id_version_key" ON "CoachPlaybook"("coach_id", "version");`,
    );
  });

  it('CHECKs the same closed sets as the code', () => {
    expect(flat).toContain(`CHECK ("status" IN (${quoted(PLAYBOOK_STATUSES)}))`);
    expect(flat).toContain(`CHECK ( "source_kind" IN ( ${quoted(PLAYBOOK_SOURCE_KINDS)} ) )`);
  });

  it('stores source ids only, never content', () => {
    const table = /CREATE TABLE "CoachPlaybookSource" \(([\s\S]*?)\n\);/.exec(code)?.[1] ?? '';
    const columns = [...table.matchAll(/^\s+"(\w+)"\s+(?:TEXT|INTEGER|JSONB|TIMESTAMP)\b/gm)].map(
      (m) => m[1],
    );
    expect(columns).toEqual([
      'id',
      'playbook_id',
      'coach_id',
      'client_id',
      'source_kind',
      'source_id',
    ]);
  });

  it('down.sql drops both tables', () => {
    const down = readFileSync(join(dir, 'down.sql'), 'utf8');
    expect(down).toContain('DROP TABLE IF EXISTS "CoachPlaybookSource";');
    expect(down).toContain('DROP TABLE IF EXISTS "CoachPlaybook";');
  });
});

describe('R11-P1 account deletion', () => {
  const COACH = 'coach-a';
  const OTHER_COACH = 'coach-b';
  const CLIENT = 'client-x';
  const OTHER_CLIENT = 'client-y';
  type Row = Record<string, unknown>;

  function seed() {
    return {
      coachPlaybook: [
        { id: 'pb-a1', coach_id: COACH, version: 1, status: 'superseded' },
        { id: 'pb-a2', coach_id: COACH, version: 2, status: 'active' },
        { id: 'pb-b1', coach_id: OTHER_COACH, version: 1, status: 'active' },
      ] as Row[],
      coachPlaybookSource: [
        {
          id: 's1',
          playbook_id: 'pb-a2',
          coach_id: COACH,
          client_id: CLIENT,
          source_kind: 'adjustment_decision',
        },
        {
          id: 's2',
          playbook_id: 'pb-a2',
          coach_id: COACH,
          client_id: OTHER_CLIENT,
          source_kind: 'coach_message',
        },
        {
          id: 's3',
          playbook_id: 'pb-a2',
          coach_id: COACH,
          client_id: null,
          source_kind: 'template',
        },
        {
          id: 's4',
          playbook_id: 'pb-b1',
          coach_id: OTHER_COACH,
          client_id: CLIENT,
          source_kind: 'session_note',
        },
        {
          id: 's5',
          playbook_id: 'pb-b1',
          coach_id: OTHER_COACH,
          client_id: OTHER_CLIENT,
          source_kind: 'guideline',
        },
      ] as Row[],
    };
  }

  /** In-memory tx for the two playbook tables; the FK cascade from playbook to source is applied like Postgres. */
  function tx(tables: ReturnType<typeof seed>): Prisma.TransactionClient {
    const matches = (row: Row, where: Row) => Object.entries(where).every(([k, v]) => row[k] === v);
    const delegate = (name: keyof typeof tables) => ({
      deleteMany: async ({ where }: { where: Row }) => {
        const before = tables[name];
        tables[name] = before.filter((r) => !matches(r, where));
        if (name === 'coachPlaybook') {
          const live = new Set(tables.coachPlaybook.map((p) => p.id));
          tables.coachPlaybookSource = tables.coachPlaybookSource.filter((s) =>
            live.has(s.playbook_id),
          );
        }
        return { count: before.length - tables[name].length };
      },
      updateMany: async () => ({ count: 0 }),
    });
    const client = {
      coachMediaAsset: { findMany: async () => [] },
      coachPlaybook: delegate('coachPlaybook'),
      coachPlaybookSource: delegate('coachPlaybookSource'),
      $executeRaw: async () => 0,
      $queryRaw: async () => [{ present: false }],
    };
    return client as unknown as Prisma.TransactionClient;
  }

  const playbookEntries = ERASURE_MANIFEST.filter(
    (e) => e.model === 'CoachPlaybook' || e.model === 'CoachPlaybookSource',
  );
  const run = (userId: string, tables: ReturnType<typeof seed>) =>
    executeErasureManifest(
      tx(tables),
      {
        userId,
        email: `${userId}@example.test`,
        tombstoneEmail: `deleted-${userId}@tombstone.invalid`,
        now: new Date(),
      },
      playbookEntries,
    );
  const ids = (rows: Row[]) => rows.map((r) => r.id);

  it('has a delete decision for every playbook user column, sources before playbooks', () => {
    expect(playbookEntries.map((e) => [e.model, e.field, e.action.op])).toEqual([
      ['CoachPlaybookSource', 'client_id', 'delete'],
      ['CoachPlaybookSource', 'coach_id', 'delete'],
      ['CoachPlaybook', 'coach_id', 'delete'],
    ]);
  });

  it("deleting a client removes only that client's source rows", async () => {
    const tables = seed();
    await run(CLIENT, tables);
    expect(ids(tables.coachPlaybook)).toEqual(['pb-a1', 'pb-a2', 'pb-b1']);
    expect(ids(tables.coachPlaybookSource)).toEqual(['s2', 's3', 's5']);
  });

  it("deleting a coach removes the coach's playbooks and sources, and no one else's", async () => {
    const tables = seed();
    await run(COACH, tables);
    expect(ids(tables.coachPlaybook)).toEqual(['pb-b1']);
    expect(ids(tables.coachPlaybookSource)).toEqual(['s4', 's5']);
  });
});
