// B-701-1 (R75) — typed partial test double. The compiler checks every member
// given against the real type T, so a double cannot drift from the signature
// of the service it stands in for. Members not given are absent at runtime:
// an unexpected call fails with a TypeError instead of returning a value.
export function partialDouble<T extends object>(members: Partial<T> = {}): T {
  const double: T = Object.assign(Object.create(null), members);
  return double;
}
