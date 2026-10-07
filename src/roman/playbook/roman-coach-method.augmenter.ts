/**
 * Roman v1.1 slice R11-P4: the coach-method block in a client's turn.
 *
 * Adds "# COACH METHOD" (kind 'coach_method') to a grounded client turn: how
 * the client's coach trains, feeds and recovers clients, from that coach's one
 * active CoachPlaybook, so Roman shapes advice to the coach's method.
 *
 * Rules:
 *  - Null unless FEATURE_ROMAN_PLAYBOOK is on and the caller is a student.
 *  - The coach is the client's CURRENT live coach (User.coach, the same rule
 *    as the turn context, roman-coach-scope.ts), folded into its head coach
 *    (CoachAIBudgetService.resolveHeadCoachId). The user row is read on every
 *    turn, so a former coach's playbook is never used after a reassignment.
 *  - Only the head coach's active playbook (newest active version), re-run
 *    through validateCoachPlaybook; an invalid row gives no block.
 *  - The block never names a playbook and tells Roman never to say the method
 *    was learned or to quote the coach's notes. Red lines are plain rules and
 *    go to post_check.red_lines.
 *  - Whether the block may be sent at all is the R11-T2A seam's rule (the
 *    'memory' scope); this augmenter only reads.
 *
 * In-process cache of the rendered block by (coach_id, version): 10 minutes,
 * at most 200 entries. A new version is a new key, so a rebuild applies on
 * the next turn.
 */
import { createHash } from 'node:crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { CoachAIBudgetService } from '../../ai-credits/coach-ai-budget.service';
import type {
  RomanAugmentCaller,
  RomanTurnAugment,
  RomanTurnAugmenter,
} from '../augment/roman-turn-augmenter';
import type { RomanClientContextBundle } from '../context/roman-client-context.types';
import { resolveRomanCoachScope } from '../context/roman-coach-scope';
import { estimateTokens } from '../context/roman-client-context.renderer';
import { isRomanPlaybookEnabled } from './roman-playbook.feature';
import {
  PLAYBOOK_SECTION_KEYS,
  validateCoachPlaybook,
  type CoachPlaybookContent,
  type PlaybookItem,
  type PlaybookSectionName,
  type PlaybookSubstitution,
} from './coach-playbook.schema';

export const COACH_METHOD_CACHE_TTL_MS = 10 * 60_000;
export const COACH_METHOD_CACHE_MAX = 200;
/** Most items rendered per section (the strongest evidence first). */
export const COACH_METHOD_SECTION_ITEMS_MAX = 12;

export const COACH_METHOD_HEADING = '# COACH METHOD';
export const COACH_METHOD_INSTRUCTION =
  'This is how the client’s coach trains, feeds and recovers clients. Shape your advice to it. ' +
  'Never mention a playbook or say that this was learned, and never quote the coach’s notes.';

const SECTION_TITLES: Record<PlaybookSectionName, string> = {
  exercises: 'Exercises',
  training: 'Training',
  diet: 'Nutrition',
  recovery: 'Recovery',
};

const LIST_LABELS: Record<string, string> = {
  go_to: 'Go-to',
  avoid: 'Avoid',
  substitutions: 'Swap',
  cues: 'Cue',
  warm_up: 'Warm-up',
  split: 'Split',
  frequency: 'Frequency',
  progression: 'Progression',
  volume_intensity: 'Volume and intensity',
  failure: 'Training to failure',
  deload: 'Deloads',
  cardio: 'Cardio',
  missed_sessions: 'Missed sessions',
  plateaus: 'Plateaus',
  macro_method: 'Macros',
  protein: 'Protein',
  flexibility: 'Flexibility',
  meal_timing: 'Meal timing',
  cut_bulk: 'Cutting and bulking',
  refeeds: 'Refeeds',
  supplements_endorse: 'Supplements used',
  supplements_reject: 'Supplements not used',
  bad_day: 'After an off day',
  sleep_target: 'Sleep',
  wind_down: 'Wind-down',
  poor_sleep_low_hrv: 'Poor sleep or low HRV',
  rest_days: 'Rest days',
};

/** Item text cannot open or close a tag inside the block. */
const plain = (s: string): string => s.replace(/[<>]/g, '').trim();

interface Line {
  readonly order: number;
  readonly text: string;
  readonly stated: boolean;
  readonly evidence: number;
}

type AnyItem = PlaybookItem | PlaybookSubstitution;

function itemText(it: AnyItem): string {
  if ('use' in it) {
    const when = it.when ? ` (${plain(it.when)})` : '';
    return `${plain(it.use)} instead of ${plain(it.for)}${when}`;
  }
  return plain(it.text);
}

function sectionLines(content: CoachPlaybookContent, section: PlaybookSectionName): string[] {
  const lists: Partial<Record<string, readonly AnyItem[]>> = content.sections[section];
  const lines: Line[] = [];
  for (const key of PLAYBOOK_SECTION_KEYS[section]) {
    for (const it of lists[key] ?? []) {
      const body = itemText(it);
      if (!body) continue;
      lines.push({
        order: lines.length,
        text: `- ${LIST_LABELS[key] ?? key}: ${body}`,
        stated: it.basis === 'stated',
        evidence: it.evidence_count,
      });
    }
  }
  // Over the cap: keep stated items, then the strongest evidence; render in schema order.
  return [...lines]
    .sort((a, b) => Number(b.stated) - Number(a.stated) || b.evidence - a.evidence || a.order - b.order)
    .slice(0, COACH_METHOD_SECTION_ITEMS_MAX)
    .sort((a, b) => a.order - b.order)
    .map((l) => l.text);
}

/** The rendered block and its red-line phrases, or null when nothing is known. */
export function renderCoachMethod(
  content: CoachPlaybookContent,
): { block: string; redLines: string[] } | null {
  const parts: string[] = [];
  for (const section of Object.keys(PLAYBOOK_SECTION_KEYS) as PlaybookSectionName[]) {
    const lines = sectionLines(content, section);
    if (lines.length > 0) parts.push(`${SECTION_TITLES[section]}:\n${lines.join('\n')}`);
  }
  const redLines = content.red_lines.map((r) => plain(r.text)).filter((t) => t.length > 0);
  if (redLines.length > 0) {
    parts.push(`Rules this coach never breaks:\n${redLines.map((t) => `- ${t}`).join('\n')}`);
  }
  if (parts.length === 0) return null;
  const block = `${COACH_METHOD_HEADING}\n${COACH_METHOD_INSTRUCTION}\n<coach_method>\n${parts.join('\n\n')}\n</coach_method>`;
  return { block, redLines };
}

@Injectable()
export class RomanCoachMethodAugmenter implements RomanTurnAugmenter {
  readonly kind = 'coach_method' as const;
  private readonly logger = new Logger(RomanCoachMethodAugmenter.name);
  private readonly cache = new Map<string, { at: number; value: RomanTurnAugment | null }>();

  constructor(
    private readonly prisma: PrismaService,
    // @Global AiCreditsModule; without it no head coach can be resolved, so no block.
    @Optional()
    private readonly budget: CoachAIBudgetService | null = null,
  ) {}

  async augment(
    caller: RomanAugmentCaller,
    _bundle: RomanClientContextBundle,
    _userMessage: string,
  ): Promise<RomanTurnAugment | null> {
    if (!isRomanPlaybookEnabled() || caller.role !== 'student' || !this.budget) return null;
    const headCoachId = await this.headCoachOf(caller);
    if (!headCoachId) return null;

    const active = await this.prisma.coachPlaybook.findFirst({
      where: { coach_id: headCoachId, status: 'active' },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    if (!active) return null;

    const key = `${headCoachId}:${active.version}`;
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < COACH_METHOD_CACHE_TTL_MS) return hit.value;
    if (hit) this.cache.delete(key);

    const row = await this.prisma.coachPlaybook.findFirst({
      where: { coach_id: headCoachId, version: active.version, status: 'active' },
      select: { sections: true, red_lines: true },
    });
    if (!row) return null;
    const value = this.build(row.sections, row.red_lines);
    if (this.cache.size >= COACH_METHOD_CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { at: now, value });
    return value;
  }

  /** Current live coach (roman-coach-scope rule), folded into its head coach. */
  private async headCoachOf(caller: RomanAugmentCaller): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: caller.id },
      select: { role: true, coach: { select: { id: true, role: true, deleted_at: true } } },
    });
    if (!user || !this.budget) return null;
    const { coachId } = resolveRomanCoachScope({
      userRole: user.role,
      callerRole: caller.role,
      coach: user.coach,
      overlay: null,
    });
    return coachId ? this.budget.resolveHeadCoachId(coachId) : null;
  }

  private build(sections: unknown, redLines: unknown): RomanTurnAugment | null {
    const checked = validateCoachPlaybook({ sections, red_lines: redLines });
    if (!checked.ok) {
      this.logger.warn(`roman.coach_method_invalid issues=${checked.issues.length}`);
      return null;
    }
    const rendered = renderCoachMethod(checked.value);
    if (!rendered) return null;
    return {
      block: rendered.block,
      hash: createHash('sha256').update(rendered.block).digest('hex'),
      estimated_tokens: estimateTokens(rendered.block),
      ...(rendered.redLines.length > 0 ? { post_check: { red_lines: rendered.redLines } } : {}),
    };
  }
}
