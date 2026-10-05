/** AUD-SOL-P34-120, agent 120: independent acceptance probes, never merge. */
import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockNavigation = {
  navigate: jest.fn(), push: jest.fn(), replace: jest.fn(),
  setOptions: jest.fn(), goBack: jest.fn(),
};
const mockProgram = jest.fn();
const mockCreate = jest.fn();
const mockUpdate = jest.fn();
const mockSetDay = jest.fn();
const mockDuplicate = jest.fn();
const mockArchive = jest.fn();

jest.mock("@react-navigation/native", () => ({
  useNavigation: () => mockNavigation, useFocusEffect: jest.fn(),
}));
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("../../../../theme/ThemeProvider", () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => "#123456" }) }),
}));
jest.mock("../../../../services/sentry", () => ({ captureError: jest.fn() }));
jest.mock("../../../../services/api", () => ({
  __esModule: true, default: {}, coachApi: {},
}));
jest.mock("../../../../hooks/usePrograms", () => ({
  ...jest.requireActual("../../../../hooks/usePrograms"),
  useProgram: (...args: unknown[]) => mockProgram(...args),
  useSavedWorkouts: () => ({
    data: { pages: [{ items: [
      { id: "saved-a", name: "Saved A", type: "strength", exercise_count: 1 },
      { id: "saved-b", name: "Saved B", type: "strength", exercise_count: 1 },
    ] }] },
    isLoading: false, hasNextPage: false,
  }),
  useInvalidatePrograms: () => async () => undefined,
}));
jest.mock("../../../../api/programsApi", () => ({
  ...jest.requireActual("../../../../api/programsApi"),
  programsApi: {
    create: (...args: unknown[]) => mockCreate(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    setDay: (...args: unknown[]) => mockSetDay(...args),
    duplicate: (...args: unknown[]) => mockDuplicate(...args),
    archive: (...args: unknown[]) => mockArchive(...args),
  },
}));

import ProgramFormScreen from "../ProgramFormScreen";
import ProgramDayPickerScreen from "../ProgramDayPickerScreen";
import ProgramEditorScreen from "../ProgramEditorScreen";
import { programKeys } from "../../../../hooks/usePrograms";

const detail = {
  id: "p1", version: 3, name: "Original name", description: "", goal_tag: "",
  weeks: 4, days_per_week: 3, filled_days: 1, assigned_count: 0,
  package_count: 0, days: [], packages: [], archived_at: null, can_edit: true,
};
function fake<T>(value: unknown): T { return value as T; }
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
function provider(qc: QueryClient, child: React.ReactNode) {
  return <QueryClientProvider client={qc}>{child}</QueryClientProvider>;
}
function formProps(programId?: string) {
  return fake<Parameters<typeof ProgramFormScreen>[0]>({
    route: { params: programId ? { programId } : {} }, navigation: mockNavigation,
  });
}
beforeEach(() => {
  jest.clearAllMocks();
  mockProgram.mockReturnValue({ data: detail, isLoading: false, refetch: jest.fn() });
  mockUpdate.mockResolvedValue(detail);
  mockCreate.mockResolvedValue({ ...detail, id: "created" });
  mockSetDay.mockResolvedValue(detail);
  mockArchive.mockResolvedValue({ ...detail, archived_at: "now" });
});
afterEach(() => jest.restoreAllMocks());

it("P3 conflict: a second unrelated server revision must not discard an unresolved name conflict", async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const props = formProps("p1");
  const screen = await render(provider(qc, <ProgramFormScreen {...props} />));
  await fireEvent.changeText(screen.getByLabelText("Program name"), "My name");
  mockUpdate.mockRejectedValueOnce({
    response: { status: 409, data: { code: "program_version_conflict" } },
  });
  await fireEvent.press(screen.getByLabelText("Save details"));
  mockProgram.mockReturnValue({ data: { ...detail, version: 4, name: "Their name" }, isLoading: false });
  await screen.rerender(provider(qc, <ProgramFormScreen {...props} />));
  expect(screen.getByText(/Name also changed on another device/)).toBeTruthy();
  expect(screen.getByLabelText("Save details").props.accessibilityState.disabled).toBe(true);
  mockProgram.mockReturnValue({
    data: { ...detail, version: 5, name: "Their name", goal_tag: "Strength" }, isLoading: false,
  });
  await screen.rerender(provider(qc, <ProgramFormScreen {...props} />));
  expect(screen.getByLabelText("Program name").props.value).toBe("My name");
  expect(screen.getByLabelText("Goal tag").props.value).toBe("Strength");
  expect(screen.queryByText(/Name also changed on another device/)).not.toBeNull();
  expect(screen.getByLabelText("Save details").props.accessibilityState.disabled).toBe(true);
  qc.clear();
});

it("P3 day picker: an unresolved Saved A intent cannot silently reuse its key for Saved B", async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  const props = fake<Parameters<typeof ProgramDayPickerScreen>[0]>({
    route: { params: { programId: "p1", week: 0, day: 0, mode: "saved" } },
    navigation: mockNavigation,
  });
  mockSetDay.mockRejectedValueOnce(new Error("response lost after Saved A committed"));
  const screen = await render(provider(qc, <ProgramDayPickerScreen {...props} />));
  await fireEvent.press(screen.getByLabelText(/^Saved A,/));
  await screen.findByLabelText("Retry");
  await fireEvent.press(screen.getByLabelText(/^Saved B,/));
  expect(mockSetDay).toHaveBeenCalledTimes(1);
  qc.clear();
});

it("P3 duplicate: the copy must never replace the original program's cached identity", async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  const props = fake<Parameters<typeof ProgramEditorScreen>[0]>({
    route: { params: { programId: "p1" } }, navigation: mockNavigation,
  });
  qc.setQueryData(programKeys.detail("p1"), detail);
  mockDuplicate.mockResolvedValueOnce({ ...detail, id: "copy", name: "Copied program" });
  const screen = await render(provider(qc, <ProgramEditorScreen {...props} />));
  await fireEvent.press(screen.getByLabelText("Duplicate"));
  await waitFor(() => expect(mockNavigation.push).toHaveBeenCalledWith("ProgramEditor", { programId: "copy" }));
  expect(qc.getQueryData(programKeys.detail("p1"))).toMatchObject({ id: "p1", name: "Original name" });
  expect(qc.getQueryData(programKeys.detail("copy"))).toMatchObject({ id: "copy" });
  qc.clear();
});

it("P3 ownership: a held create cannot repopulate a cleared global cache or navigate after unmount", async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  const pending = deferred<typeof detail>();
  mockCreate.mockReturnValueOnce(pending.promise);
  const screen = await render(provider(qc, <ProgramFormScreen {...formProps()} />));
  await fireEvent.changeText(screen.getByLabelText("Program name"), "Old owner's private program");
  await fireEvent.press(screen.getByLabelText("Create program"));
  expect(mockCreate).toHaveBeenCalledTimes(1);
  await screen.unmount();
  qc.clear(); // Equivalent global-cache boundary after the old session screens are retired.
  await act(async () => { pending.resolve({ ...detail, name: "Old owner's private program" }); });
  expect(qc.getQueryData(programKeys.detail("p1"))).toBeUndefined();
  expect(mockNavigation.replace).not.toHaveBeenCalled();
  qc.clear();
});
