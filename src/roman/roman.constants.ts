/**
 * Roman Phase 1 budgets and limits (brief §3).
 */

/** Per-user user-turn caps per rolling 24h, by tier (brief §3). */
export const ROMAN_RATE_LIMIT_FREE_PER_DAY = 50;
export const ROMAN_RATE_LIMIT_PRO_PER_DAY = 500;

/** Rolling rate-limit window. */
export const ROMAN_RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * History budget for one API call (PLAN_roman_intelligence §2.4). The most
 * recent N turns are included, oldest-first; each prior turn is clamped to
 * ROMAN_HISTORY_TURN_MAX_CHARS and the whole history is trimmed oldest-first
 * until it fits ROMAN_HISTORY_MAX_TOKENS (estimated at ROMAN_CHARS_PER_TOKEN).
 */
export const ROMAN_MAX_CONTEXT_TURNS = 20;
export const ROMAN_HISTORY_TURN_MAX_CHARS = 1500;
export const ROMAN_HISTORY_MAX_TOKENS = 6000;
/** Conservative chars-per-token estimate used for local budgeting only. */
export const ROMAN_CHARS_PER_TOKEN = 4;

/** Default + max page size for the messages list endpoint. */
export const ROMAN_MESSAGES_DEFAULT_LIMIT = 30;
export const ROMAN_MESSAGES_MAX_LIMIT = 100;

/**
 * Max tokens for a single Roman completion (plan §2.4). Up-front thinking is
 * off on the primary model (`thinking.type=between_tools`), so this is text.
 */
export const ROMAN_MAX_OUTPUT_TOKENS = 2048;

/** Per-call upstream timeout (plan §2.8: 30 s upstream; mobile waits 60 s). */
export const ROMAN_UPSTREAM_TIMEOUT_MS = 30_000;

/**
 * Deterministic reply when the global daily spend cap has tripped (plan §2.8).
 * No model call is made. Voice contract: no contractions, no exclamation.
 */
export const ROMAN_DAILY_CAP_REPLY =
  'I am resting for the rest of today and cannot answer new questions. Your coach is available in Messages, and I will be back tomorrow.';

/** Structured error codes (ENGINEERING_RULES §3 / AGENT_RULES #9 — no raw codes). */
export const ROMAN_ERROR_RATE_LIMIT = 'ROMAN_RATE_LIMIT';
export const ROMAN_ERROR_UNAVAILABLE = 'ROMAN_UNAVAILABLE';
/** The model returned no text at all (e.g. a refusal stop) — never a blank bubble. */
export const ROMAN_ERROR_EMPTY_REPLY = 'ROMAN_EMPTY_REPLY';
/** User-facing copy for an upstream failure (voice contract: state fact + remedy, stop). */
export const ROMAN_UNAVAILABLE_MESSAGE =
  'Roman could not answer just now. Please try again in a moment.';
