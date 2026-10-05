// Audit-only concurrency counterexample at #345 97c9005e.
const mockStore = new Map<string, string>();
let mockHoldFirstWrite: Promise<void> | null = null;
let mockWriteCount = 0;
jest.mock("../../../storage/mmkv", () => ({
  prefsStorage: {
    getStringAsync: async (key: string) => mockStore.get(key),
    set: async (key: string, value: string) => {
      mockStore.set(key, value);
      mockWriteCount += 1;
      // Native storage has committed; its completion callback is delayed.
      if (mockWriteCount === 1 && mockHoldFirstWrite) await mockHoldFirstWrite;
    },
    delete: async (key: string) => { mockStore.delete(key); },
  },
}));
import {
  createPackageOnce, intentStorageKey, loadIntent, PackageCreateStoppedError,
} from "../packageCreateIntent";
import type { PackageCreateInput } from "../../../api/packagesApi";

const input: PackageCreateInput = {
  title: "Synthetic coaching", priceCents: 4900, currency: "usd",
  billingInterval: "monthly", intervalCount: 1,
};
const key = intentStorageKey("coach_1");
const offline = () => Object.assign(new Error("Network Error"), {
  code: "ERR_NETWORK", request: {},
});
const rows = new Map<string, string>();
const create = jest.fn(async (_body: PackageCreateInput, idempotency: string) => {
  if (!rows.has(idempotency)) rows.set(idempotency, `pkg_${rows.size + 1}`);
  throw offline(); // The server commits, but its answer is lost.
});
beforeEach(() => {
  mockStore.clear(); rows.clear(); create.mockClear();
  mockHoldFirstWrite = null; mockWriteCount = 0;
});

it("retired unsent origin cannot delete the identity that a remounted form has sent", async () => {
  let release!: () => void;
  mockHoldFirstWrite = new Promise<void>((r) => { release = r; });
  let oldLive = true;
  const old = createPackageOnce({
    coachId: "coach_1", scope: "wizard", input, earlier: null,
    deps: { create, update: jest.fn() }, onIntent: jest.fn(),
    isLive: () => oldLive,
  }).catch((err: unknown) => err);
  expect(mockStore.has(key)).toBe(true);
  oldLive = false;
  // A replacement mount hydrates the successfully committed old write.
  const read = await loadIntent("coach_1");
  expect(read.kind).toBe("found");
  if (read.kind !== "found") throw new Error("fixture: missing write-ahead");
  const sentKey = read.intent.key;
  await expect(createPackageOnce({
    coachId: "coach_1", scope: "wizard", input, earlier: read.intent,
    deps: { create, update: jest.fn() }, onIntent: jest.fn(), isLive: () => true,
  })).rejects.toMatchObject({ code: "ERR_NETWORK" });
  expect(rows.size).toBe(1);
  expect(JSON.parse(mockStore.get(key) as string).key).toBe(sentKey);
  release();
  expect(await old).toBeInstanceOf(PackageCreateStoppedError);
  // This assertion fails: old cleanup blindly deletes the now-sent intent.
  expect(JSON.parse(mockStore.get(key) ?? "null")?.key).toBe(sentKey);
});

it("the same retirement race turns a later retry into a second server package", async () => {
  let release!: () => void;
  mockHoldFirstWrite = new Promise<void>((r) => { release = r; });
  let oldLive = true;
  const old = createPackageOnce({
    coachId: "coach_1", scope: "wizard", input, earlier: null,
    deps: { create, update: jest.fn() }, onIntent: jest.fn(),
    isLive: () => oldLive,
  }).catch((err: unknown) => err);
  oldLive = false;
  const read = await loadIntent("coach_1");
  if (read.kind !== "found") throw new Error("fixture: missing write-ahead");
  await createPackageOnce({
    coachId: "coach_1", scope: "wizard", input, earlier: read.intent,
    deps: { create, update: jest.fn() }, onIntent: jest.fn(), isLive: () => true,
  }).catch(() => undefined);
  release(); await old;
  const retryRead = await loadIntent("coach_1");
  await createPackageOnce({
    coachId: "coach_1", scope: "wizard", input,
    earlier: retryRead.kind === "found" ? retryRead.intent : null,
    deps: { create, update: jest.fn() }, onIntent: jest.fn(), isLive: () => true,
  }).catch(() => undefined);
  expect(rows.size).toBe(1); // Actual: two keys, two committed packages.
});

it("control: a lost answer without overlapping retired cleanup preserves its key", async () => {
  await createPackageOnce({
    coachId: "coach_1", scope: "wizard", input, earlier: null,
    deps: { create, update: jest.fn() }, onIntent: jest.fn(), isLive: () => true,
  }).catch(() => undefined);
  const read = await loadIntent("coach_1");
  if (read.kind !== "found") throw new Error("fixture: missing write-ahead");
  await createPackageOnce({
    coachId: "coach_1", scope: "wizard", input, earlier: read.intent,
    deps: { create, update: jest.fn() }, onIntent: jest.fn(), isLive: () => true,
  }).catch(() => undefined);
  expect(rows.size).toBe(1);
  expect(create.mock.calls[0][1]).toBe(create.mock.calls[1][1]);
});
