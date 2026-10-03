/**
 * Coach read model of a client's consultation (owner ruling 2026-09-30:
 * "make sure the coach sees every client's answers, in an easy way").
 * Pure: turns a stored answer snapshot into chapters of human-readable
 * question / answer pairs, plus screening and consent blocks.
 */
import { ageInYears } from '../macros/macro-calculator';
import {
  CHAPTER_KEYS,
  CHAPTER_TITLES,
  SCREEN_LABELS,
  type OptionLabel,
  type ScreenLabel,
} from './consultation-definitions';
import { SCREENING_KEYS, consentCopyVersion, type Answers } from './consultation-answers';

export interface ConsultationView {
  version: string;
  revision: number;
  revision_cause: string;
  submitted_at: string | null;
  saved_at: string;
  chapters: Array<{
    key: string;
    title: string;
    answers: Array<{ screen: string; question: string; answer_label: string }>;
  }>;
  screening: {
    any_yes: boolean;
    items: Array<{
      key: string;
      question: string;
      answer: 'yes' | 'no' | null;
      note: string | null;
    }>;
  };
  consent: { version: string | null; agreed_at: string | null };
}

export interface ConsultationSnapshot {
  version: string;
  revision: number;
  cause: string;
  answers: Answers;
  disclaimer_version: string | null;
  disclaimer_accepted_at: Date | null;
  screening_any_yes: boolean;
  created_at: Date;
}

const NOT_ANSWERED = 'Not answered';

function labelOf(options: OptionLabel[] | undefined, value: unknown): string {
  const hit = options?.find((o) => o.value === value);
  return hit ? hit.label : String(value);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatBody(v: unknown): string {
  if (!isRecord(v)) return NOT_ANSWERED;
  const metric = v.unit === 'metric';
  const h = typeof v.height_cm === 'number' ? v.height_cm : null;
  const lbs =
    typeof v.weight_lbs === 'number'
      ? v.weight_lbs
      : typeof v.weight_kg === 'number'
        ? v.weight_kg / 0.45359237
        : null;
  const parts: string[] = [];
  if (h !== null) {
    if (metric) parts.push(`${Math.round(h)} cm`);
    else {
      const inches = Math.round(h / 2.54);
      parts.push(`${Math.floor(inches / 12)} ft ${inches % 12} in (${Math.round(h)} cm)`);
    }
  }
  if (lbs !== null)
    parts.push(metric ? `${Math.round(lbs * 0.45359237)} kg` : `${Math.round(lbs)} lb`);
  return parts.join(', ') || NOT_ANSWERED;
}

function answerLabel(screen: ScreenLabel, a: Answers, now: Date): string {
  const v = a[screen.key];
  if (v === undefined || v === null) {
    return screen.key === 'B4' && a.B3 !== undefined ? 'No number, just the goal' : NOT_ANSWERED;
  }
  let main: string;
  switch (screen.key) {
    case 'B2':
      main =
        typeof v === 'string'
          ? `${formatDate(v)} (age ${ageInYears(new Date(`${v}T00:00:00.000Z`), now)})`
          : NOT_ANSWERED;
      break;
    case 'B3':
      main = formatBody(v);
      break;
    case 'B4':
      main = typeof v === 'number' ? `${Math.round(v)} lb` : NOT_ANSWERED;
      break;
    case 'C1':
      main = typeof v === 'string' ? formatDate(v) : NOT_ANSWERED;
      break;
    default:
      main = Array.isArray(v)
        ? v.map((x) => labelOf(screen.options, x)).join(', ')
        : labelOf(screen.options, v);
  }
  const extras: string[] = [];
  if (screen.detail_chips) {
    const chips = a[screen.detail_chips.key];
    if (Array.isArray(chips) && chips.length > 0) {
      extras.push(
        `${screen.detail_chips.label ?? 'Details'}: ${chips.map((x) => labelOf(screen.detail_chips?.options, x)).join(', ')}`,
      );
    }
  }
  if (screen.detail_text) {
    const t = a[screen.detail_text.key];
    if (typeof t === 'string' && t.trim().length > 0) extras.push(`"${t.trim()}"`);
  }
  return extras.length > 0 ? `${main}. ${extras.join('. ')}` : main;
}

export function buildConsultationView(
  snap: ConsultationSnapshot,
  meta: { submitted_at: Date | null; saved_at: Date },
  now: Date,
): ConsultationView {
  const a = snap.answers;
  const screening = new Set<string>(SCREENING_KEYS);
  const chapters: ConsultationView['chapters'] = [];
  for (const chapter of Object.keys(CHAPTER_KEYS).map(Number)) {
    const screens = SCREEN_LABELS.filter(
      (s) => s.chapter === chapter && s.key !== 'P0' && !screening.has(s.key),
    );
    if (screens.length === 0) continue;
    // Conditional screens (S3b) are listed only when they applied.
    const shown = screens.filter(
      (s) => s.key !== 'S3b' || a.S3 === 'home_some' || a.S3 === 'home' || a.S3b !== undefined,
    );
    chapters.push({
      key: CHAPTER_KEYS[chapter],
      title: CHAPTER_TITLES[chapter],
      answers: shown.map((s) => ({
        screen: s.key,
        question: s.question,
        answer_label: answerLabel(s, a, now),
      })),
    });
  }
  const items = SCREEN_LABELS.filter((s) => screening.has(s.key)).map((s) => {
    const v = a[s.key];
    const note = a[`${s.key}_note`];
    const answer: 'yes' | 'no' | null = v === 'yes' ? 'yes' : v === 'no' ? 'no' : null;
    return {
      key: s.key,
      question: s.question,
      answer,
      note: typeof note === 'string' && note.trim().length > 0 ? note.trim() : null,
    };
  });
  const p0 = isRecord(a.P0) ? a.P0 : null;
  return {
    version: snap.version,
    revision: snap.revision,
    revision_cause: snap.cause,
    submitted_at: meta.submitted_at?.toISOString() ?? null,
    saved_at: meta.saved_at.toISOString(),
    chapters,
    screening: { any_yes: items.some((i) => i.answer === 'yes'), items },
    consent: {
      version: snap.disclaimer_version ?? (p0 ? consentCopyVersion(p0) : null),
      agreed_at: snap.disclaimer_accepted_at?.toISOString() ?? null,
    },
  };
}
