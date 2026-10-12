/**
 * B-DP-4-1 (owner decision 4): when a client moves, the old coach loses
 * everything at once and the history stays with the client.
 *
 * Coach A coached client C, who has moved to coach B; client D is still A's.
 * The real DataExportService._buildArchive runs against an in-memory store.
 * A's own export leaves out every row about C, keeps D's rows and A's rows
 * about no client; C's own export still has the history with A.
 */
import type { PrismaService } from '../src/prisma.service';
import { DataExportService } from '../src/data-export/data-export.service';

type Row = Record<string, unknown>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (key === 'OR') return (want as Row[]).some((w) => matches(row, w));
    if (key === 'AND') return (want as Row[]).every((w) => matches(row, w));
    if (want === null) return row[key] === null || row[key] === undefined;
    if (typeof want === 'object' && 'in' in want)
      return (want as { in: unknown[] }).in.includes(row[key]);
    if (typeof want === 'object' && 'gt' in want)
      return String(row[key]) > String((want as { gt: unknown }).gt);
    if (typeof want === 'object') return false;
    return row[key] === want;
  });
}

const A = 'coach-a';
const B = 'coach-b';
const C = 'client-moved';
const D = 'client-current';

const users: Row[] = [
  { id: A, email: 'a@example.test', role: 'coach', coach_id: null, deleted_at: null },
  { id: B, email: 'b@example.test', role: 'coach', coach_id: null, deleted_at: null },
  { id: C, email: 'c@example.test', role: 'student', coach_id: B, deleted_at: null },
  { id: D, email: 'd@example.test', role: 'student', coach_id: A, deleted_at: null },
];

const tables: Record<string, Row[]> = {
  user: users,
  mealPlan: [
    { id: 'mp-c', coach_id: A, client_id: C, notes: 'C plan' },
    { id: 'mp-d', coach_id: A, client_id: D, notes: 'D plan' },
    { id: 'mp-template', coach_id: A, client_id: null, notes: 'template' },
  ],
  coachNudge: [
    { id: 'cn-c', coach_id: A, client_id: C, body: 'C nudge' },
    { id: 'cn-d', coach_id: A, client_id: D, body: 'D nudge' },
  ],
  messageDraft: [
    { id: 'md-c', coach_id: A, client_id: C, body: 'C draft' },
    { id: 'md-d', coach_id: A, client_id: D, body: 'D draft' },
  ],
  coachGuideline: [
    { id: 'cg-c', coach_id: A, client_id: C, body: 'C guideline' },
    { id: 'cg-d', coach_id: A, client_id: D, body: 'D guideline' },
  ],
  coachMessage: [
    { id: 'm-a-c', sender_id: A, coach_id: A, client_id: C, body: 'A to C' },
    { id: 'm-c-a', sender_id: C, coach_id: A, client_id: C, body: 'C to A' },
    { id: 'm-a-d', sender_id: A, coach_id: A, client_id: D, body: 'A to D' },
  ],
};

function store(): PrismaService {
  const delegate = (name: string) => {
    const findMany = async (args: { where: Row; take?: number }) =>
      (tables[name] ?? [])
        .filter((r) => matches(r, args.where))
        .sort((x, y) => (String(x.id) < String(y.id) ? -1 : 1))
        .slice(0, args.take);
    return {
      findMany,
      findFirst: async (args: { where: Row }) => (await findMany(args))[0] ?? null,
      findUnique: async (args: { where: Row }) => (await findMany(args))[0] ?? null,
    };
  };
  const prisma = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string' || prop.startsWith('$') || prop === 'then') return undefined;
        return delegate(prop);
      },
    },
  );
  return prisma as PrismaService;
}

async function exportOf(userId: string): Promise<Record<string, Row[]>> {
  const svc = new DataExportService(store());
  const build = Reflect.get(svc, '_buildArchive') as (
    u: string,
    e: string,
  ) => Promise<{ buffer: Buffer }>;
  const { buffer } = await build.call(svc, userId, '00000000-0000-4000-8000-000000000041');
  return JSON.parse(buffer.toString('utf8'));
}

const SECTIONS = [
  'meal_plans',
  'coach_nudges',
  'message_drafts',
  'coach_guidelines',
  'coach_messages',
];
const ids = (archive: Record<string, Row[]>, section: string) =>
  archive[section].map((r) => String(r.id)).sort();

describe('former coach export (B-DP-4-1, owner decision 4)', () => {
  it("leaves every row about a moved client out of the old coach's own export", async () => {
    const archive = await exportOf(A);
    for (const section of SECTIONS) {
      expect(JSON.stringify(archive[section])).not.toContain(C);
    }
  });

  it("keeps the old coach's rows about a current client and about no client", async () => {
    const archive = await exportOf(A);
    expect(ids(archive, 'meal_plans')).toEqual(['mp-d', 'mp-template']);
    expect(ids(archive, 'coach_nudges')).toEqual(['cn-d']);
    expect(ids(archive, 'message_drafts')).toEqual(['md-d']);
    expect(ids(archive, 'coach_guidelines')).toEqual(['cg-d']);
    expect(ids(archive, 'coach_messages')).toEqual(['m-a-d']);
  });

  it("leaves the moved client's own export unchanged, history with the old coach included", async () => {
    const archive = await exportOf(C);
    expect(ids(archive, 'meal_plans')).toEqual(['mp-c']);
    expect(ids(archive, 'coach_nudges')).toEqual(['cn-c']);
    expect(ids(archive, 'message_drafts')).toEqual(['md-c']);
    expect(ids(archive, 'coach_guidelines')).toEqual(['cg-c']);
    expect(ids(archive, 'coach_messages')).toEqual(['m-a-c', 'm-c-a']);
    const own = archive.coach_messages.find((m) => m.id === 'm-c-a');
    expect(own).toMatchObject({ body: 'C to A' });
  });
});
