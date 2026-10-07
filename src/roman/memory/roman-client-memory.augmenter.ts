/**
 * Roman v1.1 R11-M5 — the client-memory block in a client's turn.
 *
 * Plugs into the R11-00 turn-augmenter seam as kind 'client_memory'. Inert
 * unless FEATURE_ROMAN_MEMORY is on and the caller is a client (role
 * `student`). Reads only the caller's own rows (client_id = caller.id; never
 * an id from the bundle or the message): live notes (not superseded, not
 * expired), newest 40, plus the newest 2 week and 1 month summaries if any.
 *
 * Sanitised, capped at 2,500 characters. Memory consent (client-ai-v5) is
 * enforced by the R11-T2A seam in RomanService: without the 'memory' grant the
 * block is dropped and the turn is sent exactly as today.
 */

import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { sanitizePromptInput } from '../../ai/utils/sanitize-prompt-input';
import type {
  RomanAugmentCaller,
  RomanTurnAugment,
  RomanTurnAugmenter,
} from '../augment/roman-turn-augmenter';
import { isRomanMemoryEnabled } from './roman-memory.feature';

export { ROMAN_CLIENT_MEMORY_AUGMENTER } from '../augment/roman-turn-augmenter';

export const ROMAN_CLIENT_MEMORY_LIMITS = Object.freeze({
  max_notes: 40,
  max_week_summaries: 2,
  max_month_summaries: 1,
  max_block_chars: 2_500,
  max_note_chars: 200,
  max_summary_chars: 400,
});

const KIND_LABELS: Readonly<Record<string, string>> = {
  preference: 'Preference',
  schedule: 'Schedule',
  household: 'Household',
  work: 'Work',
  injury_history: 'Injury history',
  goal: 'Goal',
  equipment: 'Equipment',
  diet_like: 'Food they like',
  diet_dislike: 'Food they dislike',
  travel: 'Travel',
  other: 'Note',
};

const HEADER =
  '# CLIENT MEMORY\n' +
  'Things this client told you in earlier chats, dated. Use them naturally when relevant; ' +
  'do not list them back. When one disagrees with client_data, prefer client_data.';
const OPEN = '<client_memory>';
const CLOSE = '</client_memory>';

/** One line of free text: sanitised, no tags, no line breaks, clamped. */
function clean(text: string, max: number): string {
  return sanitizePromptInput(text, max)
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const ymd = (d: Date): string => d.toISOString().slice(0, 10);

@Injectable()
export class RomanClientMemoryAugmenter implements RomanTurnAugmenter {
  readonly kind = 'client_memory' as const;

  constructor(private readonly prisma: PrismaService) {}

  async augment(caller: RomanAugmentCaller): Promise<RomanTurnAugment | null> {
    if (!isRomanMemoryEnabled() || caller.role !== 'student') return null;
    const clientId = caller.id;
    const now = new Date();
    const L = ROMAN_CLIENT_MEMORY_LIMITS;
    const [notes, weeks, months] = await Promise.all([
      this.prisma.romanClientNote.findMany({
        where: {
          client_id: clientId,
          superseded_at: null,
          OR: [{ expires_at: null }, { expires_at: { gt: now } }],
        },
        orderBy: { source_at: 'desc' },
        take: L.max_notes,
        select: { kind: true, text: true, source_at: true },
      }),
      this.prisma.romanClientSummary.findMany({
        where: { client_id: clientId, period: 'week' },
        orderBy: { period_start: 'desc' },
        take: L.max_week_summaries,
        select: { period_start: true, text: true },
      }),
      this.prisma.romanClientSummary.findMany({
        where: { client_id: clientId, period: 'month' },
        orderBy: { period_start: 'desc' },
        take: L.max_month_summaries,
        select: { period_start: true, text: true },
      }),
    ]);

    const lines: string[] = [];
    for (const n of notes) {
      const text = clean(n.text, L.max_note_chars);
      if (text) lines.push(`${ymd(n.source_at)} · ${KIND_LABELS[n.kind] ?? 'Note'} · ${text}`);
    }
    for (const [rows, label] of [
      [weeks, 'Week summary'],
      [months, 'Month summary'],
    ] as const) {
      for (const s of rows) {
        const text = clean(s.text, L.max_summary_chars);
        if (text) lines.push(`${ymd(s.period_start)} · ${label} · ${text}`);
      }
    }
    if (lines.length === 0) return null;

    // Whole lines only, newest notes first, until the block cap.
    let body = '';
    for (const line of lines) {
      const next = body ? `${body}\n${line}` : line;
      if (`${HEADER}\n${OPEN}\n${next}\n${CLOSE}`.length > L.max_block_chars) break;
      body = next;
    }
    if (!body) return null;
    const block = `${HEADER}\n${OPEN}\n${body}\n${CLOSE}`;
    return {
      block,
      hash: createHash('sha256').update(block).digest('hex'),
      estimated_tokens: Math.ceil(block.length / 3.5),
    };
  }
}
