/**
 * Roman v1.1 slice R11-P4: the coach-method block ("# COACH METHOD", kind 'coach_method') in a grounded client
 * turn, behind FEATURE_ROMAN_PLAYBOOK. Null unless the flag is on and the caller is a student. The coach is the
 * client's CURRENT live coach (roman-coach-scope.ts), folded into its head coach (resolveHeadCoachId); the user
 * row is read on every turn, so a former coach's playbook is never used after a reassignment. Only that head
 * coach's active playbook, re-validated with validateCoachPlaybook (invalid -> null). Red lines become plain
 * rules and post_check.red_lines. Whether the block may be sent is the R11-T2A 'memory' scope rule.
 * Cache: rendered block by (coach_id, version), 10 minutes, at most 200 keys.
 * PLAYBOOK-WITHDRAW: a version is used only while every client eligible at its build (the collector's one client
 * definition: a live client of the team holding the memory grant, whose texts and figures it learned from) still
 * is, read through the one egress consent path on every turn (never cached; a failed read is no grant). Otherwise
 * the turn gets no block (Roman still answers), the version is marked stale (superseded, so no other turn on any
 * machine uses it) and the scheduler rebuilds it at once from what the collector may still read.
 */
import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { CoachAIBudgetService } from '../../ai-credits/coach-ai-budget.service';
import { AiEgressService } from '../../ai-egress/ai-egress.service';
import type { RomanAugmentCaller, RomanTurnAugment, RomanTurnAugmenter } from '../augment/roman-turn-augmenter';
import type { RomanClientContextBundle } from '../context/roman-client-context.types';
import { resolveRomanCoachScope } from '../context/roman-coach-scope';
import { estimateTokens } from '../context/roman-client-context.renderer';
import { isRomanPlaybookEnabled } from './roman-playbook.feature';
import { PlaybookBuilderScheduler } from './playbook-builder.scheduler';
import { PlaybookSourceCollector, playbookLedgerDigest } from './playbook-sources';
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
export const COACH_METHOD_SECTION_ITEMS_MAX = 12; // per section, stated first, then the strongest evidence
export const COACH_METHOD_HEADING = '# COACH METHOD';
export const COACH_METHOD_INSTRUCTION =
  'This is how the client’s coach trains, feeds and recovers clients. Shape your advice to it. ' +
  'Never mention a playbook or say that this was learned, and never quote the coach’s notes.';

// List labels: the key in words, with a few clearer names.
const LABELS: Record<string, string> = {
  substitutions: 'Swap',
  volume_intensity: 'Volume and intensity',
  failure: 'Training to failure',
  supplements_endorse: 'Supplements used',
  supplements_reject: 'Supplements not used',
  bad_day: 'After an off day',
  poor_sleep_low_hrv: 'Poor sleep or low HRV',
  sleep_target: 'Sleep',
};
const labelOf = (k: string) => LABELS[k] ?? `${k.charAt(0).toUpperCase()}${k.slice(1).replace(/_/g, ' ')}`;

/** Item text cannot open or close a tag inside the block. */
const plain = (s: string): string => s.replace(/[<>]/g, '').trim();

type Line = { order: number; text: string; stated: boolean; evidence: number };
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
      const text = `- ${labelOf(key)}: ${body}`;
      lines.push({ order: lines.length, text, stated: it.basis === 'stated', evidence: it.evidence_count });
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
export function renderCoachMethod(content: CoachPlaybookContent): { block: string; redLines: string[] } | null {
  const parts: string[] = [];
  for (const section of Object.keys(PLAYBOOK_SECTION_KEYS) as PlaybookSectionName[]) {
    const lines = sectionLines(content, section);
    if (lines.length > 0) parts.push(`${section === 'diet' ? 'Nutrition' : labelOf(section)}:\n${lines.join('\n')}`);
  }
  const redLines = content.red_lines.map((r) => plain(r.text)).filter((t) => t.length > 0);
  if (redLines.length > 0) {
    parts.push(`Rules this coach never breaks:\n${redLines.map((t) => `- ${t}`).join('\n')}`);
  }
  if (parts.length === 0) return null;
  const block = `${COACH_METHOD_HEADING}\n${COACH_METHOD_INSTRUCTION}\n<coach_method>\n${parts.join('\n\n')}\n</coach_method>`;
  return { block, redLines };
}

/** A version's rendered block (cached), and what the live eligibility check compares against. */
type CoachMethodVersion = {
  at: number;
  value: RomanTurnAugment | null;
  ledger: Array<{ source_kind: string; source_id: string; client_id: string | null }>;
  digest: string;
  builtAt: number;
};

@Injectable()
export class RomanCoachMethodAugmenter implements RomanTurnAugmenter {
  readonly kind = 'coach_method' as const;
  private readonly logger = new Logger(RomanCoachMethodAugmenter.name);
  private readonly cache = new Map<string, CoachMethodVersion>();

  constructor(
    private readonly prisma: PrismaService,
    // @Global AiCreditsModule; without it no head coach can be resolved, so no block.
    // B31-D1 (agent 133): explicit token (a `T | null` param has no usable type metadata).
    @Optional()
    @Inject(CoachAIBudgetService)
    private readonly budget: CoachAIBudgetService | null = null,
    // PLAYBOOK-WITHDRAW (@Global AiEgressModule): without the one consent path, no block.
    @Optional()
    @Inject(AiEgressService)
    private readonly egress: AiEgressService | null = null,
    @Optional()
    @Inject(PlaybookBuilderScheduler)
    private readonly scheduler: PlaybookBuilderScheduler | null = null,
    // PLAYBOOK-WITHDRAW: the builds' client definition; without it, no block.
    @Optional()
    @Inject(PlaybookSourceCollector)
    private readonly collector: PlaybookSourceCollector | null = null,
  ) {}

  async augment(caller: RomanAugmentCaller, _bundle: RomanClientContextBundle, _message: string): Promise<RomanTurnAugment | null> {
    if (!isRomanPlaybookEnabled() || caller.role !== 'student') return null;
    if (!this.budget || !this.egress || !this.collector) return null;
    const headCoachId = await this.headCoachOf(caller);
    if (!headCoachId) return null;

    const active = await this.prisma.coachPlaybook.findFirst({
      where: { coach_id: headCoachId, status: 'active' },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    if (!active) return null;

    const entry = await this.versionOf(headCoachId, active.version);
    if (!entry?.value) return null;
    if (!(await this.noneLeftSinceBuild(headCoachId, entry))) {
      await this.markStale(headCoachId, active.version);
      return null;
    }
    return entry.value;
  }

  /** The rendered block, the version's ledger, digest and build time, cached by (coach_id, version). */
  private async versionOf(headCoachId: string, version: number): Promise<CoachMethodVersion | null> {
    const key = `${headCoachId}:${version}`;
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < COACH_METHOD_CACHE_TTL_MS) return hit;
    if (hit) this.cache.delete(key);

    const row = await this.prisma.coachPlaybook.findFirst({
      where: { coach_id: headCoachId, version, status: 'active' },
      select: {
        sections: true,
        red_lines: true,
        source_digest: true,
        built_at: true,
        sources: { select: { source_kind: true, source_id: true, client_id: true } },
      },
    });
    if (!row) return null;
    const entry: CoachMethodVersion = {
      at: now,
      value: this.build(row.sections, row.red_lines),
      ledger: row.sources,
      digest: row.source_digest,
      builtAt: row.built_at.getTime(),
    };
    const oldest = this.cache.size >= COACH_METHOD_CACHE_MAX ? this.cache.keys().next().value : undefined;
    if (oldest !== undefined) this.cache.delete(oldest);
    this.cache.set(key, entry);
    return entry;
  }

  /**
   * PLAYBOOK-WITHDRAW: no client eligible at the build has since turned AI off or left (a live read; a failed read is
   * no grant). The stored digest covers the ledger and the clients eligible at the build, so it must equal the digest
   * over the ledger and the clients eligible now, less any whose memory grant came after the build (a new grant never
   * retires a version). A version built before ledger-v2, or whose ledger rows were removed, never matches.
   */
  private async noneLeftSinceBuild(headCoachId: string, entry: CoachMethodVersion): Promise<boolean> {
    if (!this.collector || !this.egress) return false;
    const { consented } = await this.collector.eligibleClients(headCoachId);
    if (playbookLedgerDigest(entry.ledger, consented) === entry.digest) return true;
    const grantedAt = await this.egress.memoryGrantTimes(consented);
    const atBuild = consented.filter((id) => !((grantedAt.get(id)?.getTime() ?? 0) > entry.builtAt));
    return atBuild.length < consented.length && playbookLedgerDigest(entry.ledger, atBuild) === entry.digest;
  }

  /** PLAYBOOK-WITHDRAW: supersede the version; the turn that does starts the rebuild without that client. */
  private async markStale(headCoachId: string, version: number): Promise<void> {
    const { count } = await this.prisma.coachPlaybook.updateMany({
      where: { coach_id: headCoachId, version, status: 'active' },
      data: { status: 'superseded' },
    });
    this.logger.warn(`roman.coach_method_stale marked=${count}`);
    if (count > 0) void this.scheduler?.rebuildNow(headCoachId);
  }

  /** Current live coach (roman-coach-scope rule), folded into its head coach. */
  private async headCoachOf(caller: RomanAugmentCaller): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: caller.id },
      select: { role: true, coach: { select: { id: true, role: true, deleted_at: true } } },
    });
    if (!user || !this.budget) return null;
    const scope = { userRole: user.role, callerRole: caller.role, coach: user.coach, overlay: null };
    const { coachId } = resolveRomanCoachScope(scope);
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
