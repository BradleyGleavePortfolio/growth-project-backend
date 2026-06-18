// TM-9 — Portfolio showcase model + validators.
//
// The portfolio is a projection over EXISTING Applicant columns (no schema
// change): headline (headline results), bio (about), specialties, and
// sample_program_url (one sample program ref). The intro-video URL and extra
// sample-program refs ride inside the same bounded fields the apply surface
// already validates — every external URL is HTTPS-only and length-capped, and
// inline base64 blobs are rejected outright as a DoS guard.

export const PORTFOLIO_URL_MAX_LEN = 1024;
export const PORTFOLIO_MAX_SAMPLE_PROGRAMS = 10;

// Reject data: URIs and any inline base64 blob masquerading as a URL. A
// legitimate showcase link is a short HTTPS reference, never an embedded asset.
const BASE64_BLOB = /^data:|;base64,|^[A-Za-z0-9+/]{512,}={0,2}$/;

export interface PortfolioShowcase {
  headline: string | null;
  about: string | null;
  specialties: string[];
  intro_video_url: string | null;
  sample_program_urls: string[];
}

// A single URL is valid iff: HTTPS scheme, within the length cap, and not an
// inline base64 / data-URI blob. Returns the trimmed URL or throws via the
// caller's mapping (we return null/throw decision to the service layer).
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

// Normalize + validate an optional URL field. Empty/omitted → null (clearing the
// field is allowed). A present-but-invalid value is a hard reject (returns the
// `invalid` sentinel) so the service can map it to a 400 with an opaque code.
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

// Validate a sample-program URL list: bounded count, each URL HTTPS + capped +
// blob-free. Returns the cleaned list or a reject reason.
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
