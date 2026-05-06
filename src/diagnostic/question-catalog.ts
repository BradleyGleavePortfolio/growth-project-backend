import * as fs from 'fs';
import * as path from 'path';
import type { DiagnosticCatalogResponse, DiagnosticQuestionPublic } from './diagnostic.dto';

/**
 * The 40-question diagnostic catalog. Source of truth: prisma/seed-diagnostic.json.
 *
 * Loaded once at module init. The file is hand-curated marketing-grade copy —
 * the doctrine spec asserts the section/question shape so a future PR can't
 * accidentally drift the wording.
 */

interface RawQuestion {
  id: number;
  section: 'income' | 'body' | 'lifestyle';
  text: string;
}

export interface RawCatalog {
  version: string;
  scale_label: string;
  sections: Array<{ id: string; title: string; max_score: number; question_count: number }>;
  buckets: {
    section: Array<{ id: string; min_pct: number; max_pct: number }>;
    overall: Array<{ id: string; min: number; max: number; headline: string }>;
  };
  questions: RawQuestion[];
}

const SEED_PATH = path.resolve(__dirname, '..', '..', 'prisma', 'seed-diagnostic.json');

let cached: RawCatalog | null = null;

export function loadCatalog(): RawCatalog {
  if (cached) return cached;
  const raw = fs.readFileSync(SEED_PATH, 'utf8');
  const parsed = JSON.parse(raw) as RawCatalog;
  if (parsed.questions.length !== 40) {
    throw new Error(
      `seed-diagnostic.json must contain exactly 40 questions; found ${parsed.questions.length}`,
    );
  }
  cached = parsed;
  return parsed;
}

export function getCatalogResponse(): DiagnosticCatalogResponse {
  const c = loadCatalog();
  const questions: DiagnosticQuestionPublic[] = c.questions.map((q) => ({
    id: q.id,
    section: q.section,
    text: q.text,
  }));
  return {
    version: c.version,
    scale_label: c.scale_label,
    sections: c.sections,
    questions,
  };
}

export function questionIdsBySection(): Record<'income' | 'body' | 'lifestyle', number[]> {
  const c = loadCatalog();
  const out: Record<'income' | 'body' | 'lifestyle', number[]> = {
    income: [],
    body: [],
    lifestyle: [],
  };
  for (const q of c.questions) out[q.section].push(q.id);
  return out;
}

export function overallBucket(rawTotal: number): { id: 'stuck' | 'moving' | 'compounding'; headline: string } {
  const c = loadCatalog();
  for (const b of c.buckets.overall) {
    if (rawTotal >= b.min && rawTotal <= b.max) {
      return { id: b.id as 'stuck' | 'moving' | 'compounding', headline: b.headline };
    }
  }
  // Defensive default — out-of-range scores fall to 'stuck' rather than throwing,
  // because GET handlers must never 5xx on stored historical rows.
  return { id: 'stuck', headline: c.buckets.overall[0]?.headline ?? '' };
}

export function sectionBucket(pct: number): 'stuck' | 'moving' | 'compounding' {
  // Brief's bands are 0-30 / 31-60 / 61-100. We round normalized percentages
  // before bucketing so a 60.4 still lands in 'moving' rather than tipping
  // into 'compounding' — operators read the integer percent in the UI.
  const rounded = Math.round(pct);
  if (rounded <= 30) return 'stuck';
  if (rounded <= 60) return 'moving';
  return 'compounding';
}
