/**
 * AUD-OPUS-P34-120 probe (B-358-1) — the Assign screen's client list must hold
 * every active client, not the first page of `/coach/clients`.
 *
 * Fake backend modelled on growth-project-backend main ee55f814 (same in
 * production f48267f9): coach.controller.ts:63-73 (`take` default undefined,
 * capped at 50) and coach.service.ts:147-157 (`take: take ?? 20`, ordered by
 * created_at desc, keyset `cursor: { id }, skip: 1`). The fake answers both
 * call shapes a fix could use (coachApi.getClients or api.get).
 */
const ROSTER = Array.from({ length: 25 }, (_, i) => ({
  id: `c${String(i).padStart(2, "0")}`,
  name: `Client ${String(i).padStart(2, "0")}`,
  email: `c${i}@example.test`,
  archived_at: null,
}));

function page(params: { cursor?: string; take?: number | string } = {}) {
  const takeRaw = params.take === undefined ? undefined : Number(params.take);
  const take =
    takeRaw === undefined ? 20 : Math.min(Number.isFinite(takeRaw) ? takeRaw : 20, 50);
  const start = params.cursor
    ? ROSTER.findIndex((c) => c.id === params.cursor) + 1
    : 0;
  return { data: ROSTER.slice(start, start + take) };
}

function paramsFromUrl(url: string, config?: { params?: Record<string, unknown> }) {
  const out: Record<string, string> = {};
  const q = url.split("?")[1];
  if (q) new URLSearchParams(q).forEach((v, k) => (out[k] = v));
  Object.entries(config?.params ?? {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null) out[k] = String(v);
  });
  return out;
}

const mockGetClients = jest.fn(
  async (_status?: string, opts?: { cursor?: string; take?: number }) =>
    page(opts ?? {}),
);
const mockGet = jest.fn(async (url: string, config?: { params?: Record<string, unknown> }) => {
  if (url.startsWith("/coach/clients")) return page(paramsFromUrl(url, config));
  return { data: {} };
});

jest.mock("../../services/api", () => ({
  __esModule: true,
  default: { get: (...a: unknown[]) => mockGet(...(a as [string])) },
  coachApi: {
    getClients: (...a: unknown[]) => mockGetClients(...(a as [string])),
  },
}));

import { programsApi } from "../programsApi";

describe("AUD-OPUS-P34-120 B-358-1 probe: assignable clients are complete", () => {
  it("returns all 25 active clients when the roster route pages at 20", async () => {
    const rows = await programsApi.assignableClients();
    expect(rows).toHaveLength(25);
    expect(rows.map((r) => r.id)).toContain("c24");
  });
});
