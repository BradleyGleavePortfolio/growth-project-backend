import { FoodService } from '../src/food/food.service';

// Lightweight Prisma stub — only the methods FoodService calls during
// search are stubbed. The fetch upstreams (USDA + OFF) are mocked at the
// global level so we never hit the network.
function buildPrismaStub() {
  return {
    foodItem: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    // searchLocalDB falls back to ILIKE when pg_trgm raises. Returning a
    // rejected $queryRaw forces the unit test through that fallback, which
    // also returns [] under jest. Net: zero local hits, so we only assert
    // against the NL-parsed query echoed in the response.
    $queryRaw: jest.fn().mockRejectedValue(new Error('no pg_trgm in test')),
  } as any;
}

describe('FoodService.search NL parsing integration', () => {
  let service: FoodService;
  let prisma: any;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    prisma = buildPrismaStub();
    // ConfigService isn't required in unit tests (no REDIS_URL needed) —
    // omitting it is supported via the optional constructor param.
    service = new FoodService(prisma);
    // Stub all upstream HTTP — both USDA and OFF return zero foods.
    fetchSpy = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      json: async () => ({ foods: [], products: [] }),
    } as any);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('extracts parsed_quantity and parsed_unit from "6oz chicken breast"', async () => {
    const res = await service.search('6oz chicken breast', 10);
    expect(res.parsed_quantity).toBe(6);
    expect(res.parsed_unit).toBe('oz');
    // The query echo is the *raw* user input so the mobile picker can still
    // surface it; the upstream search ran against the parsed food name.
    expect(res.query).toBe('6oz chicken breast');
  });

  it('omits parsed_* when the query has no qty/unit', async () => {
    const res = await service.search('chicken breast', 10);
    expect(res.parsed_quantity).toBeUndefined();
    expect(res.parsed_unit).toBeUndefined();
  });

  it('passes the parsed food name (not the raw query) to the upstream fetch', async () => {
    await service.search('1/2 cup oats', 10);
    // The USDA URL is fetch's first argument on its first call — the parser
    // should have stripped "1/2 cup " before it reached the encoder.
    const usdaUrl = String(fetchSpy.mock.calls[0][0]);
    expect(usdaUrl).toContain('oats');
    expect(usdaUrl).not.toContain('1%2F2');
    expect(usdaUrl).not.toContain('cup');
  });

  it('returns short-circuit defaults for empty input without invoking upstreams', async () => {
    const res = await service.search('', 5);
    expect(res.results).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('caches identical normalized queries (second call skips upstreams)', async () => {
    // First call hits USDA + OFF (2 fetch calls in parallel).
    await service.search('chicken breast', 10);
    const firstCallCount = fetchSpy.mock.calls.length;
    expect(firstCallCount).toBeGreaterThanOrEqual(2);

    // Second call with the same query should be served from the in-memory
    // cache — no further upstream fetches.
    await service.search('chicken breast', 10);
    expect(fetchSpy.mock.calls.length).toBe(firstCallCount);
  });
});
