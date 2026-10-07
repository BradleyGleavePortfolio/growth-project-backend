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
 *   7. voice_scrub         — emoji removed; every exclamation becomes a full stop
 *
 * B-651-6: every predicate runs on the NFKC-normalised reply (full-width
 * digits and letters fold to ASCII), so "９００ kcal" is judged as 900.
 * B-651-8: on a medical_scope / injury_pain turn the safe step, the coach
 * route and the exact physician line are enforced on the FINAL composed
 * reply, also when an earlier rule already rewrote it.
 * B-651-9: shipped replies carry no exclamation marks at all.
 */

import type { SafetyClass } from './safety-router';
import {
  normalizeForSafety,
  ROMAN_PHYSICIAN_LINE_INJURY,
  ROMAN_PHYSICIAN_LINE_MEDICAL,
} from './safety-router';

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
  /**
   * B-668-3: extra kcal facts, each kept in its own field family and day, so
   * one kind of number can never validate a claim about another (a burned
   * total is not intake, yesterday is not today, a meal-plan slot is not a
   * log).
   */
  kcal_facts?: PostCheckKcalFacts;
  /**
   * R11-T3: grams of EARLIER days (client_data's past days, tool day totals and
   * entries, personal baselines), per macro; only a past-day claim reads them.
   */
  macro_past?: PostCheckMacroFacts;
  /** R11-T3: medians, averages and ranges of earlier days (personal baselines), per macro. */
  macro_average?: PostCheckMacroFacts;
}

export type PostCheckMacroFacts = Partial<Record<'protein_g' | 'carbs_g' | 'fat_g', number[]>>;

export interface PostCheckKcalFacts {
  /** Today's individual logged food entries (intake, today). */
  intake_entries_today?: number[];
  /** Logged daily intake totals of earlier days (intake, past). */
  intake_past_days?: number[];
  /** Active energy burned today (wearable). */
  burned_today?: number[];
  /** Active energy burned on earlier days, and the 7-day average (wearable). */
  burned_past?: number[];
  /** kcal numbers of the client's meal plan slots (a plan, not a log). */
  meal_plan?: number[];
}

export interface PostCheckInput {
  routerClass: SafetyClass;
  context: PostCheckContext | null;
  /** Floor used when no context is available. */
  fallbackFloorKcal?: number;
  /**
   * Kept for call-site compatibility only. B-651-9: no reply may carry an
   * exclamation mark, so this no longer grants one.
   */
  exclamationAllowed?: boolean;
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
  /(?:^|[.:;,]\s*|\bthen\s+|\bso\s+)(eat|have|consume|get|take in|keep it to|go with)\s+(about\s+|around\s+|roughly\s+|only\s+|just\s+|approximately\s+|~\s?)?\d|\b(aim(ing)? for|stick (to|with)|drop( down)? to|cut( down| back)? to|go down to|bring it down to|keep (it|your intake|intake|yourself) (at|under|below|around|to)|stay (at|under|below|around)|limit (yourself |it |intake )?to|no more than|cap (it|yourself|intake) at|should (eat|have|get|consume)|try (eating|to eat|having)|eat (only|just|around|about|no more than|under|less than|roughly)|have (only|just)|only (eat|have)|you (could|can|might) (eat|have|go with|drop to|try)|go for|target of)\b/i;
const DAILY =
  /\b(a|per|each|every) day\b|\bdaily\b|\bin total\b|\bfor the (whole )?day\b|\btoday\b|\bthis week\b/i;
const MEAL =
  /\b(at|for|with) (breakfast|lunch|dinner|supper|your (next )?(meal|snack))\b|\b(this|next|per|each|a) (meal|snack)\b|\b(remaining|left|rest of (the|your) day)\b/i;

/**
 * B-651-7: the semantic field family a quoted number belongs to, read from its
 * own clause. A number is only ever validated against facts of ITS family, so
 * a remaining or logged value can never validate a false target.
 */
type KcalFamily = 'target' | 'floor' | 'remaining' | 'intake' | 'average' | 'burned';
const FAMILY_WORDS: Array<{ family: KcalFamily; rx: RegExp }> = [
  { family: 'remaining', rx: /\b(remaining|left|leaving|to go)\b/i },
  { family: 'average', rx: /\baverag(e|ed|ing)\b/i },
  { family: 'burned', rx: /\b(burned|burnt|active energy|burn)\b/i },
  {
    family: 'intake',
    rx: /\b(so far|logged|have had|you'?ve had|you have eaten|you ate|eaten|consumed|you are at|you'?re at|sitting at|intake)\b/i,
  },
  { family: 'floor', rx: /\b(floor|minimum|lowest)\b/i },
  { family: 'target', rx: /\b(target|goal|prescribed|set (at|to)|your daily)\b/i },
];
/** Clause boundaries inside one sentence. */
const CLAUSE_SPLIT = /,|;|\s[-\u2013\u2014]\s|\s(?:and|but|while|with|which|so)\s/i;
const KCAL_NUMBER = /\b(\d{1,2},\d{3}|\d{1,5})\s?(kcal|calories|cals?)\b/gi;
/**
 * B-666-3 (Opus): the unit-before-number form ("keep your calories at 900 a
 * day", "calories: 900"). Group 1 is the number.
 */
const KCAL_NUMBER_UNIT_FIRST =
  /\b(?:kcal|calories|cals?)\s*(?:intake\s*)?(?:at|to|of|around|about|near|under|below|:|=|is|are|be|should be|stays? at)?\s*(?:about\s+|around\s+|roughly\s+|only\s+|just\s+|~\s?)?(\d{1,2},\d{3}|\d{2,5})\b(?!\s?(?:kcal|calories|cals?|g\b|grams?|%|percent|minutes?|min\b|steps?|reps?|sets?|hours?))/gi;
/**
 * B-666-3 (Opus): a whole-day amount marker. Unlike DAILY it excludes
 * "today" ("today's lunch was 450 kcal" is one meal, not a daily intake).
 */
const WHOLE_DAY =
  /\b(a|per|each|every) day\b|\bdaily\b|\bin total\b|\bfor the (whole )?day\b|\ba day'?s\b/i;
/** A clause about one meal, snack or serving is never a daily amount. */
const MEAL_CLAUSE =
  /\b(breakfast|lunch|dinner|supper|snacks?|meals?|servings?|portions?|plates?|bowls?|bars?|shakes?)\b/i;
/** A kcal number that is a change (deficit, surplus, "300 fewer"), not an intake. */
const KCAL_DELTA_AFTER =
  /^\s*(deficit|surplus|less|fewer|more|extra|over|under|below|above|short|a day (deficit|surplus)|per day (deficit|surplus))\b/i;
// B-668-3: only the imperative "burn 300 kcal" is a change amount; "you
// burned 200 kcal today" states a fact and is checked against burned energy.
const KCAL_DELTA_BEFORE =
  /\b(deficit|surplus) of\s*$|\b(cut|trim|drop|remove|subtract|add|burn)\s+(an extra\s+|another\s+|about\s+|around\s+|roughly\s+)?$/i;
const MACRO_NUMBER =
  /\b(\d{1,4})\s?g(?:rams?)?\s+(?:of\s+)?(protein|carbs?|carbohydrates|fat|fats)\b/gi;
const MACRO_NUMBER_REVERSED =
  /\b(protein|carbs?|carbohydrates|fat|fats)\b[^.\d]{0,40}?\b(\d{1,4})\s?g\b/gi;

// ─── A-R4-2: medication / treatment directives and false reassurance ────────
const MEDICATION_DIRECTIVE: RegExp[] = [
  /\b\d+(\.\d+)?\s?(mg|mcg|µg|milligrams?|micrograms?|iu|units of insulin)\b/i,
  /\b(take|taking|try|use|using|pop|start|grab|have)\s+(some\s+|an?\s+|a couple of\s+|two\s+)?(ibuprofen|advil|motrin|aleve|naproxen|acetaminophen|paracetamol|tylenol|aspirin|antibiotics?|painkillers?|pain ?relievers?|muscle relaxants?|anti-?inflammator(y|ies)|nsaids?|prednisone|cortisone|antihistamines?|benadryl|melatonin|sleeping pills?)\b/i,
  /\b(ibuprofen|advil|motrin|aleve|naproxen|acetaminophen|paracetamol|tylenol|aspirin|nsaids?|prednisone)\b[^.]{0,60}\b(twice|three times|every \d+ hours|daily|a day|per day|with food|before (bed|training))\b/i,
  /\b(increase|decrease|lower|raise|stop|skip|double|halve|pause|change|adjust|time)\s+(taking\s+)?(your\s+)?(medication|meds|dose|prescription|metformin|ozempic|wegovy|mounjaro|semaglutide|tirzepatide)\b/i,
  // B-666-1 (Opus): "carbs raise insulin" is physiology; changing the
  // client's own insulin is a medication directive.
  /\b(increase|decrease|lower|raise|stop|skip|double|halve|pause|change|adjust|time)\s+(taking\s+(your\s+)?|your\s+)insulin\b/i,
  // B-666-4 (Sol): "Skip insulin before training" is a medication
  // directive without the possessive too; "carbs raise insulin" and
  // "improve insulin sensitivity" stay physiology.
  /\b(stop|skip|double|halve|pause|miss|reduce|cut back on|cut down on|hold off on|go without)\s+(taking\s+)?(the\s+|any\s+|some\s+|an?\s+|less\s+|more\s+)?insulin\b(?!\s+(sensitivity|resistance|levels?|response|spikes?|production))/i,
  /(?:^|[.!?:;]\s*|\b(?:you should|you can|you could|try to|just)\s+)(increase|decrease|lower|raise|change|adjust|time)\s+(the\s+|any\s+|less\s+|more\s+)?insulin\b(?!\s+(sensitivity|resistance|levels?|response|spikes?|production))/i,
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
const STOP_DIRECTIVE =
  /\b(stop|pause|skip|leave out|avoid|ease off|drop|hold off on|sit out|back off)\b/gi;
/**
 * B-666-3 (Sol): a stop word only counts when it is an AFFIRMATIVE instruction
 * about the painful movement: not negated in its clause ("do not stop",
 * "never skip", "no need to pause", "avoid skipping"), and with the pain or
 * the movement as its object in the same clause.
 */
const STOP_NEGATED_BEFORE =
  /(?:\b(?:not|never|no|without|instead of|rather than|avoid|nothing|dont|cant|wont|shouldnt|doesnt|didnt)\b|n't\b)(\s+\w+){0,3}\s*$/i;
const STOP_OBJECT =
  /\b(hurts?|hurting|pain(ful|s)?|sore(ness)?|aches?|aching|discomfort|twinges?|injur(y|ed|ies)|movements?|motions?|exercises?|lifts?|lifting|sets?|reps?|sessions?|training|workouts?|activit(y|ies)|range|load|weight|squats?|squatting|lunges?|deadlifts?|press(es|ing)?|bench(ing)?|rows?|rowing|curls?|pull-?ups?|push-?ups?|runs?|running|jog(s|ging)?|jumps?|jumping|sprints?|sprinting|cardio|planks?|stretch(es|ing)?|that|it|whatever|anything)\b/i;

/** B-666-3 (Sol): the reply tells the client, affirmatively, to stop the movement that hurts. */
function affirmativeStop(text: string): boolean {
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    for (const m of sentence.matchAll(STOP_DIRECTIVE)) {
      const at = m.index ?? 0;
      const { text: clause, start } = clauseSpanAt(sentence, at);
      const before = clause.slice(0, at - start);
      const after = clause.slice(at - start + m[0].length);
      if (STOP_NEGATED_BEFORE.test(before)) continue;
      if (/^\s*(by|in|over|at|eating|logging|worrying|thinking)\b/i.test(after)) continue;
      if (STOP_OBJECT.test(after) || STOP_OBJECT.test(before)) return true;
    }
  }
  return false;
}
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
  // B-651-3: "treat" and "dose" are everyday coaching words ("a small
  // treat", "a dose of cardio"). Only treatment of a medical object, or a
  // medication dose, is diagnosis/treatment language.
  /\btreat(s|ed|ing)?\s+(it|this|that|the|your|an?|my)\s+(?:[a-z-]+\s+){0,2}(injury|injuries|pain|condition|symptoms?|infection|inflammation|wound|sprain|strain|tear|fracture|tendon|joint|knee|back|shoulder|[a-z]+itis)\b/i,
  // B-666-1 (Opus): "you can treat today as a lighter day" is coaching;
  // treating a medical object, or treating it with something, is not.
  /\btreat(s|ed|ing)?\s+(it|this|that|them)\s+with\b/i,
  /\btreatments?\s+(plan|for|of|options?|protocol)\b/i,
  // B-666-1 (Opus): "cured meats" is food; curing a condition is not.
  /\bcure(s|d)?\s+(your|this|that|the|it|my|his|her|their)\b|\b(a|the|no|any) cure (for|of)\b/i,
  // B-666-1 (Opus): "your coach prescribed four sets" is a program; a
  // prescription for a medicine is not.
  /\bprescri(be|bes|bed|bing|ption|ptions)\b[^.]{0,30}\b(medication|medicine|meds|drugs?|pills?|tablets?|antibiotics?|painkillers?|steroids?|insulin|rehab|physio(therapy)?|cream|ointment|inhaler)\b/i,
  /\b(medication|medicine|meds|drugs?|pills?|antibiotics?|painkillers?)\b[^.]{0,30}\bprescri(be|bed|ption)\b|\b(a|your|the) prescription\b/i,
  /\b(dose|dosage|dosing)\b[^.]{0,30}\b(medication|meds|medicine|insulin|drug|pills?|tablets?|capsules?|mg|mcg|milligrams?)\b/i,
  /\b(medication|meds|medicine|insulin|drug|pill|prescription)\s+(dose|dosage|dosing)\b/i,
];

/**
 * B-666-1 (Opus): substances that are also everyday physiology or food words
 * ("a mild diuretic", "releases growth hormone", "carbs raise insulin").
 * They are banned only as advice: an intake directive, an endorsement, or a
 * weight, fat-loss or weigh-in purpose.
 */
const DUAL_USE_SUBSTANCE = '(diuretics?|laxatives?|water pills?|insulin|hgh|growth hormone)';
const DUAL_USE_ADVICE: RegExp[] = [
  new RegExp(
    `\\b(take|taking|use|using|try|trying|start|starting|get|getting|buy|inject|injecting|pop|grab|add)\\s+(some\\s+|a\\s+|an\\s+|the\\s+|your\\s+)?([a-z-]+\\s+)?${DUAL_USE_SUBSTANCE}\\b`,
    'i',
  ),
  new RegExp(
    `\\b${DUAL_USE_SUBSTANCE}\\b[^.]{0,40}\\b(can|will|would|could|may|might|should|help|helps|work|works)\\s+(help|work|drop|reduce|flush|speed|get|make|cut|lean|shred|you)\\b`,
    'i',
  ),
  new RegExp(
    `\\b${DUAL_USE_SUBSTANCE}\\b[^.]{0,60}\\b(lose|losing|drop|dropping|cut|cutting|shred(ded|ding)?|lean(er)?|weight|weigh-?ins?|fat loss|burn fat|make weight)\\b`,
    'i',
  ),
];

const BANNED: RegExp[] = [
  /\b(anabolic\s+steroids?|steroids?|sarms?|clenbuterol|ephedrine|dnp|trenbolone)\b/i,
  // B-651-3: starvation is banned as advice, not as a negated mention ("you
  // are not starving yourself by eating at your target").
  /(?<!\b(?:not|never|no|don'?t|do not|avoid|without|stop|instead of)\s+(?:\w+\s+){0,2})\bstarv(e|ation|ing)\b/i,
  /\b(water\s+fast(?:ing)?(?:\s+for\s+\d+\s+days?)?|hcg\s+diet|cleanse|detox tea|juice cleanse)\b/i,
  ...DUAL_USE_ADVICE,
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

/**
 * A claim about an earlier day ("yesterday you logged ..."), not today. R11-T3: also a dated day
 * ("on 22 September", "on Sept 22"), a range of earlier days ("over the last three weeks", "two
 * weeks ago", "last month") and the client's normal ("your usual"), the way tool answers name them.
 * ROMAN-GUARD-129: the client's normal is a comparison, not a day (USUAL_PHRASE, dayClaimOf).
 */
const MONTH =
  '(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)';
const COUNT = '(\\d+|two|three|four|five|six|seven|eight)';
const PAST_DAY = new RegExp(
  '\\b(yesterday|last (night|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|on (monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\\d+ days? ago|the day before|earlier this week|this past week)\\b' +
    `|\\bon (the )?\\d{1,2}(st|nd|rd|th)? (of )?${MONTH}\\b|\\bon ${MONTH}\\.? \\d{1,2}\\b|\\b${COUNT} weeks? ago\\b` +
    `|\\b(over|in|across|during) the (last|past) ${COUNT} (days|weeks)\\b|\\byour (normal|usual|typical|baseline)\\b`,
  'i',
);
const PAST_DAY_ALL = new RegExp(PAST_DAY.source, 'gi');
/** R11-T3-FU: a number said about today ("60 g protein today", "780 kcal so far"). */
const TODAY_WORD = /\b(today|so far)\b/gi;
/** ROMAN-GUARD-129: the PAST_DAY phrases that name the client's normal, not an earlier day. */
const USUAL_PHRASE = /^your (normal|usual|typical|baseline)$/i;
/** Which day's facts a number is checked against; 'either' accepts today's or earlier days'. */
type DayClaim = 'today' | 'past' | 'either';
/** A claim about the meal plan ("your plan has 450 kcal at lunch"), not a log. */
const PLAN_WORD = /\b(meal plan|your plan|the plan|planned)\b/i;
/** B-668-3 (Sol): wording that states the whole day's intake ("logged 450 kcal today", "so far"). */
const DAY_TOTAL_CLAIM =
  /\b(today|so far|in total|total|for the day|daily|you are at|you'?re at|sitting at|intake)\b/i;
/** B-666-5 (Sol): one named meal or food item (singular: "at lunch", "a 450 kcal bowl"). */
const SINGLE_MEAL_CLAUSE =
  /\b(breakfast|lunch|dinner|supper|snack|meal|serving|portion|plate|bowl|bar|shake)\b/i;
/** B-666-5 (Sol): wording that sums the day; it wins over a meal word ("across two meals"). */
const AGGREGATE_CLAIM =
  /\b(in total|total|so far|for the day|daily|intake|across|combined|altogether|meals|snacks|all (of )?(your|my|the|today'?s))\b/i;
/**
 * B-669-1 (Sol): a sum of the client's own meals is today's intake even with
 * no intake verb ("your meals add up to 450 kcal", "both meals come to ...").
 */
const MEAL_SUM_CLAIM =
  /\b(meals|snacks|entries)(\s+[a-z']+){0,2}\s+(add(s|ed)? up|come to|came to|total(s|led|ed)?|sum(s|med)? (to|up))\b/i;

/**
 * kcal facts of the given field families (B-651-7: never pooled across
 * families). B-668-3: also never pooled across days or sources: a claim about
 * today is checked against today's facts, a claim about an earlier day against
 * earlier days, and a meal-plan claim against the plan. ROMAN-GUARD-129: a
 * claim no day decides ('either', dayClaimOf) is checked against both days.
 */
function kcalFacts(
  ctx: PostCheckContext,
  families: ReadonlySet<KcalFamily>,
  sentence = '',
  clause = sentence,
  day: DayClaim = PAST_DAY.test(sentence) ? 'past' : 'today',
): number[] {
  const out: Array<number | null | undefined> = [];
  const f = ctx.kcal_facts ?? {};
  if (families.has('intake')) {
    if (day !== 'today') out.push(...(f.intake_past_days ?? []));
    if (day !== 'past') {
      out.push(ctx.today.kcal);
      // B-668-3 / B-666-5 / B-669-1 (Sol): one meal never validates a
      // whole-day claim. Summing wording ("across two meals", "your meals",
      // "altogether", "so far") is always checked against the day's total,
      // with or without "today". Otherwise entry values count when the clause
      // makes no whole-day claim ("you logged a 450 kcal salad") or names one
      // meal ("450 kcal at lunch today").
      if (
        !AGGREGATE_CLAIM.test(clause) &&
        (!DAY_TOTAL_CLAIM.test(clause) || SINGLE_MEAL_CLAUSE.test(clause))
      ) {
        out.push(...(f.intake_entries_today ?? []));
      }
    }
    if (PLAN_WORD.test(sentence)) out.push(...(f.meal_plan ?? []));
  }
  if (families.has('remaining')) out.push(ctx.today.remaining_kcal);
  if (families.has('average')) out.push(ctx.last_7_days.avg_kcal_on_logged_days);
  if (families.has('burned')) {
    const average = families.has('average');
    if (day !== 'today' || average) out.push(...(f.burned_past ?? []));
    if (day !== 'past' && !average) out.push(...(f.burned_today ?? []));
  }
  if (families.has('target')) out.push(ctx.targets.calories);
  if (families.has('floor')) out.push(ctx.macro_method.floor_kcal);
  return finite(out);
}

/**
 * gram facts for ONE macro and the given families (protein never matches carbs).
 * R11-T3: like kcal (B-668-3), a claim about an earlier day reads earlier days only.
 */
function macroFacts(
  ctx: PostCheckContext,
  key: MacroKey,
  families: ReadonlySet<KcalFamily>,
  day: DayClaim,
): number[] {
  const out: Array<number | null | undefined> = [];
  if (families.has('target')) out.push(ctx.targets[key]);
  if (families.has('intake')) {
    if (day !== 'today') out.push(...(ctx.macro_past?.[key] ?? []));
    if (day !== 'past') out.push(ctx.today[key]);
  }
  if (families.has('remaining')) {
    out.push(
      key === 'protein_g'
        ? ctx.today.remaining_protein_g
        : key === 'carbs_g'
          ? ctx.today.remaining_carbs_g
          : ctx.today.remaining_fat_g,
    );
  }
  if (families.has('average')) {
    if (key === 'protein_g') out.push(ctx.last_7_days.avg_protein_g_on_logged_days);
    out.push(...(ctx.macro_average?.[key] ?? []));
  }
  return finite(out);
}

/** Rounding tolerance for a quoted fact: 2% or 2 units, whichever is larger. */
function matchesFact(n: number, facts: number[]): boolean {
  return facts.some((f) => Math.abs(n - f) <= Math.max(2, Math.abs(f) * 0.02));
}

function offTarget(n: number, target: number | null | undefined): boolean {
  return target != null && target > 0 && Math.abs(n - target) / target > 0.1;
}

type NumberVerdict = 'calorie_floor' | 'target_mismatch' | 'ungrounded_number' | null;

/** The clause of `sentence` that contains character offset `at`, with its start offset. */
function clauseSpanAt(sentence: string, at: number): { text: string; start: number } {
  let startAt = 0;
  const rx = new RegExp(CLAUSE_SPLIT.source, 'gi');
  for (const m of sentence.matchAll(rx)) {
    const idx = m.index ?? 0;
    if (idx >= at) return { text: sentence.slice(startAt, idx), start: startAt };
    startAt = idx + m[0].length;
  }
  return { text: sentence.slice(startAt), start: startAt };
}

function clauseAt(sentence: string, at: number): string {
  return clauseSpanAt(sentence, at).text;
}

/**
 * R11-T3-FU / ROMAN-GUARD-129: which day the number at [at, end) is a claim about. A sentence with
 * no earlier-day phrase is about today, exactly as before. Otherwise the time word closest to the
 * number inside its own clause decides ("60 g protein today, under your usual": today; "last month
 * you logged 118 g": earlier days). A clause with no time word follows the last day named before it
 * ("Yesterday you logged 1,850 kcal and 118 g protein": earlier days). The client's normal ("your
 * usual") is a comparison, not a day: it never decides another clause. A number it decides, or one no
 * earlier day decides ("60 g protein, under your usual"; "today you have logged 780 kcal and 60 g
 * protein, both under your usual"), may match today's or earlier days' facts ('either'); a figure in
 * neither is still rewritten. Thousands separators ("1,850") do not end a clause here.
 */
function dayClaimOf(sentence: string, at: number, end: number): DayClaim {
  if (!PAST_DAY.test(sentence)) return 'today';
  const plain = sentence.replace(/(\d),(?=\d{3}\b)/g, '$1_');
  const { text, start } = clauseSpanAt(plain, at);
  const [from, to] = [at - start, end - start];
  let best: { d: number; day: DayClaim } | null = null;
  for (const w of timeWordsIn(text)) {
    const d = w.at >= to ? w.at - to : Math.max(0, from - w.end);
    if (!best || d < best.d) best = { d, day: w.day };
  }
  if (best) return best.day;
  let last: { at: number; day: DayClaim } | null = null;
  for (const w of timeWordsIn(plain.slice(0, start))) {
    if (w.day !== 'either' && (!last || w.at > last.at)) last = w;
  }
  return last?.day === 'past' ? 'past' : 'either';
}

/** Every time word in `text` with the day it names; today's words first (they win a tie). */
function timeWordsIn(text: string): Array<{ at: number; end: number; day: DayClaim }> {
  const out: Array<{ at: number; end: number; day: DayClaim }> = [];
  for (const [rx, past] of [
    [TODAY_WORD, false],
    [PAST_DAY_ALL, true],
  ] as const) {
    for (const m of text.matchAll(rx)) {
      const at = m.index ?? 0;
      const day: DayClaim = !past ? 'today' : USUAL_PHRASE.test(m[0]) ? 'either' : 'past';
      out.push({ at, end: at + m[0].length, day });
    }
  }
  return out;
}

/** Families whose word follows the number in English ("670 kcal left", "... target"). */
const POSTFIX_FAMILIES: ReadonlySet<KcalFamily> = new Set(['remaining', 'target', 'floor']);

/** Every family (optionally only postfix ones) whose word matches first in `text`. */
function earliestFamilies(text: string, postfixOnly = false): Set<KcalFamily> {
  let best = Number.POSITIVE_INFINITY;
  let out = new Set<KcalFamily>();
  for (const { family, rx } of FAMILY_WORDS) {
    if (postfixOnly && !POSTFIX_FAMILIES.has(family)) continue;
    const m = new RegExp(rx.source, 'i').exec(text);
    if (!m) continue;
    if (m.index < best) {
      best = m.index;
      out = new Set([family]);
    } else if (m.index === best) out.add(family);
  }
  return out;
}

/** Every family whose word ends last (closest to the end) in `text`. */
function latestFamilies(text: string): Set<KcalFamily> {
  let best = -1;
  let out = new Set<KcalFamily>();
  for (const { family, rx } of FAMILY_WORDS) {
    for (const m of text.matchAll(new RegExp(rx.source, 'gi'))) {
      const endAt = (m.index ?? 0) + m[0].length;
      if (endAt > best) {
        best = endAt;
        out = new Set([family]);
      } else if (endAt === best) out.add(family);
    }
  }
  return out;
}

/**
 * B-651-7: the role of one number, read from the words that belong to it:
 *   1. a family word right after it, before any digit or punctuation
 *      ("670 kcal left", "115 g protein target", "1,450 kcal is your daily target");
 *   2. else the closest family word before it in the sentence
 *      ("logged 62 g and 780 kcal", "your daily target is 670 kcal");
 *   3. else the first family word after it.
 * A remaining or logged value therefore never validates a target statement.
 */
function roleOf(sentence: string, at: number, end: number): Set<KcalFamily> {
  const rest = sentence.slice(end);
  const cut = rest.search(/[\d.,;:!?]/);
  const immediate = earliestFamilies((cut === -1 ? rest : rest.slice(0, cut)).slice(0, 32), true);
  if (immediate.size > 0) return immediate;
  const before = latestFamilies(sentence.slice(0, at));
  if (before.size > 0) return before;
  return earliestFamilies(rest);
}

const FACT_FAMILIES: ReadonlyArray<KcalFamily> = ['remaining', 'intake', 'average', 'burned'];

/** Whether the clause holding a number tells the client how much to eat per day. */
function directiveAt(s: string, clause: string): { directive: boolean; daily: boolean } {
  const directive = DIRECTIVE.test(clause);
  return { directive, daily: directive && (DAILY.test(clause) || !MEAL.test(s)) };
}

/** A-R4-3 / B-651-6 / B-651-7: judge every kcal / macro number in one sentence by its role. */
function judgeSentence(
  s: string,
  ctx: PostCheckContext | null,
  floor: number,
  grounded: boolean,
): NumberVerdict {
  const kcalHits: Array<{ n: number; at: number; end: number }> = [
    ...[...s.matchAll(KCAL_NUMBER)].map((m) => ({
      n: toNumber(m[1]),
      at: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
    })),
    ...[...s.matchAll(KCAL_NUMBER_UNIT_FIRST)].map((m) => {
      const at = (m.index ?? 0) + m[0].lastIndexOf(m[1]);
      return { n: toNumber(m[1]), at, end: at + m[1].length };
    }),
  ];
  for (const { n, at, end } of kcalHits) {
    const clause = clauseAt(s, at);
    const { directive, daily } = directiveAt(s, clause);
    // "a 300 kcal deficit", "300 kcal less", "cut 300 kcal": a change, not an intake.
    const delta = KCAL_DELTA_AFTER.test(s.slice(end)) || KCAL_DELTA_BEFORE.test(s.slice(0, at));
    // B-666-3 (Opus): default-deny below the floor. A whole-day amount below
    // the floor is refused whatever verb carries it ("Try 900 calories a
    // day", "900 calories a day is plenty"), unless the clause states a
    // fact of the client's own data (logged / remaining / average / burned),
    // a change amount, or one meal.
    if (!delta && n > 0 && n < floor && WHOLE_DAY.test(clause) && !MEAL_CLAUSE.test(clause)) {
      const role = roleOf(s, at, end);
      if (!FACT_FAMILIES.some((f) => role.has(f))) return 'calorie_floor';
    }
    if (daily && !delta) {
      // B-651-6: every positive daily value below the floor is refused, and a
      // daily directive is never waived because the digits match client_data.
      if (n > 0 && n < floor) return 'calorie_floor';
      if (ctx && offTarget(n, ctx.targets.calories)) return 'target_mismatch';
      continue;
    }
    if (directive || delta) continue; // a meal-level suggestion or a change amount
    const role = roleOf(s, at, end);
    // B-669-1 (Sol): "your meals add up to 450 kcal" states today's intake.
    if (role.size === 0 && MEAL_SUM_CLAIM.test(clause)) role.add('intake');
    if (role.size === 0) continue;
    // Not a grounded turn (coach surface, or no client data was expected):
    // there are no client facts to compare with, only the floor applies.
    if (!grounded) continue;
    const factFamilies = new Set(FACT_FAMILIES.filter((f) => role.has(f)));
    if (factFamilies.size > 0) {
      // A quoted fact must match a fact of its OWN family ("670 kcal left").
      const day = dayClaimOf(s, at, end);
      if (ctx && matchesFact(n, kcalFacts(ctx, factFamilies, s, clause, day))) continue;
      return 'ungrounded_number';
    }
    if (role.has('floor') && ctx && matchesFact(n, kcalFacts(ctx, new Set(['floor'])))) continue;
    // B-651-7: a target statement is checked against the target, nothing else.
    if (!ctx || ctx.targets.calories == null) return 'ungrounded_number';
    if (offTarget(n, ctx.targets.calories)) return 'target_mismatch';
  }
  const macroHits: Array<{ n: number; key: MacroKey; at: number; end: number }> = [
    ...[...s.matchAll(MACRO_NUMBER)].map((m) => ({
      n: toNumber(m[1]),
      key: macroKeyOf(m[2]),
      at: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
    })),
    ...[...s.matchAll(MACRO_NUMBER_REVERSED)].map((m) => ({
      n: toNumber(m[2]),
      key: macroKeyOf(m[1]),
      at: (m.index ?? 0) + m[0].lastIndexOf(m[2]),
      end: (m.index ?? 0) + m[0].length,
    })),
  ];
  for (const { n, key, at, end } of macroHits) {
    if (!grounded) continue;
    const clause = clauseAt(s, at);
    const { directive, daily } = directiveAt(s, clause);
    if (daily) {
      if (ctx && offTarget(n, ctx.targets[key])) return 'target_mismatch';
      continue;
    }
    if (directive) continue;
    const role = roleOf(s, at, end);
    const factFamilies = new Set(FACT_FAMILIES.filter((f) => role.has(f)));
    if (factFamilies.size > 0) {
      if (!ctx || !matchesFact(n, macroFacts(ctx, key, factFamilies, dayClaimOf(s, at, end)))) {
        return 'ungrounded_number';
      }
      continue;
    }
    if (role.has('target')) {
      if (!ctx || ctx.targets[key] == null) return 'ungrounded_number';
      if (offTarget(n, ctx.targets[key])) return 'target_mismatch';
    }
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
    "I cannot see your plan and logs at this moment, so I will not quote any of your numbers. Your targets and today's log are on the Today tab. Ask me again in a minute and I will have them.",
  referral_medical: ROMAN_PHYSICIAN_LINE_MEDICAL,
  referral_injury: ROMAN_PHYSICIAN_LINE_INJURY,
};

/**
 * B-651-6: the form every predicate reads. NFKC folds full-width digits and
 * letters ("９００" -> "900"), quotes fold to ASCII and invisible format
 * characters are dropped, exactly as the SafetyRouter normalises user text.
 */
function predicateForm(text: string): string {
  return normalizeForSafety(presentationFree(text));
}

/** A Markdown list marker, quote marker or heading at the start of a line. */
const LINE_MARKER =
  /^[ \t]*(?:#{1,6}|>+|[-*+\u2022\u2023\u2043\u2219\u25E6\u25AA\u25CF]|\(?\d{1,3}[.)])[ \t]+/;
/** Inline emphasis and code marks (`**`, `*`, `__`, `_` at a word edge, backticks, `~~`). */
const INLINE_MARKS = /\*+|`+|~~|(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu;

/**
 * B-666-2 (Sol): presentation syntax never changes what a sentence says, so
 * the predicates read the reply without it. Emphasis and code marks are
 * dropped ("Eat **900 kcal** per day" reads as "Eat 900 kcal per day"), and
 * each list item or heading becomes its own sentence ("- Eat 900 kcal per
 * day" reads as "Eat 900 kcal per day"). The client still receives the
 * original text when nothing fires.
 */
function presentationFree(text: string): string {
  const out: string[] = [];
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const item = LINE_MARKER.test(raw);
    const line = raw.replace(LINE_MARKER, '').replace(INLINE_MARKS, '').trim();
    if (!line) continue;
    const prev = out.length - 1;
    if (item && prev >= 0 && !/[.!?:;]$/.test(out[prev])) out[prev] += '.';
    out.push(line);
  }
  return out.join(' ');
}

/**
 * B-651-8: a medical_scope / injury_pain reply must carry the safe next step
 * (injury: stop the movement), route to the coach and avoid reassurance. Run
 * on the final composed text, whatever rule produced it.
 */
function medicalReplyGap(
  text: string,
  routerClass: SafetyClass,
  ctx: PostCheckContext | null,
): 'false_reassurance' | 'safe_step_missing' | null {
  const t = predicateForm(text);
  if (FALSE_REASSURANCE.some((rx) => rx.test(t))) return 'false_reassurance';
  if (routerClass === 'injury_pain' && !affirmativeStop(t)) return 'safe_step_missing';
  if (!routesToCoach(t, ctx)) return 'safe_step_missing';
  return null;
}

export function postCheckRomanReply(reply: string, input: PostCheckInput): PostCheckResult {
  const applied: string[] = [];
  const ctx = input.context;
  const floor = floorOf(ctx, input.fallbackFloorKcal ?? 1500);
  const medicalClass = input.routerClass === 'medical_scope' || input.routerClass === 'injury_pain';
  let text = reply ?? '';
  let rewritten = false;
  const form = predicateForm(text);

  const sentences = form.split(/(?<=[.!?])\s+/);

  // 1-3. typed number checks (A-R4-3), first failing sentence decides.
  let verdict: NumberVerdict = null;
  // Grounding checks (target mismatch, ungrounded numbers) apply only when the
  // turn is about the client's own data: a context is present, or it was
  // expected and could not be loaded (degraded mode). The coach surface and
  // pre-grounding callers pass neither, so only the calorie floor applies.
  const grounded = ctx !== null || input.contextUnavailable === true;
  for (const sentence of sentences) {
    verdict = judgeSentence(sentence, ctx, floor, grounded);
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
  if (!rewritten && DIAGNOSIS.some((rx) => rx.test(form))) {
    applied.push('diagnosis_language');
    text =
      input.routerClass === 'medical_scope'
        ? ROMAN_POST_CHECK_TEMPLATES.medical_scope(ctx)
        : ROMAN_POST_CHECK_TEMPLATES.medical(ctx);
    rewritten = true;
  }

  // 4b. A-R4-2: medication / treatment directives, in every class. Appending a
  //     physician sentence never makes "take 400 mg ibuprofen" acceptable.
  if (!rewritten && MEDICATION_DIRECTIVE.some((rx) => rx.test(form))) {
    applied.push('medication_directive');
    text =
      input.routerClass === 'injury_pain'
        ? ROMAN_POST_CHECK_TEMPLATES.medical(ctx)
        : ROMAN_POST_CHECK_TEMPLATES.medical_scope(ctx);
    rewritten = true;
  }

  // 5. banned substances / protocols
  if (!rewritten && BANNED.some((rx) => rx.test(form))) {
    applied.push('banned_substance');
    text = ROMAN_POST_CHECK_TEMPLATES.banned(ctx);
    rewritten = true;
  }

  // 6. A-R4-2 + B-651-8: medical / injury turns are fail-closed on the FINAL
  //    composed reply, also when a number / banned rewrite above produced it.
  //    False reassurance, or a reply missing the required safe next step
  //    (injury: stop the movement; both: route to the coach), is replaced by
  //    the fixed safe reply. The exact physician line is then enforced.
  if (medicalClass) {
    const gap = medicalReplyGap(text, input.routerClass, ctx);
    if (gap) {
      applied.push(gap);
      text =
        input.routerClass === 'injury_pain'
          ? ROMAN_POST_CHECK_TEMPLATES.medical(ctx)
          : ROMAN_POST_CHECK_TEMPLATES.medical_scope(ctx);
      rewritten = true;
    }
    const line =
      input.routerClass === 'medical_scope'
        ? ROMAN_POST_CHECK_TEMPLATES.referral_medical
        : ROMAN_POST_CHECK_TEMPLATES.referral_injury;
    if (!text.includes(line)) {
      applied.push('referral_added');
      text = `${text.trim()} ${line}`;
    }
  }

  // 6b. false reassurance about pain or a doctor in an ordinary turn
  if (!rewritten && !medicalClass && FALSE_REASSURANCE.slice(0, 2).some((rx) => rx.test(form))) {
    applied.push('false_reassurance');
    text = ROMAN_POST_CHECK_TEMPLATES.medical_scope(ctx);
    rewritten = true;
  }

  // 7. voice scrub — B-651-9: no exclamation marks at all (every variant,
  // including the emoji-presentation double marks, becomes a full stop
  // BEFORE emoji removal so the sentence keeps its end); then emoji removed.
  if (/[!\uFF01\u01C3\u203C\u2049\uFE57]/.test(text)) {
    applied.push('voice_scrub');
    text = text.replace(/\.?[!\uFF01\u01C3\uFE57\u203C\u2049]+\uFE0F?/g, '.');
  }
  const noEmoji = text.replace(EMOJI, '');
  if (noEmoji !== text) {
    if (!applied.includes('voice_scrub')) applied.push('voice_scrub');
    text = noEmoji
      .replace(/ +([.?,])/g, '$1')
      .replace(/ {2,}/g, ' ')
      .trim();
  }

  return { text, guardrails_applied: applied, rewritten };
}
