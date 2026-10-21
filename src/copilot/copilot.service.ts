import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type AiActionDraft } from '@prisma/client';
import { AiConsentRequiredException } from '../ai-egress/ai-consent-required.exception';
import { AiEgressService } from '../ai-egress/ai-egress.service';
import { CLIENT_PATH_CHANGE, PATH_CHANGE_PENDING_MS, pathChangeLapsed } from '../ai/gateway/materialisers/client-path-change.materialiser';
import { PrismaService } from '../prisma.service';
import { assertRomanClient } from '../roman/roman-requires-coach';
import { addDays, localClock, localDayStart } from '../roman/context/roman-client-context.service';
import type { StoredCopilot } from './copilot-turn';

/** Sent states the client sees as status lines; `suggested` (not sent yet) never reaches the coach or this list. */
const SENT = ['pending', 'approved', 'rejected', 'expired'];
export const COPILOT_RECENT = 3;
/** Past questions a page (CP-A-44/45). */
export const COPILOT_PAGE = 20;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface CopilotSuggestionView {
  id: string;
  status: string;
  change: unknown;
  reason: string | null;
  note: string | null;
  /** Null until the client taps Send. */
  sent_at: Date | null;
  decided_at: Date | null;
}

const unsentLapsed = (d: AiActionDraft, now = new Date()) =>
  d.status === 'suggested' && !!d.expires_at && d.expires_at.getTime() <= now.getTime();

export const suggestionView = (d: AiActionDraft): CopilotSuggestionView => ({
  id: d.id,
  // #CP-LAPSE: a sent suggestion the coach did not decide within PATH_CHANGE_PENDING_MS reads as expired, and so does an
  // unsent one past its expires_at (Send then refuses it).
  status: pathChangeLapsed(d) || unsentLapsed(d) ? 'expired' : d.status,
  change: d.payload,
  reason: d.rationale,
  note: d.decision_note,
  sent_at: d.status === 'suggested' ? null : d.created_at,
  decided_at: d.decided_at,
});

/**
 * COPILOT-BE: the client's half of a Copilot plan change. Roman's turn writes the change as an AiActionDraft with status
 * `suggested`, no tenant, the client as requester and subject, so no coach can read it (RLS and every queue key on the
 * tenant). Send is the one step that hands it to the client's current coach. Not counted in the 5 changes a day
 * (owner #CP-COUNT op 1: `coach_approved_change` has no count in roman-usage.ts).
 */
@Injectable()
export class CopilotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly egress: AiEgressService,
  ) {}

  private mine(clientId: string) {
    return { capability: CLIENT_PATH_CHANGE, requester_id: clientId, subject_user_id: clientId };
  }

  /** Newest first, the last three sent, and how many the client has sent in all. */
  async recent(clientId: string) {
    const where = { ...this.mine(clientId), status: { in: SENT } };
    const [rows, total] = await Promise.all([
      this.prisma.aiActionDraft.findMany({ where, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: COPILOT_RECENT }),
      this.prisma.aiActionDraft.count({ where }),
    ]);
    return { week: await this.week(clientId), suggestions: rows.map(suggestionView), suggestions_total: total };
  }

  /**
   * COPILOT-BE2: the style A masthead, from the client's own rows: week {n} with their coach, the daily target (when it
   * started, and the one before it), this local week's workouts done of planned, and the last check-in day.
   */
  async week(clientId: string, now = new Date()) {
    const select = { coach_id: true, coach_joined_at: true, coach: { select: { name: true } }, notification_prefs: { select: { timezone: true } } };
    const user = await this.prisma.user.findUnique({ where: { id: clientId }, select });
    const clock = localClock(now, user?.notification_prefs?.timezone ?? 'America/Los_Angeles');
    const monday = addDays(clock.local_date, -((new Date(`${clock.local_date}T00:00:00Z`).getUTCDay() + 6) % 7));
    const [targets, sessions, checkIn] = await Promise.all([
      // The same row MacrosService.getCurrentForClient reads, and the one before it.
      this.prisma.macroTarget.findMany({ where: { client_id: clientId, archived_at: null, effective_from: { lte: now } }, orderBy: { effective_from: 'desc' }, take: 2, select: { id: true, coach_id: true, calories_kcal: true, effective_from: true, notes: true } }),
      this.prisma.clientWorkoutAssignment.findMany({
        where: { client_id: clientId, scheduled_for: { gte: localDayStart(monday, clock.timezone), lt: localDayStart(addDays(monday, 7), clock.timezone) } },
        select: { completed_at: true },
      }),
      this.prisma.checkIn.findFirst({ where: { user_id: clientId }, orderBy: { date: 'desc' }, select: { date: true } }),
    ]);
    const [current, previous] = targets;
    const coach = user?.coach?.name.trim().split(/\s+/)[0] || null;
    // set_by: the coach's first name when the current coach set it; null for a target from onboarding or the profile ('auto-').
    const setBy = current && current.coach_id === user?.coach_id && !current.id.startsWith('auto-') ? coach : null;
    return {
      number: user?.coach_joined_at ? Math.floor((now.getTime() - user.coach_joined_at.getTime()) / WEEK_MS) + 1 : null,
      coach_first_name: coach,
      target: current
        ? { kcal: current.calories_kcal, from: current.effective_from, set_by: setBy, note: current.notes, previous_kcal: previous?.calories_kcal ?? null }
        : null,
      workouts: { done: sessions.filter((s) => s.completed_at).length, total: sessions.length },
      last_check_in: checkIn ? checkIn.date.toISOString().slice(0, 10) : null,
    };
  }

  /** COPILOT-BE2: the client's past Copilot questions, newest first, COPILOT_PAGE a page, with the total and the first one's time. */
  async questions(clientId: string, cursor?: string) {
    const where: Prisma.RomanMessageWhereInput = { user_id: clientId, role: 'roman', copilot: { not: Prisma.DbNull }, session: { deleted_at: null } };
    const [rows, total, first] = await Promise.all([
      this.prisma.romanMessage.findMany({ where, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: COPILOT_PAGE + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: { id: true, session_id: true, created_at: true, copilot: true } }),
      this.prisma.romanMessage.count({ where }),
      this.prisma.romanMessage.findFirst({ where, orderBy: { created_at: 'asc' }, select: { created_at: true } }),
    ]);
    const page = rows.slice(0, COPILOT_PAGE).map((r) => ({ ...r, c: r.copilot as unknown as StoredCopilot }));
    const ids = (pick: (c: StoredCopilot) => string | null) => page.map((r) => pick(r.c)).filter((x): x is string => !!x);
    const [asked, drafts] = await Promise.all([
      this.prisma.romanMessage.findMany({ where: { user_id: clientId, id: { in: ids((c) => c.question_id) } }, select: { id: true, content: true } }),
      this.prisma.aiActionDraft.findMany({ where: { ...this.mine(clientId), id: { in: ids((c) => c.suggestion_id) } } }),
    ]);
    return {
      items: page.map((r) => {
        const d = drafts.find((x) => x.id === r.c.suggestion_id);
        const question = asked.find((q) => q.id === r.c.question_id)?.content ?? null;
        return { question, asked_at: r.created_at, session_id: r.session_id, message_id: r.id, outcome: d ? suggestionView(d).status : null };
      }),
      total,
      since: first?.created_at ?? null,
      next_cursor: rows.length > COPILOT_PAGE ? page[page.length - 1].id : null,
    };
  }

  /** Send to the coach: `suggested` -> `pending`, stamped with the client's coach now. A repeat Send answers the same row. */
  async send(client: { id: string; role: string; coach_id: string | null }, id: string): Promise<CopilotSuggestionView> {
    assertRomanClient(client);
    if (!(await this.egress.consentedClients([client.id])).has(client.id)) throw new AiConsentRequiredException('client');
    const now = new Date();
    const mine = { id, ...this.mine(client.id) };
    await this.prisma.aiActionDraft.updateMany({
      where: { ...mine, status: 'suggested', OR: [{ expires_at: null }, { expires_at: { gt: now } }] },
      // created_at becomes the moment it was sent: the coach's queue reads oldest first from it.
      // provenance (the Roman chat it came from) stays with the client: the coach sees the change, the reason and the sources.
      data: { status: 'pending', tenant_coach_id: client.coach_id, created_at: now, expires_at: new Date(now.getTime() + PATH_CHANGE_PENDING_MS), provenance: Prisma.DbNull },
    });
    const row = await this.prisma.aiActionDraft.findFirst({ where: mine });
    if (!row) throw new NotFoundException('Suggestion not found');
    if (row.status === 'suggested') {
      throw new ConflictException({ code: 'COPILOT_SUGGESTION_EXPIRED', message: 'This suggestion is no longer available. Ask Roman again.' });
    }
    return suggestionView(row);
  }
}
