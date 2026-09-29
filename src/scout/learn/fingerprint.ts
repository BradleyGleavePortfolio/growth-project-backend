import { createHash } from 'crypto';
import {
  reuseKeyString,
  structureKeyMatches,
  structureKeyOf,
  structureKeyString,
  type DigestTemplate,
  type StructureDigestV1,
  type StructureKey,
} from './digest-contract';

/**
 * L1 (D-L0-3/D-L0-5 r5; R591-B-B3) — the reuse fingerprint and the structure keys.
 *
 * - `reuseMaterial`/`reuseFingerprint`: sha256 over the sorted, distinct REUSE KEYS
 *   `JSON.stringify([originTemplate, method, slotted template])` of the round-1 LANDING
 *   collection templates. No key name, kind, bucket or count enters it, so a sparser account
 *   (optional keys absent, empty collections, `null` kinds) and a fuller one fingerprint the
 *   same; explore-only templates never participate. It is a per-coach match and drift SIGNAL
 *   stored on a version, never compared for equality (D-L0-3) and never a lookup key — the
 *   lookup key is `(coach_id, slug)` server-side. There is no "full" fingerprint: the r3
 *   `fingerprint_full` drift check is deleted (R591-B-C4); drift is the per-step conformance.
 * - `structureKeys`: the per-template structure keys (reuse key + REQUIRED key paths). A package
 *   step covers a digest template when the reuse keys are equal and the digest's key paths are a
 *   subset of the step's (`structureKeyMatches`).
 *
 * Byte-compatible with the extension mirror (X2 `shared/learn/fingerprint.js`) on the shared
 * vectors `test/fixtures/scout/learn/fingerprint-vectors.json`: entries de-duplicated, sorted by
 * code unit, joined with `\n` (no trailing newline) and hashed as UTF-8. The v2 vectors replace
 * the r3 ones (grammar version 2 changed the material); X2 must re-copy them.
 */
export { reuseKeyString, structureKeyMatches, structureKeyOf, structureKeyString };

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function originOf(digest: StructureDigestV1, template: DigestTemplate): string {
  return structureKeyOf(digest, template).origin;
}

/** The landing collection templates: the domain of the reuse fingerprint. */
export function landingCollectionTemplates(digest: StructureDigestV1): readonly DigestTemplate[] {
  return digest.templates.filter((t) => t.role === 'collection' && t.discoveredBy === 'landing');
}

/** The sorted, distinct material lines the reuse fingerprint hashes (pinned by the vectors). */
export function reuseMaterial(digest: StructureDigestV1): string[] {
  const lines = new Set<string>();
  for (const t of landingCollectionTemplates(digest)) {
    lines.add(reuseKeyString(originOf(digest, t), t.method, t.template));
  }
  return [...lines].sort(compareText);
}

/** `fingerprint_r1`: over a round-1 digest only (round 2 is a union, never a reuse signal). */
export function reuseFingerprint(digest: StructureDigestV1): string {
  if (digest.round !== 1)
    throw new Error('the reuse fingerprint is computed over a round-1 digest');
  return createHash('sha256').update(reuseMaterial(digest).join('\n'), 'utf8').digest('hex');
}

/** Structure keys of the collection templates, keyed by ref: the domain of V-L10 and the package. */
export function collectionStructureKeys(
  digest: StructureDigestV1,
): ReadonlyMap<string, StructureKey> {
  return new Map(
    digest.templates
      .filter((t) => t.role === 'collection')
      .map((t) => [t.ref, structureKeyOf(digest, t)]),
  );
}

/** The sorted structure-key strings of the collection templates. */
export function collectionStructureKeyStrings(digest: StructureDigestV1): readonly string[] {
  return [...collectionStructureKeys(digest).values()].map(structureKeyString).sort(compareText);
}
