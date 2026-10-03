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
  /** Optional extra kcal facts (food entries, wearable active energy, meal plan). */
  extra_kcal_facts?: number[];
}

export interface PostCheckInput {
  routerClass: SafetyClass;
  context: PostCheckContext | null;
  /** Floor used when no context is available. */
  fallbackFloorKcal?: number;
  /** Whether this turn may still spend the single per-session exclamation. */
  exclamationAllowed: boolean;
  /**
   * A-R3-1: true when the client's data could not be loaded for this turn.
   * Any personal number in the reply is then ungrounded by definition and is
   * replaced by the degraded-mode copy (never the "no targets yet" copy).
   */
  contextUnavailable?: boolean;
}

export interface PostCheckResult {
  text: string;
  guardrails_applied: string[];
  rewritten: boolean;
}

// ─── A-R4-3: typed number checks ─────────────────────────────────────────────
// A number is judged by WHAT the sentence does with it, never by whether the
// same digits appear somewhere in client_data:
//   - directive (tells the client how much to eat): a DAILY directive must be
//     at or above the floor and, when targets exist, within 10% of them;
//   - target statement ("your target is ..."): within 10% of that target;
//   - fact claim ("you have logged ...", "you averaged ..."): must match a
//     fact of the SAME unit and field family in client_data.
const DIRECTIVE =
  /\b(aim(ing)? for|stick (to|with)|drop( down)? to|cut( down| back)? to|go down to|bring it down to|keep (it|your intake|intake|yourself) (at|under|below|around|to)|stay (at|under|below|around)|limit (yourself |it |intake )?to|no more than|cap (it|yourself|intake) at|should (eat|have|get|consume)|try (eating|to eat|having)|eat (only|just|around|about|no more than|under|less than|roughly)|have (only|just)|only (eat|have)|you (could|can|might) (eat|have|go with|drop to|try)|go for|target of)\b/i;
const DAILY = /\b(a|per|each|every) day\b|\bdaily\b|\bin total\b|\bfor the (whole )?day\b|\btoday\b|\bthis week\b/i;
const MEAL =
  /\b(at|for|with) (breakfast|lunch|dinner|supper|your (next )?(meal|snack))\b|\b(this|next|per|each|a) (meal|snack)\b|\b(remaining|left|rest of (the|your) day)\b/i;
const TARGET_STMT = /\b(target|goal|prescribed|set (at|to)|your daily)\b/i;
const FACT =
  /\b(so far|logged|remaining|left|have had|you'?ve had|you have eaten|you ate|eaten|consumed|you are at|you'?re at|sitting at|averag(e|ed|ing)|burned|burnt)\b/i;
const KCAL_NUMBER = /\b(\d{1,2},\d{3}|\d{2,5})\s?(kcal|calories|cal)\b/gi;
const MACRO_NUMBER =
  /\b(\d{1,4})\s?g(?:rams?)?\s+(?:of\s+)?(protein|carbs?|carbohydrates|fat|fats)\b/gi;
const MACRO_NUMBER_REVERSED =
  /\b(protein|carbs?|carbohydrates|fat|fats)\b[^.\d]{0,40}?\b(\d{1,4})\s?g\b/gi;

// ─── A-R4-2: medication / treatment directives and false reassurance ────────
const MEDICATION_DIRECTIVE: RegExp[] = [
  /\b\d+(\.\d+)?\s?(mg|mcg|µg|milligrams?|micrograms?|iu|units of insulin)\b/i,
  /\b(take|taking|try|use|using|pop|start|grab|have)\s+(some\s+|an?\s+|a couple of\s+|two\s+)?(ibuprofen|advil|motrin|aleve|naproxen|acetaminophen|paracetamol|tylenol|aspirin|antibiotics?|painkillers?|pain ?relievers?|muscle relaxants?|anti-?inflammator(y|ies)|nsaids?|prednisone|cortisone|antihistamines?|benadryl|melatonin|sleeping pills?)\b/i,
  /\b(ibuprofen|advil|motrin|aleve|naproxen|acetaminophen|paracetamol|tylenol|aspirin|nsaids?|prednisone)\b[^.]{0,60}\b(twice|three times|every \d+ hours|daily|a day|per day|with food|before (bed|training))\b/i,
  /\b(increase|decrease|lower|raise|stop|skip|double|halve|pause|change|adjust|time)\s+(taking\s+)?(your\s+)?(medication|meds|dose|insulin|prescription|metformin|ozempic|wegovy|mounjaro|semaglutide|tirzepatide)\b/i,
  /\b(ice|heat) (it|the area|your [a-z]+) (for )?\d+\s?(minutes|min)\b[^.]{0,30}\b(times|every)\b/i,
];
const FALSE_REASSURANCE: RegExp[] = [
  /\byou (do not|don'?t|won'?t) need (to see |to call |to visit )?(a |your |any )?(doctor|physician|medical|gp|clinician)/i,
  /\bno need (to|for) (see |call |visit )?(a |the |your )?(doctor|physician|gp|clinician)/i,
  /\b(nothing|not anything) to worry about\b/i,
  /\b(keep|continue|carry on) (training|lifting|running|exercising|working out|squatting)( as usual| as normal| through it| anyway| like normal)\b/i,
  /\b(train|push|work|run|lift|squat) through (it|the pain|that pain)\b/i,
  /\b(it'?s|it is|that'?s|that is|this is) (probably |likely |almost certainly |definitely )?(fine|nothing serious|nothing|not serious|harmless|safe to (train|keep going))\b/i,
  /\b(safe|fine|okay|ok) (for you )?to (keep )?(train|lift|run|exercise) (on|with) (it|that)\b/i,
];
const STOP_DIRECTIVE = /\b(stop|pause|skip|leave out|avoid|ease off)\b/i;
const COACH_ROUTE = /\bcoach\b/i;

/** The reply routes the client to their coach (by role, or by the coach's first name). */
function routesToCoach(text: string, ctx: PostCheckContext | null): boolean {
  if (COACH_ROUTE.test(text)) return true;
  const name = ctx?.coach.has_coach ? ctx.coach.coach_first_name : null;
  const clean = (name ?? '').replace(/[^A-Za-z' -]/g, '').trim();
  return clean.length > 1 && new RegExp(`\\b${clean}\\b`).test(text);
}

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

type MacroKey = 'protein_g' | 'carbs_g' | 'fat_g';

function macroKeyOf(word: string): MacroKey {
  return /protein/i.test(word) ? 'protein_g' : /carb/i.test(word) ? 'carbs_g' : 'fat_g';
}

const finite = (xs: Array<number | null | undefined>): number[] =>
  xs.filter((n): n is number => typeof n === 'number' && Number.isFinite(n));

/** kcal facts Roman may quote, typed by unit (never mixed with grams). */
function kcalFacts(ctx: PostCheckContext): number[] {
  return finite([
    ctx.today.kcal,
    ctx.today.remaining_kcal,
    ctx.last_7_days.avg_kcal_on_logged_days,
    ctx.targets.calories,
    ctx.macro_method.floor_kcal,
    ...(ctx.extra_kcal_facts ?? []),
  ]);
}

/** gram facts for ONE macro (protein never matches a carbs number). */
function macroFacts(ctx: PostCheckContext, key: MacroKey): number[] {
  const t = ctx.targets[key];
  if (key === 'protein_g') {
    return finite([
      t,
      ctx.today.protein_g,
      ctx.today.remaining_protein_g,
      ctx.last_7_days.avg_protein_g_on_logged_days,
    ]);
  }
  if (key === 'carbs_g') return finite([t, ctx.today.carbs_g, ctx.today.remaining_carbs_g]);
  return finite([t, ctx.today.fat_g, ctx.today.remaining_fat_g]);
}

/** Rounding tolerance for a quoted fact: 2% or 2 units, whichever is larger. */
function matchesFact(n: number, facts: number[]): boolean {
  return facts.some((f) => Math.abs(n - f) <= Math.max(2, Math.abs(f) * 0.02));
}

function offTarget(n: number, target: number | null | undefined): boolean {
  return target != null && target > 0 && Math.abs(n - target) / target > 0.1;
}

type NumberVerdict = 'calorie_floor' | 'target_mismatch' | 'ungrounded_number' | null;

/** A-R4-3: judge every kcal / macro number in one sentence by its role. */
function judgeSentence(
  s: string,
  ctx: PostCheckContext | null,
  floor: number,
): NumberVerdict {
  const directive = DIRECTIVE.test(s);
  const daily = directive && (DAILY.test(s) || !MEAL.test(s));
  const target = TARGET_STMT.test(s);
  const fact = FACT.test(s);
  for (const m of s.matchAll(KCAL_NUMBER)) {
    const n = toNumber(m[1]);
    if (daily) {
      // Never waived because the digits also appear in client_data.
      if (n >= 400 && n < floor) return 'calorie_floor';
      if (n >= 400 && ctx && offTarget(n, ctx.targets.calories)) return 'target_mismatch';
      continue;
    }
    if (directive) continue; // a meal-level suggestion ("about 600 kcal at dinner")
    if (!target && !fact) continue;
    // A quoted fact of the same unit is always fine ("670 kcal left").
    if (ctx && matchesFact(n, kcalFacts(ctx))) continue;
    if (target) {
      if (!ctx || ctx.targets.calories == null) return 'ungrounded_number';
      if (offTarget(n, ctx.targets.calories)) return 'target_mismatch';
      continue;
    }
    return 'ungrounded_number';
  }
  const macroHits: Array<{ n: number; key: MacroKey }> = [
    ...[...s.matchAll(MACRO_NUMBER)].map((m) => ({ n: toNumber(m[1]), key: macroKeyOf(m[2]) })),
    ...[...s.matchAll(MACRO_NUMBER_REVERSED)].map((m) => ({
      n: toNumber(m[2]),
      key: macroKeyOf(m[1]),
    })),
  ];
  for (const { n, key } of macroHits) {
    if (daily || target) {
      if (ctx && fact && matchesFact(n, macroFacts(ctx, key))) continue;
      if (target && (!ctx || ctx.targets[key] == null)) return 'ungrounded_number';
      if (ctx && offTarget(n, ctx.targets[key])) return 'target_mismatch';
      continue;
    }
    if (directive || !fact) continue;
    if (!ctx || !matchesFact(n, macroFacts(ctx, key))) return 'ungrounded_number';
  }
  return null;
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
  /** A-R4-2: fail-closed reply for a medical_scope turn the model got wrong. */
  medical_scope: (ctx: PostCheckContext | null) =>
    `I cannot advise on the medical side of that, and I will not guess. What I can do: keep today's session as written or at a lighter effort, keep logging, and hold your current targets. Message ${coachName(ctx)} so your plan can be adjusted around it, and I can help you word that. ${ROMAN_PHYSICIAN_LINE_MEDICAL}`,
  /** A-R3-1: the client's data could not be loaded for this turn. */
  context_unavailable: () =>
    'I cannot see your plan and logs at this moment, so I will not quote any of your numbers. Your targets and today\'s log are on the Today tab. Ask me again in a minute and I will have them.',
  referral_medical: ROMAN_PHYSICIAN_LINE_MEDICAL,
  referral_injury: ROMAN_PHYSICIAN_LINE_INJURY,
};

export function postCheckRomanReply(reply: string, input: PostCheckInput): PostCheckResult {
  const applied: string[] = [];
  const ctx = input.context;
  const floor = floorOf(ctx, input.fallbackFloorKcal ?? 1500);
  const medicalClass = input.routerClass === 'medical_scope' || input.routerClass === 'injury_pain';
  let text = reply ?? '';
  let rewritten = false;

  const sentences = text.split(/(?<=[.!?])\s+/);

  // 1-3. typed number checks (A-R4-3), first failing sentence decides.
  let verdict: NumberVerdict = null;
  for (const s of sentences) {
    verdict = judgeSentence(s, ctx, floor);
    if (verdict) break;
  }
  if (verdict) {
    applied.push(verdict);
    text =
      input.contextUnavailable && verdict === 'ungrounded_number'
        ? ROMAN_POST_CHECK_TEMPLATES.context_unavailable()
        : restateTargets(ctx, floor);
    rewritten = true;
  }

  // 4. diagnosis / treatment language, in every class
  if (!rewritten && DIAGNOSIS.some((rx) => rx.test(text))) {
    applied.push('diagnosis_language');
    text =
      input.routerClass === 'medical_scope'
        ? ROMAN_POST_CHECK_TEMPLATES.medical_scope(ctx)
        : ROMAN_POST_CHECK_TEMPLATES.medical(ctx);
    rewritten = true;
  }

  // 4b. A-R4-2: medication / treatment directives, in every class. Appending a
  //     physician sentence never makes "take 400 mg ibuprofen" acceptable.
  if (!rewritten && MEDICATION_DIRECTIVE.some((rx) => rx.test(text))) {
    applied.push('medication_directive');
    text =
      input.routerClass === 'injury_pain'
        ? ROMAN_POST_CHECK_TEMPLATES.medical(ctx)
        : ROMAN_POST_CHECK_TEMPLATES.medical_scope(ctx);
    rewritten = true;
  }

  // 5. banned substances / protocols
  if (!rewritten && BANNED.some((rx) => rx.test(text))) {
    applied.push('banned_substance');
    text = ROMAN_POST_CHECK_TEMPLATES.banned(ctx);
    rewritten = true;
  }

  // 6. A-R4-2: medical / injury turns are fail-closed. False reassurance, or
  //    a reply missing the required safe next step (injury: stop the movement;
  //    both: route to the coach), is replaced by the fixed safe reply. The
  //    exact physician line is then enforced (not "any mention of doctor").
  if (!rewritten && medicalClass) {
    const reassures = FALSE_REASSURANCE.some((rx) => rx.test(text));
    const missingStep =
      (input.routerClass === 'injury_pain' && !STOP_DIRECTIVE.test(text)) ||
      !routesToCoach(text, ctx);
    if (reassures || missingStep) {
      applied.push(reassures ? 'false_reassurance' : 'safe_step_missing');
      text =
        input.routerClass === 'injury_pain'
          ? ROMAN_POST_CHECK_TEMPLATES.medical(ctx)
          : ROMAN_POST_CHECK_TEMPLATES.medical_scope(ctx);
      rewritten = true;
    } else {
      const line =
        input.routerClass === 'medical_scope'
          ? ROMAN_POST_CHECK_TEMPLATES.referral_medical
          : ROMAN_POST_CHECK_TEMPLATES.referral_injury;
      if (!text.includes(line)) {
        applied.push('referral_added');
        text = `${text.trim()} ${line}`;
      }
    }
  }

  // 6b. false reassurance about pain or a doctor in an ordinary turn
  if (!rewritten && !medicalClass && FALSE_REASSURANCE.slice(0, 2).some((rx) => rx.test(text))) {
    applied.push('false_reassurance');
    text = ROMAN_POST_CHECK_TEMPLATES.medical_scope(ctx);
    rewritten = true;
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
