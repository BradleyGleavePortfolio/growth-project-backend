/**
 * SafetyRouter — deterministic, pre-model classification of the user's turn
 * (PLAN_roman_intelligence §2.2 step 5, §4.6). Pure functions, no I/O, no
 * model call. `emergency` and `self_harm` short-circuit to fixed templates;
 * the other classes add a forced hint to the system block and tighten the
 * post-check.
 */

export type SafetyClass =
  'emergency' | 'self_harm' | 'eating_disorder_risk' | 'medical_scope' | 'injury_pain' | 'normal';

export interface SafetyRouteResult {
  class: SafetyClass;
  /** The pattern source that fired (for logs / eval tables). Empty for normal. */
  matched: string | null;
  /** True for classes that must never reach the model. */
  short_circuit: boolean;
}

/**
 * B-666-1 / B-666-2: `<condition>` framed as happening now ("I am having",
 * "she is in", "going into"), or asked about as happening ("is this",
 * "could this be", "signs of"). A past or hypothetical mention ("my dad had
 * a heart attack", "lower my risk of a heart attack") does not match.
 */
function acute(condition: string): RegExp {
  return new RegExp(
    `\\b(having|experiencing|going into|go into|just went into|in the middle of|signs of|symptoms of|(i'?m|i am|am|is|are|he'?s|she'?s|they'?re|we'?re) (now |currently )?in|(is|could|might) (this|it|that)( be)?|(i )?think (it'?s|this is|that'?s|i'?m in)) ${condition}\\b`,
    'i',
  );
}

const EMERGENCY: RegExp[] = [
  /\bchest (pain|pressure|tightness)\b/i,
  // A-666-2 (Opus): chest pain in plain words with a warning sign in the
  // same message ("my chest hurts and my left arm is numb"). A sore chest
  // after bench press on its own is not an emergency.
  /^(?=.*\bchest (hurts|is hurting|aches|is aching|feels (tight|heavy))\b)(?=.*\b(numb(ness)?|tingl(e|es|ed|ing|y)|short(ness)? of breath|out of breath|jaw|left arm|cold sweat)\b)/i,
  /\b(crushing|squeezing) (pain|feeling) in my chest\b/i,
  /\b(can(?:'|no)?t|can not|cannot|could(?:'|n)?t|couldn't|unable to|hard to|trouble|struggling to) breath(e|ing)?\b/i,
  /\b(i'?m|i am) not breathing\b/i,
  // B-651-2: loss of consciousness only when it is happening now, is about to,
  // or happened to someone just now. A past or near-miss report ("I almost
  // passed out after leg day") goes to the model with the medical hint.
  /\b(i'?m|i am|i feel like i'?m|i think i'?m|feels like i'?m) (fainting|passing out|blacking out|losing consciousness)\b/i,
  /\b(about to|going to|gonna|feel like i'?m going to|think i'?m going to|i might|i'?m going to) (faint|pass out|black out|collapse)\b/i,
  /\b(just|keeps?|kept) (fainted|passed out|blacked out|collapsed|fainting|passing out|blacking out|collapsing)\b/i,
  /\b(someone|somebody|he|she|they|my (friend|partner|wife|husband|son|daughter|mom|mum|dad|brother|sister|client|training partner)) (just |has |is )?(fainted|passed out|blacked out|collapsed|unconscious|unresponsive|not breathing)\b/i,
  /\b(unconscious|unresponsive)\b/i,
  // B-651-2: "stroke" alone is training vocabulary (rowing stroke rate, back
  // stroke). Emergency needs acute stroke context or the FAST symptoms.
  /\b((i'?m|i am|he'?s|she'?s|they'?re|is|am|are|might be|could be|think i'?m|think (he|she|they)'?s?( is| are)?) having|signs of|symptoms of|is (this|it|that) a|could (this|it|that) be a|i think it'?s a) (a )?stroke\b/i,
  /\bstroke (symptoms|signs)\b/i,
  /\b(face (is )?droop(ing)?|slurr(ed|ing) (my |his |her )?speech|one side of (my|his|her) (body|face) (is |went |feels )?(numb|weak|drooping))\b/i,
  // B-651-2: a past allergic reaction is history, not an emergency; an acute
  // one (or its airway signs) is.
  /\b(throat (is )?(closing|swelling)|lips (are )?swelling|tongue (is )?swelling)\b/i,
  /\b((i'?m|i am|think i'?m|might be|he'?s|she'?s) having|having) an allergic reaction\b|\ballergic reaction (right )?now\b/i,
  // B-666-1 (Sol) / B-666-2 (Opus): anaphylaxis, an EpiPen, a heart attack or
  // cardiac arrest is an emergency when it is happening now, about to, or
  // asked about as happening ("is this ..."). History, risk and family
  // mentions go to the model with the medical hint (MEDICAL_SCOPE below).
  acute('(an? )?(anaphyla(xis|ctic)( shock| reaction)?)'),
  /\banaphyla(xis|ctic)( shock| reaction)?,? (right )?now\b/i,
  /\b(used|use|using|grab|give (me|him|her|them)) (my |an |the |his |her |their )?epi ?-?pens?\b|\bneed(s|ed)? (my|his|her|their) epi ?-?pens?\b|\bepi ?-?pens? (now|is not working|isn'?t working|did not work|didn'?t work)\b/i,
  acute('(a )?(heart attack|cardiac arrest)'),
  /\b(heart attack|cardiac arrest),? (right )?now\b|\b(is|are|gone|going) into cardiac arrest\b/i,
  // "food poisoning" last week is history (medical scope); a poisoning or an
  // overdose happening now is not.
  /\b(overdos(e|ed|ing)|(?<!food )poison(ed|ing))\b/i,
  // A-666-1 (Opus): an overdose described without the word.
  /\b(took|taken|swallowed|have taken|i'?ve taken) (too many|way too many|a (whole |full )?(bottle|pack|packet|box) of|all (of )?(my|the)|a handful of)( of)?( my| the)? (\w+ )?(pills|tablets|meds|medication|medicine|capsules|painkillers|sleeping pills)\b/i,
  // A-666-2 (Opus): an overdose given as a count ("I took 20 of my sleeping
  // pills", "a bunch of pills"). Five or more; "took 2 pills" is a dose.
  /\b(took|taken|swallowed|have taken|i'?ve taken) ([5-9]|[1-9]\d+|a bunch of|a lot of|lots of|loads of|a load of|so many)( of)?( my| the)? (\w+ )?(pills|tablets|meds|capsules|painkillers)\b/i,
  /\b(coughing|throwing|vomiting) up blood\b/i,
];

const SELF_HARM: RegExp[] = [
  /\bsuicid(e|al)\b/i,
  /\bkill(ing)? myself\b/i,
  /\bend (my|it) (life|all)\b/i,
  /\b(don'?t|do not|dont|no longer) want to (live|be alive|be here|wake up|exist|go on)( anymore)?\b/i,
  /\b(i'?m|i am) going to (kill myself|end it)\b/i,
  /\bwant to die\b/i,
  /\bself[- ]?harm(ing)?\b/i,
  /\b(hurt|cut|cutting) myself\b/i,
  /\bno reason to (live|go on|keep going)\b/i,
  /\bbetter off dead\b/i,
  /\b(want|wish) (to die|i was dead|i were dead)\b/i,
  /\bnot worth living\b/i,
  // A-666-1 (Opus): "I cannot go on anymore" (but not "I can't go on the bike").
  /\b(can'?t|cannot|can not) go on( (anymore|any more|any longer|like this|living))\b|\b(can'?t|cannot|can not) go on[.!?]*\s*$/i,
  // A-666-2 (Opus): ordinary suicidal phrasings ("ending my life", "take my
  // own life", "ending it all", "no point in living", "better off without
  // me"). "End the set" and "ending my workout early" do not match.
  /\b(end|ends|ending|ended|take|taking|took)( my| his| her| their) (own )?life\b(?! (back|savings|insurance|story|goals?|to the next level)\b)/i,
  /\b(end|ending|ended) it all\b/i,
  /\b(want to|going to|gonna|thinking (about|of)|thought (about|of)|plan(ning)? to|ready to) end(ing)? it( now| tonight| today)?[.!?]*\s*$/i,
  /\b(no|don'?t see (the|any)|do not see (the|any)|what'?s the|there'?s no) point (in|of|to) (living|life|being alive|going on|being here|existing)\b/i,
  /\bbetter off without me\b/i,
];

const EATING_DISORDER: RegExp[] = [
  /\bpurg(e|ing|ed)\b/i,
  /\b(throw|throwing|threw) up (after|what i)\b/i,
  /\bmake myself (sick|throw up|vomit)\b/i,
  /\bbing(e|ed|eing|ing)\b/i,
  /\blaxative/i,
  /\b(eat|eating) nothing\b/i,
  /\bnot (eat|eating) (at all|anything)\b/i,
  /\bstop eating (altogether|completely|entirely)\b/i,
  /\b(zero|no) calories (today|tomorrow|for)\b/i,
  /\b(burn|work|exercise) (off|away) (everything|what|all) i (ate|eat)\b/i,
  /\b(punish|make up for) (myself|it) (with|by) (exercise|cardio|working out)\b/i,
  /\b(only|just) (eat|have|do) (\d{2,3}) ?(kcal|calories|cal)\b/i,
  /\b(\d{2,3}) ?(kcal|calories|cal) (a|per) day\b/i,
  /\bskip (all|every) meals?\b/i,
  /\b(fast|fasting) for (\d+|two|three|four|five|several|a few) days\b/i,
];

const MEDICAL_SCOPE: RegExp[] = [
  /\bdiagnos(e|is|ed|ing)\b/i,
  /\bmedication|\bmeds\b|\bprescri(be|bed|ption)\b|\bdos(e|age)\b/i,
  /\bblood ?work\b|\blab(s| results| work)\b/i,
  /\bpregnan(t|cy)\b|\bpostpartum\b|\bbreastfeeding\b/i,
  /\bdiabet(es|ic)\b|\binsulin\b|\bblood sugar\b|\ba1c\b/i,
  /\bblood pressure\b|\bhypertension\b/i,
  /\bheart (condition|disease|problem|failure|rate is)\b|\barrhythmia\b|\bafib\b/i,
  /\bcholesterol\b|\bstatin\b|\bthyroid\b|\bkidney\b|\bliver\b/i,
  /\b(ozempic|wegovy|semaglutide|mounjaro|tirzepatide|metformin|phentermine|adderall|antidepressant|ssri)\b/i,
  /\b(symptom|symptoms)\b/i,
  /\b(disorder|syndrome|disease)\b/i,
  // B-651-2: history or near-miss reports the emergency router leaves to the
  // model: the medical hint makes the reply route to the coach and physician.
  /\b(fainted|passed out|blacked out|fainting|passing out|blacking out|faint|dizzy|dizziness|light-?headed)\b/i,
  /\b(had|have had|history of|after|since) (a |my )?stroke\b/i,
  /\ballergic reaction\b|\ballerg(y|ies|ic) to\b/i,
  // B-666-1 / B-666-2: history, risk and family mentions of the acute
  // emergencies above (the acute forms are caught first by EMERGENCY).
  /\banaphyla(xis|ctic)\b|\bepi ?-?pens?\b|\bheart attacks?\b|\bcardiac arrest\b|\bfood poisoning\b/i,
];

const INJURY_PAIN: RegExp[] = [
  /\bpain(ful|s)?\b/i,
  /\bhurt(s|ing)?\b/i,
  /\binjur(y|ed|ies)\b/i,
  /\bswollen\b|\bswelling\b/i,
  /\bnumb(ness)?\b|\btingl(e|ing|y)\b/i,
  /\b(pulled|tore|torn|tweaked|strained|sprained) (a |my )?(muscle|hamstring|back|shoulder|knee|ankle|calf|quad|groin)\b/i,
  /\b(sharp|stabbing|shooting) (twinge|sensation|feeling)\b/i,
  /\bpopp(ed|ing) (sound|noise)\b|\bclick(ing|s)? (in|when)\b/i,
];

const ORDER: Array<{ cls: SafetyClass; patterns: RegExp[]; short_circuit: boolean }> = [
  { cls: 'emergency', patterns: EMERGENCY, short_circuit: true },
  { cls: 'self_harm', patterns: SELF_HARM, short_circuit: true },
  { cls: 'eating_disorder_risk', patterns: EATING_DISORDER, short_circuit: false },
  { cls: 'medical_scope', patterns: MEDICAL_SCOPE, short_circuit: false },
  { cls: 'injury_pain', patterns: INJURY_PAIN, short_circuit: false },
];

/**
 * A-R4-1: canonical form of a user message before classification. Phones
 * type smart punctuation by default ("I can’t breathe"), and pasted text can
 * carry full-width letters, zero-width characters or non-breaking spaces.
 * NFKC folds compatibility forms; every apostrophe / quote variant becomes
 * ASCII; invisible format characters are removed; whitespace collapses.
 */
export function normalizeForSafety(message: string): string {
  return (message ?? '')
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035\u02BC\u02B9\u0060\u00B4\uFF07]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036\uFF02]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The lowest daily intake Roman ever endorses (the women's floor; the post-check
 * enforces the per-client floor on the reply). A user asking to restrict
 * BELOW it is an eating_disorder_risk turn.
 */
export const ROMAN_ROUTER_SUB_FLOOR_KCAL = 1200;
const KCAL_IN_TEXT = /\b(\d{1,2},\d{3}|\d{2,5})\s?(kcal|calories|cals?)\b/gi;
/** Restriction framing in the words just before the number. */
const RESTRICT_BEFORE =
  /\b(drop(ping)?|cut(ting)?|go(ing)? down|get(ting)? down|bring(ing)? (it |myself )?down|limit(ing)?|stay(ing)? (under|below|at)|under|below|less than|fewer than|no more than|only|just|eat(ing)?|aim(ing)? for|goal|target)\b/i;
/** A number about one meal or snack is not a daily restriction. */
const MEAL_WORD = /\b(breakfast|lunch|dinner|supper|snack|meal)\b/i;

/**
 * A request to eat a daily amount below the floor ("Can I drop to 1,000
 * calories?", "aim for 900 kcal"). Numbers are compared, so 1,000 is caught
 * and 1,800 is not; a per-meal number ("500 calories at lunch") is skipped.
 */
export function asksForSubFloorIntake(text: string): boolean {
  for (const m of text.matchAll(KCAL_IN_TEXT)) {
    const n = parseInt(m[1].replace(/,/g, ''), 10);
    if (!Number.isFinite(n) || n <= 0 || n >= ROMAN_ROUTER_SUB_FLOOR_KCAL) continue;
    const at = m.index ?? 0;
    const before = text.slice(Math.max(0, at - 40), at);
    const after = text.slice(at + m[0].length, at + m[0].length + 30);
    if (MEAL_WORD.test(before) || MEAL_WORD.test(after)) continue;
    if (RESTRICT_BEFORE.test(before)) return true;
  }
  return false;
}

/** Classify one user message. Deterministic; first class in priority order wins. */
export function classifySafety(message: string): SafetyRouteResult {
  const text = normalizeForSafety(message);
  for (const { cls, patterns, short_circuit } of ORDER) {
    for (const rx of patterns) {
      if (rx.test(text)) return { class: cls, matched: rx.source, short_circuit };
    }
    if (cls === 'eating_disorder_risk' && asksForSubFloorIntake(text)) {
      return { class: cls, matched: 'sub_floor_intake', short_circuit };
    }
  }
  return { class: 'normal', matched: null, short_circuit: false };
}

// ─── fixed templates (no model call) ─────────────────────────────────────────

/**
 * Owner ruling 2026-09-30 16:38: the safety copy is "butlered up" (warm,
 * composed, Alfred-like) and gives something genuinely useful beyond "talk
 * to your doctor". The 911 / 988 routing stays. These two templates are
 * DETERMINISTIC: no model call is ever made for them, so what follows is the
 * exact text the client sees. No contractions, no exclamation marks, no
 * emoji, no promise of an action Roman does not perform.
 */
export const ROMAN_SAFETY_TEMPLATES: Record<'emergency' | 'self_harm', string> = {
  emergency:
    'Please stop what you are doing and call 911 now, or your local emergency number. ' +
    'If you are able, stay where you are, unlock the door, and keep your phone within reach so help can find you quickly. ' +
    'This is beyond what I can help with, and it should not wait. ' +
    'Once you are safe, your coach would want to hear from you in Messages, and I will be here.',
  self_harm:
    'I am sorry you are carrying this, and I am glad you said it here rather than holding it alone. ' +
    'Please reach the 988 Suicide & Crisis Lifeline now: call or text 988 in the United States, any hour, and a trained person will answer. ' +
    'If you are in immediate danger, call 911. ' +
    'If you can, let someone you trust know where you are so they can sit with you. ' +
    'You matter, and talking to a person right now is the right next step.',
};

/** Model id recorded on a short-circuited turn. */
/**
 * OR-115-1: the closed reason code recorded with the neutral
 * `roman.safety_route` audit action (AuditAction.ROMAN_SAFETY_ROUTE): which
 * fixed template answered. Stored only in the restricted-read metadata
 * field; never in an action name, the spend ledger or an info log.
 * OR-115-2: these templates answer without the box-2 AI consent grant and
 * without any provider call.
 */
export const ROMAN_SAFETY_ROUTE_REASON: Record<'emergency' | 'self_harm', 'call_911' | 'call_988'> =
  {
    emergency: 'call_911',
    self_harm: 'call_988',
  };

export const ROMAN_SAFETY_ROUTER_MODEL_ID = 'safety-router';

// ─── per-class hints appended to the system block ────────────────────────────

/**
 * Per-class hints appended to SESSION STATE. The model composes the reply, so
 * these describe the SHAPE of a useful answer (owner ruling 16:38): general,
 * non-diagnostic guidance first, then a safe next step inside the client's
 * own plan, then the offer to message the coach, then the physician line.
 * The exact closing lines are also what the post-check enforces.
 */
export const ROMAN_PHYSICIAN_LINE_MEDICAL =
  'For the medical side of it, please check with your physician.';
export const ROMAN_PHYSICIAN_LINE_INJURY =
  'If it persists, gets worse, or is severe, please see a physician.';

export const ROMAN_ROUTER_HINTS: Record<
  Exclude<SafetyClass, 'emergency' | 'self_harm' | 'normal'>,
  string
> = {
  eating_disorder_risk:
    'ROUTER HINT (eating_disorder_risk): the message signals disordered eating or extreme restriction. Be warm, supportive and calm. ' +
    'Do not give any calorie number below the floor, do not praise restriction, do not suggest compensatory exercise. ' +
    'Offer one steadying next step inside their plan (for example, the next regular meal with protein, logged as usual), ' +
    'offer to help them message their coach, and suggest talking with a physician or a qualified professional. Keep it short.',
  medical_scope:
    'ROUTER HINT (medical_scope): the message touches medication, labs, pregnancy, diabetes, blood pressure, a heart condition or a diagnosis. ' +
    'Stay within general fitness and nutrition; do not interpret, diagnose or advise on the medical matter itself, and do not change or time any medication. ' +
    'Be genuinely useful first, in this order: ' +
    '(1) give the general, non-diagnostic principle that applies to anyone (for example: keep effort at a level you could hold a conversation at, build intensity gradually, drink water through the day, eat regular meals with protein, and do not change food, water or training sharply around a medication without the prescriber); ' +
    "(2) name one safe next step inside their current plan (keep today's session as written or at a lower intensity, keep logging, hold the coach-set targets); " +
    '(3) offer to help them message their coach so the plan can be adjusted around it; ' +
    `(4) then close with this exact line: "${ROMAN_PHYSICIAN_LINE_MEDICAL}" ` +
    'Warm and composed; no alarm, no lecture.',
  injury_pain:
    'ROUTER HINT (injury_pain): the message reports pain or a possible injury. Do not diagnose, name a condition or prescribe rehab. ' +
    'Be genuinely useful first, in this order: ' +
    '(1) tell them to stop the movement that hurts for today; pain is not effort; ' +
    '(2) offer a pain-free alternative or a lower-intensity version of the same session (for example a bodyweight or machine version, a smaller range of motion, less load, or a walk and gentle mobility work instead), and note that mild soreness a day or two after training is normal while sharp, joint, or persistent pain is a reason to stop; ' +
    '(3) suggest resting the area today and keeping any movement pain-free; ' +
    '(4) offer to help them message their coach so the next sessions can be adjusted; ' +
    `(5) then close with this exact line: "${ROMAN_PHYSICIAN_LINE_INJURY}" ` +
    'Warm and composed; no alarm, no lecture.',
};

export function routerHintFor(cls: SafetyClass): string | null {
  if (cls === 'eating_disorder_risk' || cls === 'medical_scope' || cls === 'injury_pain') {
    return ROMAN_ROUTER_HINTS[cls];
  }
  return null;
}
