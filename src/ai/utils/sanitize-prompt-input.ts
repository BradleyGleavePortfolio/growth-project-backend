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
const INJECTION_PATTERNS: RegExp[] = [
  // Classic instruction override
  /ignore\s+(all\s+)?(previous|prior|above|the\s+above)\s+instructions?/gi,
  /disregard\s+(all\s+)?(previous|prior|above)\s+instructions?/gi,
  /forget\s+(all\s+)?(previous|prior|above)\s+instructions?/gi,
  // Numbered/step override attempts
  /step\s*\d+\s*:\s*ignore/gi,
  /step\s*\d+\s*:\s*disregard/gi,
  // Role label prefixes (start of line or after newline)
  /^(human|assistant|system|user|ai|developer|coach|client)\s*:/gim,
  // OpenAI / Anthropic delimiters
  /\[INST\]/gi,
  /\[\/INST\]/gi,
  /<<SYS>>/gi,
  /<<\/SYS>>/gi,
  /<\|im_start\|>/gi,
  /<\|im_end\|>/gi,
  /<\|system\|>/gi,
  /<\|user\|>/gi,
  /<\|assistant\|>/gi,
  // XML-style context wrappers
  /<\/?context>/gi,
  /<\/?system>/gi,
  /<\/?instructions?>/gi,
  /<\/?prompt>/gi,
  /<\/?s>/gi,
  // Llama / Mistral
  /###\s*(Human|Assistant|System|Instruction)/gi,
  /BEGIN\s+INSTRUCTIONS?/gi,
  /END\s+INSTRUCTIONS?/gi,
];

export function sanitizePromptInput(
  value: unknown,
  maxLength = 2000,
): string {
  if (typeof value !== 'string') return '';
  let sanitized = value
    .normalize('NFC')
    // Strip non-ASCII characters that could be used as Unicode confusables.
    // Legitimate user content (names, addresses) may use accented Latin — those
    // are preserved by NFC normalization above. Characters entirely outside
    // Latin Extended are stripped.
    .replace(/[^\x00-\x7F\u00C0-\u024F\u1E00-\u1EFF]/g, ' ')
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
