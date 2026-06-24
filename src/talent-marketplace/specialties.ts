// Shared specialty-column normalization. Both alerts (TM-9b) and portfolio
// (TM-9a) write Applicant.specialties through this helper to keep the column
// canonical.
//
// Map → trim → drop empties → dedupe while preserving first-seen order, so a
// payload like ['', '  ', 'Strength', 'Strength'] persists as ['Strength']
// (A-P1-1). An explicit null clears to [] (B-P0-2).
export function normalizeSpecialties(input: string[] | null | undefined): string[] {
  if (input == null) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
