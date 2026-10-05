/**
 * AUD-OPUS-P12-120 probe (mobile #356 @ 40ee678a). Never merge.
 * P356-A: the deployed 409 undo_head_moved envelope (HttpExceptionFilter keeps
 * only statusCode, code, message, error, timestamp, path, request_id) through
 * the real workoutAutosaveApi.undo and the G2 outcome helpers.
 */
jest.mock("../services/api", () => ({
  __esModule: true,
  default: { patch: jest.fn(), post: jest.fn(), get: jest.fn() },
}));

import { workoutAutosaveApi, WorkoutAutosaveApiError } from "../api/workoutAutosaveApi";
import {
  describeHistoryFailure,
  isUnknownHistoryOutcome,
} from "../screens/coach/workoutBuilderUndo";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const api = require("../services/api").default as { post: jest.Mock };

it("P356-A: the deployed undo_head_moved 409 reaches the screen as headMoved (or at least as an unknown outcome)", async () => {
  api.post.mockRejectedValueOnce({
    isAxiosError: true,
    message: "Request failed with status code 409",
    response: {
      status: 409,
      data: {
        statusCode: 409,
        code: "undo_head_moved",
        message:
          "This workout changed after the undo was requested. Showing the latest saved version.",
        error: "undo_head_moved",
        timestamp: "2026-10-05T16:40:00.000Z",
        path: "/workout-plans/11111111-1111-4111-8111-111111111111/undo",
        request_id: "3f6c2a1e-0d7b-4c55-9a51-8f0e2b7d9c11",
      },
    },
  });
  let caught: unknown;
  try {
    await workoutAutosaveApi.undo("11111111-1111-4111-8111-111111111111", {
      to_revision_index: 0,
      expected_head_index: 1,
    });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(WorkoutAutosaveApiError);
  const err = caught as WorkoutAutosaveApiError;
  // eslint-disable-next-line no-console
  console.log(
    "P356-A observed:",
    JSON.stringify({
      kind: err.kind,
      status: err.status,
      headMoved: err.headMoved ?? null,
      unknown: isUnknownHistoryOutcome(err),
      copy: describeHistoryFailure(err, "undo").message,
    }),
  );
  expect(err.headMoved).toBeDefined();
});
