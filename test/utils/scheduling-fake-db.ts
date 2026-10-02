/**
 * S-SCHED-2 in-memory Prisma double for the scheduling surface.
 *
 * Models just enough of Postgres to exercise the booking integrity rules in
 * unit tests:
 *   - where-filters used by the scheduling services (equality, in, not,
 *     lt/lte/gt/gte, null, `session_type: { is: {...} }`),
 *   - `$transaction(fn)` handing `fn` a transaction view whose
 *     `$executeRaw\`SELECT pg_advisory_xact_lock(...)\`` really serialises
 *     callers on the same key until the transaction callback settles
 *     (`enforceLock`),
 *   - the CoachingSession_no_overlapping_active_booking exclusion constraint
 *     on create/update/updateMany (`enforceExclusion`), raised with the
 *     constraint name in the message like Postgres does.
 * Every delegate method is async, so concurrent service calls interleave at
 * each await exactly as they would against a real pool; the control test
 * turns both guards off to prove the harness can reproduce a double booking.
 */
import { PrismaService } from '../../src/prisma.service';

type Row = Record<string, unknown>;

const OCCUPYING = new Set(['requested', 'scheduled', 'pending_provider']);

export interface FakeUserInput {
  id: string;
  name: string;
  role: 'student' | 'coach' | 'owner';
  coach_id?: string | null;
  timezone?: string | null;
}

function toMs(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return new Date(v).getTime();
  return Number.NaN;
}

// Ordering for range operators: dates by instant, plain strings (ids) by
// code unit, the same total order the fake's ORDER BY uses.
function compare(a: unknown, b: unknown): number {
  if (typeof a === 'string' && typeof b === 'string') {
    const da = Date.parse(a);
    const db = Date.parse(b);
    if (Number.isNaN(da) || Number.isNaN(db)) return a < b ? -1 : a > b ? 1 : 0;
  }
  return toMs(a) - toMs(b);
}

function matchValue(value: unknown, cond: unknown): boolean {
  if (cond === undefined) return true;
  if (cond === null) return value === null || value === undefined;
  if (cond instanceof Date) return toMs(value) === cond.getTime();
  if (typeof cond === 'object' && !Array.isArray(cond)) {
    for (const [op, arg] of Object.entries(cond as Row)) {
      switch (op) {
        case 'equals':
          if (!matchValue(value, arg)) return false;
          break;
        case 'in':
          if (!Array.isArray(arg) || !arg.includes(value)) return false;
          break;
        case 'not':
          if (matchValue(value, arg)) return false;
          break;
        case 'lt':
          if (!(compare(value, arg) < 0)) return false;
          break;
        case 'lte':
          if (!(compare(value, arg) <= 0)) return false;
          break;
        case 'gt':
          if (!(compare(value, arg) > 0)) return false;
          break;
        case 'gte':
          if (!(compare(value, arg) >= 0)) return false;
          break;
        default:
          throw new TypeError(`scheduling-fake-db: unsupported operator ${op}`);
      }
    }
    return true;
  }
  return value === cond;
}

export class SchedulingFakeDb {
  users: Row[] = [];
  sessionTypes: Row[] = [];
  availability: Row[] = [];
  overrides: Row[] = [];
  sessions: Row[] = [];
  subAssignments: Row[] = [];
  teamAssignments: Row[] = [];
  deliveryLogs: Row[] = [];

  enforceLock = true;
  enforceExclusion = true;
  lockKeys: string[] = [];

  private seq = 0;
  private readonly locks = new Map<string, Promise<void>>();

  // ── seed helpers ─────────────────────────────────────────────────

  addUser(u: FakeUserInput): void {
    this.users.push({
      id: u.id,
      name: u.name,
      role: u.role,
      coach_id: u.coach_id ?? null,
      coach_profile: u.role === 'coach' ? { timezone: u.timezone ?? 'America/Los_Angeles' } : null,
      profile: { avatar_url: null },
    });
  }

  addSessionType(t: {
    id: string;
    coach_id: string;
    name: string;
    duration_minutes: number;
    auto_approve?: boolean;
    is_welcome?: boolean;
    default_meeting_url?: string | null;
    archived_at?: Date | null;
  }): void {
    this.sessionTypes.push({
      description: null,
      default_video_provider: 'stub',
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, this.sessionTypes.length)),
      updated_at: new Date(),
      auto_approve: false,
      is_welcome: false,
      default_meeting_url: null,
      archived_at: null,
      ...t,
    });
  }

  addWindow(
    coachId: string,
    day: number,
    startMinute: number,
    endMinute: number,
    typeId: string | null = null,
  ): void {
    this.availability.push({
      id: `av-${++this.seq}`,
      coach_id: coachId,
      day_of_week: day,
      start_minute: startMinute,
      end_minute: endMinute,
      session_type_id: typeId,
    });
  }

  addOverride(o: {
    coach_id: string;
    date: string;
    kind: 'holiday' | 'block' | 'extra';
    start_minute: number | null;
    end_minute: number | null;
  }): void {
    this.overrides.push({
      id: `ov-${++this.seq}`,
      note: null,
      ...o,
      date: new Date(`${o.date}T00:00:00.000Z`),
    });
  }

  addSession(
    s: Row & { id: string; coach_id: string; start_at: Date; end_at: Date; status: string },
  ): Row {
    const row = this.sessionDefaults(s);
    this.sessions.push(row);
    return row;
  }

  // ── matching ─────────────────────────────────────────────────────

  private matches(row: Row, where: Row | undefined, table: 'session' | 'other'): boolean {
    if (!where) return true;
    for (const [key, cond] of Object.entries(where)) {
      if (key === 'OR') {
        if (!(cond as Row[]).some((w) => this.matches(row, w, table))) return false;
        continue;
      }
      if (key === 'AND') {
        if (!(cond as Row[]).every((w) => this.matches(row, w, table))) return false;
        continue;
      }
      if (table === 'session' && key === 'session_type') {
        const is = (cond as { is?: Row }).is;
        const type = this.sessionTypes.find((t) => t.id === row.session_type_id);
        if (!type || !this.matches(type, is, 'other')) return false;
        continue;
      }
      if (!matchValue(row[key], cond)) return false;
    }
    return true;
  }

  private withSessionRelations(row: Row): Row {
    const type = this.sessionTypes.find((t) => t.id === row.session_type_id) ?? null;
    const coach = this.users.find((u) => u.id === row.coach_id) ?? null;
    const client = this.users.find((u) => u.id === row.client_id) ?? null;
    return {
      ...row,
      session_type: type,
      coach: coach ? { id: coach.id, name: coach.name } : null,
      client: client ? { id: client.id, name: client.name } : null,
    };
  }

  private sessionDefaults(data: Row): Row {
    return {
      id: `sess-${++this.seq}`,
      client_id: null,
      session_type_id: null,
      status: 'requested',
      title: 'Session',
      coach_notes_md: null,
      client_recap_md: null,
      video_provider: 'stub',
      video_url: null,
      video_meeting_id: null,
      calendar_provider: 'stub',
      calendar_event_id: null,
      provider_idempotency_key: null,
      approved_at: null,
      ended_at: null,
      end_reason: null,
      created_at: new Date(),
      updated_at: new Date(),
      ...data,
    };
  }

  // Postgres EXCLUDE USING gist (coach_id WITH =, tsrange(start_at, end_at, '[)') WITH &&)
  // WHERE status IN ('requested','scheduled','pending_provider').
  private assertExclusion(candidate: Row): void {
    if (!this.enforceExclusion || !OCCUPYING.has(String(candidate.status))) return;
    const clash = this.sessions.find(
      (s) =>
        s.id !== candidate.id &&
        s.coach_id === candidate.coach_id &&
        OCCUPYING.has(String(s.status)) &&
        toMs(s.start_at) < toMs(candidate.end_at) &&
        toMs(candidate.start_at) < toMs(s.end_at),
    );
    if (clash) {
      throw Object.assign(
        new TypeError(
          'conflicting key value violates exclusion constraint "CoachingSession_no_overlapping_active_booking"',
        ),
        { code: 'P2010', meta: { code: '23P01' } },
      );
    }
  }

  private async tick(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  // ── delegates ────────────────────────────────────────────────────

  user = {
    findUnique: async (args: { where: { id: string } }) => {
      await this.tick();
      return this.users.find((u) => u.id === args.where.id) ?? null;
    },
    findMany: async (args: { where?: Row }) => {
      await this.tick();
      return this.users.filter((u) => this.matches(u, args.where, 'other'));
    },
  };

  subCoachAssignment = {
    findFirst: async (args: { where?: Row }) => {
      await this.tick();
      return this.subAssignments.find((r) => this.matches(r, args.where, 'other')) ?? null;
    },
  };

  teamSubCoachAssignment = {
    findFirst: async (args: { where?: Row }) => {
      await this.tick();
      return this.teamAssignments.find((r) => this.matches(r, args.where, 'other')) ?? null;
    },
  };

  sessionType = {
    findUnique: async (args: { where: { id: string } }) => {
      await this.tick();
      const row = this.sessionTypes.find((t) => t.id === args.where.id);
      return row ? { ...row } : null;
    },
    findMany: async (args: { where?: Row }) => {
      await this.tick();
      return this.sessionTypes
        .filter((t) => this.matches(t, args.where, 'other'))
        .map((t) => ({ ...t }));
    },
    findFirst: async (args: { where?: Row }) => {
      await this.tick();
      const row = this.sessionTypes.find((t) => this.matches(t, args.where, 'other'));
      return row ? { ...row } : null;
    },
    create: async (args: { data: Row }) => {
      await this.tick();
      const row: Row = {
        id: `st-${++this.seq}`,
        description: null,
        archived_at: null,
        is_welcome: false,
        default_meeting_url: null,
        created_at: new Date(),
        updated_at: new Date(),
        ...args.data,
      };
      this.assertOneWelcome(row);
      this.sessionTypes.push(row);
      return { ...row };
    },
    update: async (args: { where: { id: string }; data: Row }) => {
      await this.tick();
      const i = this.sessionTypes.findIndex((t) => t.id === args.where.id);
      const next = { ...this.sessionTypes[i], ...args.data, updated_at: new Date() };
      this.assertOneWelcome(next);
      this.sessionTypes[i] = next;
      return { ...next };
    },
    updateMany: async (args: { where?: Row; data: Row }) => {
      await this.tick();
      let count = 0;
      this.sessionTypes.forEach((t, i) => {
        if (this.matches(t, args.where, 'other')) {
          this.sessionTypes[i] = { ...t, ...args.data };
          count += 1;
        }
      });
      return { count };
    },
  };

  // Partial unique index SessionType_one_active_welcome_per_coach.
  private assertOneWelcome(row: Row): void {
    if (row.is_welcome !== true || row.archived_at) return;
    const other = this.sessionTypes.find(
      (t) =>
        t.id !== row.id && t.coach_id === row.coach_id && t.is_welcome === true && !t.archived_at,
    );
    if (other) throw Object.assign(new TypeError('Unique constraint failed'), { code: 'P2002' });
  }

  coachAvailability = {
    findMany: async (args: { where?: Row }) => {
      await this.tick();
      return this.availability.filter((a) => this.matches(a, args.where, 'other'));
    },
    deleteMany: async (args: { where?: Row }) => {
      await this.tick();
      const before = this.availability.length;
      this.availability = this.availability.filter((a) => !this.matches(a, args.where, 'other'));
      return { count: before - this.availability.length };
    },
    createMany: async (args: { data: Row[] }) => {
      await this.tick();
      for (const d of args.data) this.availability.push({ id: `av-${++this.seq}`, ...d });
      return { count: args.data.length };
    },
  };

  coachAvailabilityOverride = {
    findMany: async (args: { where?: Row }) => {
      await this.tick();
      return this.overrides.filter((o) => this.matches(o, args.where, 'other'));
    },
  };

  coachingSession = {
    findUnique: async (args: { where: { id: string }; include?: Row }) => {
      await this.tick();
      const row = this.sessions.find((s) => s.id === args.where.id);
      if (!row) return null;
      return args.include ? this.withSessionRelations(row) : { ...row };
    },
    findUniqueOrThrow: async (args: { where: { id: string } }) => {
      await this.tick();
      const row = this.sessions.find((s) => s.id === args.where.id);
      if (!row) throw Object.assign(new TypeError('No record'), { code: 'P2025' });
      return { ...row };
    },
    findFirst: async (args: { where?: Row }) => {
      await this.tick();
      const row = this.sessions.find((s) => this.matches(s, args.where, 'session'));
      return row ? { ...row } : null;
    },
    findMany: async (args: {
      where?: Row;
      include?: Row;
      orderBy?: Row | Row[];
      take?: number;
    }) => {
      await this.tick();
      let rows = this.sessions.filter((s) => this.matches(s, args.where, 'session'));
      // Lexicographic multi-key ORDER BY, e.g. [{ start_at: 'desc' }, { id: 'desc' }].
      const keys = (Array.isArray(args.orderBy) ? args.orderBy : args.orderBy ? [args.orderBy] : [])
        .flatMap((o) => Object.entries(o))
        .map(([k, d]) => ({ k, dir: d === 'desc' ? -1 : 1 }));
      if (keys.length === 0) keys.push({ k: 'start_at', dir: 1 });
      rows = rows.slice().sort((a, b) => {
        for (const { k, dir } of keys) {
          const c = compare(a[k], b[k]);
          if (c !== 0) return dir * c;
        }
        return 0;
      });
      if (typeof args.take === 'number') rows = rows.slice(0, args.take);
      return rows.map((r) => (args.include ? this.withSessionRelations(r) : { ...r }));
    },
    count: async (args: { where?: Row }) => {
      await this.tick();
      return this.sessions.filter((s) => this.matches(s, args.where, 'session')).length;
    },
    create: async (args: { data: Row }) => {
      await this.tick();
      const row = this.sessionDefaults(args.data);
      this.assertExclusion(row);
      this.sessions.push(row);
      return { ...row };
    },
    update: async (args: { where: { id: string }; data: Row }) => {
      await this.tick();
      const i = this.sessions.findIndex((s) => s.id === args.where.id);
      if (i < 0) throw Object.assign(new TypeError('No record'), { code: 'P2025' });
      const next = { ...this.sessions[i], ...args.data, updated_at: new Date() };
      this.assertExclusion(next);
      this.sessions[i] = next;
      return { ...next };
    },
    updateMany: async (args: { where?: Row; data: Row }) => {
      await this.tick();
      let count = 0;
      for (let i = 0; i < this.sessions.length; i++) {
        if (!this.matches(this.sessions[i], args.where, 'session')) continue;
        const next = { ...this.sessions[i], ...args.data, updated_at: new Date() };
        this.assertExclusion(next);
        this.sessions[i] = next;
        count += 1;
      }
      return { count };
    },
  };

  notificationDeliveryLog = {
    create: async (args: { data: Row }) => {
      await this.tick();
      const dup = this.deliveryLogs.find(
        (l) =>
          l.session_id === args.data.session_id &&
          l.user_id === args.data.user_id &&
          l.kind === args.data.kind,
      );
      if (dup) throw Object.assign(new TypeError('Unique constraint failed'), { code: 'P2002' });
      // Column defaults of migration 20270222000000.
      const row = {
        id: `log-${++this.seq}`,
        status: 'sent',
        attempts: 1,
        lease_until: null,
        claim_token: null,
        session_start_at: null,
        inapp_done_at: null,
        push_done_at: null,
        notification_id: null,
        last_error: null,
        created_at: new Date(),
        ...args.data,
      };
      this.deliveryLogs.push(row);
      return { ...row };
    },
    findFirst: async (args: { where?: Row }) => {
      await this.tick();
      const row = this.deliveryLogs.find((l) => this.matches(l, args.where, 'other'));
      return row ? { ...row } : null;
    },
    updateMany: async (args: { where?: Row; data: Row }) => {
      await this.tick();
      let count = 0;
      this.deliveryLogs.forEach((l, i) => {
        if (!this.matches(l, args.where, 'other')) return;
        this.deliveryLogs[i] = { ...l, ...args.data };
        count += 1;
      });
      return { count };
    },
    deleteMany: async (args: { where?: Row }) => {
      await this.tick();
      const before = this.deliveryLogs.length;
      this.deliveryLogs = this.deliveryLogs.filter((l) => !this.matches(l, args.where, 'other'));
      return { count: before - this.deliveryLogs.length };
    },
  };

  // Outside a transaction a bare $executeRaw is a no-op.
  $executeRaw: (strings?: TemplateStringsArray, ...values: unknown[]) => Promise<number> =
    async () => 0;

  $transaction = async <T>(fn: (tx: SchedulingFakeDb) => Promise<T>): Promise<T> => {
    const held: Array<() => void> = [];
    const tx: SchedulingFakeDb = Object.create(this);
    tx.$executeRaw = async (
      strings?: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<number> => {
      const sql = strings ? strings.join('?') : '';
      if (!this.enforceLock || !sql.includes('pg_advisory_xact_lock')) return 0;
      const key = values.map(String).join(':');
      this.lockKeys.push(key);
      const prev = this.locks.get(key) ?? Promise.resolve();
      let release: () => void = () => undefined;
      const mine = new Promise<void>((resolve) => {
        release = resolve;
      });
      this.locks.set(
        key,
        prev.then(() => mine),
      );
      await prev;
      held.push(release);
      return 1;
    };
    try {
      return await fn(tx);
    } finally {
      for (const r of held) r();
    }
  };
}

/** Typed PrismaService view of the fake (repo pattern, no cast tokens). */
export function asPrisma(db: SchedulingFakeDb): PrismaService {
  return Object.assign(Object.create(PrismaService.prototype) as PrismaService, db);
}
