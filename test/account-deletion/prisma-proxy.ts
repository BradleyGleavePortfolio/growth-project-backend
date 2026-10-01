/**
 * Auto-delegate Prisma mock for the account-deletion suites: any
 * `prisma.<model>.<method>` access returns a stable jest.fn, so the finalizer
 * fan-out can be asserted model by model without hand-listing every delegate.
 */
export type DelegateMock = Record<string, jest.Mock>;

export function makePrismaProxy(defaults: Record<string, unknown> = {}) {
  const delegates = new Map<string, DelegateMock>();
  const delegate = (model: string): DelegateMock => {
    let d = delegates.get(model);
    if (!d) {
      d = new Proxy({} as DelegateMock, {
        get(target, method: string) {
          if (!target[method]) {
            const key = `${model}.${method}`;
            const value = key in defaults ? defaults[key] : { count: 0 };
            target[method] = jest.fn().mockResolvedValue(value);
          }
          return target[method];
        },
      });
      delegates.set(model, d);
    }
    return d;
  };
  const raw = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockResolvedValue([{ present: false }]),
  };
  const client: Record<string, unknown> = new Proxy(raw, {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof typeof target];
      if (prop === '$transaction') {
        return jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(client));
      }
      if (prop === 'then') return undefined;
      return delegate(prop);
    },
  });
  return { client, delegate, raw };
}
