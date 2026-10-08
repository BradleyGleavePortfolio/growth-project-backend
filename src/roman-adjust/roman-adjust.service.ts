/**
 * Roman approve-to-adjust service.
 *
 *   scan     deterministic rule over the coach's consented clients (wearable
 *            trend + training load) -> at most one pending proposal per
 *            client's next workout
 *   approve  apply the proposed set counts to that ONE assignment's snapshot
 *   edit     apply the coach's own set counts instead
 *   dismiss  close it; the same rule never re-raises it for that workout
 *   undo     restore the previous set counts inside the undo window
 *
 * Every state change writes an append-only WorkoutAdjustmentEvent row in the
 * same transaction. Box-2 AI consent (D2) is read through AiEgressService
 * (R2b) before a proposal is created, on every list and again before one is
 * applied. A proposal is visible and actionable only while its client is
 * still the caller's live client. Writes go through
 * WorkoutBuilderService, which owns assignment snapshots and refuses a write
 * once the client has started the workout or anyone edited it since.
 */
import { HttpException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AiEgressService } from '../ai-egress/ai-egress.service';
import { ConsentScope, ConsentService } from '../consent/consent.service';
import { coachSharingCheck } from '../consent/coach-sharing-gate';
import {
  WorkoutBuilderService,
  type AssignmentExerciseRow,
} from '../workout-builder/workout-builder.service';
import {
  ADJUST_ERRORS,
  ADJUST_LOOKAHEAD_DAYS,
  ADJUST_SCAN_MAX_CLIENTS,
  ADJUST_SCAN_MIN_INTERVAL_MS,
  ADJUST_UNDO_WINDOW_MS,
  type AdjustDismissReason,
  type AdjustErrorKey,
} from './roman-adjust.constants';
import {
  ADJUST_RULE_KEY,
  ADJUST_RULE_VERSION,
  cutVolume,
  decideVolumeCut,
  evaluateSignals,
  localDate,
  romanProposalText,
  setsChange,
  whenWord,
  type AdjustChange,
  type AdjustSignal,
} from './roman-adjust.rules';

const DEFAULT_TZ = 'America/Los_Angeles';
const RULE_METRICS = [
  'HRV_MS',
  'RESTING_HEART_RATE_BPM',
  'SLEEP_TOTAL_MIN',
  'SLEEP_DURATION_MIN',
  'READINESS_SCORE',
  'RECOVERY_SCORE',
] as const;

export function adjustError(key: AdjustErrorKey): HttpException {
  const e = ADJUST_ERRORS[key];
  return new HttpException({ statusCode: e.status, code: e.code, message: e.message }, e.status);
}

class ApplyRefused extends Error {
  constructor(readonly reason: 'not_found' | 'started' | 'changed' | 'invalid') {
    super(`apply refused: ${reason}`);
  }
}

export interface AdjustProposalView {
  id: string;
  status: string;
  severity: string;
  roman_text: string;
  client: { id: string; first_name: string };
  workout: { assignment_id: string; plan_name: string; scheduled_for: string };
  signals: AdjustSignal[];
  proposed_change: AdjustChange;
  applied_change: AdjustChange | null;
  /** Display names by exercise_external_id (catalog id or slug); missing ids are absent. */
  exercise_names: Record<string, string>;
  created_at: string;
  decided_at: string | null;
  undo_until: string | null;
}

type ProposalRow = Prisma.WorkoutAdjustmentProposalGetPayload<{
  include: { assignment: { select: { scheduled_for: true; snapshot: { select: { plan_name: true } } } } };
}>;

function firstName(name: string | null | undefined): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? '';
}

function toJson(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
}

function asChange(v: Prisma.JsonValue | null): AdjustChange | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.exercises)) return null;
  return {
    volume_pct: Number(o.volume_pct ?? 0),
    sets_before: Number(o.sets_before ?? 0),
    sets_after: Number(o.sets_after ?? 0),
    exercises: (o.exercises as Array<Record<string, unknown>>).map((x) => ({
      order: Number(x.order),
      exercise_external_id: String(x.exercise_external_id),
      sets_before: Number(x.sets_before),
      sets_after: Number(x.sets_after),
    })),
  };
}

function asSignals(v: Prisma.JsonValue): AdjustSignal[] {
  return Array.isArray(v) ? (v as unknown[]).filter((x): x is AdjustSignal => !!x && typeof x === 'object' && 'key' in x) : [];
}

function asRows(v: Prisma.JsonValue | null): AssignmentExerciseRow[] {
  return Array.isArray(v)
    ? (v as unknown[]).filter((x): x is AssignmentExerciseRow => !!x && typeof x === 'object' && 'order' in x && 'sets' in x)
    : [];
}

@Injectable()
export class RomanAdjustService {
  private readonly logger = new Logger(RomanAdjustService.name);
  private readonly lastScan = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly workoutBuilder: WorkoutBuilderService,
    private readonly egress: AiEgressService,
    // COACH-AI-GATE-130 — Coach sharing switches; no @Optional() (see coach-sharing-gate.ts).
    private readonly consent?: ConsentService,
  ) {}

  // ─── list + scan ──────────────────────────────────────────────────────────

  /** Pending proposals plus applied ones still inside their undo window. */
  async listForCoach(coachId: string, now: Date = new Date()): Promise<{ proposals: AdjustProposalView[] }> {
    try {
      await this.refreshForCoach(coachId, now);
      await this.expireStale(coachId, now);
      const rows = await this.prisma.workoutAdjustmentProposal.findMany({
        where: {
          coach_id: coachId,
          OR: [
            { status: 'pending' },
            { status: { in: ['approved', 'edited'] }, undo_until: { gt: now } },
          ],
        },
        include: { assignment: { select: { scheduled_for: true, snapshot: { select: { plan_name: true } } } } },
        orderBy: { created_at: 'desc' },
        take: 50,
      });
      // Only the caller's current, live clients: a client moved to another
      // coach or deleted since the scan drops out, health signals included.
      const clientIds = [...new Set(rows.map((r) => r.client_id))];
      const current = clientIds.length
        ? await this.prisma.user.findMany({
            where: { id: { in: clientIds }, coach_id: coachId, deleted_at: null },
            select: { id: true, name: true },
          })
        : [];
      const nameOf = new Map(current.map((n) => [n.id, firstName(n.name)]));
      // Box 2 on read too: a client who withdrew since the scan drops out.
      const consented = await this.egress.consentedClients([...nameOf.keys()]);
      const visibleTo = (clientId: string) => nameOf.has(clientId) && consented.has(clientId);
      for (const r of rows) {
        if (r.status !== 'pending' || visibleTo(r.client_id)) continue;
        await this.closeAs(r.id, 'withdrawn', null, { reason: nameOf.has(r.client_id) ? 'consent_withdrawn' : 'client_not_current' });
      }
      const visible = rows.filter((r) => visibleTo(r.client_id));
      const exNames = await this.exerciseNames(visible);
      return { proposals: visible.map((r) => this.view(r, nameOf.get(r.client_id) ?? '', exNames)) };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(`adjust list failed: ${err instanceof Error ? err.name : 'unknown'}`);
      throw adjustError('UNAVAILABLE');
    }
  }

  /**
   * Run the deterministic rule for the coach's clients. Throttled per coach;
   * idempotent through the (assignment_id, rule_key) unique index.
   */
  async refreshForCoach(coachId: string, now: Date = new Date(), force = false): Promise<number> {
    const last = this.lastScan.get(coachId) ?? 0;
    if (!force && now.getTime() - last < ADJUST_SCAN_MIN_INTERVAL_MS) return 0;
    this.lastScan.set(coachId, now.getTime());

    const clients = await this.prisma.user.findMany({
      where: { coach_id: coachId, role: 'student', deleted_at: null },
      select: { id: true, name: true, notification_prefs: { select: { timezone: true } } },
      take: ADJUST_SCAN_MAX_CLIENTS,
    });
    if (clients.length === 0) return 0;
    const consented = await this.egress.consentedClients(clients.map((c) => c.id));
    const eligible = clients.filter((c) => consented.has(c.id));
    if (eligible.length === 0) return 0;
    const ids = eligible.map((c) => c.id);

    const horizon = new Date(now.getTime() + ADJUST_LOOKAHEAD_DAYS * 86_400_000);
    const upcoming = await this.prisma.clientWorkoutAssignment.findMany({
      where: {
        client_id: { in: ids },
        scheduled_for: { gte: new Date(now.getTime() - 86_400_000), lte: horizon },
        started_at: null,
        completed_at: null,
      },
      orderBy: { scheduled_for: 'asc' },
      select: { id: true, client_id: true, scheduled_for: true },
    });
    const nextByClient = new Map<string, { id: string; scheduled_for: Date }>();
    for (const a of upcoming) {
      const tz = eligible.find((c) => c.id === a.client_id)?.notification_prefs?.timezone ?? DEFAULT_TZ;
      // Today or later on the client's own calendar.
      if (localDate(a.scheduled_for, tz) < localDate(now, tz)) continue;
      if (!nextByClient.has(a.client_id)) nextByClient.set(a.client_id, a);
    }
    if (nextByClient.size === 0) return 0;
    const candidates = [...nextByClient.keys()];
    // COACH-AI-GATE-130 — effort ratings are workout logs: only for clients who share Workouts (wearables have no switch).
    const sharing = await coachSharingCheck(this.consent, this.prisma, coachId);
    const workoutSharers = await sharing(ConsentScope.FITNESS_WORKOUTS, candidates);

    const [samples, completions] = await Promise.all([
      this.prisma.wearableSample.findMany({
        where: {
          user_id: { in: candidates },
          metric: { in: [...RULE_METRICS] },
          start_at: { gte: new Date(now.getTime() - 32 * 86_400_000) },
        },
        select: { user_id: true, metric: true, value: true, start_at: true, end_at: true },
      }),
      this.prisma.clientWorkoutAssignment.findMany({
        where: { client_id: { in: workoutSharers }, completed_at: { gte: new Date(now.getTime() - 36 * 86_400_000) } },
        select: { client_id: true, completed_at: true, post_rpe: true },
      }),
    ]);

    let created = 0;
    for (const client of eligible) {
      const next = nextByClient.get(client.id);
      if (!next) continue;
      const tz = client.notification_prefs?.timezone ?? DEFAULT_TZ;
      const signals = evaluateSignals({
        samples: samples.filter((s) => s.user_id === client.id),
        completions: completions
          .filter((c) => c.client_id === client.id && c.completed_at)
          .map((c) => ({ completed_at: c.completed_at as Date, post_rpe: c.post_rpe })),
        now,
        timeZone: tz,
      });
      const decision = decideVolumeCut(signals);
      if (!decision) continue;
      const existing = await this.prisma.workoutAdjustmentProposal.findUnique({
        where: { assignment_id_rule_key: { assignment_id: next.id, rule_key: ADJUST_RULE_KEY } },
        select: { id: true },
      });
      if (existing) continue;
      try {
        await this.prisma.$transaction(async (tx) => {
          const cur = await this.workoutBuilder.readAssignmentPrescription(tx, next.id);
          if (!cur.ok) return;
          const change = cutVolume(cur.exercises, decision.volume_pct);
          if (change.sets_after >= change.sets_before) return;
          const text = romanProposalText({
            clientFirstName: firstName(client.name),
            signals,
            change,
            planName: cur.plan_name,
            when: whenWord(cur.scheduled_for, tz),
          });
          const p = await tx.workoutAdjustmentProposal.create({
            data: {
              coach_id: coachId,
              client_id: client.id,
              assignment_id: next.id,
              rule_key: ADJUST_RULE_KEY,
              rule_version: ADJUST_RULE_VERSION,
              severity: decision.severity,
              signals: toJson(signals),
              proposed_change: toJson(change),
              base_fingerprint: cur.fingerprint,
              roman_text: text,
            },
            select: { id: true },
          });
          await tx.workoutAdjustmentEvent.create({
            data: {
              proposal_id: p.id,
              actor_id: null,
              action: 'proposed',
              detail: toJson({ rule: `${ADJUST_RULE_KEY}@${ADJUST_RULE_VERSION}`, signals: signals.map((s) => s.key) }),
            },
          });
          created += 1;
        });
      } catch (err) {
        // A concurrent scan won the unique index: that is the idempotent path.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
        throw err;
      }
    }
    return created;
  }

  /** Pending proposals whose workout started, finished or passed are closed. */
  private async expireStale(coachId: string, now: Date): Promise<void> {
    const pending = await this.prisma.workoutAdjustmentProposal.findMany({
      where: { coach_id: coachId, status: 'pending' },
      select: {
        id: true,
        assignment: { select: { started_at: true, completed_at: true, scheduled_for: true } },
      },
    });
    const dayAgo = now.getTime() - 86_400_000;
    for (const p of pending) {
      const a = p.assignment;
      if (a.started_at || a.completed_at || a.scheduled_for.getTime() < dayAgo) {
        await this.closeAs(p.id, 'expired', null, { reason: a.completed_at ? 'completed' : a.started_at ? 'started' : 'passed' });
      }
    }
  }

  private async closeAs(id: string, status: 'expired' | 'withdrawn', actorId: string | null, detail: Record<string, unknown>) {
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.workoutAdjustmentProposal.updateMany({ where: { id, status: 'pending' }, data: { status } });
      if (r.count === 1) {
        await tx.workoutAdjustmentEvent.create({ data: { proposal_id: id, actor_id: actorId, action: status, detail: toJson(detail) } });
      }
    });
  }

  // ─── decisions ────────────────────────────────────────────────────────────

  async approve(coachId: string, id: string, now: Date = new Date()): Promise<AdjustProposalView> {
    return this.apply(coachId, id, 'approved', null, now);
  }

  /**
   * Edit: the coach's own numbers. Either a reduction percentage (5 to 50) or
   * explicit per-exercise set counts.
   */
  async edit(
    coachId: string,
    id: string,
    input: { volume_pct?: number; sets?: Array<{ order: number; sets: number }> },
    now: Date = new Date(),
  ): Promise<AdjustProposalView> {
    const hasPct = typeof input.volume_pct === 'number';
    const hasSets = Array.isArray(input.sets) && input.sets.length > 0;
    if (hasPct === hasSets) throw adjustError('EDIT_INVALID');
    if (hasPct && (!Number.isInteger(input.volume_pct) || (input.volume_pct ?? 0) < 5 || (input.volume_pct ?? 0) > 50)) {
      throw adjustError('EDIT_INVALID');
    }
    return this.apply(coachId, id, 'edited', input, now);
  }

  private async apply(
    coachId: string,
    id: string,
    action: 'approved' | 'edited',
    edit: { volume_pct?: number; sets?: Array<{ order: number; sets: number }> } | null,
    now: Date,
  ): Promise<AdjustProposalView> {
    const p = await this.ownPending(coachId, id);
    if (!(await this.egress.consentedClients([p.client_id])).has(p.client_id)) {
      await this.closeAs(p.id, 'withdrawn', coachId, { reason: 'consent_withdrawn' });
      throw adjustError('CONSENT_WITHDRAWN');
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        const cur = await this.workoutBuilder.readAssignmentPrescription(tx, p.assignment_id);
        if (!cur.ok) throw new ApplyRefused(cur.reason);
        if (cur.fingerprint !== p.base_fingerprint) throw new ApplyRefused('changed');
        if (edit?.sets) {
          // Every row must name an exercise of THIS workout, 1 to 20 sets, once.
          const orders = new Set(cur.exercises.map((e) => e.order));
          const seen = new Set<number>();
          for (const r of edit.sets) {
            if (!orders.has(r.order) || seen.has(r.order) || !Number.isInteger(r.sets) || r.sets < 1 || r.sets > 20) {
              throw new ApplyRefused('invalid');
            }
            seen.add(r.order);
          }
        }
        let change: AdjustChange | null;
        if (!edit) change = asChange(p.proposed_change);
        else if (typeof edit.volume_pct === 'number') change = cutVolume(cur.exercises, edit.volume_pct);
        else change = setsChange(cur.exercises, new Map((edit.sets ?? []).map((s) => [s.order, s.sets])));
        if (!change) throw new ApplyRefused('invalid');
        const write = await this.workoutBuilder.replaceAssignmentSets(tx, p.assignment_id, {
          expectedFingerprint: p.base_fingerprint,
          sets: new Map(change.exercises.map((e) => [e.order, e.sets_after])),
        });
        if (!write.ok) throw new ApplyRefused(write.reason);
        const claimed = await tx.workoutAdjustmentProposal.updateMany({
          where: { id: p.id, status: 'pending' },
          data: {
            status: action,
            applied_change: toJson(change),
            applied_fingerprint: write.fingerprint,
            before_exercises: toJson(write.before),
            decided_by_id: coachId,
            decided_at: now,
            undo_until: new Date(now.getTime() + ADJUST_UNDO_WINDOW_MS),
          },
        });
        if (claimed.count !== 1) throw new ApplyRefused('not_found');
        await tx.workoutAdjustmentEvent.create({
          data: {
            proposal_id: p.id,
            actor_id: coachId,
            action,
            detail: toJson({ sets_before: change.sets_before, sets_after: change.sets_after, volume_pct: change.volume_pct, exercises: change.exercises }),
          },
        });
      });
    } catch (err) {
      if (!(err instanceof ApplyRefused)) throw err;
      return this.refused(p.id, coachId, err.reason);
    }
    return this.viewById(coachId, p.id);
  }

  private async refused(id: string, coachId: string, reason: ApplyRefused['reason']): Promise<never> {
    if (reason === 'invalid') throw adjustError('EDIT_INVALID');
    if (reason === 'not_found') {
      // Lost a race with another decision (or the workout was deleted).
      const now = await this.prisma.workoutAdjustmentProposal.findUnique({ where: { id }, select: { status: true } });
      throw adjustError(now && now.status !== 'pending' ? 'ALREADY_DECIDED' : 'NOT_FOUND');
    }
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.workoutAdjustmentProposal.updateMany({ where: { id, status: 'pending' }, data: { status: 'expired' } });
      await tx.workoutAdjustmentEvent.create({ data: { proposal_id: id, actor_id: coachId, action: 'apply_refused', detail: toJson({ reason }) } });
      if (r.count === 1) {
        await tx.workoutAdjustmentEvent.create({ data: { proposal_id: id, actor_id: coachId, action: 'expired', detail: toJson({ reason }) } });
      }
    });
    throw adjustError(reason === 'started' ? 'WORKOUT_STARTED' : 'WORKOUT_CHANGED');
  }

  async dismiss(coachId: string, id: string, reason: AdjustDismissReason | null): Promise<AdjustProposalView> {
    const p = await this.ownPending(coachId, id);
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.workoutAdjustmentProposal.updateMany({
        where: { id: p.id, status: 'pending' },
        data: { status: 'dismissed', dismiss_reason: reason, decided_by_id: coachId, decided_at: new Date() },
      });
      if (r.count !== 1) throw adjustError('ALREADY_DECIDED');
      await tx.workoutAdjustmentEvent.create({ data: { proposal_id: p.id, actor_id: coachId, action: 'dismissed', detail: toJson({ reason }) } });
    });
    return this.viewById(coachId, p.id);
  }

  async undo(coachId: string, id: string, now: Date = new Date()): Promise<AdjustProposalView> {
    const p = await this.own(coachId, id);
    if (p.status !== 'approved' && p.status !== 'edited') {
      throw adjustError(p.status === 'pending' ? 'NOT_FOUND' : 'ALREADY_DECIDED');
    }
    if (!p.undo_until || p.undo_until.getTime() <= now.getTime()) throw adjustError('UNDO_EXPIRED');
    const before = asRows(p.before_exercises);
    if (!p.applied_fingerprint || before.length === 0) throw adjustError('UNDO_BLOCKED');
    try {
      await this.prisma.$transaction(async (tx) => {
        const write = await this.workoutBuilder.replaceAssignmentSets(tx, p.assignment_id, {
          expectedFingerprint: p.applied_fingerprint as string,
          sets: new Map(before.map((e) => [e.order, e.sets])),
        });
        if (!write.ok) throw new ApplyRefused(write.reason);
        const r = await tx.workoutAdjustmentProposal.updateMany({
          where: { id: p.id, status: p.status },
          data: { status: 'undone', undo_until: null },
        });
        if (r.count !== 1) throw new ApplyRefused('not_found');
        await tx.workoutAdjustmentEvent.create({
          data: { proposal_id: p.id, actor_id: coachId, action: 'undone', detail: toJson({ restored_sets: before.reduce((a, e) => a + e.sets, 0) }) },
        });
      });
    } catch (err) {
      if (!(err instanceof ApplyRefused)) throw err;
      if (err.reason === 'started') throw adjustError('WORKOUT_STARTED');
      if (err.reason === 'not_found') throw adjustError('ALREADY_DECIDED');
      throw adjustError('UNDO_BLOCKED');
    }
    return this.viewById(coachId, p.id);
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  private async own(coachId: string, id: string): Promise<ProposalRow> {
    const p = await this.prisma.workoutAdjustmentProposal.findUnique({
      where: { id },
      include: { assignment: { select: { scheduled_for: true, snapshot: { select: { plan_name: true } } } } },
    });
    // Another coach's proposal is indistinguishable from a missing one.
    if (!p || p.coach_id !== coachId) throw adjustError('NOT_FOUND');
    // So is one whose client has since moved to another coach or been deleted.
    const client = await this.prisma.user.findUnique({ where: { id: p.client_id }, select: { coach_id: true, deleted_at: true } });
    if (!client || client.coach_id !== coachId || client.deleted_at) throw adjustError('NOT_FOUND');
    return p;
  }

  private async ownPending(coachId: string, id: string): Promise<ProposalRow> {
    const p = await this.own(coachId, id);
    if (p.status !== 'pending') throw adjustError('ALREADY_DECIDED');
    return p;
  }

  private async viewById(coachId: string, id: string): Promise<AdjustProposalView> {
    const p = await this.own(coachId, id);
    const u = await this.prisma.user.findUnique({ where: { id: p.client_id }, select: { name: true } });
    return this.view(p, firstName(u?.name), await this.exerciseNames([p]));
  }

  /** One catalog lookup for every exercise on the given proposals. */
  private async exerciseNames(rows: readonly ProposalRow[]): Promise<Map<string, string>> {
    const ids = new Set<string>();
    for (const r of rows) for (const e of asChange(r.proposed_change)?.exercises ?? []) ids.add(e.exercise_external_id);
    if (ids.size === 0) return new Map();
    const list = [...ids];
    const found = await this.prisma.exerciseCatalogItem.findMany({
      where: { OR: [{ id: { in: list } }, { slug: { in: list } }] },
      select: { id: true, slug: true, name: true },
    });
    const out = new Map<string, string>();
    for (const f of found) {
      out.set(f.id, f.name);
      if (f.slug) out.set(f.slug, f.name);
    }
    return out;
  }

  private view(p: ProposalRow, clientFirstName: string, exNames: ReadonlyMap<string, string>): AdjustProposalView {
    const proposed = asChange(p.proposed_change) ?? { volume_pct: 0, sets_before: 0, sets_after: 0, exercises: [] };
    const exercise_names: Record<string, string> = {};
    for (const e of proposed.exercises) {
      const n = exNames.get(e.exercise_external_id);
      if (n) exercise_names[e.exercise_external_id] = n;
    }
    return {
      id: p.id,
      status: p.status,
      severity: p.severity,
      roman_text: p.roman_text,
      client: { id: p.client_id, first_name: clientFirstName },
      workout: {
        assignment_id: p.assignment_id,
        plan_name: p.assignment.snapshot?.plan_name ?? '',
        scheduled_for: p.assignment.scheduled_for.toISOString(),
      },
      signals: asSignals(p.signals),
      proposed_change: proposed,
      applied_change: asChange(p.applied_change),
      exercise_names,
      created_at: p.created_at.toISOString(),
      decided_at: p.decided_at ? p.decided_at.toISOString() : null,
      undo_until: p.undo_until ? p.undo_until.toISOString() : null,
    };
  }
}
