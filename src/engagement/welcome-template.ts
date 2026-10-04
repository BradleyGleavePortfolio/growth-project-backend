/**
 * Coach welcome message template (C05 item 6).
 *
 * The code ships ONE generic default. It names no clinic, no partner and no
 * coach. A coach's real template is runtime data: the operator writes it to
 * CoachWelcomeMessageSetting.template at bootstrap (owner endpoint or
 * scripts/set-coach-welcome-message.ts). It must never be committed.
 *
 * Placeholders: {first_name} (client) and {coach_first_name}. Any other
 * {token} is rejected at write time so a typo never reaches a client as a
 * literal brace.
 */

export const DEFAULT_WELCOME_TEMPLATE =
  "Hi {first_name}, it's {coach_first_name}. Welcome in. Your plan and targets are ready. Message me here anytime.";

/** Delay after onboarding completed_at (owner ruling 2026-09-30 18:11). */
export const WELCOME_DELAY_MS = 13 * 60 * 1000;

export const WELCOME_TEMPLATE_MAX_LENGTH = 1000;

export const WELCOME_TEMPLATE_VARIABLES = ['first_name', 'coach_first_name'] as const;

const TOKEN_RE = /\{([^{}]*)\}/g;

/** Fallbacks keep the sentence natural when a name is missing. */
const CLIENT_NAME_FALLBACK = 'there';
const COACH_NAME_FALLBACK = 'your coach';

export type TemplateValidation =
  | { ok: true; template: string }
  | {
      ok: false;
      code: 'empty' | 'too_long' | 'unknown_placeholder' | 'unbalanced_braces';
      detail?: string;
    };

export function validateWelcomeTemplate(raw: unknown): TemplateValidation {
  if (typeof raw !== 'string') return { ok: false, code: 'empty' };
  const template = raw.replace(/\r\n/g, '\n').trim();
  if (template.length === 0) return { ok: false, code: 'empty' };
  if (template.length > WELCOME_TEMPLATE_MAX_LENGTH) return { ok: false, code: 'too_long' };
  const allowed: readonly string[] = WELCOME_TEMPLATE_VARIABLES;
  for (const m of template.matchAll(TOKEN_RE)) {
    if (!allowed.includes(m[1])) {
      return { ok: false, code: 'unknown_placeholder', detail: m[1].slice(0, 40) };
    }
  }
  // After removing the known tokens no stray brace may remain.
  if (/[{}]/.test(template.replace(TOKEN_RE, ''))) {
    return { ok: false, code: 'unbalanced_braces' };
  }
  return { ok: true, template };
}

/** First whitespace-delimited token of a display name, or null. */
export function firstNameOf(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  const first = name.trim().split(/\s+/)[0] ?? '';
  return first.length > 0 ? first.slice(0, 60) : null;
}

export function renderWelcomeMessage(
  template: string | null | undefined,
  vars: { clientName: string | null | undefined; coachName: string | null | undefined },
): string {
  const checked = validateWelcomeTemplate(template ?? DEFAULT_WELCOME_TEMPLATE);
  // A stored template that no longer validates falls back to the default
  // rather than sending something malformed.
  const tpl = checked.ok ? checked.template : DEFAULT_WELCOME_TEMPLATE;
  const values: Record<string, string> = {
    first_name: firstNameOf(vars.clientName) ?? CLIENT_NAME_FALLBACK,
    coach_first_name: firstNameOf(vars.coachName) ?? COACH_NAME_FALLBACK,
  };
  return tpl.replace(TOKEN_RE, (_m, key: string) => values[key] ?? '').trim();
}
