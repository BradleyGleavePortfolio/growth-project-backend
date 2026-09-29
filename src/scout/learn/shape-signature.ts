import type { ShapeNode } from './digest-contract';

/**
 * L1 (D-L0-5, r3 `L0R2-OPUS-C4`) — `shapeSignature`: ONE function over `ShapeNode`, owned here in
 * TypeScript and mirrored in JavaScript by X2 (`E:shared/learn/fingerprint.js`); L02 asserts byte
 * equality on the shared vectors. Kinds and counts only — never key names, classes, buckets or
 * values — so two coaches whose captures differ in tenant words, ids and values sign the same:
 *
 * - `object` → `object{child*count,…}`, children signatures sorted by code unit and counted;
 * - `array` → `array[items]`; `map` → `map[values]`; scalars → their kind;
 * - `object(*)` / `array(*)` / `map(*)` once `maxDepth` is reached.
 */
export const FINGERPRINT_SHAPE_DEPTH = 2;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function shapeSignature(
  node: ShapeNode,
  depth = 0,
  maxDepth: number = FINGERPRINT_SHAPE_DEPTH,
): string {
  switch (node.kind) {
    case 'object': {
      if (depth >= maxDepth) return 'object(*)';
      const counts = new Map<string, number>();
      for (const key of Object.keys(node.keys)) {
        const child = shapeSignature(node.keys[key], depth + 1, maxDepth);
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
        : `array[${shapeSignature(node.items, depth + 1, maxDepth)}]`;
    case 'map':
      return depth >= maxDepth
        ? 'map(*)'
        : `map[${shapeSignature(node.values, depth + 1, maxDepth)}]`;
    default:
      return node.kind;
  }
}
