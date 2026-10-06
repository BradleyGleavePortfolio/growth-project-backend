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
 * Follow-up runs of the erasure sweep (Sol C-635-1 / B-635-3). A run that
 * made progress but left rows behind (the per-run bound was hit, or a
 * straggler arrived) continues after ROMAN_ERASE_SWEEP_CONTINUE_DELAY_MS until
 * nothing is left. A run that erased nothing but saw failures retries after
 * ROMAN_ERASE_SWEEP_RETRY_DELAY_MS, at most ROMAN_ERASE_SWEEP_MAX_RETRIES times
 * in a row, then waits for the nightly run (every failure is already in
 * Sentry, so a persistent fault is never silent).
 */
export const ROMAN_ERASE_SWEEP_CONTINUE_DELAY_MS = 60_000;
export const ROMAN_ERASE_SWEEP_RETRY_DELAY_MS = 15 * 60_000;
export const ROMAN_ERASE_SWEEP_MAX_RETRIES = 4;

/**
 * DELETE /roman/sessions (erase every chat of the caller, B-635-2): sessions
 * erased per batch, and the batch bound per request. One session exists per
 * (surface, UTC day), so the bound covers years of daily use on both
 * surfaces; anything left past it is a coded 503 the client can retry (what
 * was erased stays erased).
 */
export const ROMAN_DELETE_ALL_BATCH = 100;
export const ROMAN_DELETE_ALL_MAX_BATCHES = 50;

/** Default + max page size for the caller's session list (GET /roman/sessions). */
export const ROMAN_SESSIONS_DEFAULT_LIMIT = 30;
export const ROMAN_SESSIONS_MAX_LIMIT = 100;

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
/** 404: the session does not exist for this caller (never 403: no ID probing). */
export const ROMAN_ERROR_SESSION_NOT_FOUND = 'ROMAN_SESSION_NOT_FOUND';
/** 503: a delete could not finish; nothing of that chat was removed, retry is safe. */
export const ROMAN_ERROR_ERASE_INCOMPLETE = 'ROMAN_ERASE_INCOMPLETE';
/** 400: the session-list cursor is not one of the caller's sessions, or is not a session id at all. */
export const ROMAN_ERROR_CURSOR_INVALID = 'ROMAN_CURSOR_INVALID';
/**
 * 400 (Sol B-635-5): GET /roman/sessions was sent a limit, surface or
 * parameter it does not accept. The message names the parameter and the
 * accepted values. The app only sends valid queries, so this means an
 * outdated or modified client: refresh, then update the app.
 */
export const ROMAN_ERROR_SESSIONS_QUERY_INVALID = 'ROMAN_SESSIONS_QUERY_INVALID';

/** User-facing copy for the coded Roman errors (plain words, a next step). */
export const ROMAN_SESSION_NOT_FOUND_MESSAGE =
  'This conversation no longer exists. Open Roman again to start a new one.';
export const ROMAN_ERASE_INCOMPLETE_MESSAGE =
  'Roman could not finish deleting this conversation, so it was not changed. Try deleting it again in a moment.';
/**
 * Sol B-635-4: the erase transaction failed in a way that does not prove a
 * rollback (connection lost, commit acknowledgement lost), so the chat may or
 * may not be gone. Never claim "not changed" here; deleting again is safe
 * (a repeat delete of an erased chat is a quiet 204).
 */
export const ROMAN_ERASE_UNCONFIRMED_MESSAGE =
  'Roman could not confirm that this conversation was deleted. Delete it again in a moment to make sure. Deleting it twice is safe.';
export const ROMAN_ERASE_ALL_INCOMPLETE_MESSAGE =
  'Roman could not finish deleting your conversations. The ones already deleted stay deleted. Try again in a moment to delete the rest.';
export const ROMAN_CURSOR_INVALID_MESSAGE =
  'This list of conversations is out of date. Refresh it to load your conversations again.';

// ─── OR-113-2: live chat launch hardening ───────────────────────────────────

/**
 * Platform-wide daily spend ceiling for all Roman turns together (UTC day),
 * in US dollars: a runaway breaker, not a per-client limit (the per-client
 * limit is the 429 ROMAN_RATE_LIMIT turn cap above; the per-coach money
 * bound is the coach's monthly AI credit pool). Env ROMAN_DAILY_COST_CAP_USD
 * (registered in ENV_RULES); default 100, sized to launch volume (operator
 * 121, 13:33): about 2,000 to 3,000 ordinary turns a day at $0.03 to $0.05
 * each, or 23 clients each at the full 50-turn limit at the worst-case
 * reservation, so ordinary launch use never meets it. A turn
 * RESERVES the upper bound of its exact payload plus max output in the
 * content-free ledger (AiRequestAudit, capability `roman.chat`) under a
 * per-day advisory lock before the provider call (B-651-4/5), and settles
 * the known tokens after it, keeping the reserved value for any side whose
 * usage the provider never reported (B-651-1). Fail closed: when today's
 * spend cannot be read, no paid call is made.
 */
export const ROMAN_DAILY_COST_CAP_USD_ENV = 'ROMAN_DAILY_COST_CAP_USD';
export const ROMAN_DAILY_COST_CAP_USD_DEFAULT = 100;
/** claude-sonnet-4-6 list price per million tokens (input / output), USD. */
export const ROMAN_PRICE_PER_MTOK = { input: 3, output: 15 } as const;
/** The content-free ledger capability for one Roman turn. */
export const ROMAN_LEDGER_CAPABILITY = 'roman.chat';

// ─── Roman v1.1 seams (R11-00) ───────────────────────────────────────────────

/** Ledger + coach-pool capability for v1.1 memory work (day summaries, notes). */
export const ROMAN_MEMORY_CAPABILITY = 'roman.memory';
/** Ledger + coach-pool capability for v1.1 coach playbook builds. */
export const ROMAN_PLAYBOOK_CAPABILITY = 'roman.playbook';
/** The background capabilities, which share one daily ceiling. */
export const ROMAN_BACKGROUND_CAPABILITIES = [
  ROMAN_MEMORY_CAPABILITY,
  ROMAN_PLAYBOOK_CAPABILITY,
] as const;
export type RomanBackgroundCapability = (typeof ROMAN_BACKGROUND_CAPABILITIES)[number];

/**
 * Platform-wide daily ceiling (UTC day, US dollars) for all background work
 * together, separate from ROMAN_DAILY_COST_CAP_USD so background jobs can
 * never use chat headroom (owner decision D4 default). Unset or invalid = 10,
 * never no cap.
 */
export const ROMAN_BACKGROUND_DAILY_COST_CAP_USD_ENV = 'ROMAN_BACKGROUND_DAILY_COST_CAP_USD';
export const ROMAN_BACKGROUND_DAILY_COST_CAP_USD_DEFAULT = 10;

/**
 * Upper bound of the time one turn augmenter may take before its block is
 * left out of the turn (the turn itself always continues).
 */
export const ROMAN_TURN_AUGMENTER_TIMEOUT_MS = 1500;

/**
 * Who a Roman failure message is written for. Roman serves clients
 * (`student`) AND coaches / the owner on the coach surface: a client is
 * pointed to their coach, a coach is never told to message "your coach".
 */
export type RomanAudience = 'client' | 'coach';
export function romanAudienceOf(role: string | null | undefined): RomanAudience {
  return role === 'coach' || role === 'owner' ? 'coach' : 'client';
}
/** The working next step that closes every coach-audience failure message. */
const ROMAN_COACH_NEXT_STEP = 'Your clients, messages and the rest of the app work as usual.';

/** 429: the caller used their rolling 24 h Roman turns. */
export function romanRateLimitMessage(retryAfterSeconds: number, role: string = 'student'): string {
  const hours = Math.max(1, Math.round(retryAfterSeconds / 3600));
  const when = retryAfterSeconds < 3600 ? 'within the hour' : `in about ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const next =
    romanAudienceOf(role) === 'client'
      ? 'Your coach is in Messages any time, and your plan and logs work as usual.'
      : ROMAN_COACH_NEXT_STEP;
  return `You have used your Roman conversations for today. Roman can talk again ${when}. ${next}`;
}

/** 503: today's Roman capacity (the daily spend cap) is used up. */
export const ROMAN_ERROR_CAPACITY_REACHED = 'ROMAN_CAPACITY_REACHED';
export const ROMAN_CAPACITY_REACHED_MESSAGE =
  'Roman has reached his limit of conversations for today and will be back tomorrow. Your coach is in Messages any time, and your plan and logs work as usual.';
/** 503: the spend ledger could not be read, so Roman does not answer (fail closed). */
export const ROMAN_CAPACITY_UNKNOWN_MESSAGE =
  'Roman cannot check his daily limit at this moment, so he is not answering yet. Send your message again in a few minutes. Your coach is in Messages any time.';
/** 503: the language model did not answer (outage, timeout, overload). */
export const ROMAN_ERROR_MODEL_UNAVAILABLE = 'ROMAN_MODEL_UNAVAILABLE';
export const ROMAN_MODEL_UNAVAILABLE_MESSAGE =
  'Roman could not reach his language service just now, so this message has no reply yet. Your message is saved. Send it again in a minute; if it keeps happening, your coach is in Messages.';
/** 503: Roman is switched on but the provider key is not configured. */
export const ROMAN_NOT_CONFIGURED_MESSAGE =
  'Roman is not set up on this server yet. Your coach is in Messages any time, and the support team has been told.';

/** 503: the chat flag is off (defence-in-depth re-check inside the turn). */
export const ROMAN_SWITCHED_OFF_MESSAGE =
  'Roman is switched off at the moment. Your coach is in Messages any time.';

// Coach-audience variants (coach surface; the owner reads the same copy).
export const ROMAN_CAPACITY_REACHED_MESSAGE_COACH =
  `Roman has reached his limit of conversations for today and will be back tomorrow. ${ROMAN_COACH_NEXT_STEP}`;
export const ROMAN_CAPACITY_UNKNOWN_MESSAGE_COACH =
  `Roman cannot check his daily limit at this moment, so he is not answering yet. Send your message again in a few minutes. ${ROMAN_COACH_NEXT_STEP}`;
export const ROMAN_MODEL_UNAVAILABLE_MESSAGE_COACH =
  `Roman could not reach his language service just now, so this message has no reply yet. Your message is saved. Send it again in a minute. ${ROMAN_COACH_NEXT_STEP}`;
export const ROMAN_NOT_CONFIGURED_MESSAGE_COACH =
  `Roman is not set up on this server yet, and the support team has been told. ${ROMAN_COACH_NEXT_STEP}`;
export const ROMAN_SWITCHED_OFF_MESSAGE_COACH = `Roman is switched off at the moment. ${ROMAN_COACH_NEXT_STEP}`;

/**
 * 402 COACH_AI_BUDGET_EXHAUSTED (B-668-1): the coach's monthly AI credit pool
 * is used up. The client copy never shows the coach's credit figures.
 */
export const ROMAN_COACH_POOL_EMPTY_MESSAGE =
  "Your coach's AI credits for this month are used up, so Roman cannot answer right now. Your coach is in Messages any time, and your plan and logs work as usual.";
export const ROMAN_COACH_POOL_EMPTY_MESSAGE_COACH = `The AI credits on your coaching account are used up for this month, so Roman cannot answer right now. Add a credit pack to keep using Roman. ${ROMAN_COACH_NEXT_STEP}`;

/** The failure copy for one machine code, written for the caller's audience. */
export function romanFailureMessage(
  kind: 'capacity_reached' | 'capacity_unknown' | 'model_unavailable' | 'not_configured' | 'switched_off',
  role: string | null | undefined,
): string {
  const client = romanAudienceOf(role) === 'client';
  switch (kind) {
    case 'capacity_reached':
      return client ? ROMAN_CAPACITY_REACHED_MESSAGE : ROMAN_CAPACITY_REACHED_MESSAGE_COACH;
    case 'capacity_unknown':
      return client ? ROMAN_CAPACITY_UNKNOWN_MESSAGE : ROMAN_CAPACITY_UNKNOWN_MESSAGE_COACH;
    case 'model_unavailable':
      return client ? ROMAN_MODEL_UNAVAILABLE_MESSAGE : ROMAN_MODEL_UNAVAILABLE_MESSAGE_COACH;
    case 'not_configured':
      return client ? ROMAN_NOT_CONFIGURED_MESSAGE : ROMAN_NOT_CONFIGURED_MESSAGE_COACH;
    case 'switched_off':
      return client ? ROMAN_SWITCHED_OFF_MESSAGE : ROMAN_SWITCHED_OFF_MESSAGE_COACH;
  }
}
