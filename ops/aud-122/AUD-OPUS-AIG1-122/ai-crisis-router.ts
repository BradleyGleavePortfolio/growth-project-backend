/**
 * AI guide crisis router (B-AIG-122). Deterministic, pre-model check of the
 * client's message on /ai/chat. Pure functions, no I/O, no model call.
 *
 * A crisis message (self-harm, suicidal thoughts, an overdose or another
 * emergency happening now) is answered with a fixed 988 / 911 reply BEFORE
 * consent, context, the daily token quota and the model, so a client who has
 * used up the day's AI guide allotment, or who has not allowed AI help, still
 * gets the crisis line instead of a limit or consent message.
 *
 * The patterns mirror the Roman SafetyRouter's `emergency` and `self_harm`
 * classes (src/roman/guardrails/safety-router.ts on the Roman stack), which
 * have been through the Roman safety reviews. Once the Roman stack is on
 * main, both surfaces should share one list.
 */

export type AiGuideCrisisClass = 'emergency' | 'self_harm';

/**
 * `<condition>` framed as happening now ("I am having", "she is in", "going
 * into"), or asked about as happening ("is this", "could this be", "signs
 * of"). A past or hypothetical mention ("my dad had a heart attack") does not
 * match.
 */
function acute(condition: string): RegExp {
  return new RegExp(
    `\\b(having|experiencing|going into|go into|just went into|in the middle of|signs of|symptoms of|(i'?m|i am|am|is|are|he'?s|she'?s|they'?re|we'?re) (now |currently )?in|(is|could|might) (this|it|that)( be)?|(i )?think (it'?s|this is|that'?s|i'?m in)) ${condition}\\b`,
    'i',
  );
}

const EMERGENCY: RegExp[] = [
  /\bchest (pain|pressure|tightness)\b/i,
  /^(?=.*\bchest (hurts|is hurting|aches|is aching|feels (tight|heavy))\b)(?=.*\b(numb(ness)?|tingl(e|es|ed|ing|y)|short(ness)? of breath|out of breath|jaw|left arm|cold sweat)\b)/i,
  /\b(crushing|squeezing) (pain|feeling) in my chest\b/i,
  /\b(can(?:'|no)?t|can not|cannot|could(?:'|n)?t|couldn't|unable to|hard to|trouble|struggling to) breath(e|ing)?\b/i,
  /\b(i'?m|i am) not breathing\b/i,
  /\b(i'?m|i am|i feel like i'?m|i think i'?m|feels like i'?m) (fainting|passing out|blacking out|losing consciousness)\b/i,
  /\b(about to|going to|gonna|feel like i'?m going to|think i'?m going to|i might|i'?m going to) (faint|pass out|black out|collapse)\b/i,
  /\b(just|keeps?|kept) (fainted|passed out|blacked out|collapsed|fainting|passing out|blacking out|collapsing)\b/i,
  /\b(someone|somebody|he|she|they|my (friend|partner|wife|husband|son|daughter|mom|mum|dad|brother|sister|client|training partner)) (just |has |is )?(fainted|passed out|blacked out|collapsed|unconscious|unresponsive|not breathing)\b/i,
  /\b(unconscious|unresponsive)\b/i,
  /\b((i'?m|i am|he'?s|she'?s|they'?re|is|am|are|might be|could be|think i'?m|think (he|she|they)'?s?( is| are)?) having|signs of|symptoms of|is (this|it|that) a|could (this|it|that) be a|i think it'?s a) (a )?stroke\b/i,
  /\bstroke (symptoms|signs)\b/i,
  /\b(face (is )?droop(ing)?|slurr(ed|ing) (my |his |her )?speech|one side of (my|his|her) (body|face) (is |went |feels )?(numb|weak|drooping))\b/i,
  /\b(throat (is )?(closing|swelling)|lips (are )?swelling|tongue (is )?swelling)\b/i,
  /\b((i'?m|i am|think i'?m|might be|he'?s|she'?s) having|having) an allergic reaction\b|\ballergic reaction (right )?now\b/i,
  acute('(an? )?(anaphyla(xis|ctic)( shock| reaction)?)'),
  /\banaphyla(xis|ctic)( shock| reaction)?,? (right )?now\b/i,
  /\b(used|use|using|grab|give (me|him|her|them)) (my |an |the |his |her |their )?epi ?-?pens?\b|\bneed(s|ed)? (my|his|her|their) epi ?-?pens?\b|\bepi ?-?pens? (now|is not working|isn'?t working|did not work|didn'?t work)\b/i,
  acute('(a )?(heart attack|cardiac arrest)'),
  /\b(heart attack|cardiac arrest),? (right )?now\b|\b(is|are|gone|going) into cardiac arrest\b/i,
  // "food poisoning" last week is history; an overdose or a poisoning is not.
  /\b(overdos(e|ed|ing)|(?<!food )poison(ed|ing))\b/i,
  // An overdose described without the word.
  /\b(took|taken|swallowed|have taken|i'?ve taken) (too many|way too many|a (whole |full )?(bottle|pack|packet|box) of|all (of )?(my|the)|a handful of)( of)?( my| the)? (\w+ )?(pills|tablets|meds|medication|medicine|capsules|painkillers|sleeping pills)\b/i,
  // An overdose given as a count: five or more ("took 2 pills" is a dose).
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
  // "I cannot go on anymore" (but not "I can't go on the bike").
  /\b(can'?t|cannot|can not) go on( (anymore|any more|any longer|like this|living))\b|\b(can'?t|cannot|can not) go on[.!?]*\s*$/i,
  // "ending my life", "take my own life" (not "end the set").
  /\b(end|ends|ending|ended|take|taking|took)( my| his| her| their) (own )?life\b(?! (back|savings|insurance|story|goals?|to the next level)\b)/i,
  /\b(end|ending|ended) it all\b/i,
  /\b(want to|going to|gonna|thinking (about|of)|thought (about|of)|plan(ning)? to|ready to) end(ing)? it( now| tonight| today)?[.!?]*\s*$/i,
  /\b(no|don'?t see (the|any)|do not see (the|any)|what'?s the|there'?s no) point (in|of|to) (living|life|being alive|going on|being here|existing)\b/i,
  /\bbetter off without me\b/i,
];

/**
 * Canonical form of a message before classification. Phones type smart
 * punctuation by default ("I can’t breathe"); NFKC folds compatibility forms,
 * apostrophe and quote variants become ASCII, invisible characters are
 * removed and whitespace collapses.
 */
export function normalizeForCrisis(message: string): string {
  return (message ?? '')
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035\u02BC\u02B9\u0060\u00B4\uFF07]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036\uFF02]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The crisis class of one message, or null for every other message. Emergency wins. */
export function classifyAiGuideCrisis(message: string): AiGuideCrisisClass | null {
  const text = normalizeForCrisis(message);
  if (EMERGENCY.some((rx) => rx.test(text))) return 'emergency';
  if (SELF_HARM.some((rx) => rx.test(text))) return 'self_harm';
  return null;
}

/**
 * Fixed replies (no model call), so this is the exact text the client sees.
 * Same routing as Roman's templates (911 for an emergency, 988 for a crisis),
 * in the impersonal product voice: no first person, no contractions, no
 * exclamation marks, no promise of an action the app does not perform.
 */
export const AI_GUIDE_CRISIS_REPLIES: Record<AiGuideCrisisClass, string> = {
  emergency:
    'Please stop what you are doing and call 911 now, or your local emergency number. ' +
    'If you are able, stay where you are, unlock the door, and keep your phone within reach so help can find you quickly. ' +
    'This needs a person, not an app, and it should not wait.',
  self_harm:
    'What you are carrying matters, and you do not have to hold it alone. ' +
    'Please reach the 988 Suicide & Crisis Lifeline now: call or text 988 in the United States, any hour, and a trained person will answer. ' +
    'If you are in immediate danger, call 911. ' +
    'If you can, let someone you trust know where you are so they can sit with you. ' +
    'Talking to a person right now is the right next step.',
};
