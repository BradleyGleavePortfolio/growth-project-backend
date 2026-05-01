import { Injectable } from '@nestjs/common';

// Minimization + redaction layer. Runs before any provider call and on
// any free-form rationale we persist to AiActionDraft. The goal is to
// keep training-grade identifiers out of provider request bodies and
// reduce blast radius if a provider misroutes or logs prompts.
//
// This is NOT a full PII scrubber — the structured CLIENT_CONTEXT block
// already excludes raw email/phone. This pass catches user-supplied
// free-text (chat messages, notes) where someone might paste an email
// address, phone number, or credential-shaped string.

export interface RedactionSummary {
  email: number;
  phone: number;
  ssn: number;
  credit_card: number;
  ip: number;
  bearer_token: number;
  url_with_credentials: number;
}

export interface RedactionResult {
  text: string;
  summary: RedactionSummary;
}

const PATTERNS: Array<{ key: keyof RedactionSummary; pattern: RegExp; mask: string }> = [
  // Order matters: higher-specificity patterns first (e.g. URL with creds
  // before bearer token, before email). Patterns are global (`g`) so we
  // count all matches; counts are accumulated per replace pass.
  {
    key: 'url_with_credentials',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@\S+/gi,
    mask: '[redacted-url]',
  },
  {
    key: 'bearer_token',
    pattern: /\bBearer\s+[A-Za-z0-9._-]{16,}/g,
    mask: 'Bearer [redacted-token]',
  },
  {
    key: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    mask: '[redacted-email]',
  },
  {
    key: 'phone',
    // E.164 + common North-American forms. Avoids matching short numbers
    // (e.g. "5 reps") by requiring at least 10 digits (with separators).
    pattern: /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g,
    mask: '[redacted-phone]',
  },
  {
    key: 'ssn',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    mask: '[redacted-ssn]',
  },
  {
    key: 'credit_card',
    // 13-19 digits with optional separators. Conservative — does not Luhn.
    pattern: /\b(?:\d[ -]?){13,19}\b/g,
    mask: '[redacted-card]',
  },
  {
    key: 'ip',
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    mask: '[redacted-ip]',
  },
];

const EMPTY_SUMMARY = (): RedactionSummary => ({
  email: 0,
  phone: 0,
  ssn: 0,
  credit_card: 0,
  ip: 0,
  bearer_token: 0,
  url_with_credentials: 0,
});

@Injectable()
export class AiRedactionService {
  redact(input: string): RedactionResult {
    const summary = EMPTY_SUMMARY();
    if (!input) return { text: input ?? '', summary };
    let text = input;
    for (const { key, pattern, mask } of PATTERNS) {
      const matches = text.match(pattern);
      if (matches && matches.length > 0) {
        summary[key] = (summary[key] ?? 0) + matches.length;
        text = text.replace(pattern, mask);
      }
    }
    return { text, summary };
  }

  // Convenience for redacting a structured object's free-text fields. Only
  // string values are touched; nested objects/arrays are recursed.
  // Non-string leaves pass through unchanged.
  redactObject<T>(obj: T): { value: T; summary: RedactionSummary } {
    const summary = EMPTY_SUMMARY();
    const out = this.walk(obj, summary);
    return { value: out as T, summary };
  }

  private walk(value: unknown, summary: RedactionSummary): unknown {
    if (typeof value === 'string') {
      const r = this.redact(value);
      for (const k of Object.keys(r.summary) as Array<keyof RedactionSummary>) {
        summary[k] += r.summary[k];
      }
      return r.text;
    }
    if (Array.isArray(value)) return value.map((v) => this.walk(v, summary));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.walk(v, summary);
      }
      return out;
    }
    return value;
  }

  emptySummary(): RedactionSummary {
    return EMPTY_SUMMARY();
  }
}
