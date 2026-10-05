import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { broadcastError } from './broadcast-errors';
import { BroadcastScopeService, type CoachScope } from './broadcast-scope.service';
import { CardsService, parseCardSpec, readStoredCard, type ResolvedCard } from './cards.service';
import {
  localDateString,
  nextOccurrence,
  parseRecurrence,
  type RecurrenceRule,
} from './recurrence';
import { parseSegment, type Segment } from './segment';
import { SegmentResolverService } from './segment-resolver.service';
import { isValidTimeZone } from './tz';

export const BODY_MAX = 4000;
const MAX_ACTIVE = 50;
const MAX_LEAD_MS = 366 * 86_400_000;
const EDITABLE = new Set(['draft', 'scheduled', 'paused']);
const ACTIVE = ['scheduled', 'sending', 'paused'];

export interface BroadcastInput {
  body: unknown;
  card?: unknown;
  segment: unknown;
  timezone: unknown;
  send_at?: unknown;
  recurrence?: unknown;
  urgent?: unknown;
  /** 'draft' saves without scheduling; 'scheduled' (default) arms it. */
  status?: unknown;
}

interface ValidBroadcast {
  body: string;
  card: ResolvedCard | null;
  segment: Segment;
  timezone: string;
  sendAt: Date | null;
  recurrence: RecurrenceRule | null;
  urgent: boolean;
  status: 'draft' | 'scheduled';
}

type BroadcastRow = Prisma.CoachBroadcastGetPayload<Record<string, never>>;

@Injectable()
export class BroadcastsService {
  private readonly logger = new Logger(BroadcastsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: BroadcastScopeService,
    private readonly segments: SegmentResolverService,
    private readonly cards: CardsService,
    private readonly audit: AuditService,
  ) {}

  // ---- preview -------------------------------------------------------

  async preview(actorId: string, rawSegment: unknown) {
    const scope = await this.scopes.resolve(actorId);
    const segment = parseSegment(rawSegment);
    const aud = await this.segments.resolve(scope, segment);
    const sample = aud.recipientIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: aud.recipientIds.slice(0, 5) } },
          select: { id: true, name: true },
        })
      : [];
    return {
      recipient_count: aud.recipientIds.length,
      excluded_blocked_count: aud.blockedIds.length,
      roster_size: aud.rosterSize,
      sample: sample.map((u) => ({ id: u.id, name: u.name })),
    };
  }

  async segmentOptions(actorId: string) {
    const scope = await this.scopes.resolve(actorId);
    const owners = [...new Set([scope.tenantId, scope.actorId])];
    const [packages, programs, tags] = await Promise.all([
      this.prisma.coachPackage.findMany({
        where: { coach_id: { in: owners }, archived_at: null },
        select: { id: true, name: true, billing_type: true },
        orderBy: { created_at: 'desc' },
        take: 100,
      }),
      this.prisma.workoutProgram.findMany({
        where: { coach_id: scope.tenantId, is_template: true, archived_at: null },
        select: { id: true, name: true },
        orderBy: { updated_at: 'desc' },
        take: 100,
      }),
      scope.clientIds.length
        ? this.prisma.coachClientTag.groupBy({
            by: ['tag'],
            where: { coach_id: scope.tenantId, client_id: { in: scope.clientIds } },
            _count: { _all: true },
            orderBy: { tag: 'asc' },
          })
        : Promise.resolve([]),
    ]);
    return {
      roster_size: scope.clientIds.length,
      packages,
      programs,
      tags: tags.map((t) => ({ tag: t.tag, client_count: t._count._all })),
      risk_buckets: ['red', 'amber', 'green', 'unknown'],
    };
  }

  async validateCard(actorId: string, rawCard: unknown) {
    const scope = await this.scopes.resolve(actorId);
    return this.cards.resolve(scope, parseCardSpec(rawCard), 'group');
  }

  // ---- create / update -------------------------------------------------

  private async validate(
    scope: CoachScope,
    input: BroadcastInput,
    now: Date,
  ): Promise<ValidBroadcast> {
    if (typeof input.body !== 'string') throw broadcastError('broadcast.body_invalid');
    const body = input.body.trim();
    if (body.length < 1 || body.length > BODY_MAX) throw broadcastError('broadcast.body_invalid');
    if (!isValidTimeZone(input.timezone)) throw broadcastError('broadcast.timezone_invalid');
    const timezone = input.timezone;
    const segment = parseSegment(input.segment);
    const card =
      input.card == null
        ? null
        : await this.cards.resolve(scope, parseCardSpec(input.card), 'group');
    let sendAt: Date | null = null;
    if (input.send_at != null) {
      if (typeof input.send_at !== 'string' || Number.isNaN(Date.parse(input.send_at))) {
        throw broadcastError('broadcast.send_at_invalid');
      }
      sendAt = new Date(input.send_at);
      // One minute of clock-skew grace; anything older is a stale form.
      if (
        sendAt.getTime() < now.getTime() - 60_000 ||
        sendAt.getTime() > now.getTime() + MAX_LEAD_MS
      ) {
        throw broadcastError('broadcast.send_at_invalid');
      }
    }
    const recurrence = input.recurrence == null ? null : parseRecurrence(input.recurrence);
    if (input.urgent !== undefined && typeof input.urgent !== 'boolean')
      throw broadcastError('broadcast.body_invalid', { field: 'urgent' });
    const status = input.status ?? 'scheduled';
    if (status !== 'draft' && status !== 'scheduled')
      throw broadcastError('broadcast.invalid_transition');
    return {
      body,
      card,
      segment,
      timezone,
      sendAt,
      recurrence,
      urgent: input.urgent === true,
      status,
    };
  }

  /** First occurrence for a valid broadcast; pins the recurrence anchor. */
  firstRun(
    v: Pick<ValidBroadcast, 'sendAt' | 'recurrence' | 'timezone'>,
    now: Date,
  ): { at: Date | null; recurrence: RecurrenceRule | null } {
    const start = v.sendAt && v.sendAt.getTime() > now.getTime() ? v.sendAt : now;
    if (!v.recurrence) return { at: start, recurrence: null };
    const anchored: RecurrenceRule = {
      ...v.recurrence,
      anchor_date: localDateString(start, v.timezone),
    };
    const at = nextOccurrence(anchored, v.timezone, new Date(start.getTime() - 1));
    if (!at) throw broadcastError('broadcast.recurrence_invalid', { reason: 'no_occurrence' });
    return { at, recurrence: anchored };
  }

  async create(
    actorId: string,
    input: BroadcastInput,
    idempotencyKey: string | undefined,
    now: Date = new Date(),
  ) {
    const scope = await this.scopes.resolve(actorId);
    const key = idempotencyKey?.trim() ? idempotencyKey.trim().slice(0, 128) : null;
    if (key) {
      const existing = await this.findOwnKey(scope, key);
      if (existing) return this.replay(scope, existing, input);
    }
    const v = await this.validate(scope, input, now);
    if (v.status === 'scheduled') {
      const aud = await this.segments.resolve(scope, v.segment, now);
      if (aud.recipientIds.length === 0) throw broadcastError('broadcast.no_recipients');
      const active = await this.prisma.coachBroadcast.count({
        where: { coach_id: scope.tenantId, status: { in: ACTIVE } },
      });
      if (active >= MAX_ACTIVE) throw broadcastError('broadcast.active_limit');
    }
    const first =
      v.status === 'scheduled' ? this.firstRun(v, now) : { at: null, recurrence: v.recurrence };
    try {
      const row = await this.prisma.coachBroadcast.create({
        data: {
          coach_id: scope.tenantId,
          author_user_id: actorId,
          status: v.status,
          body: v.body,
          card: v.card ? this.cardJson(v.card) : Prisma.DbNull,
          segment: this.segmentJson(v.segment),
          timezone: v.timezone,
          send_at: v.sendAt,
          recurrence: first.recurrence ? this.recurrenceJson(first.recurrence) : Prisma.DbNull,
          next_run_at: first.at,
          urgent: v.urgent,
          idempotency_key: key,
        },
      });
      void this.audit.write({
        action: 'broadcast.created',
        actorId,
        actorRole: 'coach',
        targetType: 'coach_broadcast',
        targetId: row.id,
        tenantCoachId: scope.tenantId,
        metadata: {
          status: row.status,
          recurring: !!first.recurrence,
          urgent: v.urgent,
          card: v.card?.type ?? null,
        },
      });
      return this.present(row);
    } catch (err) {
      if (key && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.findOwnKey(scope, key);
        if (existing) return this.replay(scope, existing, input);
      }
      throw err;
    }
  }

  /**
   * A-659-6: an Idempotency-Key replays only the caller's own broadcast. The
   * persisted namespace is (tenant, author, key), so a sibling sub-coach or
   * the head coach sending the same key and text creates a broadcast of
   * their own and learns nothing about another author's.
   */
  private findOwnKey(scope: CoachScope, key: string) {
    return this.prisma.coachBroadcast.findFirst({
      where: { coach_id: scope.tenantId, author_user_id: scope.actorId, idempotency_key: key },
    });
  }

  private replay(scope: CoachScope, existing: BroadcastRow, input: BroadcastInput) {
    // The same read rule as get/list, on every replay path (A-659-6).
    if (existing.coach_id !== scope.tenantId || existing.author_user_id !== scope.actorId) {
      throw broadcastError('broadcast.idempotency_conflict');
    }
    const sameBody = typeof input.body === 'string' && input.body.trim() === existing.body;
    if (!sameBody) throw broadcastError('broadcast.idempotency_conflict');
    return this.present(existing);
  }

  async update(actorId: string, id: string, input: BroadcastInput, now: Date = new Date()) {
    const scope = await this.scopes.resolve(actorId);
    const row = await this.load(scope, id);
    if (!EDITABLE.has(row.status)) throw broadcastError('broadcast.not_editable');
    const lastRun = await this.lastClaimed(row.id);
    const v = await this.validate(scope, input, now);
    // B-659-1: a claimed occurrence is never sent twice. A one-off that has
    // started sending is immutable (its run carries its own frozen payload);
    // a series may be edited, and the edit applies from the next occurrence.
    if (lastRun && !row.recurrence) throw broadcastError('broadcast.already_sending');
    if (lastRun && !v.recurrence) throw broadcastError('broadcast.series_started');
    if (v.status === 'scheduled') {
      const aud = await this.segments.resolve(scope, v.segment, now);
      if (aud.recipientIds.length === 0) throw broadcastError('broadcast.no_recipients');
    }
    const keepPaused = row.status === 'paused' && v.status === 'scheduled';
    const first: { at: Date | null; recurrence: RecurrenceRule | null } =
      v.status === 'scheduled' ? this.firstRun(v, now) : { at: null, recurrence: v.recurrence };
    if (lastRun && first.at && first.recurrence) {
      first.at = afterClaimed(first.recurrence, v.timezone, first.at, lastRun);
      if (!first.at)
        throw broadcastError('broadcast.recurrence_invalid', { reason: 'no_occurrence' });
    }
    const updated = await this.prisma.coachBroadcast.updateMany({
      where: {
        id: row.id,
        coach_id: scope.tenantId,
        status: row.status,
        updated_at: row.updated_at,
      },
      data: {
        status: keepPaused ? 'paused' : v.status,
        body: v.body,
        card: v.card ? this.cardJson(v.card) : Prisma.DbNull,
        segment: this.segmentJson(v.segment),
        timezone: v.timezone,
        send_at: v.sendAt,
        recurrence: first.recurrence ? this.recurrenceJson(first.recurrence) : Prisma.DbNull,
        next_run_at: first.at,
        urgent: v.urgent,
        failure_code: null,
      },
    });
    if (updated.count !== 1) throw broadcastError('broadcast.not_editable');
    void this.audit.write({
      action: 'broadcast.updated',
      actorId,
      actorRole: 'coach',
      targetType: 'coach_broadcast',
      targetId: row.id,
      tenantCoachId: scope.tenantId,
    });
    return this.get(actorId, row.id);
  }

  async transition(
    actorId: string,
    id: string,
    action: 'pause' | 'resume' | 'cancel',
    now: Date = new Date(),
  ) {
    const scope = await this.scopes.resolve(actorId);
    const row = await this.load(scope, id);
    const from: Record<typeof action, string[]> = {
      pause: ['scheduled', 'sending'],
      resume: ['paused'],
      cancel: ['draft', 'scheduled', 'sending', 'paused'],
    };
    if (!from[action].includes(row.status))
      throw broadcastError('broadcast.invalid_transition', { status: row.status });
    let data: Prisma.CoachBroadcastUpdateManyMutationInput;
    if (action === 'pause') data = { status: 'paused' };
    else if (action === 'cancel')
      data = { status: 'canceled', canceled_at: now, next_run_at: null };
    else {
      // Resume: a recurring broadcast skips the occurrences missed while
      // paused and continues from the next one; a one-off that never started
      // sends now. B-659-1: a one-off that has started is never re-armed, and
      // a series never sends twice on a local day it already sent on.
      const rule = row.recurrence ? parseStoredRecurrence(row.recurrence) : null;
      const lastRun = await this.lastClaimed(row.id);
      const ruleNext = rule ? nextOccurrence(rule, row.timezone, now) : null;
      const next = rule
        ? ruleNext && lastRun
          ? afterClaimed(rule, row.timezone, ruleNext, lastRun)
          : ruleNext
        : row.next_run_at && !lastRun
          ? row.next_run_at < now
            ? now
            : row.next_run_at
          : null;
      const inFlight = await this.prisma.coachBroadcastRun.count({
        where: { broadcast_id: row.id, status: { in: ['pending', 'delivering'] } },
      });
      data = { status: next ? 'scheduled' : inFlight > 0 ? 'sending' : 'sent', next_run_at: next };
    }
    const res = await this.prisma.coachBroadcast.updateMany({
      where: { id: row.id, coach_id: scope.tenantId, status: { in: from[action] } },
      data,
    });
    if (res.count !== 1) throw broadcastError('broadcast.invalid_transition');
    void this.audit.write({
      action: `broadcast.${action}`,
      actorId,
      actorRole: 'coach',
      targetType: 'coach_broadcast',
      targetId: row.id,
      tenantCoachId: scope.tenantId,
    });
    return this.get(actorId, row.id);
  }

  // ---- reads ---------------------------------------------------------------

  async list(actorId: string, opts: { status?: string; cursor?: string; limit?: number }) {
    const scope = await this.scopes.resolve(actorId);
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
    const cursor =
      opts.cursor && !Number.isNaN(Date.parse(opts.cursor)) ? new Date(opts.cursor) : null;
    const rows = await this.prisma.coachBroadcast.findMany({
      where: {
        coach_id: scope.tenantId,
        ...this.authorFilter(scope),
        ...(opts.status ? { status: opts.status } : {}),
        ...(cursor ? { created_at: { lt: cursor } } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const stats = await this.statsFor(page.map((r) => r.id));
    return {
      items: page.map((r) => ({ ...this.present(r), stats: stats.get(r.id) ?? emptyStats() })),
      next_cursor: rows.length > limit ? page[page.length - 1].created_at.toISOString() : null,
    };
  }

  async get(actorId: string, id: string) {
    const scope = await this.scopes.resolve(actorId);
    const row = await this.load(scope, id);
    const stats = await this.statsFor([row.id]);
    const runs = await this.prisma.coachBroadcastRun.findMany({
      where: { broadcast_id: row.id },
      orderBy: { scheduled_for: 'desc' },
      take: 20,
      select: {
        id: true,
        scheduled_for: true,
        status: true,
        recipient_count: true,
        failure_code: true,
        completed_at: true,
      },
    });
    const runStats = await this.runStatsFor(runs.map((r) => r.id));
    return {
      ...this.present(row),
      stats: stats.get(row.id) ?? emptyStats(),
      runs: runs.map((r) => ({ ...r, stats: runStats.get(r.id) ?? emptyStats() })),
    };
  }

  /** Latest claimed occurrence of a broadcast (B-659-1), or null if none. */
  private async lastClaimed(broadcastId: string): Promise<Date | null> {
    const run = await this.prisma.coachBroadcastRun.findFirst({
      where: { broadcast_id: broadcastId },
      orderBy: { scheduled_for: 'desc' },
      select: { scheduled_for: true },
    });
    return run?.scheduled_for ?? null;
  }

  /** Sub-coaches see only broadcasts they wrote; the head coach sees all. */
  private authorFilter(scope: CoachScope): Prisma.CoachBroadcastWhereInput {
    return scope.actorId === scope.tenantId ? {} : { author_user_id: scope.actorId };
  }

  private async load(scope: CoachScope, id: string): Promise<BroadcastRow> {
    if (typeof id !== 'string' || id.length > 64) throw broadcastError('broadcast.not_found');
    const row = await this.prisma.coachBroadcast.findFirst({
      where: { id, coach_id: scope.tenantId, ...this.authorFilter(scope) },
    });
    if (!row) throw broadcastError('broadcast.not_found');
    return row;
  }

  private async statsFor(ids: string[]) {
    const out = new Map<string, DeliveryStats>();
    if (ids.length === 0) return out;
    const groups = await this.prisma.coachBroadcastDelivery.groupBy({
      by: ['broadcast_id', 'status'],
      where: { broadcast_id: { in: ids } },
      _count: { _all: true },
    });
    for (const g of groups) addStatus(out, g.broadcast_id, g.status, g._count._all);
    const reads = await this.prisma.coachBroadcastDelivery.groupBy({
      by: ['broadcast_id'],
      where: {
        broadcast_id: { in: ids },
        status: 'delivered',
        message: { read_at: { not: null } },
      },
      _count: { _all: true },
    });
    for (const r of reads) ensure(out, r.broadcast_id).read = r._count._all;
    return out;
  }

  private async runStatsFor(ids: string[]) {
    const out = new Map<string, DeliveryStats>();
    if (ids.length === 0) return out;
    const groups = await this.prisma.coachBroadcastDelivery.groupBy({
      by: ['run_id', 'status'],
      where: { run_id: { in: ids } },
      _count: { _all: true },
    });
    for (const g of groups) addStatus(out, g.run_id, g.status, g._count._all);
    const reads = await this.prisma.coachBroadcastDelivery.groupBy({
      by: ['run_id'],
      where: { run_id: { in: ids }, status: 'delivered', message: { read_at: { not: null } } },
      _count: { _all: true },
    });
    for (const r of reads) ensure(out, r.run_id).read = r._count._all;
    return out;
  }

  present(row: BroadcastRow) {
    return {
      id: row.id,
      status: row.status,
      body: row.body,
      card: readStoredCard(row.card),
      segment: row.segment,
      timezone: row.timezone,
      send_at: row.send_at,
      recurrence: row.recurrence,
      next_run_at: row.next_run_at,
      urgent: row.urgent,
      occurrences_sent: row.occurrences_sent,
      last_run_at: row.last_run_at,
      failure_code: row.failure_code,
      author_user_id: row.author_user_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private cardJson(c: ResolvedCard): Prisma.InputJsonValue {
    return { type: c.type, ref_id: c.ref_id, snapshot: c.snapshot };
  }

  private segmentJson(s: Segment): Prisma.InputJsonValue {
    return {
      match: s.match,
      rules: s.rules.map((r) => ({ ...r })),
      ...(s.exclude_client_ids ? { exclude_client_ids: s.exclude_client_ids } : {}),
    };
  }

  private recurrenceJson(r: RecurrenceRule): Prisma.InputJsonValue {
    const out: Record<string, string | number | number[]> = {
      freq: r.freq,
      interval: r.interval,
      local_time: r.local_time,
    };
    if (r.by_weekday) out.by_weekday = r.by_weekday;
    if (r.by_month_day) out.by_month_day = r.by_month_day;
    if (r.until) out.until = r.until;
    if (r.count) out.count = r.count;
    if (r.anchor_date) out.anchor_date = r.anchor_date;
    return out;
  }
}

/**
 * B-659-1: the first occurrence at or after `candidate` that is later than
 * the last claimed occurrence and not on the same local day as it, so an
 * edit or a resume never re-sends into a day that already had a copy. Null
 * when the series has no such occurrence left.
 */
export function afterClaimed(
  rule: RecurrenceRule,
  timeZone: string,
  candidate: Date,
  lastClaimed: Date,
): Date | null {
  const claimedDay = localDateString(lastClaimed, timeZone);
  let at: Date | null = candidate;
  for (let i = 0; at && i < 8; i++) {
    if (at > lastClaimed && localDateString(at, timeZone) !== claimedDay) return at;
    at = nextOccurrence(rule, timeZone, at);
  }
  return null;
}

/** Stored rows were validated on write; re-validate on read and keep the anchor. */
export function parseStoredRecurrence(v: Prisma.JsonValue): RecurrenceRule | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const { anchor_date, ...rest } = v;
  try {
    const rule = parseRecurrence(rest);
    return typeof anchor_date === 'string' ? { ...rule, anchor_date } : rule;
  } catch {
    return null;
  }
}

export interface DeliveryStats {
  total: number;
  delivered: number;
  pending: number;
  deferred: number;
  skipped_blocked: number;
  skipped_ineligible: number;
  failed: number;
  read: number;
}

function emptyStats(): DeliveryStats {
  return {
    total: 0,
    delivered: 0,
    pending: 0,
    deferred: 0,
    skipped_blocked: 0,
    skipped_ineligible: 0,
    failed: 0,
    read: 0,
  };
}

function ensure(m: Map<string, DeliveryStats>, id: string): DeliveryStats {
  let s = m.get(id);
  if (!s) {
    s = emptyStats();
    m.set(id, s);
  }
  return s;
}

function addStatus(m: Map<string, DeliveryStats>, id: string, status: string, n: number) {
  const s = ensure(m, id);
  s.total += n;
  if (
    status === 'delivered' ||
    status === 'pending' ||
    status === 'deferred' ||
    status === 'skipped_blocked' ||
    status === 'skipped_ineligible' ||
    status === 'failed'
  ) {
    s[status] += n;
  }
}
