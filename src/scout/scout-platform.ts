/** Canonical token shared with the later R CHECK; no normalization or fallback. */
export function isCanonicalPlatform(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 256 &&
    /^[a-z0-9]/.test(value) &&
    !/[^a-z0-9._:-]/.test(value)
  );
}
