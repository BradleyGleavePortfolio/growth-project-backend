/**
 * Roman v1.1 R11-P3b-1: playbook source collector (no model, no writes).
 *
 * Gathers what one head coach's team wrote, so the playbook builder (R11-P3b-2)
 * can learn the coach's methods. Every string is scrubbed (playbook-scrub.ts)
 * before it leaves this file; the builder never sees a raw row.
 *
 * Team: the head coach (a sub-coach is folded into its head) plus its active
 * sub-coaches, the same rule as playbook-signals.service.ts. Every query is
 * filtered to rows the team authored; another coach's rows are never read.
 *
 * Consent: a client's information is used only when that client holds the
 * Roman v1.1 'memory' scope (client-ai-v5), read once per run through the
 * egress gate. Coach-to-client messages and private session notes come only
 * from those clients, and a guideline or meal plan written for one client is
 * client information too, so it is read only for those clients. Coach-wide
 * guidelines, templates and library plans carry no client and are always read.
 *
 * Output: scrubbed items (600 characters each, 40,000 in total), the source
 * ledger (ids only, the CoachPlaybookSource shape), its sha256 digest, the
 * consented client ids and the deterministic team signals for those clients.
 */
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma.service';
import { CoachAIBudgetService } from '../../ai-credits/coach-ai-budget.service';
import { AiEgressService } from '../../ai-egress/ai-egress.service';
import { PlaybookSignalsService } from './playbook-signals.service';
import type { PlaybookSignals } from './playbook-signals.types';
import type { PlaybookSourceKind } from './coach-playbook.schema';
import { buildPlaybookRoster, scrubPlaybookText, type PlaybookRoster } from './playbook-scrub';

const DAY_MS = 24 * 60 * 60 * 1000;

export const PLAYBOOK_SOURCE_LIMITS = Object.freeze({
  itemChars: 600,
  totalChars: 40_000,
  messageDays: 90,
  messages: 150,
  sessionNoteDays: 120,
  sessionNotes: 80,
  guidelines: 100,
  workoutPlans: 100,
  templates: 50,
  mealPlans: 100,
  exercisesPerPlan: 30,
  rosterRows: 5000,
});

export interface PlaybookSourceItem {
  readonly kind: PlaybookSourceKind;
  readonly id: string;
  /** Scrubbed text, one line, at most PLAYBOOK_SOURCE_LIMITS.itemChars. */
  readonly text: string;
  /** Session notes and coach messages: never quotable (the validator's verbatim rule). */
  readonly private: boolean;
}

export interface PlaybookLedgerRow {
  readonly source_kind: PlaybookSourceKind;
  readonly source_id: string;
  readonly client_id?: string;
}

export interface PlaybookSources {
  readonly headCoachId: string;
  readonly roster: PlaybookRoster;
  readonly items: readonly PlaybookSourceItem[];
  readonly ledger: readonly PlaybookLedgerRow[];
  readonly digest: string;
  readonly consentedClientIds: readonly string[];
  readonly signals: PlaybookSignals;
}

interface Candidate {
  kind: PlaybookSourceKind;
  id: string;
  raw: string;
  clientId: string | null;
  private: boolean;
}

/** sha256 over the ledger sorted by kind, id, client (order of reads never matters). */
export function playbookLedgerDigest(ledger: readonly PlaybookLedgerRow[]): string {
  const rows = ledger
    .map((r) => [r.source_kind, r.source_id, r.client_id ?? ''])
    .sort((a, b) => a.join('\u0000').localeCompare(b.join('\u0000')));
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

@Injectable()
export class PlaybookSourceCollector {
  constructor(
    private readonly prisma: PrismaService,
    private readonly budget: CoachAIBudgetService,
    private readonly egress: AiEgressService,
    private readonly signals: PlaybookSignalsService,
  ) {}

  async collect(headCoachId: string, now: Date = new Date()): Promise<PlaybookSources> {
    const L = PLAYBOOK_SOURCE_LIMITS;
    const head = await this.budget.resolveHeadCoachId(headCoachId);
    const subs = await this.prisma.teamSubCoachAssignment.findMany({
      where: { head_coach_id: head, archived_at: null },
      select: { sub_coach_id: true },
    });
    const subIds = [...new Set(subs.map((s) => s.sub_coach_id).filter((id) => id !== head))];
    const team = [head, ...subIds];

    const person = { id: true, name: true, leaderboard_display_name: true, email: true, phone: true } as const;
    const [clients, subCoaches] = await Promise.all([
      this.prisma.user.findMany({
        where: { coach_id: { in: team }, role: 'student', deletion_scheduled_at: null, deleted_at: null },
        select: person,
        take: L.rosterRows,
      }),
      subIds.length ? this.prisma.user.findMany({ where: { id: { in: subIds } }, select: person }) : [],
    ]);
    const roster = buildPlaybookRoster(
      [...clients, ...subCoaches].map((p) => ({
        name: p.name,
        display_name: p.leaderboard_display_name,
        email: p.email,
        phone: p.phone,
      })),
    );

    const clientIds = clients.map((c) => c.id);
    const granted = clientIds.length ? await this.egress.consentedClients(clientIds, 'memory') : new Set<string>();
    const consented = clientIds.filter((id) => granted.has(id)).sort();
    const forClient = [{ client_id: null }, ...(consented.length ? [{ client_id: { in: consented } }] : [])];

    const [guidelines, templates, plans, mealPlans] = await Promise.all([
      this.prisma.coachGuideline.findMany({
        where: { coach_id: { in: team }, OR: forClient },
        orderBy: { updated_at: 'desc' },
        select: { id: true, client_id: true, content: true },
        take: L.guidelines,
      }),
      this.prisma.workoutProgram.findMany({
        where: { owner_user_id: { in: team }, is_template: true, archived_at: null },
        orderBy: { updated_at: 'desc' },
        select: { id: true, name: true, description: true, weeks: true, days_per_week: true },
        take: L.templates,
      }),
      // Library plans and template days only; a program day cloned onto one
      // client is that client's copy and is learned from its template instead.
      this.prisma.workoutPlan.findMany({
        where: { coach_id: { in: team }, archived_at: null, OR: [{ is_template: true }, { program_id: null }] },
        orderBy: { updated_at: 'desc' },
        select: {
          id: true,
          name: true,
          exercises: {
            where: { archived_at: null },
            orderBy: { order: 'asc' },
            select: { exercise_external_id: true },
            take: L.exercisesPerPlan,
          },
        },
        take: L.workoutPlans,
      }),
      this.prisma.mealPlan.findMany({
        where: { coach_id: { in: team }, archived_at: null, OR: forClient },
        orderBy: { updated_at: 'desc' },
        select: { id: true, client_id: true, title: true, notes: true },
        take: L.mealPlans,
      }),
    ]);

    // Private material (session notes, coach messages) only from memory-scope clients.
    const notes = consented.length
      ? await this.prisma.coachingSession.findMany({
          where: {
            coach_id: { in: team },
            client_id: { in: consented },
            coach_notes_md: { not: null },
            start_at: { gte: new Date(now.getTime() - L.sessionNoteDays * DAY_MS), lte: now },
          },
          orderBy: { start_at: 'desc' },
          select: { id: true, client_id: true, coach_notes_md: true },
          take: L.sessionNotes,
        })
      : [];
    const messages = consented.length
      ? await this.prisma.coachMessage.findMany({
          where: {
            coach_id: { in: team },
            sender_id: { in: team },
            client_id: { in: consented },
            deleted_at: null,
            body: { not: null },
            created_at: { gte: new Date(now.getTime() - L.messageDays * DAY_MS), lte: now },
          },
          orderBy: { created_at: 'desc' },
          select: { id: true, client_id: true, body: true },
          take: L.messages,
        })
      : [];

    const exerciseIds = [...new Set(plans.flatMap((p) => p.exercises.map((e) => e.exercise_external_id)))];
    const catalog = await this.exerciseNames(exerciseIds);

    // Coach-authored material first, so the total cap trims messages before methods.
    const candidates: Candidate[] = [
      ...guidelines.map((g) => ({ kind: 'guideline' as const, id: g.id, raw: g.content, clientId: g.client_id, private: false })),
      ...templates.map((t) => ({
        kind: 'template' as const,
        id: t.id,
        raw: `${t.name} (${t.weeks} weeks, ${t.days_per_week} days a week)${t.description ? `: ${t.description}` : ''}`,
        clientId: null,
        private: false,
      })),
      ...plans.map((p) => {
        const names = p.exercises.map((e) => catalog.get(e.exercise_external_id)).filter((n): n is string => !!n);
        return { kind: 'program' as const, id: p.id, raw: names.length ? `${p.name}: ${names.join(', ')}` : p.name, clientId: null, private: false };
      }),
      ...mealPlans.map((m) => ({
        kind: 'meal_plan' as const,
        id: m.id,
        raw: m.notes ? `${m.title}: ${m.notes}` : m.title,
        clientId: m.client_id,
        private: false,
      })),
      ...notes.map((n) => ({ kind: 'session_note' as const, id: n.id, raw: n.coach_notes_md ?? '', clientId: n.client_id, private: true })),
      ...messages.map((m) => ({ kind: 'coach_message' as const, id: m.id, raw: m.body ?? '', clientId: m.client_id, private: true })),
    ];

    const items: PlaybookSourceItem[] = [];
    const ledger: PlaybookLedgerRow[] = [];
    let total = 0;
    for (const c of candidates) {
      const text = oneLine(scrubPlaybookText(c.raw, roster)).slice(0, L.itemChars).trim();
      if (!text) continue;
      if (total + text.length > L.totalChars) break;
      total += text.length;
      items.push({ kind: c.kind, id: c.id, text, private: c.private });
      ledger.push(c.clientId ? { source_kind: c.kind, source_id: c.id, client_id: c.clientId } : { source_kind: c.kind, source_id: c.id });
    }

    const signals = await this.signals.compute(head, { clientIds: consented, now });
    return {
      headCoachId: head,
      roster,
      items,
      ledger,
      digest: playbookLedgerDigest(ledger),
      consentedClientIds: consented,
      signals,
    };
  }

  /** Library names by id, slug or seed source_ref (the forms exercise_external_id takes). */
  private async exerciseNames(ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (ids.length === 0) return out;
    const rows = await this.prisma.exerciseCatalogItem.findMany({
      where: { OR: [{ id: { in: ids } }, { slug: { in: ids } }, { source_ref: { in: ids } }] },
      select: { id: true, slug: true, source_ref: true, name: true },
    });
    for (const r of rows) {
      const name = r.name.trim();
      if (!name) continue;
      for (const key of [r.id, r.slug, r.source_ref]) if (key) out.set(key, name);
    }
    return out;
  }
}
