/**
 * AUD-OPUS-P12-120 probe (mobile #355 @ 902c64a6). Never merge.
 *
 * Feeds the EXACT envelopes the deployed backend sends (HttpExceptionFilter:
 * statusCode, code?, message, error, timestamp, path, request_id; nothing
 * else) into the G1 code that classifies them.
 *
 * P355-A: withIdempotency's in-flight answer (workout-builder.service.ts
 *   ConflictException('Request in progress — retry in a moment')) means the
 *   original request is STILL RUNNING: the outcome is unknown, the key must
 *   be kept, and the IDEMPOTENCY_CONFLICT copy should show.
 * P355-B: the autosave bootstrap 409 autosave_lock_stale reaches the app
 *   without head_revision_index / lock_token, so the hook can never learn the
 *   real token (clinic profile turns EXPO_PUBLIC_FF_MWB_AUTOSAVE on here).
 */
jest.mock("../services/api", () => ({
  __esModule: true,
  default: { patch: jest.fn(), post: jest.fn(), get: jest.fn() },
  coachApi: { getClients: jest.fn() },
}));

import { describeProgramFailure, isOutcomeUnknown } from "../utils/programErrors";
import { workoutAutosaveApi, WorkoutAutosaveApiError } from "../api/workoutAutosaveApi";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const api = require("../services/api").default as { patch: jest.Mock };

function envelope(status: number, fields: Record<string, unknown>) {
  return {
    isAxiosError: true,
    message: `Request failed with status code ${status}`,
    response: {
      status,
      data: {
        statusCode: status,
        ...fields,
        timestamp: "2026-10-05T16:40:00.000Z",
        path: "/v1/coach/programs",
        request_id: "3f6c2a1e-0d7b-4c55-9a51-8f0e2b7d9c11",
      },
    },
  };
}

describe("P355-A in-flight idempotent retry (backend withIdempotency 409)", () => {
  const inFlight = envelope(409, {
    message: "Request in progress — retry in a moment",
    error: "Conflict",
  });
  it("is an unknown outcome (the original request is still running)", () => {
    expect(isOutcomeUnknown(inFlight)).toBe(true);
  });
  it("shows the still-finishing copy, not a definite refusal", () => {
    const f = describeProgramFailure(inFlight, "create the program");
    expect(f.message).toBe(
      "A previous attempt of this action is still finishing. Wait a few seconds, then reload.",
    );
  });
});

describe("P355-B autosave bootstrap 409 through the deployed envelope", () => {
  it("still carries the fresh head and lock token the hook needs", async () => {
    api.patch.mockRejectedValueOnce(
      envelope(409, { message: "Conflict Exception", error: "autosave_lock_stale" }),
    );
    let caught: unknown;
    try {
      await workoutAutosaveApi.autosave({
        planId: "11111111-1111-4111-8111-111111111111",
        idempotencyKey: "22222222-2222-4222-8222-222222222222",
        body: {
          base_revision_index: 0,
          lock_token: "0000000000000000",
          ops: [{ op: "plan_meta", meta: { name: "Push day B" } }],
          cause: "manual_edit",
        },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WorkoutAutosaveApiError);
    const err = caught as WorkoutAutosaveApiError;
    expect(err.kind).toBe("conflict");
    // The hook's bootstrap (useAutosave.ts:787-798) needs this payload; without
    // it the first save of every session ends in a manual 'conflict' state.
    expect(err.conflict).toBeDefined();
  });
});
