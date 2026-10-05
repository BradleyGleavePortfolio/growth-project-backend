/**
 * AUD-OPUS-PD1-122 probe (mobile stack top #358 @ dc47b493). Never merge.
 *
 * 1. Feeds the EXACT 409 bodies backend#733 @ 635cabee sends through the real
 *    HttpExceptionFilter (test/mwb-head-conflict-409-http.spec.ts asserts the
 *    key set ENVELOPE + head_revision_index + lock_token, code === error) into
 *    the real workoutAutosaveApi parser.
 * 2. Drives programsApi.assignableClients against a fake of the REAL call
 *    coachApi.getClients(status, cursor, take) modelled on backend
 *    coach.controller.ts:63-73 / coach.service.ts:133-157 (take default 20,
 *    cap 50, ordered newest first, cursor = last id with skip 1).
 */
import axios from "axios";

jest.mock("axios");
jest.mock("../services/sentry", () => ({ captureError: jest.fn() }));

const mockGetClients = jest.fn();
jest.mock("../services/api", () => ({
  __esModule: true,
  default: { patch: jest.fn(), post: jest.fn(), get: jest.fn(), delete: jest.fn() },
  coachApi: {
    getClients: (...a: unknown[]) => mockGetClients(...a),
  },
}));

import { workoutAutosaveApi, WorkoutAutosaveApiError } from "../api/workoutAutosaveApi";
import { programsApi } from "../api/programsApi";
import { describeProgramFailure } from "../utils/programErrors";
import { isUnknownHistoryOutcome } from "../screens/coach/workoutBuilderUndo";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const api = require("../services/api").default as { patch: jest.Mock; post: jest.Mock };

const TOKEN = "9f3a1c0b7e2d4a65";
const PLAN = "11111111-1111-4111-8111-111111111111";

/** Body exactly as backend#733 emits it (filter envelope + two allow-listed fields). */
function be733(code: string, path: string, message: string) {
  return {
    isAxiosError: true,
    message: "Request failed with status code 409",
    response: {
      status: 409,
      data: {
        statusCode: 409,
        code,
        message,
        error: code,
        timestamp: "2026-10-05T23:40:00.000Z",
        path,
        head_revision_index: 5,
        lock_token: TOKEN,
      },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(axios.isCancel).mockImplementation(
    (e: unknown): e is import("axios").Cancel =>
      Boolean((e as { code?: string })?.code === "ERR_CANCELED"),
  );
  jest.mocked(axios.isAxiosError).mockImplementation(
    (e: unknown): e is import("axios").AxiosError =>
      Boolean((e as { isAxiosError?: boolean })?.isAxiosError),
  );
});

const batch = {
  base_revision_index: 0,
  lock_token: "0000000000000000",
  ops: [{ op: "plan_meta" as const, meta: { name: "Push day B" } }],
  cause: "autosave" as const,
};

describe("PD1-1 backend#733 autosave 409 bodies parse", () => {
  it.each(["autosave_lock_stale", "autosave_conflict_retry"])(
    "%s carries head and token to the hook",
    async (code) => {
      api.patch.mockRejectedValueOnce(
        be733(code, `/workout-plans/${PLAN}/autosave`, "Conflict Exception"),
      );
      const err = await workoutAutosaveApi
        .autosave({ planId: PLAN, idempotencyKey: "k1", body: batch as never })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WorkoutAutosaveApiError);
      expect((err as WorkoutAutosaveApiError).kind).toBe("conflict");
      expect((err as WorkoutAutosaveApiError).conflict).toEqual({
        error: code,
        head_revision_index: 5,
        lock_token: TOKEN,
      });
    },
  );
});

describe("PD1-2 backend#733 undo_head_moved body parses", () => {
  it("headMoved carries head and token; not an unknown outcome", async () => {
    api.post.mockRejectedValueOnce(
      be733(
        "undo_head_moved",
        `/workout-plans/${PLAN}/undo`,
        "This workout changed after the undo was requested. Showing the latest saved version.",
      ),
    );
    const err = await workoutAutosaveApi
      .undo(PLAN, { to_revision_index: 3, expected_head_index: 4 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkoutAutosaveApiError);
    expect((err as WorkoutAutosaveApiError).headMoved).toEqual(
      expect.objectContaining({ head_revision_index: 5, lock_token: TOKEN }),
    );
    expect(isUnknownHistoryOutcome(err)).toBe(false);
  });
});

// ── roster through the real call shape ─────────────────────────────────────
function makeRoster(n: number) {
  // newest first, as the backend orders it
  return Array.from({ length: n }, (_, i) => ({
    id: `c${String(i).padStart(3, "0")}`,
    name: `Client ${String(i).padStart(3, "0")}`,
    email: `c${i}@example.test`,
    archived_at: null,
  }));
}
function fakeBackend(roster: ReturnType<typeof makeRoster>) {
  return async (_status?: string, cursor?: string, takeRaw?: number) => {
    const take = takeRaw ? Math.min(Number(takeRaw) || 20, 50) : 20;
    const start = cursor ? roster.findIndex((c) => c.id === cursor) + 1 : 0;
    return { data: roster.slice(start, start + take) };
  };
}

describe("PD1-3 assignableClients reads the whole roster via getClients(status, cursor, take)", () => {
  it.each([1, 19, 20, 21, 25, 45, 60])("%i active clients -> all shown", async (n) => {
    const roster = makeRoster(n);
    mockGetClients.mockImplementation(fakeBackend(roster));
    const out = await programsApi.assignableClients();
    expect(out).toHaveLength(n);
    expect(new Set(out.map((c) => c.id))).toEqual(new Set(roster.map((c) => c.id)));
    for (const call of mockGetClients.mock.calls) expect(call[0]).toBe("active");
  });

  it("a failed later page fails the load instead of showing a partial list", async () => {
    const roster = makeRoster(45);
    const ok = fakeBackend(roster);
    mockGetClients
      .mockImplementationOnce(ok)
      .mockImplementationOnce(async () => {
        throw { isAxiosError: true, message: "Network Error" };
      });
    await expect(programsApi.assignableClients()).rejects.toBeTruthy();
  });

  it("a non-list page fails with the roster-incomplete copy", async () => {
    mockGetClients.mockResolvedValueOnce({ data: { items: [] } });
    const err = await programsApi.assignableClients().catch((e: unknown) => e);
    const f = describeProgramFailure(err, "load your clients");
    expect(f.message).toMatch(/full client list did not load/);
  });
});
