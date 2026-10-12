/**
 * SafetyRouter — deterministic, pre-model classification of the user's turn
 * (PLAN_roman_intelligence §2.2 step 5, §4.6). Pure functions, no I/O, no
 * model call. `emergency`, `self_harm` and `urgent_symptoms` short-circuit to
 * fixed templates; the other classes add a forced hint to the system block and
 * tighten the post-check.
 */

import { CRISIS_EMERGENCY_PATTERNS, CRISIS_SELF_HARM_PATTERNS } from '../../ai/ai-crisis-router';

export type SafetyClass =
  | 'emergency'
  | 'self_harm'
  | 'urgent_symptoms'
  | 'eating_disorder_risk'
  | 'medical_scope'
  | 'injury_pain'
  | 'normal';

export interface SafetyRouteResult {
  class: SafetyClass;
  /** The pattern source that fired (for logs / eval tables). Empty for normal. */
  matched: string | null;
  /** True for classes that must never reach the model. */
  short_circuit: boolean;
}

/**
 * B-ROMAN911-123: the 911 (`emergency`) and 988 (`self_harm`) lists are the
 * AI guide crisis router's lists (src/ai/ai-crisis-router.ts), so both
 * surfaces route the same message the same way. Those lists carry the
 * narrowing Roman lacked: "overdose on cardio", "can you overdose on
 * creatine?", "hard to breathe during heavy squats", "unconscious snacking",
 * "I hurt myself deadlifting" and "suicide sprints" get a normal answer, while
 * an overdose, a poisoning, breathing trouble or self-harm happening to a
 * person still short-circuits.
 */
const EMERGENCY: readonly RegExp[] = CRISIS_EMERGENCY_PATTERNS;
const SELF_HARM: readonly RegExp[] = CRISIS_SELF_HARM_PATTERNS;

/**
 * GLP-1 and related weight-loss medicines: semaglutide (Ozempic, Wegovy,
 * Rybelsus), tirzepatide (Mounjaro, Zepbound), liraglutide (Victoza, Saxenda),
 * dulaglutide (Trulicity), exenatide (Byetta, Bydureon), retatrutide, a few
 * common misspellings, and "weight loss shot" style wording. Gates the
 * urgent_symptoms route and feeds the post-check's medication-directive rule.
 */
export const WEIGHT_LOSS_MEDICINES =
  'ozempic|ozempik|ozempick|wegovy|wegovey|rybelsus|semaglutide?|sema|mounjaro|monjaro|mounjuro|zepbound|zepbond|tirzepatide|tirzepetide|tirz|victoza|saxenda|liraglutide|trulicity|dulaglutide|byetta|bydureon|exenatide|retatrutide|glp[- ]?1s?|(weight[- ]?loss|fat|skinny|diet) (shots?|jabs?|injections?|pens?|medications?|medicines?|meds|drugs?)';
/**
 * Operator ruling (B-913-2, R1): for the urgent route only, the client's own
 * injection counts as the medicine ("since my shot I can't keep anything
 * down"): the fixed reply says "Contact your prescribing clinic", which fits
 * any prescribed injection. "My flu shot" is not "my shot".
 */
const OWN_INJECTION =
  'my (weekly |last |latest )?(shots?|jabs?|injections?|pens?)|the shot|shot day';
const WEIGHT_LOSS_MEDICINE = new RegExp(`\\b(${WEIGHT_LOSS_MEDICINES}|${OWN_INJECTION})\\b`, 'i');

/**
 * Red-flag symptoms from the warnings and Medication Guides in the FDA labels
 * for these medicines (pancreatitis, gallbladder disease, dehydration, serious
 * allergic reaction, low blood sugar, thyroid tumors). Acute emergencies
 * (throat closing, cannot breathe, about to pass out) are caught first by
 * EMERGENCY. Each pattern is tested per sentence (see NOT_A_REPORT).
 */
const STOMACH = '(stomach|belly|abdominal|abdomen|tummy)';
const PAIN = '(pains?|aches?|cramps?|cramping)';
const SEVERE =
  '(severe|really bad|very bad|terrible|horrible|awful|intense|extreme|unbearable|excruciating|agonizing|sharp|worst|constant|persistent)';
// B-913-1: "stomachache", "has hurt", "has been hurting", "pains in".
const STOMACH_PAIN = `(${STOMACH} ?${PAIN}|${STOMACH} (hurts?|is hurting|keeps hurting|has hurt|has been hurting)|pains? in (my |the )?(upper )?${STOMACH})`;
const CANT = "(can'?t|cannot|can not|unable to|couldn'?t|could not)";
const INTAKE = '(anything|water|fluids?|liquids?|drinks?|food)';
const KEEPABLE = `(any )?${INTAKE}( (or|and) ${INTAKE})?`;
const URGENT_SYMPTOMS: RegExp[] = [
  // Severe or lasting stomach pain, pain reaching the back, or named
  // pancreas / gallbladder trouble.
  new RegExp(
    `\\b(${SEVERE}|bad) ((upper )?${STOMACH} ?${PAIN}|pains? in (my |the )?(upper )?${STOMACH})\\b`,
    'i',
  ),
  new RegExp(
    `\\b${STOMACH_PAIN}\\b.{0,30}\\b((won'?t|will not|doesn'?t|does not) (go away|stop|ease|let up)|(to|into|through) (my |the )?back|for (\\d+|two|three|four|five|several|a few) (days|hours)|all (day|night))\\b`,
    'i',
  ),
  new RegExp(
    `\\b${STOMACH_PAIN}(,? (it'?s|it is|is|feels|has been|gets|is getting))? (really |so |very |extremely )?(${SEVERE}|bad|badly|severely|worse)\\b|\\b${STOMACH} (is killing me|really hurts|is really hurting|is in (so much|a lot of) pain|is in agony|(hurts?|is hurting|has been hurting) (so much|a lot|like crazy))\\b|\\b${STOMACH} (won'?t|will not|doesn'?t|does not) stop (hurting|aching|cramping)\\b`,
    'i',
  ),
  /\b(pancreatitis|gallstones?|pancreas (hurts|pain)|gall ?bladder( is| has been| keeps)? (attack|pain|problems?|issues?|trouble|hurts|hurting|aching|acting up|killing me)|pain (where|around|near) my gall ?bladder|(it'?s|it is|must be|could be) (my )?gall ?bladder)\b/i,
  // Vomiting that will not stop, not keeping fluids down, severe dehydration.
  new RegExp(
    `\\b${CANT} (even )?(keep|hold) (${KEEPABLE}( (at all|either|today|anymore))? down|down ${KEEPABLE})\\b|\\bnothing (stays|will stay) down\\b`,
    'i',
  ),
  /\b(keep|keeps|kept|nonstop|non-stop|constant|constantly|persistent|uncontrollable|can'?t stop|cannot stop) (vomitt?ing|throwing up|puking)\b/i,
  /\b(vomitt?(ing|ed)?|throw(ing)? up|threw up|thrown up|puk(e|ing|ed))\b.{0,30}\b((won'?t|will not|doesn'?t|does not|can'?t|cannot) stop|all (day|night)|nonstop|non-stop|constantly|repeatedly|over and over|for (\d+|two|three|several|a few) (days|hours)|since (yesterday|last night)|(\d+|several|many) times)\b/i,
  /\b(severely|very|really|so|extremely|badly) dehydrated\b|\b(haven'?t|have not|hasn'?t|barely) (peed|urinated|been able to drink)\b/i,
  // Yellow skin or eyes.
  /\b(yellow(ing|ish)?( of)? (my |the )?(skin|eyes?)|(skin|eyes?)( (is|are|look|looks|looking|turned|turning|went|gone|seem|seems|has|have|kind of|a bit|really|very))* yellow(ish)?|jaundiced?)\b/i,
  // A serious allergic reaction: swelling of the face, lips, tongue or
  // throat, trouble swallowing, hives or a severe rash.
  /\b(face|lips?|tongue|throat|mouth|eyelids?)( (is|are|got|has|have|went|keeps?|started))* (swollen|swelling|swelled|puff(ed|ing) up)\b|\b(swollen|swelling (of|in)( my)?) (face|lips?|tongue|throat|mouth|eyelids?)\b/i,
  /\b((broke|breaking|broken) out in hives|(i have|i've got|i got|covered in) hives|hives all over|severe (rash|itching)|rash all over|itch(y|ing) all over|(trouble|difficulty|problems?) swallowing)\b/i,
  // Fainting (not "passed out at 9pm" or "on the sofa": that is sleep).
  /\b(i|i'?ve|i have|i had)( (just|nearly|almost|also|then|suddenly|actually))? (fainted|collapsed|passed out|blacked out|lost consciousness)\b(?! (at \d|on (the |my )?(couch|sofa)|in (the |my )?bed|watching|early))|\b(fainting|passing out|blacking out)\b/i,
  // Very low blood sugar, reported.
  /\b(i'?m|i am|i'?ve|i have|i get|i keep getting|my) (\w+ )?(low blood sugar|(blood )?sugars? (is |are |was |were |keeps? )?(really |very |so |too |dangerously )?(low|dropping|crashing|tanking)|hypoglycemi[ac]|a hypo)\b/i,
  /\b((shaky|shaking|trembling|sweaty|sweating)\b.{0,20}\b(confused|disoriented)|(confused|disoriented)\b.{0,20}\b(shaky|shaking|trembling|sweaty|sweating))\b(?! (about|by|with|on|why|how|what|if|whether)\b)/i,
  // A lump or swelling in the neck.
  /\b(lump|bump|nodule|swelling)\b.{0,25}\bneck\b|\bneck (is |looks |feels |seems )?(swollen|lumpy)\b|\bswollen neck\b/i,
];

/**
 * Words just before a match that make it something other than a report:
 * "no vomiting", "I have not fainted", "I don't take Ozempic"; for symptoms
 * also a question about the risk ("can Wegovy cause pancreatitis", "worried
 * about low blood sugar", "watch for").
 */
const NEGATION = "no|not|never|without|don'?t|doesn'?t|didn'?t|haven'?t|hasn'?t|isn'?t|aren'?t|wasn'?t";
const closelyAfter = (cues: string) =>
  new RegExp(`\\b(${cues})( (?!and |but )[^\\s,]+){0,2} $`, 'i');
const NEGATED = closelyAfter(NEGATION);
const NOT_A_REPORT = closelyAfter(
  `${NEGATION}|cause|causes|risks? of|chance of|worr(y|ied|ying) about|watch (out )?for|afraid of|scared of|if|avoid|prevent`,
);
/**
 * B-913-3: a question or a past event is not a report. "What are the symptoms
 * of pancreatitis", "is gallbladder pain a side effect?", "what should I do if
 * I can't keep water down?", "I had gallstones years ago" go to the model; a
 * first-person report in a question still fires ("is it normal that I can't
 * keep water down?", "I can't keep water down, what should I do?"). R2: the
 * question can start mid-clause ("I'm on Wegovy and want to know what the
 * symptoms of pancreatitis are"); only I/my after the last opener is a report.
 * R3: a clause also starts after but/because/cause ("not sure what's going on
 * but severe stomach pain"), and "this/these" points at a symptom being had.
 */
const QUESTION_OPENER =
  /^\s*(is|are|can|could|does|do|should|would|will|when|any)\b|\b(what'?s?|how|why|which|wonder(ing)?|want to know|curious)\b/gi;
const OWN_REPORT = /\b(i|i'?m|i'?ve|my|me|this|these)\b/i;
const CLAUSE_JOIN = /\b(but|because|cause) /gi;
const IN_THE_PAST = /^.{0,25}\b(years? (ago|back)|as a (kid|child|teen))\b/i;
const negated = (sentence: string, m: RegExpExecArray) => NEGATED.test(sentence.slice(0, m.index));
function notAReport(sentence: string, m: RegExpExecArray): boolean {
  const joins = [...sentence.slice(0, m.index).matchAll(CLAUSE_JOIN)].map(
    (j) => (j.index ?? 0) + j[0].length,
  );
  const clause = Math.max(sentence.lastIndexOf(',', m.index) + 1, ...joins); // "I'm on Ozempic, is ..."
  const opener = [...sentence.slice(clause, m.index).matchAll(QUESTION_OPENER)].pop();
  const after = opener && clause + (opener.index ?? 0) + opener[0].length;
  return (
    NOT_A_REPORT.test(sentence.slice(0, m.index)) ||
    IN_THE_PAST.test(sentence.slice(m.index + m[0].length)) ||
    (after !== undefined && !OWN_REPORT.test(sentence.slice(after, m.index + m[0].length)))
  );
}

/** The first pattern stated in any sentence of the text and not undercut by `skip`. */
function stated(
  patterns: readonly RegExp[],
  text: string,
  skip: (sentence: string, m: RegExpExecArray) => boolean,
): RegExp | undefined {
  for (const sentence of text.split(/[.!?;]+/)) {
    for (const rx of patterns) {
      const m = rx.exec(sentence);
      if (m && !skip(sentence, m)) return rx;
    }
  }
  return undefined;
}

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
  /\b(fainted|passed out|blacked out|fainting|passing out|blacking out|faint|pass out|black out|dizzy|dizziness|light-?headed)\b/i,
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

const ORDER: Array<{ cls: SafetyClass; patterns: readonly RegExp[]; short_circuit: boolean }> = [
  { cls: 'emergency', patterns: EMERGENCY, short_circuit: true },
  { cls: 'self_harm', patterns: SELF_HARM, short_circuit: true },
  { cls: 'urgent_symptoms', patterns: URGENT_SYMPTOMS, short_circuit: true },
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

/**
 * Classify one user message. Deterministic; first class in priority order wins.
 * urgent_symptoms needs a weight-loss medicine taken (this message or the
 * client's earlier turns, `earlierUserText`) and a red flag in this message.
 */
export function classifySafety(message: string, earlierUserText = ''): SafetyRouteResult {
  const text = normalizeForSafety(message);
  for (const { cls, patterns, short_circuit } of ORDER) {
    if (cls === 'urgent_symptoms') {
      const taken = `${text}. ${normalizeForSafety(earlierUserText)}`;
      const rx =
        stated([WEIGHT_LOSS_MEDICINE], taken, negated) && stated(patterns, text, notAReport);
      if (rx) return { class: cls, matched: rx.source, short_circuit };
      continue;
    }
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
 * to your doctor". The 911 / 988 routing stays. These templates are
 * DETERMINISTIC: no model call is ever made for them, so what follows is the
 * exact text the client sees. No contractions, no exclamation marks, no
 * emoji, no promise of an action Roman does not perform.
 */
type FixedReplyClass = 'emergency' | 'self_harm' | 'urgent_symptoms';
export const ROMAN_SAFETY_TEMPLATES: Record<FixedReplyClass, string> = {
  emergency:
    'Please stop what you are doing and call 911 now, or your local emergency number. ' +
    'If you are able, stay where you are, unlock the door, and keep your phone within reach so help can find you quickly. ' +
    'This is beyond what I can help with, and it should not wait. ' +
    // CF-ROMAN-COPY-B-128: no coach is assumed (a client may have none).
    'Once you are safe, let someone you trust know what happened, and I will be here.',
  self_harm:
    'I am sorry you are carrying this, and I am glad you said it here rather than holding it alone. ' +
    'Please reach the 988 Suicide & Crisis Lifeline now: call or text 988 in the United States, any hour, and a trained person will answer. ' +
    'If you are in immediate danger, call 911. ' +
    'If you can, let someone you trust know where you are so they can sit with you. ' +
    'You matter, and talking to a person right now is the right next step.',
  // Owner decision 6 wording, word for word.
  urgent_symptoms:
    'This needs medical attention. Contact your prescribing clinic today. If symptoms are severe, call 911.',
};

/**
 * The coach alert after an urgent_symptoms reply. It carries no symptom,
 * medicine or message text: the coach learns only that the reply was sent.
 */
export const ROMAN_URGENT_COACH_ALERT =
  'Roman sent this client an urgent medical safety reply. Please check in with them.';

/** Model id recorded on a short-circuited turn. */
/**
 * OR-115-1: the closed reason code recorded with the neutral
 * `roman.safety_route` audit action (AuditAction.ROMAN_SAFETY_ROUTE): which
 * fixed template answered. Stored only in the restricted-read metadata
 * field; never in an action name, the spend ledger or an info log.
 * OR-115-2: these templates answer without the box-2 AI consent grant and
 * without any provider call.
 */
export const ROMAN_SAFETY_ROUTE_REASON: Record<
  FixedReplyClass,
  'call_911' | 'call_988' | 'contact_clinic'
> = {
  emergency: 'call_911',
  self_harm: 'call_988',
  urgent_symptoms: 'contact_clinic',
};

export const ROMAN_SAFETY_ROUTER_MODEL_ID = 'safety-router';

/**
 * CF-ROMAN-COPY-B-128 (owner default 10-07): the fixed reply to an
 * eating_disorder_risk message the AI cannot answer (AI help off, the turn
 * limit or a daily limit reached, the coach's AI credits used up). Like the
 * 911 / 988 templates: no model call, no spend, nothing sent anywhere. It
 * points to people: the coach only when the client has one, a physician or a
 * qualified professional, someone they trust, and 988 / 911 (988 serves anyone
 * in distress). Worded for a broad router match ("binge" also fires on TV).
 * When the AI can answer, the model replies under the hint below instead.
 */
export function romanEatingDisorderFallback(hasCoach: boolean): string {
  return [
    'I am not able to answer in chat at the moment.',
    'If eating or food is weighing on you, you do not have to carry it alone.',
    ...(hasCoach ? ['Your coach would want to hear from you, and Messages reaches them.'] : []),
    'A physician, or a qualified professional who works with eating concerns, is the right person to talk to, and it helps to tell someone you trust how you are doing.',
    'If you are in distress, call or text 988 in the United States, any hour, and a trained person will answer.',
    'If you are in immediate danger, call 911.',
  ].join(' ');
}

/** Closed reason code for the eating-disorder fallback (restricted-read audit metadata). */
export const ROMAN_EATING_DISORDER_FALLBACK_REASON = 'eating_disorder_fallback';

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
  Exclude<SafetyClass, FixedReplyClass | 'normal'>,
  string
> = {
  eating_disorder_risk:
    'ROUTER HINT (eating_disorder_risk): the message signals disordered eating or extreme restriction. Be warm, supportive and calm. ' +
    'Do not give any calorie number below the floor, do not praise restriction, do not suggest compensatory exercise. ' +
    'Offer one steadying next step inside their plan (for example, the next regular meal with protein, logged as usual), ' +
    'offer to help them message their coach only if client_data shows they have one (coach.has_coach), ' +
    'and suggest talking with a physician or a qualified professional. Keep it short.',
  medical_scope:
    'ROUTER HINT (medical_scope): the message touches medication, labs, pregnancy, diabetes, blood pressure, a heart condition or a diagnosis. ' +
    'Stay within general fitness and nutrition; do not interpret, diagnose or advise on the medical matter itself, and do not change or time any medication. ' +
    'Be genuinely useful first, in this order: ' +
    '(1) give the general, non-diagnostic principle that applies to anyone (for example: keep effort at a level you could hold a conversation at, build intensity gradually, drink water through the day, eat regular meals with protein, and do not change food, water or training sharply around a medication without the prescriber); ' +
    "(2) name one safe next step inside their current plan (keep today's session as written or at a lower intensity, keep logging, hold the coach-set targets); " +
    '(3) offer to help them message their coach only if client_data shows they have one (coach.has_coach), so the plan can be adjusted around it; ' +
    `(4) then close with this exact line: "${ROMAN_PHYSICIAN_LINE_MEDICAL}" ` +
    'Warm and composed; no alarm, no lecture.',
  injury_pain:
    'ROUTER HINT (injury_pain): the message reports pain or a possible injury. Do not diagnose, name a condition or prescribe rehab. ' +
    'Be genuinely useful first, in this order: ' +
    '(1) tell them to stop the movement that hurts for today; pain is not effort; ' +
    '(2) offer a pain-free alternative or a lower-intensity version of the same session (for example a bodyweight or machine version, a smaller range of motion, less load, or a walk and gentle mobility work instead), and note that mild soreness a day or two after training is normal while sharp, joint, or persistent pain is a reason to stop; ' +
    '(3) suggest resting the area today and keeping any movement pain-free; ' +
    '(4) offer to help them message their coach only if client_data shows they have one (coach.has_coach), so the next sessions can be adjusted; ' +
    `(5) then close with this exact line: "${ROMAN_PHYSICIAN_LINE_INJURY}" ` +
    'Warm and composed; no alarm, no lecture.',
};

export function routerHintFor(cls: SafetyClass): string | null {
  if (cls === 'eating_disorder_risk' || cls === 'medical_scope' || cls === 'injury_pain') {
    return ROMAN_ROUTER_HINTS[cls];
  }
  return null;
}
