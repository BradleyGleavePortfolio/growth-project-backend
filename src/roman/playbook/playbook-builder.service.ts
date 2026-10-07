/**
 * Roman v1.1 R11-P3b-2: the coach playbook builder (FEATURE_ROMAN_PLAYBOOK).
 *
 * For each head coach with clients: collect the team's scrubbed sources
 * (playbook-sources.ts), skip when nothing changed since the active version
 * (same ledger digest), admit the spend (background pool + daily ceiling),
 * ask the model for the playbook JSON once, validate it (schema, identity,
 * verbatim quotes of private notes), then write the new version in one
 * transaction: the old active row is superseded, the new one is active, and
 * its source ledger (ids only) is stored.
 *
 * Consent: with any memory-scope client the send declares those clients with
 * scope 'memory' (the gate re-reads every grant before the request). With
 * none, only coach-authored, client-free rows exist (the collector's rule) and
 * the send is the coach's own scope; a client row without consent stops the
 * build before any spend.
 *
 * Off (the flag unset) means no reads, no spend and no provider call.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { CoachAIBudgetService } from '../../ai-credits/coach-ai-budget.service';
import { AiEgressService, AnthropicHandle } from '../../ai-egress/ai-egress.service';
import { clientDataSubject, noClientDataSubject } from '../../ai-egress/ai-egress.types';
import { isAiEgressRefusal } from '../../ai-egress/ai-consent-required.exception';
import {
  ROMAN_ANTHROPIC_CLIENT,
  ROMAN_MODEL_PHASE_1,
  ROMAN_TURN_EFFORT,
  ROMAN_TURN_THINKING,
} from '../anthropic-client.provider';
import { RomanBackgroundSpendService } from '../background/roman-background-spend';
import { ROMAN_PLAYBOOK_CAPABILITY } from '../roman.constants';
import { romanErrorTag } from '../roman-error-tag';
import { inputTokenUpperBound } from '../roman.service';
import {
  PLAYBOOK_ITEM_TEXT_MAX,
  PLAYBOOK_LIST_MAX,
  PLAYBOOK_RED_LINE_KINDS,
  PLAYBOOK_SECTION_KEYS,
  validateCoachPlaybook,
  type CoachPlaybookContent,
} from './coach-playbook.schema';
import { validatePlaybookDraft, type PlaybookSchemaResult } from './playbook-validate';
import { PlaybookSourceCollector } from './playbook-sources';
import { isRomanPlaybookEnabled } from './roman-playbook.feature';

export const PLAYBOOK_BUILD_LIMITS = Object.freeze({
  coachesPerRun: 20,
  coachScan: 500,
  maxOutputTokens: 4096,
});

export type PlaybookBuildOutcome =
  | 'built'
  | 'unchanged'
  | 'no_sources'
  | 'unsafe_ledger'
  | 'not_admitted'
  | 'refused'
  | 'model_error'
  | 'invalid_draft'
  | 'empty_draft'
  | 'error';

export interface PlaybookRunResult {
  coaches: number;
  outcomes: Partial<Record<PlaybookBuildOutcome, number>>;
}

const SECTION_LINES = Object.entries(PLAYBOOK_SECTION_KEYS)
  .map(([section, keys]) => `  ${section}: ${keys.join(', ')}`)
  .join('\n');

export const PLAYBOOK_SYSTEM_PROMPT = `You write a coach's playbook: how this coach trains, feeds and recovers clients, so an assistant can answer clients the way this coach would.
Input JSON: "signals" (counts computed from the coach's programs and decisions) and "sources" (the coach's own guidelines, templates, plans, meal plans, and, when present, messages and session notes, with names, contacts and dates removed).
Reply with ONE JSON object and nothing else: {"sections": {...}, "red_lines": [...]}.
sections has up to four objects, each with optional lists:
${SECTION_LINES}
Every list item is {"text": string, "basis": "stated" | "observed", "evidence_count": integer}; exercises.substitutions items are {"for": string, "use": string, "when"?: string, "basis", "evidence_count"}.
red_lines items are {"kind": one of ${PLAYBOOK_RED_LINE_KINDS.join(', ')}, "value"?: exercise or supplement name, or a whole kcal number for min_kcal, "text": string, "basis", "evidence_count"}.
Rules: at most ${PLAYBOOK_LIST_MAX} items per list and ${PLAYBOOK_LIST_MAX} red lines; each text one line of at most ${PLAYBOOK_ITEM_TEXT_MAX} characters; general methods only, never about one client; no names, placeholders, contact details, dates, ages or body measurements of a person; never copy a message or session note, write the method in your own words; basis "stated" when the coach wrote it, "observed" when it shows in what the coach does; evidence_count is the number of sources behind the item; leave out anything the sources do not support.`;

/** The CoachPlaybook schema in the shape validatePlaybookDraft expects. */
export function playbookSchemaCheck(draft: unknown): PlaybookSchemaResult<CoachPlaybookContent> {
  const rec: Record<string, unknown> =
    typeof draft === 'object' && draft !== null && !Array.isArray(draft) ? Object.fromEntries(Object.entries(draft)) : {};
  const result = validateCoachPlaybook({ sections: rec.sections, red_lines: rec.red_lines ?? [] });
  return result.ok ? { ok: true, value: result.value } : { ok: false, errors: result.issues };
}

/** The first JSON object in the reply (code fences tolerated); null when there is none. */
export function parsePlaybookReply(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function hasHttpStatus(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number';
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value));
}

@Injectable()
export class PlaybookBuilderService {
  private readonly logger = new Logger(PlaybookBuilderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly budget: CoachAIBudgetService,
    private readonly egress: AiEgressService,
    private readonly collector: PlaybookSourceCollector,
    private readonly spend: RomanBackgroundSpendService,
    @Optional()
    @Inject(ROMAN_ANTHROPIC_CLIENT)
    private readonly anthropic: AnthropicHandle | null = null,
  ) {}

  /** One scheduled run: up to 20 head coaches with clients, oldest playbook first. Never throws. */
  async runOnce(now: Date = new Date()): Promise<PlaybookRunResult> {
    const result: PlaybookRunResult = { coaches: 0, outcomes: {} };
    if (!isRomanPlaybookEnabled() || !this.anthropic) return result;
    for (const coachId of await this.headCoaches()) {
      result.coaches += 1;
      let outcome: PlaybookBuildOutcome;
      try {
        outcome = await this.buildFor(coachId, now);
      } catch (err) {
        this.logger.warn(`roman.playbook_build_failed: ${romanErrorTag(err)}`);
        outcome = 'error';
      }
      result.outcomes[outcome] = (result.outcomes[outcome] ?? 0) + 1;
    }
    this.logger.log(`roman.playbook_run coaches=${result.coaches} outcomes=${JSON.stringify(result.outcomes)}`);
    return result;
  }

  /** Build (or skip) the playbook of one head coach. */
  async buildFor(coachId: string, now: Date = new Date()): Promise<PlaybookBuildOutcome> {
    const handle = this.anthropic;
    if (!isRomanPlaybookEnabled() || !handle) return 'error';
    const src = await this.collector.collect(coachId, now);
    const head = src.headCoachId;
    if (src.items.length === 0) return 'no_sources';
    const active = await this.prisma.coachPlaybook.findFirst({
      where: { coach_id: head, status: 'active' },
      select: { source_digest: true },
    });
    if (active?.source_digest === src.digest) return 'unchanged';
    const consented = src.consentedClientIds;
    if (consented.length === 0 && src.ledger.some((r) => r.client_id)) return 'unsafe_ledger';
    const subject = consented.length
      ? clientDataSubject(consented, 'coach', 'memory')
      : noClientDataSubject('coach_own_scope');

    const user = JSON.stringify({
      signals: src.signals,
      sources: src.items.map((i) => ({ kind: i.kind, text: i.text })),
    });
    const maxOut = PLAYBOOK_BUILD_LIMITS.maxOutputTokens;
    const inputTokenBound = inputTokenUpperBound(PLAYBOOK_SYSTEM_PROMPT, [{ content: user }]);
    const admission = await this.spend.reserve({
      capability: ROMAN_PLAYBOOK_CAPABILITY,
      payer: { kind: 'coach', coachId: head },
      model: ROMAN_MODEL_PHASE_1,
      inputTokenBound,
      maxOutputTokens: maxOut,
    });
    if (!admission.admitted) return 'not_admitted';

    let replyText: string;
    try {
      const reply = await this.egress.anthropicMessagesCreate(handle, subject, 'roman.playbook', {
        model: ROMAN_MODEL_PHASE_1,
        max_tokens: maxOut,
        // Same as a Roman turn: no up-front thinking, so the whole output
        // budget is the playbook JSON.
        thinking: ROMAN_TURN_THINKING,
        output_config: { effort: ROMAN_TURN_EFFORT },
        system: PLAYBOOK_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: user }],
      });
      await this.spend.settle(
        admission.reservation,
        reply.usage?.input_tokens ?? inputTokenBound,
        reply.usage?.output_tokens ?? maxOut,
        { outcome: 'ok' },
      );
      replyText = reply.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    } catch (err) {
      // Refused by the gate or answered with an HTTP error: nothing was
      // generated, so nothing is owed. Otherwise the worst case settles.
      const refused = isAiEgressRefusal(err);
      const none = refused || hasHttpStatus(err);
      await this.spend.settle(admission.reservation, none ? 0 : inputTokenBound, none ? 0 : maxOut, {
        outcome: refused ? 'refused' : 'model_error',
      });
      if (!refused) this.logger.warn(`roman.playbook_model_failed: ${romanErrorTag(err)}`);
      return refused ? 'refused' : 'model_error';
    }

    const checked = validatePlaybookDraft(parsePlaybookReply(replyText), {
      roster: src.roster,
      privateTexts: src.items.filter((i) => i.private).map((i) => i.text),
      schema: playbookSchemaCheck,
    });
    if (!checked.ok) {
      this.logger.warn(`roman.playbook_invalid_draft reason=${checked.reason} issues=${checked.errors.length}`);
      return 'invalid_draft';
    }
    if (checked.kept_items === 0) return 'empty_draft';

    await this.prisma.$transaction(async (tx) => {
      const last = await tx.coachPlaybook.findFirst({
        where: { coach_id: head },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      await tx.coachPlaybook.updateMany({
        where: { coach_id: head, status: 'active' },
        data: { status: 'superseded' },
      });
      const created = await tx.coachPlaybook.create({
        data: {
          coach_id: head,
          version: (last?.version ?? 0) + 1,
          status: 'active',
          sections: jsonValue(checked.value.sections),
          red_lines: jsonValue(checked.value.red_lines),
          source_count: src.ledger.length,
          source_digest: src.digest,
          model_id: ROMAN_MODEL_PHASE_1,
          built_at: now,
        },
        select: { id: true },
      });
      await tx.coachPlaybookSource.createMany({
        data: src.ledger.map((r) => ({
          playbook_id: created.id,
          coach_id: head,
          client_id: r.client_id ?? null,
          source_kind: r.source_kind,
          source_id: r.source_id,
        })),
      });
    });
    this.logger.log(
      `roman.playbook_built sources=${src.ledger.length} kept=${checked.kept_items} dropped=${checked.dropped.length}`,
    );
    return 'built';
  }

  /** Head coaches with at least one live client; never-built and oldest first. */
  private async headCoaches(): Promise<string[]> {
    const rows = await this.prisma.user.findMany({
      where: { role: 'student', coach_id: { not: null }, deletion_scheduled_at: null, deleted_at: null },
      distinct: ['coach_id'],
      select: { coach_id: true },
      take: PLAYBOOK_BUILD_LIMITS.coachScan,
    });
    const heads = new Set<string>();
    for (const r of rows) if (r.coach_id) heads.add(await this.budget.resolveHeadCoachId(r.coach_id));
    if (heads.size === 0) return [];
    const built = await this.prisma.coachPlaybook.findMany({
      where: { coach_id: { in: [...heads] }, status: 'active' },
      select: { coach_id: true, built_at: true },
    });
    const at = new Map(built.map((b) => [b.coach_id, b.built_at.getTime()]));
    return [...heads]
      .sort((a, b) => (at.get(a) ?? 0) - (at.get(b) ?? 0) || a.localeCompare(b))
      .slice(0, PLAYBOOK_BUILD_LIMITS.coachesPerRun);
  }
}
