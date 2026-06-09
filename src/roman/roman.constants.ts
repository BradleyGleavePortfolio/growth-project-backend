/**
 * Roman Phase 1 budgets and limits (brief §3).
 */

/** Per-user user-turn caps per rolling 24h, by tier (brief §3). */
export const ROMAN_RATE_LIMIT_FREE_PER_DAY = 50;
export const ROMAN_RATE_LIMIT_PRO_PER_DAY = 500;

/** Rolling rate-limit window. */
export const ROMAN_RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Max prior turns included in an API call (brief §3). Phase 1 ships a simple
 * tail-slice of the most recent N turns; Phase 1.1 summarises older turns into
 * a single "earlier in this session: …" line.
 */
export const ROMAN_MAX_CONTEXT_TURNS = 30;

/** Default + max page size for the messages list endpoint. */
export const ROMAN_MESSAGES_DEFAULT_LIMIT = 30;
export const ROMAN_MESSAGES_MAX_LIMIT = 100;

/** Max tokens for a single Roman completion. */
export const ROMAN_MAX_OUTPUT_TOKENS = 1024;

/** Structured error codes (ENGINEERING_RULES §3 / AGENT_RULES #9 — no raw codes). */
export const ROMAN_ERROR_RATE_LIMIT = 'ROMAN_RATE_LIMIT';
export const ROMAN_ERROR_UNAVAILABLE = 'ROMAN_UNAVAILABLE';
