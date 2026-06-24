// TM-9 — Portfolio showcase model + validators. A projection over existing
// Applicant columns; every external URL is HTTPS-only, length-capped, and
// rejected if it carries an inline base64 / data-URI blob (DoS guard).
//
// NOTE (intro_video deferred): there is intentionally no `intro_video_url`
// field on the showcase. The Applicant table has no backing column for it, so
// exposing it in the contract would advertise a write that silently evaporates
// (the dual-lens P0). It will be reintroduced — DTO, persistence, and read-back
// together — only once a real `intro_video_url` column exists on Applicant.

export const PORTFOLIO_URL_MAX_LEN = 1024;
// One sample-program URL is persisted (single Applicant column), so the cap is
// 1 everywhere — DTO @ArrayMaxSize and the service share this single constant
// so OpenAPI clients and the runtime guard never disagree (B-P1-1).
export const PORTFOLIO_MAX_SAMPLE_PROGRAMS = 1;

const BASE64_BLOB = /^data:|;base64,|^[A-Za-z0-9+/]{512,}={0,2}$/;

export interface PortfolioShowcase {
  headline: string | null;
  about: string | null;
  specialties: string[];
  sample_program_urls: string[];
}

export function isValidShowcaseUrl(raw: string): boolean {
  if (raw.length === 0 || raw.length > PORTFOLIO_URL_MAX_LEN) return false;
  if (BASE64_BLOB.test(raw)) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:';
}

// Empty/omitted → null (clearing is allowed); present-but-invalid → hard reject.
export type UrlCheck =
  | { ok: true; value: string | null }
  | { ok: false; reason: 'invalid_url' };

export function checkOptionalUrl(raw: string | null | undefined): UrlCheck {
  if (raw == null) return { ok: true, value: null };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (!isValidShowcaseUrl(trimmed)) return { ok: false, reason: 'invalid_url' };
  return { ok: true, value: trimmed };
}

export type UrlListCheck =
  | { ok: true; value: string[] }
  | { ok: false; reason: 'too_many' | 'invalid_url' };

export function checkSampleProgramUrls(
  raw: string[] | null | undefined,
): UrlListCheck {
  if (raw == null) return { ok: true, value: [] };
  if (raw.length > PORTFOLIO_MAX_SAMPLE_PROGRAMS) {
    return { ok: false, reason: 'too_many' };
  }
  const cleaned: string[] = [];
  for (const entry of raw) {
    const trimmed = entry.trim();
    if (!isValidShowcaseUrl(trimmed)) return { ok: false, reason: 'invalid_url' };
    cleaned.push(trimmed);
  }
  return { ok: true, value: cleaned };
}
