/**
 * AUD-OPUS-P12-120 probe (mobile #355 @ 902c64a6). Never merge.
 * P355-C: GET /coach/clients returns at most `take` rows (default 20, max 50),
 * newest first, as a bare array, paged by `cursor=<last id>`
 * (backend coach.controller.ts:63-74, coach.service.ts:133-157). The bulk
 * assign picker must list the whole active roster, or say it could not.
 */
type Row = { id: string; name: string; email: string; archived_at: null };
const mockRoster: Row[] = Array.from({ length: 25 }, (_, i) => ({
  id: `client-${String(i).padStart(2, "0")}`,
  name: `Client ${String(i).padStart(2, "0")}`,
  email: `c${i}@example.test`,
  archived_at: null,
}));

// Server emulation: honours take (default 20, max 50) and cursor from either
// the URL query or axios params, whichever the client uses.
function mockServe(url: string, config?: { params?: Record<string, unknown> }) {
  const q = new URLSearchParams(url.split("?")[1] ?? "");
  const p = config?.params ?? {};
  const cursor = (p.cursor as string | undefined) ?? q.get("cursor") ?? undefined;
  const takeRaw = (p.take as string | number | undefined) ?? q.get("take") ?? undefined;
  const take = takeRaw ? Math.min(parseInt(String(takeRaw), 10) || 20, 50) : 20;
  const start = cursor ? mockRoster.findIndex((r) => r.id === cursor) + 1 : 0;
  return { data: mockRoster.slice(start, start + take) };
}

jest.mock("../services/api", () => ({
  __esModule: true,
  default: {
    get: jest.fn((url: string, config?: { params?: Record<string, unknown> }) =>
      Promise.resolve(mockServe(url, config)),
    ),
    post: jest.fn(),
    put: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
  coachApi: {
    getClients: jest.fn((status?: string, cursor?: string, take?: number) =>
      Promise.resolve(
        mockServe(
          "/coach/clients?" +
            new URLSearchParams({
              ...(status ? { status } : {}),
              ...(cursor ? { cursor } : {}),
              ...(take ? { take: String(take) } : {}),
            }).toString(),
        ),
      ),
    ),
  },
}));

import { programsApi } from "../api/programsApi";

it("P355-C: assignableClients returns every active client of a 25-client roster", async () => {
  const rows = await programsApi.assignableClients();
  // eslint-disable-next-line no-console
  console.log(`P355-C observed: ${rows.length} of ${mockRoster.length} clients`);
  expect(rows).toHaveLength(mockRoster.length);
});
