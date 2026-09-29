import { createHash } from 'crypto';
import {
  templateKey,
  templateKeyString,
  templateShapeSignature,
  type StructureDigestV1,
} from './digest-contract';
import { shapeSignature } from './shape-signature';

/**
 * L1 (D-L0-5 "Fingerprint", r3) — two sha256 fingerprints over the SLOTTED form: the sorted set
 * of `(method, slotted template, shapeSignature(itemShape, depth 2))` for templates with role
 * `collection`. The slotted template keeps vocabulary literals and `:p`/`:s` markers only, so
 * every coach on a site with the same structure hashes the same whatever their tenant words,
 * ids and header values were (L02).
 *
 * - `fingerprint_r1` is computed over the ROUND-1 digest: the memory lookup key at Start.
 * - `fingerprint_full` is computed over the UNION digest after explore: the drift check.
 *
 * Both are the same function over different digests (`structureFingerprint`). Byte-compatible
 * with the extension (X2 `shared/learn/fingerprint.js`): entry = `JSON.stringify([method,
 * template, signature])`, entries de-duplicated, sorted by code unit, joined with `\n` (no
 * trailing newline) and hashed as UTF-8. Shared vectors: `fingerprint-vectors.json`.
 */
export { FINGERPRINT_SHAPE_DEPTH, shapeSignature } from './shape-signature';
export { templateKey, templateKeyString, templateShapeSignature };

/** Name kept for the r2 callers and the extension mirror; the same function as `shapeSignature`. */
export const itemShapeSignature = shapeSignature;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The sorted, distinct material lines the fingerprint hashes (the shared vectors pin these). */
export function fingerprintMaterial(digest: StructureDigestV1): string[] {
  const tuples = new Set<string>();
  for (const t of digest.templates) {
    if (t.role !== 'collection') continue;
    tuples.add(templateKeyString(t.method, t.template, templateShapeSignature(t)));
  }
  return [...tuples].sort(compareText);
}

export function structureFingerprint(digest: StructureDigestV1): string {
  return createHash('sha256').update(fingerprintMaterial(digest).join('\n'), 'utf8').digest('hex');
}

/** `fingerprint_r1`: over the round-1 digest (memory lookup key). Refuses a round-2 digest. */
export function fingerprintR1(digest: StructureDigestV1): string {
  if (digest.round !== 1) throw new Error('fingerprint_r1 is computed over a round-1 digest');
  return structureFingerprint(digest);
}

/** `fingerprint_full`: over the union digest (drift check); a round-1 digest is its own union. */
export function fingerprintFull(digest: StructureDigestV1): string {
  return structureFingerprint(digest);
}

/** The sorted template keys of the collection templates: the domain of V-L10 and the package. */
export function collectionTemplateKeys(digest: StructureDigestV1): readonly string[] {
  return digest.templates
    .filter((t) => t.role === 'collection')
    .map(templateKey)
    .sort(compareText);
}
