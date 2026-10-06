/**
 * C-636-2 (plus operator scope addition 10-02 12:33 and the B-RECIPES
 * follow-up "export omits created recipes"): the archive must carry
 *   - the recipes the user created (full content, not only saved ids),
 *   - the user's Roman/AI chats that are not deleted (sessions + messages),
 *   - the AI-processing consent ledger (every grant and withdrawal),
 * and nothing that belongs to another person or to an erased chat.
 *
 * The real DataExportService._buildArchive runs against an in-memory store
 * that applies each `where`, `select` and `orderBy` the service sends, so a
 * missing owner filter, a missing deleted-chat exclusion or an unselected
 * internal column shows up in the parsed archive.
 */
import type { PrismaService } from '../src/prisma.service';
import { DataExportService } from '../src/data-export/data-export.service';

jest.mock('@sentry/node', () => ({ captureMessage: jest.fn(), captureException: jest.fn() }));

function stub<T>(value: unknown): T {
  return value as T;
}

type Row = Record<string, unknown>;

/** Matches flat equality, `null`, and one level of relation filter (`session: {...}`). */
function matches(
  row: Row,
  where: Record<string, unknown>,
  related: (key: string, row: Row) => Row | undefined,
): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (key === 'OR' && Array.isArray(want)) {
      return want.some((w: Record<string, unknown>) => matches(row, w, related));
    }
    if (key === 'AND' && Array.isArray(want)) {
      return want.every((w: Record<string, unknown>) => matches(row, w, related));
    }
    if (want !== null && typeof want === 'object' && 'gt' in want) {
      // Keyset paging (`id > last`): plain string order, like a C collation.
      return String(row[key]) > String((want as { gt: unknown }).gt);
    }
    if (want !== null && typeof want === 'object' && !(want instanceof Date)) {
      const parent = related(key, row);
      return parent !== undefined && matches(parent, stub<Record<string, unknown>>(want), related);
    }
    return row[key] === want;
  });
}

const U = 'user-1';
const OTHER = 'user-2';
const t = (n: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, n));

/**
 * Store options. `unorderedPlans`: a query without an ORDER BY returns its
 * rows in an order that depends on the OFFSET, as a database may when the
 * plan changes between pages (the first page in insertion order, later
 * pages reversed). `ignoreKeyset`: the store drops an `id > last` filter.
 */
type StoreOptions = { unorderedPlans?: boolean; ignoreKeyset?: boolean };

function store(extra: Record<string, Row[]> = {}, opts: StoreOptions = {}) {
  const tables: Record<string, Row[]> = {
    recipe: [
      {
        id: 'r2',
        title: 'Overnight oats',
        created_by_id: U,
        ingredients: ['oats'],
        instructions: ['soak'],
        created_at: t(2),
      },
      {
        id: 'r1',
        title: 'Green salad',
        created_by_id: U,
        ingredients: ['kale'],
        instructions: ['toss'],
        created_at: t(1),
      },
      { id: 'r-other', title: 'Not mine', created_by_id: OTHER, created_at: t(0) },
    ],
    romanSession: [
      {
        id: 's-live',
        user_id: U,
        surface: 'client',
        day_key: '2026-10-01',
        message_count: 2,
        deleted_at: null,
        subject_context_json: { brief: 'about someone else' },
        quips_in_session: 1,
        created_at: t(1),
      },
      {
        id: 's-deleted',
        user_id: U,
        surface: 'client',
        day_key: 'erased:s-deleted',
        message_count: 0,
        deleted_at: t(5),
        subject_context_json: null,
        created_at: t(0),
      },
      {
        id: 's-other',
        user_id: OTHER,
        surface: 'client',
        day_key: '2026-10-01',
        message_count: 1,
        deleted_at: null,
        created_at: t(0),
      },
    ],
    romanMessage: [
      {
        id: 'm2',
        session_id: 's-live',
        user_id: U,
        role: 'assistant',
        content: 'Here is a plan.',
        model_id: 'claude-x',
        interrupted: false,
        prompt_tokens: 10,
        created_at: t(4),
      },
      {
        id: 'm1',
        session_id: 's-live',
        user_id: U,
        role: 'user',
        content: 'Help me plan my week.',
        model_id: null,
        interrupted: false,
        created_at: t(3),
      },
      {
        id: 'm-deleted',
        session_id: 's-deleted',
        user_id: U,
        role: 'user',
        content: 'a chat I deleted',
        created_at: t(1),
      },
      {
        id: 'm-other',
        session_id: 's-other',
        user_id: OTHER,
        role: 'user',
        content: 'someone else',
        created_at: t(1),
      },
    ],
    aiProcessingConsentEvent: [
      {
        id: 'c2',
        user_id: U,
        processor: 'anthropic',
        purpose: 'client_ai_processing',
        seq: 2,
        action: 'withdraw',
        consent_version: 'v4',
        copy_sha256: 'b'.repeat(64),
        created_at: t(6),
      },
      {
        id: 'c1',
        user_id: U,
        processor: 'anthropic',
        purpose: 'client_ai_processing',
        seq: 1,
        action: 'grant',
        consent_version: 'v4',
        copy_sha256: 'a'.repeat(64),
        created_at: t(2),
      },
      {
        id: 'c-other',
        user_id: OTHER,
        processor: 'anthropic',
        purpose: 'client_ai_processing',
        seq: 1,
        action: 'grant',
        created_at: t(2),
      },
    ],
  };
  for (const [name, rows] of Object.entries(extra))
    tables[name] = [...(tables[name] ?? []), ...rows];
  const related = (key: string, row: Row): Row | undefined => {
    if (key === 'session') return tables.romanSession.find((s) => s.id === row.session_id);
    return undefined;
  };
  const delegate = (name: string) => ({
    findMany: async (args: {
      where: Record<string, unknown>;
      select?: Record<string, true>;
      orderBy?: Array<Record<string, 'asc' | 'desc'>>;
      skip?: number;
      take?: number;
    }) => {
      const where =
        opts.ignoreKeyset && Array.isArray(args.where.AND)
          ? stub<Record<string, unknown>>(args.where.AND[0])
          : args.where;
      let rows = (tables[name] ?? []).filter((r) => matches(r, where, related));
      if (opts.unorderedPlans && !args.orderBy && (args.skip ?? 0) > 0) rows = [...rows].reverse();
      for (const order of [...(args.orderBy ?? [])].reverse()) {
        const [col, dir] = Object.entries(order)[0];
        rows = [...rows].sort((a, b) => {
          const key = (v: unknown) => (v instanceof Date ? v.getTime() : String(v));
          const x = key(a[col]);
          const y = key(b[col]);
          const c = x < y ? -1 : x > y ? 1 : 0;
          return dir === 'asc' ? c : -c;
        });
      }
      rows = rows.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? rows.length));
      if (!args.select) return rows;
      const keys = Object.keys(args.select);
      return rows.map((r) => Object.fromEntries(keys.filter((k) => k in r).map((k) => [k, r[k]])));
    },
    findUnique: async () => null,
  });
  const prisma = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'user')
          return { findUnique: async () => extra.user?.[0] ?? { id: U, email: 'u@example.test' } };
        if (typeof prop !== 'string' || prop.startsWith('$') || prop === 'then') return undefined;
        return delegate(prop);
      },
    },
  );
  return stub<PrismaService>(prisma);
}

async function build(
  extra: Record<string, Row[]> = {},
  opts: StoreOptions = {},
): Promise<Record<string, unknown>> {
  const svc = new DataExportService(store(extra, opts));
  const buildArchive: unknown = Reflect.get(svc, '_buildArchive');
  if (typeof buildArchive !== 'function') throw new Error('no _buildArchive');
  const { buffer } = await buildArchive.call(svc, U, '00000000-0000-4000-8000-000000000001');
  return JSON.parse(buffer.toString('utf8'));
}

describe('data export archive inventory (C-636-2)', () => {
  it('exports the recipes the user created, in order, with their content, and no one else recipes', async () => {
    const archive = await build();
    const recipes = stub<Row[]>(archive.created_recipes);
    expect(recipes.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(recipes[0]).toMatchObject({
      title: 'Green salad',
      ingredients: ['kale'],
      instructions: ['toss'],
    });
    expect(recipes[0]).not.toHaveProperty('created_by_id');
  });

  it('exports the user live Roman chats in order, never a deleted chat or another person chat', async () => {
    const archive = await build();
    const sessions = stub<Row[]>(archive.roman_sessions);
    const messages = stub<Row[]>(archive.roman_messages);
    expect(sessions.map((s) => s.id)).toEqual(['s-live']);
    expect(messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(messages.map((m) => m.content)).toEqual(['Help me plan my week.', 'Here is a plan.']);
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      model_id: 'claude-x',
      session_id: 's-live',
    });
    const text = JSON.stringify(archive);
    expect(text).not.toContain('a chat I deleted');
    expect(text).not.toContain('someone else');
  });

  it('leaves out the internal session context blob and budget counters', async () => {
    const archive = await build();
    const [session] = stub<Row[]>(archive.roman_sessions);
    expect(session).not.toHaveProperty('subject_context_json');
    expect(session).not.toHaveProperty('quips_in_session');
    expect(JSON.stringify(archive)).not.toContain('about someone else');
    const [first] = stub<Row[]>(archive.roman_messages);
    expect(first).not.toHaveProperty('prompt_tokens');
  });

  it('exports the full AI-processing consent ledger of the user, oldest first', async () => {
    const archive = await build();
    const events = stub<Row[]>(archive.ai_processing_consent_events);
    expect(events.map((e) => [e.seq, e.action])).toEqual([
      [1, 'grant'],
      [2, 'withdraw'],
    ]);
    expect(events.every((e) => e.user_id === U)).toBe(true);
  });
});

// F-EXPORT-TIE: the archive pages through every table 500 rows at a time.
// Pages used OFFSET over a query without an ORDER BY, so a database that
// returned the later pages in another order (a plan change between pages)
// gave an archive with repeated rows and missing rows. Pages now follow the
// primary key (`id > last id`, ordered by id).
describe('data export paging (F-EXPORT-TIE)', () => {
  const COACH = 'coach-1';
  /** `n` rows in a scrambled insertion order, so id order is not insertion order. */
  const scrambled = (n: number, row: (i: number) => Row): Row[] =>
    Array.from({ length: n }, (_, k) => row((k * 7919) % n));
  const pad = (i: number) => String(i).padStart(5, '0');

  const weightLogs = scrambled(1234, (i) => ({ id: `w-${pad(i)}`, user_id: U, weight_kg: 70 }));
  const coachMessages = scrambled(1100, (i) => ({
    id: `cm-${pad(i)}`,
    sender_id: i % 3 === 0 ? COACH : U,
    coach_id: COACH,
    client_id: U,
    body: i % 3 === 0 ? `coach note ${i}` : `client note ${i}`,
    created_at: t(i % 60),
  }));
  const others = [
    { id: 'w-other', user_id: OTHER, weight_kg: 90 },
    { id: 'cm-other', sender_id: OTHER, coach_id: 'coach-2', client_id: OTHER, body: 'not yours' },
  ];

  const ids = (rows: unknown): string[] => stub<Row[]>(rows).map((r) => String(r.id));

  it('exports every row exactly once when unordered pages come back in another order', async () => {
    const archive = await build(
      {
        weightLog: [...weightLogs, others[0]],
        coachMessage: [...coachMessages, others[1]],
      },
      { unorderedPlans: true },
    );

    const weights = ids(archive.weight_logs);
    expect(weights).toHaveLength(1234);
    expect(new Set(weights).size).toBe(1234);
    expect([...weights].sort()).toEqual(weightLogs.map((r) => String(r.id)).sort());

    const messages = stub<Row[]>(archive.coach_messages);
    expect(messages).toHaveLength(1100);
    expect(new Set(ids(messages)).size).toBe(1100);
    expect(ids(messages).sort()).toEqual(coachMessages.map((r) => String(r.id)).sort());
    // Redaction still applies on every page: the coach's own words never leave.
    const fromCoach = messages.filter((m) => m.redacted === true);
    expect(fromCoach).toHaveLength(367);
    expect(JSON.stringify(messages)).not.toContain('coach note');
    expect(JSON.stringify(archive)).not.toContain('not yours');
  });

  it('keeps the chronological sections oldest first across pages', async () => {
    const consent = scrambled(1001, (i) => ({
      id: `cx-${pad(i)}`,
      user_id: U,
      processor: 'anthropic',
      purpose: 'client_ai_processing',
      seq: i + 10,
      action: 'grant',
      created_at: t(1000 - i),
    }));
    const archive = await build({ aiProcessingConsentEvent: consent }, { unorderedPlans: true });
    const events = stub<Row[]>(archive.ai_processing_consent_events);
    // The 1,001 rows above plus the two events store() already holds for U.
    expect(events).toHaveLength(1003);
    expect(new Set(ids(events)).size).toBe(1003);
    const times = events.map((e) => new Date(String(e.created_at)).getTime());
    expect(times).toEqual([...times].sort((x, y) => x - y));
  });

  it('fails the export with the table name when a page would repeat, instead of looping', async () => {
    await expect(build({ weightLog: weightLogs }, { ignoreKeyset: true })).rejects.toThrow(
      'Data export paging stopped on weightLog: a page did not end on a newer row id.',
    );
  });
});

// W3-13 (B-DELETE-123): the export left out the data that went live on day 1
// (community, broadcasts, coach codes, Roman adjustments, wearables), although
// the privacy pages point people at the in-app export for a copy of it.
describe('data export day-1 sections (W3-13)', () => {
  const day1: Record<string, Row[]> = {
    user: [{ id: U, email: 'u@example.test', expo_push_token: 'ExponentPushToken[secret]' }],
    communityPost: [
      {
        id: 'p1',
        author_id: U,
        title: 'Week one',
        body: 'Squats felt good',
        deleted_at: null,
        created_at: t(2),
      },
      { id: 'p-del', author_id: U, body: 'a post I deleted', deleted_at: t(3), created_at: t(1) },
      {
        id: 'p-other',
        author_id: OTHER,
        body: 'post by someone else',
        deleted_at: null,
        created_at: t(1),
      },
    ],
    communityMessage: [
      {
        id: 'cm1',
        sender_id: U,
        recipient_user_id: OTHER,
        body: 'Nice work on the deadlift',
        voice_url: 'https://storage.example/voice/cm1.m4a',
        deleted_at: null,
        created_at: t(4),
      },
      {
        id: 'cm-other',
        sender_id: OTHER,
        body: 'reply by someone else',
        deleted_at: null,
        created_at: t(5),
      },
    ],
    communityResponse: [
      {
        id: 'cr1',
        user_id: U,
        target_type: 'post',
        target_id: 'p-other',
        response_kind: 'clap',
        created_at: t(6),
      },
      {
        id: 'cr-other',
        user_id: OTHER,
        target_type: 'post',
        target_id: 'p1',
        response_kind: 'clap',
        created_at: t(6),
      },
    ],
    coachBroadcastDelivery: [
      {
        id: 'bd1',
        recipient_id: U,
        broadcast_id: 'b1',
        status: 'delivered',
        lease_holder: 'machine-1',
        created_at: t(7),
      },
      {
        id: 'bd-other',
        recipient_id: OTHER,
        broadcast_id: 'b1',
        status: 'delivered',
        created_at: t(7),
      },
    ],
    coachCodeRedemption: [
      {
        id: 'ccr1',
        user_id: U,
        status: 'completed',
        outcome: 'linked',
        coach_id: 'coach-1',
        response: { internal: true },
        created_at: t(8),
      },
    ],
    inviteRedemption: [
      {
        id: 'ir1',
        client_user_id: U,
        coach_id: 'coach-1',
        code: 'BRAD10',
        source: 'qr',
        redeemed_at: t(9),
      },
      {
        id: 'ir-other',
        client_user_id: OTHER,
        coach_id: 'coach-1',
        code: 'OTHER1',
        redeemed_at: t(9),
      },
    ],
    workoutAdjustmentProposal: [
      {
        id: 'wa1',
        client_id: U,
        coach_id: 'coach-1',
        status: 'applied',
        signals: { sleep_hours: 5.1 },
        proposed_change: { volume: -0.2 },
        rule_key: 'internal.rule',
        dismiss_reason: 'coach note',
        created_at: t(10),
      },
    ],
    wearableConnection: [
      {
        id: 'wc1',
        user_id: U,
        provider: 'oura',
        status: 'active',
        encrypted_refresh_token: 'enc-secret',
        created_at: t(11),
      },
    ],
    wearableSample: [
      {
        id: 'ws2',
        user_id: U,
        metric: 'resting_hr',
        value: 52,
        unit: 'bpm',
        raw_ref: 'raw/2',
        start_at: t(13),
      },
      { id: 'ws1', user_id: U, metric: 'sleep_duration', value: 7.5, unit: 'h', start_at: t(12) },
      {
        id: 'ws-other',
        user_id: OTHER,
        metric: 'resting_hr',
        value: 70,
        unit: 'bpm',
        start_at: t(12),
      },
    ],
  };
  const ids = (rows: unknown): string[] => stub<Row[]>(rows).map((r) => String(r.id));

  it('exports the user own community posts, messages and reactions, never deleted or other people rows', async () => {
    const archive = await build(day1);
    expect(ids(archive.community_posts)).toEqual(['p1']);
    expect(stub<Row[]>(archive.community_posts)[0]).toMatchObject({ body: 'Squats felt good' });
    expect(ids(archive.community_messages)).toEqual(['cm1']);
    expect(stub<Row[]>(archive.community_messages)[0]).not.toHaveProperty('recipient_user_id');
    expect(stub<Row[]>(archive.community_messages)[0]).not.toHaveProperty('voice_url');
    expect(ids(archive.community_reactions)).toEqual(['cr1']);
    const text = JSON.stringify(archive);
    expect(text).not.toContain('a post I deleted');
    expect(text).not.toContain('someone else');
  });

  it('exports broadcasts received, code redemptions and Roman adjustments without internal fields', async () => {
    const archive = await build(day1);
    expect(ids(archive.broadcasts_received)).toEqual(['bd1']);
    expect(stub<Row[]>(archive.broadcasts_received)[0]).not.toHaveProperty('lease_holder');
    expect(ids(archive.coach_code_redemptions)).toEqual(['ccr1']);
    expect(stub<Row[]>(archive.coach_code_redemptions)[0]).not.toHaveProperty('response');
    expect(ids(archive.invite_redemptions)).toEqual(['ir1']);
    const [adjustment] = stub<Row[]>(archive.workout_adjustments);
    expect(adjustment).toMatchObject({ id: 'wa1', signals: { sleep_hours: 5.1 } });
    expect(adjustment).not.toHaveProperty('rule_key');
    expect(adjustment).not.toHaveProperty('dismiss_reason');
  });

  it('exports a coach own active Roman playbook, never a superseded one, another coach one or the source ledger', async () => {
    const playbook = (id: string, coach_id: string, version: number, status: string) => ({
      id,
      coach_id,
      version,
      status,
      sections: {
        diet: { protein: [{ text: `method ${id}`, basis: 'stated', evidence_count: 2 }] },
      },
      red_lines: [],
      source_count: 4,
      source_digest: 'd'.repeat(64),
      model_id: 'claude-x',
      built_at: t(version),
    });
    const archive = await build({
      coachPlaybook: [
        playbook('pb-old', U, 1, 'superseded'),
        playbook('pb-live', U, 2, 'active'),
        playbook('pb-other', OTHER, 1, 'active'),
      ],
      coachPlaybookSource: [{ id: 'pbs1', playbook_id: 'pb-live', coach_id: U, client_id: OTHER }],
    });
    const rows = stub<Row[]>(archive.coach_playbook);
    expect(ids(rows)).toEqual(['pb-live']);
    expect(rows[0]).toMatchObject({ version: 2, status: 'active', red_lines: [] });
    expect(rows[0]).not.toHaveProperty('source_digest');
    expect(rows[0]).not.toHaveProperty('coach_id');
    const text = JSON.stringify(archive);
    expect(text).not.toContain('method pb-old');
    expect(text).not.toContain('method pb-other');
    expect(text).not.toContain('pbs1');
  });

  it('exports wearable samples oldest first and connections without tokens', async () => {
    const archive = await build(day1);
    expect(ids(archive.wearable_samples)).toEqual(['ws1', 'ws2']);
    expect(stub<Row[]>(archive.wearable_samples)[1]).not.toHaveProperty('raw_ref');
    expect(ids(archive.wearable_connections)).toEqual(['wc1']);
    expect(JSON.stringify(archive)).not.toContain('enc-secret');
  });

  it('says a push token is registered without exporting the token', async () => {
    const archive = await build(day1);
    expect(archive.user).toMatchObject({ id: U, push_token_registered: true });
    expect(JSON.stringify(archive)).not.toContain('ExponentPushToken');
  });
});
