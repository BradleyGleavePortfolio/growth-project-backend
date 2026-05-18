/**
 * Sanitize user-controlled strings before insertion into AI prompts.
 *
 * Goals:
 *  1. Strip common prompt-injection markers (role labels, XML-style tags,
 *     "ignore previous instructions" patterns).
 *  2. Truncate to a safe maximum length.
 *  3. Normalize whitespace to prevent invisible-character attacks.
 *
 * This does NOT make injection impossible — LLMs are probabilistic — but
 * it removes the most obvious attack vectors and makes injection attempts
 * visible in logs.
 */

// Patterns that are common prompt-injection signals.
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/gi,
  /system\s*:/gi,
  /\[INST\]/gi,
  /<<SYS>>/gi,
  /<\/?s>/gi,         // Llama-style delimiters
  /\[\/INST\]/gi,
  /###\s*(Human|Assistant|System)/gi,
  /^(Human|Assistant|System)\s*:/gim,
];

export function sanitizePromptInput(
  value: unknown,
  maxLength = 2000,
): string {
  if (typeof value !== 'string') return '';
  let sanitized = value
    .normalize('NFC')
    // Strip null bytes and other control characters (except newlines/tabs)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // Normalize whitespace runs
    .replace(/[ \t]{3,}/g, '  ')
    .trim();

  // Replace injection patterns with a visible placeholder so logs reveal attempts.
  for (const pattern of INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }

  // Truncate.
  if (sanitized.length > maxLength) {
    sanitized = sanitized.slice(0, maxLength) + '…';
  }

  return sanitized;
}
