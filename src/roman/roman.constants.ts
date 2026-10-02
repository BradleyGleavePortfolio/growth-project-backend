/**
 * Roman Phase 1 budgets and limits (brief §3).
 */

/** Per-user user-turn caps per rolling 24h, by tier (brief §3). */
export const ROMAN_RATE_LIMIT_FREE_PER_DAY = 50;
export const ROMAN_RATE_LIMIT_PRO_PER_DAY = 500;

/** Rolling rate-limit window. */
export const ROMAN_RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * day_key prefix of an ERASED session shell (`erased:<session id>`). Erasing
 * a chat moves its row off the (user, surface, UTC day) key so the unique
 * index `roman_session_user_surface_day` no longer blocks a fresh session the
 * same day (Sol B-635-1); the shell keeps only a content-free count of the
 * erased user turns for the daily cap. A deleted row whose day_key does NOT
 * carry this prefix is a pre-upgrade soft delete that still holds transcript
 * rows (Sol C-635-1) and is erased by the sweep / the open path.
 */
export const ROMAN_ERASED_DAY_KEY_PREFIX = 'erased:';

/** Rows per batch and max batches per run of the deleted-session erasure sweep. */
export const ROMAN_ERASE_SWEEP_BATCH = 100;
export const ROMAN_ERASE_SWEEP_MAX_BATCHES = 50;

/** Delay after boot before the first erasure sweep (keeps it off the boot path). */
export const ROMAN_ERASE_SWEEP_BOOT_DELAY_MS = 60_000;

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
