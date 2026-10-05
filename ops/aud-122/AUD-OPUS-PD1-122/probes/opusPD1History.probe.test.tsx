/**
 * AUD-OPUS-P34-120 probes (Opus lens, agent 120) at #357 b364b9ea / #358 4dcf0aff.
 * Each `it` states the behaviour the PR's own contract promises; a red test is the finding.
 *  - B-358-2 ProgramHistoryScreen: per-run Remove, but the server removes every run of that client.
 */
import React from "react";
import { Alert } from "react-native";
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

import ProgramHistoryScreen from "../ProgramHistoryScreen";

function fake<T>(v: unknown): T {
  return v as T;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("B-358-2 probe: Remove states the scope the server applies", () => {
  it("a client on two runs: the confirmation covers every run the server removes", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
    mockRevisions.mockReturnValue({ data: { items: [] }, error: null, isLoading: false, refetch: jest.fn() });
    mockAssignees.mockReturnValue({
      data: {
        pages: [
          {
            items: [
              // run 2 (newest copy): 12 workouts, none done
              { client_id: "c1", client_name: "Alex", copy_program_id: "copy-2", start_date: "2026-11-02T12:00:00.000Z", end_date: "2026-11-27T12:00:00.000Z", workouts: 12, completed: 0 },
              // run 1: 12 workouts, 11 done
              { client_id: "c1", client_name: "Alex", copy_program_id: "copy-1", start_date: "2026-09-07T12:00:00.000Z", end_date: "2026-10-02T12:00:00.000Z", workouts: 12, completed: 11 },
            ],
            next_cursor: null,
          },
        ],
      },
      error: null,
      isLoading: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      refetch: jest.fn(),
      fetchNextPage: jest.fn(),
    });
    const screen = await render(
      <ProgramHistoryScreen
        {...fake<Parameters<typeof ProgramHistoryScreen>[0]>({
          route: { params: { programId: "p1" } },
          navigation: mockNavigation,
        })}
      />,
    );
    const removes = screen.getAllByLabelText("Remove");
    await fireEvent.press(removes[removes.length - 1]); // the older run's row
    const message = String(alert.mock.calls[0]?.[1] ?? "");
    // Server: program-library.service.ts:1462-1497 deletes every not-started
    // workout of EVERY copy of this program for c1 (1 + 12 = 13) and archives both.
    // Either one Remove per client, or the dialog states the full scope.
    // AUD-OPUS-PD1-122: one Remove per client, and the dialog states the true
    // ceiling (12 + 1 = 13) and the scope (every run, package copies included).
    expect(removes).toHaveLength(1);
    expect(message).toMatch(/Up to 13 upcoming workouts are removed/);
    expect(message).toMatch(/Every run of this program/);
    expect(message).toMatch(/including copies delivered by a package/);
    expect(message).toMatch(/cannot be undone/);
    alert.mockRestore();
  });
});

