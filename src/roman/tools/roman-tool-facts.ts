/**
 * R11-T3: the numbers a tool result may be quoted with, for the reply post-check.
 *
 * The post-check (roman-post-check.ts) judges kcal and macro-gram numbers only. Every other number a
 * tool returns (sleep, HRV, resting heart rate, steps, weight, water, sets, reps, loads, RPE, minutes,
 * counts) is never rewritten, so it needs no fact. A tool declares its facts (RomanToolResult.facts);
 * personal_baselines (R11-W1) is also read here by field name, so its protein and active-kcal numbers
 * count whether or not that tool declares them. Unparseable or clamped content adds nothing.
 */

import type { RomanToolFacts, RomanToolResult } from './roman-tool.types';

export const ROMAN_TOOL_GRAM_KEYS = ['protein_g', 'carbs_g', 'fat_g'] as const;
export type RomanToolGramKey = (typeof ROMAN_TOOL_GRAM_KEYS)[number];
export type RomanToolGramLists = Record<RomanToolGramKey, number[]>;

export const emptyGrams = (): RomanToolGramLists => ({ protein_g: [], carbs_g: [], fat_g: [] });

interface BaselineRowLike {
  metric?: unknown;
  status?: unknown;
  normal?: Record<string, unknown> | null;
  last_7?: Record<string, unknown> | null;
  change?: unknown;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** personal_baselines by field name: per metric, the normal and last-7 stats shown and the change. */
export function baselineFacts(content: string): RomanToolFacts {
  let rows: unknown;
  try {
    rows = (JSON.parse(content) as { metrics?: unknown } | null)?.metrics;
  } catch {
    return {};
  }
  if (!Array.isArray(rows)) return {};
  const shown = (metric: string): number[] =>
    rows.flatMap((raw: unknown) => {
      const row = (raw ?? {}) as BaselineRowLike;
      if (row.metric !== metric || row.status !== 'ok') return [];
      const stats = [row.normal, row.last_7].flatMap((w) =>
        ['median', 'mean', 'min', 'max'].map((k) => w?.[k]),
      );
      return [...stats, isNum(row.change) ? Math.abs(row.change) : null].filter(isNum);
    });
  const protein = shown('protein_g');
  return {
    burned_past_kcal: shown('active_kcal'),
    intake_past_g: { protein_g: protein },
    average_past_g: { protein_g: protein },
  };
}

/** Every fact list a successful result adds (declared, plus personal_baselines by field name). */
export function toolFactsOf(name: string, r: RomanToolResult): RomanToolFacts[] {
  const declared = r.facts ?? {};
  return name === 'personal_baselines' ? [declared, baselineFacts(r.content)] : [declared];
}
