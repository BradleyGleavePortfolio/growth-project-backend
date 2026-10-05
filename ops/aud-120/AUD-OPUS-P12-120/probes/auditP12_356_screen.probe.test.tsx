/* AUD-OPUS-P12-120 probe (mobile #356 @ 40ee678a). Never merge. Harness copied verbatim from src/__tests__/coachWorkoutBuilderUndo.test.tsx (lines 1-318, 474-517). */
/**
 * S-MWB-2 — CoachWorkoutBuilderScreen undo / redo buttons over the autosave
 * revisions. Harness copied from coachWorkoutBuilderAutosave.test.tsx (MWB-4).
 *
 * The two gates that matter most here:
 *
 *   1. FLAG-OFF INVARIANCE (the headline hard gate): with
 *      EXPO_PUBLIC_FF_MWB_AUTOSAVE unset/false the screen must do ZERO autosave
 *      work — no PATCH /autosave call ever fires, and no save-state pill renders
 *      (zero UI residue). The legacy explicit-Save (PUT replace-all) path is
 *      untouched.
 *
 *   2. FLAG-ON wiring: with the flag true AND an existing plan, the save-state
 *      pill renders and an edit eventually drives a PATCH /autosave.
 *
 * We drive the flag through the env var, read live by a mocked `featureFlags`
 * getter (no module reset — see the mock note below for why), and mock the
 * heavyweight deps (theme, icons, navigation, the workout-builder query hooks)
 * so the mount is deterministic. The autosave API is mocked at the boundary so
 * we can assert call counts without real axios.
 */

import React from "react";
import { render, waitFor, fireEvent, act } from "@testing-library/react-native";

// Drive the MWB-4 autosave flag WITHOUT `jest.resetModules()`. The screen
// reads `featureFlags.mwbAutosave` at *render* time (a live property access in
// `autosaveEnabled`), so a module-scope mock whose getter reflects the current
// env var is enough to flip the flag between tests. This avoids resetting the
// module registry mid-test — a reset would hand the freshly-required screen a
// different React instance than the module-scope `@testing-library/react-native`
// import, producing two React copies, a null hook dispatcher, and the
// "Invalid hook call" at `useMemo`. Keeping a single React also keeps RTL's
// auto-cleanup `afterEach` intact, so no test leaks an open handle.
jest.mock("../config/featureFlags", () => {
  const readEnvFlag = () => {
    const raw = process.env.EXPO_PUBLIC_FF_MWB_AUTOSAVE;
    if (raw == null || raw === "") return false;
    return ["1", "true", "yes", "on"].includes(
      String(raw).trim().toLowerCase(),
    );
  };
  return {
    __esModule: true,
    featureFlags: {
      get mwbAutosave() {
        return readEnvFlag();
      },
    },
    isFeatureEnabled: (key: string) =>
      key === "mwbAutosave" ? readEnvFlag() : false,
  };
});

// ─── Heavyweight-dep stubs (mirror exerciseCatalog.test.tsx) ─────────────────

jest.mock("@expo/vector-icons", () => {
  function Icon() {
    return null;
  }
  return { Ionicons: Icon, MaterialIcons: Icon, Feather: Icon };
});

jest.mock("../theme/ThemeProvider", () => {
  // Source the mock theme from the real semantic tokens (the single source of
  // truth) rather than raw hex literals — keeps the test honest about the
  // palette and satisfies the "no raw hex outside tokens.ts" invariant.
  const { lightTokens } = jest.requireActual("../theme/tokens");
  const semanticColors = lightTokens;
  const Pass = ({ children }: { children: React.ReactNode }) => children;
  return {
    __esModule: true,
    ThemeProvider: Pass,
    default: Pass,
    useTheme: () => ({ semanticColors, colors: semanticColors }),
  };
});

// useReduceMotion pulls a native accessibility module; stub to a stable false.
jest.mock("../screens/client/wearables/components/useReduceMotion", () => ({
  __esModule: true,
  useReduceMotion: () => false,
}));

// Navigation: a minimal route (planId) + a no-op navigation object. The screen
// registers a `beforeRemove` listener to mirror-first flush on back-navigation
// (the stable-flush teardown path), so the stub must expose `addListener`
// returning an unsubscribe; without it the screen's effect throws on mount.
const mockGoBack = jest.fn();
const mockAddListener = jest.fn(() => jest.fn());
jest.mock("@react-navigation/native", () => ({
  __esModule: true,
  useRoute: () => ({ params: { planId: "plan-1" } }),
  useNavigation: () => ({ goBack: mockGoBack, addListener: mockAddListener }),
}));

// The workout-builder query/mutation hooks — deterministic stand-ins.
const mockRefetch = jest.fn().mockResolvedValue({});
const EXISTING_PLAN = {
  id: "plan-1",
  coach_id: "c1",
  name: "Push day A",
  type: "strength" as const,
  duration_estimate_minutes: 45,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  archived_at: null,
  exercises: [
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workout_plan_id: "plan-1",
      exercise_external_id: "bench",
      order: 1,
      sets: 3,
      reps_or_duration_seconds: 10,
      weight_lbs: null,
      rest_seconds: 60,
      superset_group_id: null,
      notes: null,
    },
  ],
};

// The refreshed server truth delivered by the post-replay reconciliation
// refetch: the rescued edit landed, so the server now holds the `deadlift` row
// (and the stale `squat` row a naive racing Save would have re-pushed is gone).
// A distinct object + distinct rows from EXISTING_PLAN so the regression below
// proves the screen ADOPTED refreshed truth rather than echoing the mock.
const RESCUED_PLAN = {
  ...EXISTING_PLAN,
  name: "Rescued name A",
  exercises: [
    {
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      workout_plan_id: "plan-1",
      exercise_external_id: "deadlift",
      order: 1,
      sets: 5,
      reps_or_duration_seconds: 5,
      weight_lbs: null,
      rest_seconds: 120,
      superset_group_id: null,
      notes: null,
    },
  ],
};

// Mutable holder the mocked `useWorkoutPlan` reads each render. Defaults to the
// canonical EXISTING_PLAN; the P2 kill/replay regression starts it at
// `undefined` (the invalidate-driven reconciliation refetch is in flight, so the
// cache has no settled data to adopt yet — keeping the adoption effect from
// recording `initialLoadDoneRef` or consuming the replay's refetchSeq bump
// mid-flight), then swaps it to RESCUED_PLAN once the replay retry is terminal so
// the refreshed server truth is folded in by a clean full replace. Reset in
// beforeEach.
let mockCurrentPlan: typeof EXISTING_PLAN | undefined = EXISTING_PLAN;
// Named mutation spies so the kill/replay regression test can assert the exact
// full-replace payload an explicit Save sends AFTER a replay (it must carry the
// post-replay/refreshed rows, never an empty/reverted set).
const mockUpdateMutateAsync = jest.fn().mockResolvedValue({ id: "plan-1" });
const mockCreateMutateAsync = jest.fn().mockResolvedValue({ id: "plan-1" });
const mockSetExercisesMutateAsync = jest.fn().mockResolvedValue(undefined);
jest.mock("../hooks/useWorkoutBuilder", () => ({
  __esModule: true,
  useWorkoutPlan: () => ({ data: mockCurrentPlan, refetch: mockRefetch }),
  useCreateWorkoutPlan: () => ({
    mutateAsync: mockCreateMutateAsync,
    isPending: false,
  }),
  useUpdateWorkoutPlan: () => ({
    mutateAsync: mockUpdateMutateAsync,
    isPending: false,
  }),
  useSetWorkoutExercises: () => ({
    mutateAsync: mockSetExercisesMutateAsync,
    isPending: false,
  }),
}));

jest.mock("../hooks/useExerciseLibrary", () => ({
  __esModule: true,
  useExerciseSearch: () => ({ data: { items: [] } }),
}));

// Mock the autosave API boundary so we can count PATCH calls without axios.
const mockAutosaveCall = jest.fn();
const mockUndoCall = jest.fn();
jest.mock("../api/workoutAutosaveApi", () => {
  class WorkoutAutosaveApiError extends Error {
    kind: string;
    status: number;
    conflict?: unknown;
    cause?: unknown;
    headMoved?: unknown;
    constructor(
      kind: string,
      status: number,
      message: string,
      conflict?: unknown,
      cause?: unknown,
      headMoved?: unknown,
    ) {
      super(message);
      this.kind = kind;
      this.status = status;
      this.conflict = conflict;
      this.cause = cause;
      this.headMoved = headMoved;
    }
    get isNetwork() {
      return this.kind === "network";
    }
  }
  return {
    __esModule: true,
    WorkoutAutosaveApiError,
    workoutAutosaveApi: {
      autosave: (...args: unknown[]) => mockAutosaveCall(...args),
      undo: (...args: unknown[]) => mockUndoCall(...args),
    },
    AUTOSAVE_DEBOUNCE_MS: 800,
  };
});

// Mock the mirror so no AsyncStorage write fires during the test.
// `readAutosaveMirror` defaults to null (no mirror); the kill/replay regression
// test below overrides it per-test with `mockResolvedValueOnce(...)` so only
// that test exercises the on-mount replay path.
const mockReadMirror = jest.fn().mockResolvedValue(null);
const mockClearMirrorIfKey = jest.fn().mockResolvedValue(undefined);
jest.mock("../storage/autosaveMirror", () => ({
  __esModule: true,
  writeAutosaveMirror: jest.fn().mockResolvedValue(undefined),
  readAutosaveMirror: (...args: unknown[]) => mockReadMirror(...args),
  clearAutosaveMirror: jest.fn().mockResolvedValue(undefined),
  clearAutosaveMirrorIfKey: (...args: unknown[]) =>
    mockClearMirrorIfKey(...args),
}));

// The screen now reads `useQueryClient()` directly (MWB-4 #237 R6 P1) to force-
// invalidate the plan cache on replay. `useWorkoutBuilder` is fully mocked so
// the real query client is never otherwise touched — we mock React Query's
// `useQueryClient` to a spy-able stub and assert the exact invalidation keys
// the replay handler fires. (`requireActual` keeps every other RQ export real
// so the screen's other imports are untouched.)
const mockInvalidateQueries = jest.fn().mockResolvedValue(undefined);
jest.mock("@tanstack/react-query", () => {
  const actual = jest.requireActual("@tanstack/react-query");
  return {
    ...actual,
    __esModule: true,
    useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
  };
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ORIGINAL_FLAG = process.env.EXPO_PUBLIC_FF_MWB_AUTOSAVE;

function setFlag(on: boolean): void {
  if (on) process.env.EXPO_PUBLIC_FF_MWB_AUTOSAVE = "true";
  else delete process.env.EXPO_PUBLIC_FF_MWB_AUTOSAVE;
}

/** The mocked `featureFlags` getter reads the env var live, so a single
 *  module-scope require (no reset) is correct for both flag states. */
function loadScreen(): React.ComponentType {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../screens/coach/CoachWorkoutBuilderScreen").default;
}

beforeEach(() => {
  jest.clearAllMocks();
  // `clearAllMocks` wipes implementations too, so re-establish the defaults the
  // boundary mocks need between tests.
  mockCurrentPlan = EXISTING_PLAN;
  mockReadMirror.mockResolvedValue(null);
  mockClearMirrorIfKey.mockResolvedValue(undefined);
  mockInvalidateQueries.mockResolvedValue(undefined);
  mockRefetch.mockResolvedValue({});
  mockUpdateMutateAsync.mockResolvedValue({ id: "plan-1" });
  mockCreateMutateAsync.mockResolvedValue({ id: "plan-1" });
  mockSetExercisesMutateAsync.mockResolvedValue(undefined);
  mockAutosaveCall.mockResolvedValue({
    head_revision_index: 1,
    lock_token: "feedfacefeedface",
    saved_at: "2026-01-01T00:00:00.000Z",
  });
});

afterEach(() => {
  // RTL's auto-cleanup unmounts the tree (single React, default behaviour).
  // Clear any timers the screen's autosave hook left armed before restoring the
  // real clock so no debounced flush resolves after the test ("Cannot log after
  // tests are done") and keeps a handle open that makes Jest exit 1.
  jest.clearAllTimers();
  jest.useRealTimers();
  if (ORIGINAL_FLAG === undefined)
    delete process.env.EXPO_PUBLIC_FF_MWB_AUTOSAVE;
  else process.env.EXPO_PUBLIC_FF_MWB_AUTOSAVE = ORIGINAL_FLAG;
});

const UNDONE_PLAN = { ...EXISTING_PLAN, name: "Push day A" };

type Screen = Awaited<ReturnType<typeof render>>;

async function editAndSave(
  getByLabelText: Screen["getByLabelText"],
  nextName: string,
) {
  await act(async () => {
    await fireEvent.changeText(getByLabelText("Plan name"), nextName);
  });
  await act(async () => {
    jest.advanceTimersByTime(900);
  });
}

// ─── S-MWB-3: history barrier (B-328-5) and unknown outcomes (B-328-6) ─────

type ApiErrorCtor = new (
  kind: string,
  status: number,
  message: string,
  conflict?: unknown,
  cause?: unknown,
  headMoved?: unknown,
) => Error;

function apiError(): ApiErrorCtor {
  return (
    jest.requireMock("../api/workoutAutosaveApi") as {
      WorkoutAutosaveApiError: ApiErrorCtor;
    }
  ).WorkoutAutosaveApiError;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function mountWithOneSave() {
  setFlag(true);
  jest.useFakeTimers();
  const Screen = loadScreen();
  const screen = await render(<Screen />);
  await editAndSave(screen.getByLabelText, "Push day B");
  await waitFor(() => expect(mockAutosaveCall).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(
      screen.getByLabelText("Undo last change").props.accessibilityState,
    ).toEqual(expect.objectContaining({ disabled: false })),
  );
  return screen;
}


// The 409 the deployed backend sends for a fenced undo whose head moved: the
// global HttpExceptionFilter keeps only statusCode, code, message, error,
// timestamp, path, request_id (production f48267f9; main ee55f814 adds only
// allowlisted details and undo_head_moved is not on the list), so the api
// layer sees no head_revision_index / lock_token and builds no headMoved.
function deployedHeadMoved(ApiError: ApiErrorCtor): Error {
  return new ApiError("conflict", 409, "autosave conflict", undefined, {
    isAxiosError: true,
    response: {
      status: 409,
      data: {
        statusCode: 409,
        code: "undo_head_moved",
        message:
          "This workout changed after the undo was requested. Showing the latest saved version.",
        error: "undo_head_moved",
        timestamp: "2026-10-05T16:40:00.000Z",
        path: "/workout-plans/plan-1/undo",
        request_id: "3f6c2a1e-0d7b-4c55-9a51-8f0e2b7d9c11",
      },
    },
  });
}

describe("AUD-OPUS-P12-120 probes (#356)", () => {
  it("P356-B: after an unknown outcome, a Check again refused with 401 must not say nothing was undone and must keep editing paused", async () => {
    const screen = await mountWithOneSave();
    const ApiError = apiError();
    mockUndoCall.mockRejectedValueOnce(new ApiError("network", 0, "offline"));
    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Undo last change"));
    });
    expect(screen.getByLabelText("Check again")).toBeTruthy();
    // The first request may have committed; the retry's refusal says nothing about it.
    mockUndoCall.mockRejectedValueOnce(new ApiError("unauthorized", 401, "expired"));
    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Check again"));
    });
    expect(screen.queryByText(/nothing was undone/)).toBeNull();
    expect(screen.getByLabelText("Plan name").props.editable).toBe(false);
  });

  it("P356-C: a committed undo whose response was lost, then the deployed undo_head_moved envelope on Check again, must not say nothing was undone", async () => {
    const screen = await mountWithOneSave();
    const ApiError = apiError();
    mockUndoCall.mockRejectedValueOnce(new ApiError("network", 0, "offline"));
    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Undo last change"));
    });
    mockUndoCall.mockRejectedValueOnce(deployedHeadMoved(ApiError));
    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Check again"));
    });
    expect(screen.queryByText(/nothing was undone/)).toBeNull();
    expect(screen.getByLabelText("Plan name").props.editable).toBe(false);
  });

  it("P356-D: another session moved the head (deployed envelope): the screen must not invite a retry whose fence can never pass", async () => {
    const screen = await mountWithOneSave();
    const ApiError = apiError();
    mockUndoCall.mockRejectedValueOnce(deployedHeadMoved(ApiError));
    mockUndoCall.mockRejectedValueOnce(deployedHeadMoved(ApiError));
    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Undo last change"));
    });
    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Undo last change"));
    });
    // Both requests carry the same stale fence, so the second is refused the same way.
    expect(mockUndoCall.mock.calls[1][1]).toEqual(mockUndoCall.mock.calls[0][1]);
    expect(screen.queryByText(/Tap Undo again/)).toBeNull();
  });
});
