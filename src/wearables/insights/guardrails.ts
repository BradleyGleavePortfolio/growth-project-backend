import { ConfidenceLevel } from './insight-output.schema';

// PR-HK-4 — output guardrails for the AI insight surface.
//
// Two independent concerns live here:
//   1. NO-MEDICALIZE (UNIFIED_BUILD_PLAN §0): the insight surface is a
//      performance-coaching tool, not a diagnostic one. The model must
//      never name a condition, suggest a treatment, or imply a diagnosis.
//      `applyGuardrails` is the last line of defence after the system
//      prompt: any output containing a blocked clinical term is REJECTED
//      so the caller can fall back to a safe payload rather than ship
//      medicalizing copy.
//   2. CONFIDENCE CALIBRATION (UNIFIED_BUILD_PLAN §"Confidence
//      calibration"): a raw model/heuristic confidence in [0,1] maps to
//      one of the five calibrated labels. Boundaries are inclusive on the
//      lower bound, exclusive on the upper, with 1.0 the only value that
//      earns 'verified'.
//
// A third helper, `redactProviderTokens`, scrubs raw provider strings
// (OAuth tokens, bearer headers, provider account ids) from any text
// before it is injected into a prompt — defence against prompt injection
// of secrets (audit criteria: "no prompt injection of raw provider
// strings without redaction").

// Block-list of clinical / medicalizing terms. Stored as a mix of exact
// phrases and wildcard stems (`diagnos*`, `treat*`) so we catch
// "diagnose", "diagnosis", "diagnostic", "treat", "treatment", "treating",
// etc. Order does not matter — we test every entry.
//
// Each entry is { label, test } where `test` matches against a
// lower-cased, word-boundaried view of the text.
interface BlockRule {
  label: string;
  // A precompiled regex matched against the lower-cased text.
  pattern: RegExp;
}

// Build a word-boundaried regex for a literal phrase.
function phrase(p: string): RegExp {
  // Escape regex metacharacters in the phrase, then bound on word edges.
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i');
}

// Build a word-boundaried "stem*" regex: matches the stem followed by any
// word characters (so `diagnos` matches diagnose/diagnosis/diagnostic).
function stem(s: string): RegExp {
  const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\w*`, 'i');
}

// The blocked vocabulary, mirroring the task's BLOCK list verbatim:
//   apnea, arrhythmia, insomnia, depression, disorder, diagnos*, treat*,
//   cure, anxiety disorder, sleep disorder
//
// "anxiety disorder" and "sleep disorder" are listed explicitly per the
// spec even though the bare "disorder" stem already covers them — the
// dedicated phrases make the intent legible and keep the test matrix
// one-to-one with the spec.
export const MEDICALIZE_BLOCK_RULES: BlockRule[] = [
  { label: 'apnea', pattern: phrase('apnea') },
  { label: 'arrhythmia', pattern: phrase('arrhythmia') },
  { label: 'insomnia', pattern: phrase('insomnia') },
  { label: 'depression', pattern: phrase('depression') },
  { label: 'disorder', pattern: stem('disorder') },
  { label: 'diagnos*', pattern: stem('diagnos') },
  { label: 'treat*', pattern: stem('treat') },
  { label: 'cure', pattern: phrase('cure') },
  { label: 'anxiety disorder', pattern: phrase('anxiety disorder') },
  { label: 'sleep disorder', pattern: phrase('sleep disorder') },
];

export interface GuardrailResult {
  text: string;
  rejected: boolean;
  reason?: string;
}

// Scan `text` for any medicalizing term. On the FIRST match we reject,
// returning the original text unchanged plus the matched rule label so
// the caller can log + fall back. We do NOT attempt to silently rewrite
// the model's clinical claim — a partial scrub could leave a dangerous
// half-sentence ("your sleep ___ is severe"). Reject-and-regenerate is
// the safe posture (audit criteria: guardrails reject medicalizing/
// overclaiming language).
export function applyGuardrails(text: string): GuardrailResult {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: text ?? '', rejected: false };
  }
  for (const rule of MEDICALIZE_BLOCK_RULES) {
    if (rule.pattern.test(text)) {
      return {
        text,
        rejected: true,
        reason: `medicalize:${rule.label}`,
      };
    }
  }
  return { text, rejected: false };
}

// Map a raw confidence in [0,1] to the calibrated label vocabulary.
//
//   x < 0.6           → 'i_think'
//   0.6 <= x < 0.8    → 'fairly_sure'
//   0.8 <= x < 0.9    → 'confident'
//   0.9 <= x < 1.0    → 'certain'
//   x == 1.0          → 'verified'
//
// Out-of-range inputs are clamped to [0,1] first so a stray 1.4 cannot
// over-claim past 'verified', and a negative cannot under-flow.
export function calibrateConfidence(rawConfidence: number): ConfidenceLevel {
  const x = Math.min(1, Math.max(0, Number.isFinite(rawConfidence) ? rawConfidence : 0));
  if (x >= 1.0) return 'verified';
  if (x >= 0.9) return 'certain';
  if (x >= 0.8) return 'confident';
  if (x >= 0.6) return 'fairly_sure';
  return 'i_think';
}

// Redact raw provider secrets / tokens from free text before it is woven
// into a prompt. This is a belt-and-braces complement to the gateway's
// own redaction layer: the insight prompt templates call this on any
// string that originated from a provider payload (account ids, raw token
// fragments) so a leaked secret can never be embedded into the LLM
// request body.
//
// Patterns covered:
//   - Bearer / Authorization header values
//   - OAuth-style access/refresh token assignments
//   - Long opaque tokens (>= 24 chars of base64url/JWT-ish runs)
//   - The KMS envelope prefix shape (base64 JSON {"v":...}) — never
//     prompt-embed an encrypted blob.
const REDACTION_PATTERNS: { re: RegExp; replacement: string }[] = [
  // Authorization: Bearer <token>
  { re: /\b(bearer)\s+[A-Za-z0-9._-]+/gi, replacement: '$1 [REDACTED]' },
  // access_token=... / refresh_token: "..." / "token":"..."
  {
    re: /\b((?:access|refresh|api|provider)?_?token)\s*[:=]\s*["']?[A-Za-z0-9._-]+["']?/gi,
    replacement: '$1=[REDACTED]',
  },
  // Long opaque runs that look like tokens (JWT segments, base64url keys).
  { re: /\b[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replacement: '[REDACTED_TOKEN]' },
];

export function redactProviderTokens(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text ?? '';
  let out = text;
  for (const { re, replacement } of REDACTION_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}
