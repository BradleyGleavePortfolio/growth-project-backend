/**
 * Roman post-check — server-side, before emit (PLAN_roman_intelligence §4.8).
 *
 * A hit REWRITES the reply to a safe template (or a safe restatement of the
 * client's real numbers). It never appends a "note". Every hit is listed in
 * `guardrails_applied`. Pure function: no I/O.
 *
 * Checks, in order:
 *   1. calorie_floor       — a kcal number below the floor framed as intake advice
 *   2. target_mismatch     — a daily target that differs >10% from client_data.targets
 *   3. ungrounded_number   — a "target"/"today" number that is not in client_data
 *   4. diagnosis_language  — "you have <condition>", diagnos*, treat*, cure, prescri*, dose
 *   5. banned_substance    — steroids/SARMs/… plus diuretics, laxatives, insulin for weight loss
 *   6. referral_added      — mandatory physician line for medical_scope / injury_pain
 *   7. voice_scrub         — emoji removed; exclamations beyond the session allowance
 */

import type { SafetyClass } from './safety-router';
import { ROMAN_PHYSICIAN_LINE_INJURY, ROMAN_PHYSICIAN_LINE_MEDICAL } from './safety-router';

/**
 * The slice of the R3 PostCheckContext the post-check reads. Declared
 * structurally here so R4 does not depend on R3's module; the full
 * PostCheckContext satisfies it as-is.
 */
export interface PostCheckContext {
  targets: {
    source: 'coach_set' | 'onboarding_calculated' | 'none';
    calories: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    fiber_g?: number | null;
    water_ml?: number | null;
    meals_per_day?: number | null;
  };
  today: {
    kcal: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    meals_logged: number;
    remaining_kcal: number | null;
    remaining_protein_g: number | null;
    remaining_carbs_g: number | null;
    remaining_fat_g: number | null;
    pct_kcal: number | null;
    pct_protein: number | null;
  };
  last_7_days: {
    days_logged: number;
    avg_kcal_on_logged_days: number | null;
    avg_protein_g_on_logged_days: number | null;
    days_within_10pct_kcal: number | null;
  };
  macro_method: { floor_kcal: number | null };
  coach: { has_coach: boolean; coach_first_name: string | null };
}

export interface PostCheckInput {
  routerClass: SafetyClass;
  context: PostCheckContext | null;
  /** Floor used when no context is available. */
  fallbackFloorKcal?: number;
  /** Whether this turn may still spend the single per-session exclamation. */
  exclamationAllowed: boolean;
}

export interface PostCheckResult {
  text: string;
  guardrails_applied: string[];
  rewritten: boolean;
}

// "Intake advice" framing: the sentence tells the client how much to eat.
const ADVICE_FRAMING =
  /\b(aim(ing)? for|stick to|drop( down)? to|cut( down)? to|go down to|bring it down to|keep it (at|under|below)|stay (at|under|below)|limit (yourself |it )?to|no more than|cap it at|intake of|should (be )?(eat|have|get|consume)(ing)?|try (eating|to eat)|eat (only|just|around|about)|(a|per) day|daily)\b/i;
const KCAL_NUMBER = /\b(\d{1,2},?\d{3}|\d{3,4})\s?(kcal|calories|cal)\b/gi;
// "115 g protein" and "protein … 115 g" orders.
const MACRO_NUMBER =
  /\b(\d{2,4})\s?g(?:rams?)?\s+(?:of\s+)?(protein|carbs?|carbohydrates|fat|fats)\b/gi;
const MACRO_NUMBER_REVERSED =
  /\b(protein|carbs?|carbohydrates|fat|fats)\b[^.\d]{0,40}?\b(\d{2,4})\s?g\b/gi;
// Claims about the client's targets / logged data (must be grounded).
const TARGET_FRAMING = /\b(target|goal|prescribed|set (at|to)|your daily|per day|a day|daily)\b/i;
const TODAY_FRAMING =
  /\b(so far|logged|remaining|left|have had|you'?ve had|you have eaten|consumed|you are at|you'?re at|sitting at)\b/i;

const DIAGNOSIS: RegExp[] = [
  /\byou (probably |likely |might |may |could |definitely |clearly )?have (a |an |some |mild |early )?(?:[a-z-]+ ){0,2}(tendinitis|tendonitis|bursitis|arthritis|sprain|strain|tear|fracture|hernia|sciatica|plantar fasciitis|shin splints|diabetes|hypertension|deficiency|infection|disorder|syndrome|inflammation|impingement|[a-z]+itis)\b/i,
  /\b(it|this|that) (sounds|looks|seems) like (a |an )?(tendinitis|tendonitis|bursitis|arthritis|sprain|strain|tear|fracture|hernia|sciatica|[a-z]+itis|impingement)\b/i,
  /\bdiagnos(e|is|ed|ing)\b/i,
  /\btreat(s|ed|ing|ment)?\b(?! yourself)(?! it as)/i,
  /\bcure(s|d)?\b/i,
  /\bprescri(be|bed|ption|ptions)\b/i,
  /\b(dose|dosage|dosing)\b/i,
];

const BANNED: RegExp[] = [
  /\b(anabolic\s+steroids?|steroids?|sarms?|clenbuterol|ephedrine|dnp|trenbolone|hgh|growth hormone)\b/i,
  /\b(starv(e|ation|ing)|water\s+fast(?:ing)?(?:\s+for\s+\d+\s+days?)?|hcg\s+diet|cleanse|detox tea|juice cleanse)\b/i,
  /\b(diuretics?|laxatives?|water pills?)\b/i,
  /\binsulin\b[^.]{0,60}\b(weight|fat|lean(er)?|cut(ting)?|shred(ded)?)\b/i,
  /\b(purge|purging)\b[^.]{0,40}\b(calories|meal|food)\b/i,
];

// Pictographs, dingbats, flags, plus the variation selector / ZWJ joiners on their own.
const EMOJI = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|\u{FE0F}|\u{200D}/gu;

function coachName(ctx: PostCheckContext | null): string {
  return ctx?.coach.has_coach && ctx.coach.coach_first_name
    ? ctx.coach.coach_first_name
    : 'your coach';
}

function floorOf(ctx: PostCheckContext | null, fallback: number): number {
  return ctx?.macro_method.floor_kcal ?? fallback;
}

function toNumber(raw: string): number {
  return parseInt(raw.replace(/,/g, ''), 10);
}

/** Every number Roman is allowed to quote as a "today" or "target" fact. */
function groundedNumbers(ctx: PostCheckContext): Set<number> {
  const out = new Set<number>();
  const add = (n: number | null | undefined) => {
    if (typeof n === 'number' && Number.isFinite(n)) out.add(Math.round(n));
  };
  const t = ctx.targets;
  [t.calories, t.protein_g, t.carbs_g, t.fat_g, t.fiber_g, t.water_ml, t.meals_per_day].forEach(
    add,
  );
  const d = ctx.today;
  [
    d.kcal,
    d.protein_g,
    d.carbs_g,
    d.fat_g,
    d.remaining_kcal,
    d.remaining_protein_g,
    d.remaining_carbs_g,
    d.remaining_fat_g,
    d.pct_kcal,
    d.pct_protein,
    d.meals_logged,
  ].forEach(add);
  [
    ctx.last_7_days.avg_kcal_on_logged_days,
    ctx.last_7_days.avg_protein_g_on_logged_days,
    ctx.last_7_days.days_logged,
    ctx.last_7_days.days_within_10pct_kcal,
  ].forEach(add);
  add(ctx.macro_method.floor_kcal);
  return out;
}

function restateTargets(ctx: PostCheckContext | null, fallbackFloor: number): string {
  const coach = coachName(ctx);
  const calories = ctx?.targets.calories ?? null;
  if (!ctx || ctx.targets.source === 'none' || calories === null) {
    return `You do not have daily targets set yet, so I will not guess at numbers. ${coach === 'your coach' ? 'Your coach' : coach} can set them from Messages. I will not suggest going below ${fallbackFloor.toLocaleString('en-US')} kcal a day.`;
  }
  const t = ctx.targets;
  const who = t.source === 'coach_set' ? `${coach} set` : 'the app calculated';
  const macros = [
    t.protein_g != null ? `${t.protein_g} g protein` : null,
    t.carbs_g != null ? `${t.carbs_g} g carbs` : null,
    t.fat_g != null ? `${t.fat_g} g fat` : null,
  ]
    .filter(Boolean)
    .join(', ');
  const today =
    ctx.today.meals_logged > 0 && ctx.today.remaining_kcal != null
      ? ` So far today you have logged ${ctx.today.kcal} kcal and ${ctx.today.protein_g} g protein, leaving ${ctx.today.remaining_kcal} kcal.`
      : '';
  return `Your daily target is ${calories.toLocaleString('en-US')} kcal${macros ? ` (${macros})` : ''}, which ${who}.${today} I will not suggest different targets; if you would like them reviewed, message ${coach}.`;
}

/**
 * Rewrite templates (owner ruling 2026-09-30 16:38: warm, useful, a safe next
 * step inside the plan, offer to message the coach, then the physician line).
 */
export const ROMAN_POST_CHECK_TEMPLATES = {
  medical: (ctx: PostCheckContext | null) =>
    `I should not name what might be causing that, and I will not guess. What I can offer: stop any movement that hurts today, keep the rest of your session pain-free or at a lighter intensity, and rest the area. Message ${coachName(ctx)} so the plan can be adjusted around it, and I can help you word that. ${ROMAN_PHYSICIAN_LINE_INJURY}`,
  banned: (ctx: PostCheckContext | null) =>
    `I cannot help with that. It is outside what is safe for me to advise. What I can do is help you stay on your plan: hold your current targets, keep logging, and train the sessions as written. ${coachName(ctx) === 'your coach' ? 'Your coach' : coachName(ctx)} can talk through options that fit your plan, and a physician is the right person for anything medical.`,
  referral_medical: ROMAN_PHYSICIAN_LINE_MEDICAL,
  referral_injury: ROMAN_PHYSICIAN_LINE_INJURY,
};

export function postCheckRomanReply(reply: string, input: PostCheckInput): PostCheckResult {
  const applied: string[] = [];
  const ctx = input.context;
  const floor = floorOf(ctx, input.fallbackFloorKcal ?? 1500);
  let text = reply ?? '';
  let rewritten = false;

  const sentences = text.split(/(?<=[.!?])\s+/);

  // 1. kcal below the floor framed as intake advice. Grounded numbers (e.g.
  //    "670 kcal left") are facts, not advice, and are skipped.
  const groundedSet = ctx ? groundedNumbers(ctx) : new Set<number>();
  for (const s of sentences) {
    if (!ADVICE_FRAMING.test(s)) continue;
    for (const m of s.matchAll(KCAL_NUMBER)) {
      const n = toNumber(m[1]);
      if (groundedSet.has(n)) continue;
      if (n >= 400 && n < floor) {
        applied.push('calorie_floor');
        break;
      }
    }
    if (applied.includes('calorie_floor')) break;
  }

  // 2 + 3. target mismatch / ungrounded "today"/"target" numbers
  if (ctx && !applied.length) {
    const grounded = groundedNumbers(ctx);
    const t = ctx.targets;
    outer: for (const s of sentences) {
      const isTarget = TARGET_FRAMING.test(s);
      const isToday = TODAY_FRAMING.test(s);
      if (!isTarget && !isToday) continue;
      for (const m of s.matchAll(KCAL_NUMBER)) {
        const n = toNumber(m[1]);
        if (grounded.has(n)) continue;
        if (isTarget && t.calories != null && Math.abs(n - t.calories) / t.calories > 0.1) {
          applied.push('target_mismatch');
          break outer;
        }
        if (isToday || isTarget) {
          applied.push('ungrounded_number');
          break outer;
        }
      }
      const macroHits: Array<{ n: number; macro: string }> = [
        ...[...s.matchAll(MACRO_NUMBER)].map((m) => ({ n: toNumber(m[1]), macro: m[2] })),
        ...[...s.matchAll(MACRO_NUMBER_REVERSED)].map((m) => ({ n: toNumber(m[2]), macro: m[1] })),
      ];
      for (const { n, macro } of macroHits) {
        if (grounded.has(n)) continue;
        const key = /protein/i.test(macro)
          ? 'protein_g'
          : /carb/i.test(macro)
            ? 'carbs_g'
            : 'fat_g';
        const target = t[key];
        if (isTarget && target != null) {
          if (Math.abs(n - target) / target > 0.1) {
            applied.push('target_mismatch');
            break outer;
          }
          continue; // within 10% of the real target: tolerated rounding
        }
        if (isToday) {
          applied.push('ungrounded_number');
          break outer;
        }
      }
    }
  }

  if (
    applied.includes('calorie_floor') ||
    applied.includes('target_mismatch') ||
    applied.includes('ungrounded_number')
  ) {
    text = restateTargets(ctx, floor);
    rewritten = true;
  }

  // 4. diagnosis / treatment language
  if (!rewritten && DIAGNOSIS.some((rx) => rx.test(text))) {
    applied.push('diagnosis_language');
    text = ROMAN_POST_CHECK_TEMPLATES.medical(ctx);
    rewritten = true;
  }

  // 5. banned substances / protocols
  if (!rewritten && BANNED.some((rx) => rx.test(text))) {
    applied.push('banned_substance');
    text = ROMAN_POST_CHECK_TEMPLATES.banned(ctx);
    rewritten = true;
  }

  // 6. mandatory referral line for the medical / injury classes
  if (
    !rewritten &&
    (input.routerClass === 'medical_scope' || input.routerClass === 'injury_pain')
  ) {
    if (!/\b(physician|doctor)\b/i.test(text)) {
      applied.push('referral_added');
      const line =
        input.routerClass === 'medical_scope'
          ? ROMAN_POST_CHECK_TEMPLATES.referral_medical
          : ROMAN_POST_CHECK_TEMPLATES.referral_injury;
      text = `${text.trim()} ${line}`;
    }
  }

  // 7. voice scrub — emoji, exclamation allowance
  const noEmoji = text.replace(EMOJI, '');
  if (noEmoji !== text) {
    applied.push('voice_scrub');
    text = noEmoji
      .replace(/ +([.!?,])/g, '$1')
      .replace(/ {2,}/g, ' ')
      .trim();
  }
  const bangs = (text.match(/!/g) ?? []).length;
  const allowedBangs = input.exclamationAllowed ? 1 : 0;
  if (bangs > allowedBangs) {
    if (!applied.includes('voice_scrub')) applied.push('voice_scrub');
    let seen = 0;
    text = text.replace(/!/g, () => (++seen <= allowedBangs ? '!' : '.'));
  }

  return { text, guardrails_applied: applied, rewritten };
}
