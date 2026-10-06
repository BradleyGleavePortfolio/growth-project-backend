/** Typed test double: the fake implements only what the unit under test calls. */
export function stub<T>(v: unknown): T {
  return v as T;
}
