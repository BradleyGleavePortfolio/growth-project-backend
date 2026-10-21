import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { AiActionDraft, Prisma } from '@prisma/client';
import { z } from 'zod';
import { AiConsentRequiredException } from '../../../ai-egress/ai-consent-required.exception';
import { AiEgressService } from '../../../ai-egress/ai-egress.service';
import { MacrosService } from '../../../macros/macros.service';
import { PrismaService } from '../../../prisma.service';
import { CapabilityMaterializer, MaterializeResult } from './capability-materialiser.interface';

/**
 * COPILOT-BE (Path Copilot style A, owner #162-1 / #162-1b). A plan change Roman suggested to a client. Roman never applies
 * it: the client taps Send (the row goes `suggested` -> `pending` for their coach), the coach Approves, Edits or Declines
 * with an optional one-line note, and only an approval reaches this materialiser. It re-checks the client's live AI
 * consent and that the client is still the deciding tenant's, then applies one of two kinds:
 *   move_session        the client's scheduled session moves from `from_at` to `to_at` (refused if it moved or finished)
 *   set_calorie_target  a new coach target row through MacrosService (the calorie floor and every hold still apply);
 *                       protein and fibre stay, carbs and fats scale to the new calories (refused if the target changed)
 * The coach's Edit refreshes the baseline to the live plan (see `edit`); an unedited approval keeps Roman's baseline.
 */
export const CLIENT_PATH_CHANGE = 'client_path_change';
export const PATH_CHANGE_NOTE_MAX = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
/** #CP-LAPSE (built as 7 days, owner board to come): how long a sent suggestion waits for the coach. Send, the queues and decide all read it. */
export const PATH_CHANGE_PENDING_MS = 7 * DAY_MS;
/** The client's own move window (workout-builder.service.ts updateAssignment): 2 days back to 7 days ahead of now. */
export const MOVE_WINDOW = { backMs: 2 * DAY_MS, aheadMs: 7 * DAY_MS };

/** A sent suggestion lapses PATH_CHANGE_PENDING_MS after Send (Send stamps created_at with the send time). */
export const pathChangeLapsed = (d: { capability: string; status: string; created_at: Date }, now = new Date()) =>
  d.capability === CLIENT_PATH_CHANGE && d.status === 'pending' && d.created_at.getTime() + PATH_CHANGE_PENDING_MS <= now.getTime();
/** Queue filter: hides lapsed Copilot changes; every other kind is untouched. */
export const notLapsedWhere = (now = new Date()): Prisma.AiActionDraftWhereInput => ({
  OR: [{ capability: { not: CLIENT_PATH_CHANGE } }, { created_at: { gt: new Date(now.getTime() - PATH_CHANGE_PENDING_MS) } }],
});

const iso = z.iso.datetime({ offset: true });
const source = z.strictObject({
  kind: z.enum(['plan', 'check_in', 'food_log', 'workout_log']),
  id: z.string().max(64).nullable(),
  date: z.iso.date(),
  label: z.string().min(1).max(120),
});
const sources = z.array(source).max(6).default([]);
// MacroTarget ids: a plain uuid (coach targets, the column default) or `auto-<uuid>` (onboarding and profile targets).
const targetId = z.string().regex(/^(auto-)?[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
const moveSession = z.strictObject({
  kind: z.literal('move_session'), assignment_id: z.guid(), workout: z.string().min(1).max(80), from_at: iso, to_at: iso, sources,
});
const setCalorieTarget = z.strictObject({
  kind: z.literal('set_calorie_target'), target_id: targetId, from_kcal: z.int().min(0).max(7000), to_kcal: z.int().min(800).max(7000), sources,
});
export const pathChangeSchema = z.discriminatedUnion('kind', [moveSession, setCalorieTarget]);
export type PathChange = z.infer<typeof pathChangeSchema>;
/** The one field the coach may change with Edit, per kind. */
const editSchema = { move_session: z.strictObject({ to_at: iso }), set_calorie_target: z.strictObject({ to_kcal: setCalorieTarget.shape.to_kcal }) };

const invalid = () => new BadRequestException({ code: 'COPILOT_CHANGE_INVALID', message: 'Check the new day or target and try again.' });
const stale = () => new ConflictException({ code: 'COPILOT_PLAN_CHANGED', message: 'The plan changed after Roman suggested this. Edit it or decline it.' });
const notYours = () => new NotFoundException('AI draft not found');

function shapeOf(payload: unknown): PathChange {
  const parsed = pathChangeSchema.safeParse(payload);
  if (!parsed.success) throw invalid();
  return parsed.data;
}

/** The shape, plus the bounds checked at apply: a session moves only inside the client's own move window. */
export function parsePathChange(payload: unknown, now = Date.now()): PathChange {
  const p = shapeOf(payload);
  const to = p.kind === 'move_session' ? Date.parse(p.to_at) : null;
  if (to !== null && (to < now - MOVE_WINDOW.backMs || to > now + MOVE_WINDOW.aheadMs)) throw invalid();
  return p;
}

/** CP-NOTE: one optional line the client sees with the decision. */
export function pathChangeNote(note: unknown): string | null {
  if (note == null) return null;
  const line = typeof note === 'string' ? note.replace(/\s+/g, ' ').trim() : null;
  if (line === null || line.length > PATH_CHANGE_NOTE_MAX) {
    throw new BadRequestException({ code: 'COPILOT_NOTE_TOO_LONG', message: 'Keep the note to one line.' });
  }
  return line || null;
}

@Injectable()
export class ClientPathChangeMaterializer implements CapabilityMaterializer {
  readonly capability = CLIENT_PATH_CHANGE;

  constructor(
    private readonly prisma: PrismaService,
    private readonly egress: AiEgressService,
    private readonly macros: MacrosService,
  ) {}

  canHandle(capability: string): boolean {
    return capability === CLIENT_PATH_CHANGE;
  }

  /** Only a client's own sent suggestion, for the coach who holds it now, with the client's AI consent still on. */
  private async live(draft: AiActionDraft): Promise<{ clientId: string; coachId: string }> {
    const clientId = draft.subject_user_id;
    const coachId = draft.tenant_coach_id;
    const client = clientId ? await this.prisma.user.findUnique({ where: { id: clientId }, select: { role: true, coach_id: true } }) : null;
    if (!clientId || !client || !coachId || draft.requester_id !== clientId || client.role !== 'student' || client.coach_id !== coachId) {
      throw notYours();
    }
    if (!(await this.egress.consentedClients([clientId])).has(clientId)) throw new AiConsentRequiredException('coach');
    return { clientId, coachId };
  }

  /**
   * The coach's Edit: the one field the kind allows, on a baseline refreshed to the client's live plan (the session's day
   * now, the current target now), so an Edit also recovers a suggestion the plan has moved past. Ownership, consent and
   * the bounds are checked again; a session that was done or skipped, or a client with no target, is still 409.
   */
  async edit(draft: AiActionDraft, edit: unknown): Promise<PathChange> {
    const base = shapeOf(draft.payload);
    const patch = editSchema[base.kind].safeParse(edit);
    if (!patch.success) throw invalid();
    const { clientId } = await this.live(draft);
    if (base.kind === 'move_session') {
      const session = await this.prisma.clientWorkoutAssignment.findFirst({
        where: { id: base.assignment_id, client_id: clientId, completed_at: null, skipped_at: null },
        select: { scheduled_for: true },
      });
      if (!session) throw stale();
      return parsePathChange({ ...base, ...patch.data, from_at: session.scheduled_for.toISOString() });
    }
    const current = await this.macros.getCurrentForClient(clientId);
    if (!current) throw stale();
    return parsePathChange({ ...base, ...patch.data, target_id: current.id, from_kcal: current.calories_kcal });
  }

  async materialize(draft: AiActionDraft): Promise<MaterializeResult> {
    const p = parsePathChange(draft.payload);
    const { clientId, coachId } = await this.live(draft);
    const claim = await this.prisma.aiActionDraft.updateMany({
      where: { id: draft.id, materialised_at: null },
      data: { materialised_at: new Date() },
    });
    if (claim.count === 0) {
      const row = await this.prisma.aiActionDraft.findUnique({ where: { id: draft.id }, select: { materialised_ref: true } });
      return row?.materialised_ref ? { status: 'already_materialised', ref: row.materialised_ref } : { status: 'racing' };
    }
    let ref: string;
    try {
      ref = p.kind === 'move_session' ? await this.moveSession(clientId, p) : await this.setTarget(coachId, clientId, p);
    } catch (err) {
      // Release the claim so the coach can Edit, retry or Decline.
      await this.prisma.aiActionDraft.updateMany({ where: { id: draft.id, materialised_ref: null }, data: { materialised_at: null } });
      throw err;
    }
    await this.prisma.aiActionDraft.update({ where: { id: draft.id }, data: { materialised_ref: ref } });
    return { status: 'sent', ref };
  }

  private async moveSession(clientId: string, p: Extract<PathChange, { kind: 'move_session' }>): Promise<string> {
    const moved = await this.prisma.clientWorkoutAssignment.updateMany({
      where: { id: p.assignment_id, client_id: clientId, scheduled_for: new Date(p.from_at), completed_at: null, skipped_at: null },
      data: { scheduled_for: new Date(p.to_at) },
    });
    if (moved.count !== 1) throw stale();
    return p.assignment_id;
  }

  private async setTarget(coachId: string, clientId: string, p: Extract<PathChange, { kind: 'set_calorie_target' }>): Promise<string> {
    const current = await this.macros.getCurrentForClient(clientId);
    if (!current || current.id !== p.target_id) throw stale();
    const proteinKcal = current.protein_g * 4;
    const scale = Math.max(0, p.to_kcal - proteinKcal) / Math.max(1, current.calories_kcal - proteinKcal);
    const created = await this.macros.createForClient(coachId, clientId, {
      calories_kcal: p.to_kcal,
      protein_g: current.protein_g,
      carbs_g: Math.round(current.carbs_g * scale),
      fats_g: Math.round(current.fats_g * scale),
      ...(current.fiber_g != null ? { fiber_g: current.fiber_g } : {}),
    }, 'coach');
    return created.id;
  }
}
