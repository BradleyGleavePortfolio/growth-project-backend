/** AUD-SOL-P34-120, agent 120: independent acceptance probes, never merge. */
import React from "react";
import { Alert } from "react-native";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";

const mockNavigation = { navigate: jest.fn(), setOptions: jest.fn(), goBack: jest.fn() };
const mockAssign = jest.fn();
const mockUnassign = jest.fn();
const mockCapture = jest.fn();
const mockClients = jest.fn();
const mockAssignees = jest.fn();

jest.mock("@react-navigation/native", () => ({ useNavigation: () => mockNavigation }));
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("../../../../theme/ThemeProvider", () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => "#123456" }) }),
}));
jest.mock("../../../../services/sentry", () => ({
  captureError: (...args: unknown[]) => mockCapture(...args),
}));
jest.mock("../../../../services/api", () => ({ __esModule: true, default: {}, coachApi: {} }));
jest.mock("../../../../hooks/usePrograms", () => ({
  useProgram: () => ({ data: { id: "p1", name: "Master", filled_days: 1 }, isLoading: false }),
  useAssignableClients: () => ({ data: mockClients(), isLoading: false }),
  useInvalidatePrograms: () => async () => undefined,
  useProgramRevisions: () => ({ data: { items: [] }, isLoading: false }),
  useProgramAssignees: () => ({ data: { pages: [{ items: mockAssignees() }] }, isLoading: false }),
}));
jest.mock("../../../../api/programsApi", () => ({
  ...jest.requireActual("../../../../api/programsApi"),
  programsApi: {
    assign: (...args: unknown[]) => mockAssign(...args),
    unassign: (...args: unknown[]) => mockUnassign(...args),
  },
}));

import ProgramAssignScreen from "../ProgramAssignScreen";
import ProgramHistoryScreen from "../ProgramHistoryScreen";
import { scrubEvent } from "../../../../services/sentryPrivacy";
import { scrubEvent as scrubCredentials } from "../../../../services/sentryScrub";

function fake<T>(value: unknown): T { return value as T; }
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
function roster(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `c${i}`, name: `Client ${i}`, email: "" }));
}
function assignProps() {
  return fake<Parameters<typeof ProgramAssignScreen>[0]>({
    route: { params: { programId: "p1" } }, navigation: mockNavigation,
  });
}
function historyProps() {
  return fake<Parameters<typeof ProgramHistoryScreen>[0]>({
    route: { params: { programId: "p1" } }, navigation: mockNavigation,
  });
}
const assignee = {
  client_id: "c1", client_name: "Synthetic PersonPrivate", copy_program_id: "run1",
  start_date: "2026-10-05", end_date: "2026-11-02", workouts: 2, completed: 0,
};
beforeEach(() => {
  jest.clearAllMocks();
  mockClients.mockReturnValue(roster(51));
  mockAssignees.mockReturnValue([assignee]);
  mockAssign.mockResolvedValue({ results: [] });
  mockUnassign.mockResolvedValue({ removed_workouts: 2, kept_workouts: 0 });
});
afterEach(() => jest.restoreAllMocks());

it("P4 lifecycle: retiring the assign screen during chunk one must prevent a later chunk request", async () => {
  const pending = deferred<{ results: Array<{ client_id: string; status: string }> }>();
  mockAssign.mockReturnValueOnce(pending.promise);
  const screen = await render(<ProgramAssignScreen {...assignProps()} />);
  await fireEvent.press(screen.getByLabelText("Select all shown (51)"));
  await fireEvent.press(screen.getByLabelText("Assign to 51 clients"));
  expect(mockAssign).toHaveBeenCalledTimes(1);
  expect(mockAssign.mock.calls[0][1].client_ids).toHaveLength(50);
  await screen.unmount();
  await act(async () => {
    pending.resolve({ results: roster(50).map((c) => ({ client_id: c.id, status: "assigned" })) });
  });
  expect(mockAssign).toHaveBeenCalledTimes(1);
});

it("P4 completeness: a whole-program refusal must account for and recover all 51 selected clients", async () => {
  mockAssign.mockRejectedValueOnce({
    response: { status: 409, data: { code: "program_archived" } },
  });
  const screen = await render(<ProgramAssignScreen {...assignProps()} />);
  await fireEvent.press(screen.getByLabelText("Select all shown (51)"));
  await fireEvent.press(screen.getByLabelText("Assign to 51 clients"));
  await screen.findByText(/This program is archived/);
  expect(mockAssign).toHaveBeenCalledTimes(1);
  // No implicit success/omission for c50. All selected clients need a visible
  // refused/not-attempted outcome and a recovery path; current UI offers only 50.
  expect(screen.queryByLabelText("Retry 51 failed")).not.toBeNull();
});

it("P4 privacy: a failed removal must not forward a client name through telemetry action metadata", async () => {
  mockUnassign.mockRejectedValueOnce(new Error("Network Error"));
  const alert = jest.spyOn(Alert, "alert");
  const screen = await render(<ProgramHistoryScreen {...historyProps()} />);
  await fireEvent.press(screen.getByLabelText("Remove"));
  const remove = alert.mock.calls[0][2]!.find((b) => b.text === "Remove")!;
  await act(async () => { await remove.onPress!(); });
  await waitFor(() => expect(mockCapture).toHaveBeenCalled());
  const event = scrubCredentials(scrubEvent({ extra: mockCapture.mock.calls[0][1] }));
  expect(JSON.stringify(event)).not.toContain(assignee.client_name);
});

it("P4 destructive copy: a remove confirmation cannot claim only one run's count while deleting all runs", async () => {
  mockAssignees.mockReturnValue([
    assignee,
    { ...assignee, copy_program_id: "run2", workouts: 5, start_date: "2026-11-09", end_date: "2026-12-07" },
  ]);
  const alert = jest.spyOn(Alert, "alert");
  const screen = await render(<ProgramHistoryScreen {...historyProps()} />);
  await fireEvent.press(screen.getAllByLabelText("Remove")[0]);
  expect(alert.mock.calls[0][1]).toContain("7 upcoming workouts");
});
