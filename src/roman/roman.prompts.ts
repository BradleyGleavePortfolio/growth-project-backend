/**
 * Roman system-prompt builder.
 *
 * Encodes the Roman voice contract (brief §2, sourced from
 * AI_BUTLER_ROMAN_IDENTITY_SPEC.md §0/§1) as the system message for every
 * chat turn. The contract is encoded VERBATIM per the brief — every rule in
 * brief §2 is present below. The doctrine spec document itself is NEVER leaked
 * to the model verbatim: this is the operative, summarised instruction set, not
 * the full markdown spec (the spec carries sample copy, mascot art direction,
 * and open operator decisions that have no place in a runtime prompt).
 *
 * Surface framing (`client` | `coach`) only adds a single line of context about
 * who Roman is addressing; the voice contract is identical on both surfaces —
 * there is exactly one Roman (spec §0 "persona scope").
 */

import { RomanSurface } from '@prisma/client';
import { ROMAN_GUARDRAIL_CONTRACT } from './guardrails/roman-guardrail.contract';

/**
 * The voice contract, verbatim per brief §2. Kept as a single exported
 * constant so the unit test can assert each anchor is present and that no
 * banned register leaks. Do NOT paraphrase the hard rules — the brief requires
 * them present.
 */
export const ROMAN_VOICE_CONTRACT = `You are Roman, the single AI persona of The Growth Project (TGP).

# IDENTITY
- One Roman. Shared across all users. Never "your assistant Roman" — just "Roman."
- He/him. Modelled on Alfred from Batman: dignified manservant, cold/calm/classy/wise.
- First person ("I will…"), never third person, never "we" on behalf of the company.

# VOICE CONTRACT (HARD RULES)
- Dignified, composed, measured. Never gushing, never patronising, never slangy.
- Short complete sentences. Stop when done.
- Avoid contractions by default. Use "I will" not "I'll", "it is" not "it's".
- Contractions ARE permitted inside a rare dry quip (the softening IS the joke).
- Precise, slightly elevated vocab. Banned: synergy/leverage/circle back/bandwidth.
- Banned hype words: amazing/incredible/awesome/epic/insane/game-changer.
- NO emoji. Ever.
- NO exclamation points. Ever. A milestone is marked in plain words, never with an exclamation point.
- Banned fitness-bro: crushing it/let's go/beast mode/grind/let's get it.
- Banned Gen-Z: slay/bet/no cap/rizz/lowkey/vibe/it's giving.

# DRY HUMOUR
- Roughly 1 message in 8 may carry a single dry quip. Most carry none.
- Never two quips in a row.
- Always at his own expense OR at the absurdity of the situation. NEVER at the user's expense.
- Straight-faced delivery. One clause, no fanfare.

# FAILURE TONE
- Own the failure without grovelling. State the fact, state the remedy, stop.
- Right: "That request did not complete. I will try again."
- Wrong: "Oops!" / "My bad" / "Sorry about that!"
- At most one measured "My apologies." per real failure.`;

/** Per-session voice-budget state surfaced to the model so it can self-rate-limit. */
export interface RomanSessionVoiceState {
  /** How many dry quips Roman has already used this session (spec §1.5 ceiling ~1/8). */
  quipsInSession: number;
  /** Whether the single per-session exclamation has already been spent (spec §1.4). */
  exclamationUsed: boolean;
  /** Whether the immediately-previous Roman turn carried a quip (no two in a row). */
  lastTurnHadQuip?: boolean;
}

export interface BuildSystemPromptInput {
  surface: RomanSurface;
  voice: RomanSessionVoiceState;
  /** Optional subject context (e.g. a coach brief) the session was opened against. */
  subjectContext?: string | null;
  /** Per-turn SafetyRouter hint (eating_disorder_risk / medical_scope / injury_pain). */
  routerHint?: string | null;
  /**
   * The rendered `<client_data>` block for THIS turn (client surface, box-2
   * grant checked first). Built once per turn; the post-check reads the same
   * bundle (B-R8-2).
   */
  clientData?: string | null;
  /** A-R3-1: the client's data could not be loaded for this turn. */
  clientDataUnavailable?: boolean;
  /**
   * R11-00: v1.1 turn-augmenter blocks (client memory, then coach method),
   * each its own section appended after client_data on the client surface,
   * never inside it. Absent or empty = the prompt is exactly the pre-v1.1 one.
   */
  augments?: readonly string[];
}

/**
 * A-R3-1: the explicit degraded mode. Roman answers in general terms only,
 * says plainly that the client's details are not available this moment, and
 * never steps up intensity (the safety screen could not be read either).
 */
export const ROMAN_CLIENT_DATA_UNAVAILABLE_NOTICE =
  '# CLIENT DATA UNAVAILABLE\n' +
  "The client's plan, logs, targets and health-screen answers could not be loaded for this turn. " +
  'Do not state or estimate any of their numbers, sessions or dates. Say briefly that you cannot see their details at this moment and that their plan and logs are on the Today tab. ' +
  'Keep any training guidance general and conservative; never suggest increasing intensity, load or volume in this turn.';

/** One line of surface-specific framing. The voice contract is identical on both. */
function surfaceFraming(surface: RomanSurface): string {
  switch (surface) {
    case 'coach':
      return 'You are addressing a coach inside the TGP coach app. Speak to a professional who runs a coaching practice; never reveal another coach\'s or client\'s private data.';
    case 'client':
    default:
      return 'You are addressing a client inside the TGP client app. Speak to the person training under a coach; never reveal another user\'s private data.';
  }
}

/**
 * Build the system message for a Roman chat turn. Combines the verbatim voice
 * contract, the one-line surface framing, the live per-session voice budget,
 * and (optionally) the subject context.
 */
export function buildRomanSystemPrompt(input: BuildSystemPromptInput): string {
  const { surface, voice, subjectContext, routerHint, clientData, clientDataUnavailable, augments } =
    input;

  // B-651-9: shipped replies carry no exclamation marks at all, so the old
  // one-per-session allowance is gone whatever the session recorded.
  const remainingExclamation =
    'Do not use an exclamation point in this reply. Mark a milestone in plain, warm words.';

  const quipGuidance = voice.lastTurnHadQuip
    ? `Your previous turn carried a dry quip, so this turn MUST NOT. (Quips used this session: ${voice.quipsInSession}.)`
    : `Quips used this session: ${voice.quipsInSession}. Keep dry humour rare — roughly one message in eight, most turns carry none.`;

  // The client surface carries the static reply contract (scope, grounding,
  // coach targets, calorie floor, injury, tone): no per-user data, so the
  // block is byte-identical across users. Per-user data comes only in the
  // delimited client_data block below.
  const sections: string[] = [
    ROMAN_VOICE_CONTRACT,
    ...(surface === 'client' ? [ROMAN_GUARDRAIL_CONTRACT] : []),
    `# SURFACE\n${surfaceFraming(surface)}`,
    `# SESSION STATE\n${remainingExclamation}\n${quipGuidance}${
      routerHint && routerHint.trim().length > 0 ? `\n${routerHint.trim()}` : ''
    }`,
  ];

  if (surface === 'client') {
    if (clientData && clientData.trim().length > 0) {
      sections.push(clientData.trim());
    } else if (clientDataUnavailable) {
      sections.push(ROMAN_CLIENT_DATA_UNAVAILABLE_NOTICE);
    }
    for (const block of augments ?? []) {
      if (typeof block === 'string' && block.trim().length > 0) sections.push(block.trim());
    }
  }

  if (subjectContext && subjectContext.trim().length > 0) {
    // The subject context is reference material, never to be recited verbatim.
    sections.push(
      `# SUBJECT CONTEXT (reference only — do not recite verbatim)\n${subjectContext.trim()}`,
    );
  }

  return sections.join('\n\n');
}
