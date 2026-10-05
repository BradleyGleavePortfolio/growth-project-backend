/**
 * AUD-OPUS-P34-120 probes (Opus lens, agent 120) at #357 b364b9ea / #358 4dcf0aff.
 * Each `it` states the behaviour the PR's own contract promises; a red test is the finding.
 *  - B-357-1 ProgramDayPickerScreen: a request key is reused for a DIFFERENT body on the same route.
 *  - C-357-1 ProgramFormScreen: the backend's in-progress 409 releases the key (create can run twice).
 *  - C-357-2 Library: describeProgramFailure runs in render, so every re-render sends a new Sentry event.
 *  - control: DayPicker Retry of the same pick reuses the key (expected green).
 */
import React from "react";
import { fireEvent, render } from "@testing-library/react-native";

const mockNavigation = {
  navigate: jest.fn(),
  push: jest.fn(),
  setOptions: jest.fn(),
  goBack: jest.fn(),
  replace: jest.fn(),
};
jest.mock("@react-navigation/native", () => ({
  useNavigation: () => mockNavigation,
  useFocusEffect: jest.fn(),
}));
jest.mock("react-native-safe-area-context", () => {
  const { View } = jest.requireActual("react-native");
  return { SafeAreaView: View };
});
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("../../../../theme/ThemeProvider", () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => "#123456" }) }),
}));
jest.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ setQueryData: jest.fn(), invalidateQueries: jest.fn() }),
}));
const mockCaptureError = jest.fn();
jest.mock("../../../../services/sentry", () => ({
  captureError: (...a: unknown[]) => mockCaptureError(...a),
}));
jest.mock("../../../../services/api", () => ({ __esModule: true, default: {}, coachApi: {} }));

const mockProgram = jest.fn();
const mockSaved = jest.fn();
const mockProgramList = jest.fn();
const mockAssignees = jest.fn();
const mockRevisions = jest.fn();
jest.mock("../../../../hooks/usePrograms", () => ({
  programKeys: { detail: (id: string) => ["d", id] },
  useProgram: (...a: unknown[]) => mockProgram(...a),
  useSavedWorkouts: (...a: unknown[]) => mockSaved(...a),
  useProgramList: (...a: unknown[]) => mockProgramList(...a),
  useProgramAssignees: (...a: unknown[]) => mockAssignees(...a),
  useProgramRevisions: (...a: unknown[]) => mockRevisions(...a),
  useInvalidatePrograms: () => jest.fn(async () => undefined),
}));

const mockSetDay = jest.fn();
const mockCreate = jest.fn();
const mockUnassign = jest.fn();
jest.mock("../../../../api/programsApi", () => ({
  ...jest.requireActual("../../../../api/programsApi"),
  programsApi: {
    setDay: (...a: unknown[]) => mockSetDay(...a),
    create: (...a: unknown[]) => mockCreate(...a),
    unassign: (...a: unknown[]) => mockUnassign(...a),
  },
}));

import ProgramDayPickerScreen from "../ProgramDayPickerScreen";
import ProgramFormScreen from "../ProgramFormScreen";
import ProgramsLibraryScreen from "../ProgramsLibraryScreen";

function fake<T>(v: unknown): T {
  return v as T;
}

const DETAIL = {
  id: "p1",
  name: "Intro",
  description: null,
  goal_tag: null,
  weeks: 2,
  days_per_week: 3,
  filled_days: 0,
  assigned_count: 0,
  package_count: 0,
  is_regime: false,
  regime_display_name: null,
  version: 1,
  can_edit: true,
  updated_at: "2026-10-01T00:00:00.000Z",
  archived_at: null,
  days: [],
  packages: [],
};

function listResult(items: unknown[]) {
  return {
    data: { pages: [{ items, next_cursor: null, goal_tags: [] }] },
    error: null,
    isLoading: false,
    isRefetching: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    refetch: jest.fn(),
    fetchNextPage: jest.fn(),
  };
}

const SAVED = [
  { id: "plan-a", name: "Upper A", type: "strength", duration_estimate_minutes: null, exercise_count: 5, updated_at: "x" },
  { id: "plan-b", name: "Lower B", type: "strength", duration_estimate_minutes: null, exercise_count: 6, updated_at: "x" },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockProgram.mockReturnValue({ data: DETAIL, error: null, isLoading: false, refetch: jest.fn() });
  mockSaved.mockReturnValue(listResult(SAVED));
});

async function dayPicker() {
  return render(
    <ProgramDayPickerScreen
      {...fake<Parameters<typeof ProgramDayPickerScreen>[0]>({
        route: { params: { programId: "p1", week: 0, day: 0, mode: "saved" } },
        navigation: mockNavigation,
      })}
    />,
  );
}

describe("B-357-1 probe: DayPicker binds a request key to one request body", () => {
  it("a different saved workout after an unknown outcome is sent with a NEW key", async () => {
    mockSetDay
      .mockRejectedValueOnce(new Error("Network Error")) // no response: outcome unknown
      .mockResolvedValueOnce(DETAIL);
    const screen = await dayPicker();
    await fireEvent.press(screen.getByLabelText("Upper A, strength · 5 exercises"));
    await screen.findByText(/could not reach the server/);
    await fireEvent.press(screen.getByLabelText("Lower B, strength · 6 exercises"));
    expect(mockSetDay).toHaveBeenCalledTimes(2);
    expect(mockSetDay.mock.calls[1][3]).toEqual({ source: "saved_workout", plan_id: "plan-b" });
    // Backend withIdempotency (workout-builder.service.ts:198-270) keys on route
    // `programs:setDay:<program>:<week>:<day>` only, so the same key replays
    // Upper A's committed result and reports Lower B as done.
    expect(mockSetDay.mock.calls[1][4]).not.toBe(mockSetDay.mock.calls[0][4]);
  });

  it("control: Retry of the same pick reuses the key", async () => {
    mockSetDay.mockRejectedValueOnce(new Error("Network Error")).mockResolvedValueOnce(DETAIL);
    const screen = await dayPicker();
    await fireEvent.press(screen.getByLabelText("Upper A, strength · 5 exercises"));
    await fireEvent.press(await screen.findByLabelText("Retry"));
    expect(mockSetDay).toHaveBeenCalledTimes(2);
    expect(mockSetDay.mock.calls[1][3]).toEqual(mockSetDay.mock.calls[0][3]);
    expect(mockSetDay.mock.calls[1][4]).toBe(mockSetDay.mock.calls[0][4]);
  });
});

describe("C-357-1 probe: the backend in-progress 409 keeps the create key", () => {
  it("unknown -> 409 'Request in progress' -> next press still sends the first key", async () => {
    mockCreate
      .mockRejectedValueOnce(new Error("timeout of 30000ms exceeded"))
      .mockRejectedValueOnce({
        response: {
          status: 409,
          // HttpExceptionFilter envelope of withIdempotency's
          // ConflictException('Request in progress — retry in a moment')
          data: { statusCode: 409, message: "Request in progress — retry in a moment", error: "Conflict" },
        },
      })
      .mockResolvedValueOnce({ id: "new" });
    const screen = await render(
      <ProgramFormScreen
        {...fake<Parameters<typeof ProgramFormScreen>[0]>({
          route: { params: {} },
          navigation: mockNavigation,
        })}
      />,
    );
    await fireEvent.changeText(screen.getByLabelText("Program name"), "Intro");
    await fireEvent.press(screen.getByLabelText("Create program"));
    await screen.findByText(/could not confirm whether this saved/);
    await fireEvent.press(screen.getByLabelText("Create program"));
    await screen.findByText(/Request in progress/);
    await fireEvent.press(screen.getByLabelText("Create program"));
    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(mockCreate.mock.calls[2][1]).toBe(mockCreate.mock.calls[0][1]);
  });
});

describe("C-357-2 probe: one failure, one Sentry event", () => {
  it("re-rendering the library with the same load error does not send new events", async () => {
    mockProgramList.mockReturnValue({
      ...listResult([]),
      data: undefined,
      error: new Error("Network Error"),
    });
    const screen = await render(<ProgramsLibraryScreen />);
    const first = screen.getByText(/Reference [A-Z0-9]+/).props.children;
    // Any parent re-render (focus, theme, tab bar) with the SAME error object.
    await screen.rerender(<ProgramsLibraryScreen />);
    await screen.rerender(<ProgramsLibraryScreen />);
    const later = screen.getByText(/Reference [A-Z0-9]+/).props.children;
    expect(mockCaptureError).toHaveBeenCalledTimes(1);
    // The reference the coach is told to quote must not change under them.
    expect(later).toEqual(first);
  });
});
