import { createHash } from 'crypto';
import { itemShapeAt, type ShapeNode, type StructureDigestV1 } from './digest-contract';

/**
 * L1 (D-L0-5 "Fingerprint") — `structure_fingerprint` = sha256 over the sorted set of
 * `(method, template, itemShapeSignature(itemShape, depth 2))` for the digest's `collection`
 * templates. Byte-compatible with the extension (X2 `shared/learn/fingerprint.js`, PR #38); both
 * repos assert equality against the shared vectors (`fingerprint-vectors.json`, L02). Fixed:
 *
 * - `itemShape` of a template = the `items` node of the array its FIRST `collectionPaths` entry
 *   reaches in `shape`; a template whose first path reaches no array signs as `unsupported`.
 * - `itemShapeSignature(node, depth)`: kinds only — never key names, classes or values
 *   (L0R2-OPUS-C4). `object` → `object{child*count,…}` with children signatures sorted by code
 *   unit and counted; `array` → `array[items]`; `map` → `map[values]`; scalars → their kind;
 *   `object(*)` / `array(*)` / `map(*)` once depth 2 is reached.
 * - Entry = `JSON.stringify([method, template, signature])`; entries are de-duplicated, sorted by
 *   code-unit order, joined with `\n` (no trailing newline) and hashed as UTF-8.
 *
 * Order-independent (sorted), value-free (shapes carry no values, templates carry no ids, keys do
 * not enter), computed over the slotted template form (`:sN` included).
 */
export const FINGERPRINT_SHAPE_DEPTH = 2;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function itemShapeSignature(
  node: ShapeNode,
  depth = 0,
  maxDepth: number = FINGERPRINT_SHAPE_DEPTH,
): string {
  switch (node.kind) {
    case 'object': {
      if (depth >= maxDepth) return 'object(*)';
      const counts = new Map<string, number>();
      for (const key of Object.keys(node.keys)) {
        const child = itemShapeSignature(node.keys[key], depth + 1, maxDepth);
        counts.set(child, (counts.get(child) ?? 0) + 1);
      }
      return `object{${[...counts]
        .sort(([a], [b]) => compareText(a, b))
        .map(([child, count]) => `${child}*${count}`)
        .join(',')}}`;
    }
    case 'array':
      return depth >= maxDepth
        ? 'array(*)'
        : `array[${itemShapeSignature(node.items, depth + 1, maxDepth)}]`;
    case 'map':
      return depth >= maxDepth
        ? 'map(*)'
        : `map[${itemShapeSignature(node.values, depth + 1, maxDepth)}]`;
    default:
      return node.kind;
  }
}

/** The sorted, distinct material lines the fingerprint hashes (the shared vectors pin these). */
export function fingerprintMaterial(digest: StructureDigestV1): string[] {
  const tuples = new Set<string>();
  for (const t of digest.templates) {
    if (t.role !== 'collection') continue;
    const first = t.collectionPaths[0];
    const item = first === undefined ? null : itemShapeAt(t.shape, first);
    tuples.add(
      JSON.stringify([
        t.method,
        t.template,
        item === null ? 'unsupported' : itemShapeSignature(item),
      ]),
    );
  }
  return [...tuples].sort(compareText);
}

/** @deprecated name kept for the first milestone's callers; same bytes as `fingerprintMaterial`. */
export const fingerprintEntries = fingerprintMaterial;

export function structureFingerprint(digest: StructureDigestV1): string {
  return createHash('sha256').update(fingerprintMaterial(digest).join('\n'), 'utf8').digest('hex');
}
