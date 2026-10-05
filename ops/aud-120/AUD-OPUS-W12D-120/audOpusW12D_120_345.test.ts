/**
 * AUD-OPUS-W12D-120 probe on mobile #345 @ ed29833c (never merge).
 * Delta since Opus APPROVE @ 97c9005e: B-345-1, a retired create keeps the
 * intent it wrote. Runs on the real prefs storage shim (AsyncStorage jest
 * mock from jest.setup.js) so the sign-out wipe path is the real one.
 * "verify" cases assert the fix-round claims; the "observe" case records the
 * behaviour behind follow-up C-345-7 (it passes when the C is real).
 */
jest.mock("../../../services/api", () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn() },
}));
jest.mock("../../../services/sentry", () => ({ captureError: jest.fn() }));

import AsyncStorage from "@react-native-async-storage/async-storage";
import type { PackageCreateInput } from "../../../api/packagesApi";
import { clearAllStorage } from "../../../storage/mmkv";
import {
  createPackageOnce,
  IntentStorageError,
  intentStorageKey,
  loadIntent,
  newIntent,
  PackageCreateStoppedError,
  saveIntent,
  type PackageCreateIntent,
} from "../packageCreateIntent";

const COACH = "coach_1";
const input: PackageCreateInput = {
  title: "North coaching",
  description: null,
  priceCents: 4900,
  currency: "usd",
  billingInterval: "monthly",
  intervalCount: 1,
  trialDays: 0,
  features: [],
};

/** Backend double: one package per key; `lose` drops the answer. */
const rows = new Map<string, string>();
let lose = false;
let refuse: { status: number; code: string } | null = null;
const create = jest.fn(async (_b: PackageCreateInput, key: string) => {
  if (refuse) {
    const r = refuse;
    throw Object.assign(new Error("refused"), {
      response: { status: r.status, data: { code: r.code } },
    });
  }
  if (!rows.has(key)) rows.set(key, `pkg_${rows.size + 1}`);
  if (lose)
    throw Object.assign(new Error("Network Error"), {
      code: "ERR_NETWORK",
      request: {},
    });
  return { data: { id: rows.get(key) as string } };
});
const update = jest.fn(async () => ({}));
const deps = { create, update };

const run = (
  earlier: PackageCreateIntent | null,
  isLive: () => boolean = () => true,
  body: PackageCreateInput = input,
  scope: "wizard" | "editor" = "wizard",
) =>
  createPackageOnce({
    coachId: COACH,
    scope,
    input: body,
    earlier,
    deps,
    onIntent: jest.fn(),
    isLive,
  });

const stored = async (coach = COACH, scope: "wizard" | "editor" = "wizard") => {
  const r = await loadIntent(coach, scope);
  return r.kind === "found" ? r.intent : null;
};

let spy: jest.SpyInstance | null = null;
afterEach(() => {
  spy?.mockRestore();
  spy = null;
});

beforeEach(async () => {
  create.mockClear();
  update.mockClear();
  rows.clear();
  lose = false;
  refuse = null;
  await AsyncStorage.clear();
});

describe("AUD-OPUS-W12D-120 #345 B-345-1 delta", () => {
  it("verify: retired after the write-ahead saved: nothing sent, the exact key and body stay; the live retry sends that key once", async () => {
    let live = true;
    const p = run(null, () => live);
    live = false; // retirement observed when the save completes
    await expect(p).rejects.toBeInstanceOf(PackageCreateStoppedError);
    expect(create).not.toHaveBeenCalled();
    const kept = await stored();
    expect(kept).not.toBeNull();
    expect(kept?.packageId).toBeNull();
    expect(kept?.input).toEqual(input);
    const out = await run(kept);
    expect(create.mock.calls.map((c) => c[1])).toEqual([kept?.key]);
    expect(rows.size).toBe(1);
    expect(out.intent.key).toBe(kept?.key);
    expect(update).not.toHaveBeenCalled();
  });

  it("verify: retired while the write-ahead fails: stopped (not a storage error), nothing sent, nothing on disk", async () => {
    spy = jest
      .spyOn(AsyncStorage, "setItem")
      .mockImplementationOnce(async () => {
        throw new Error("disk full");
      });
    let live = true;
    const p = run(null, () => live);
    live = false;
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PackageCreateStoppedError);
    expect(err).not.toBeInstanceOf(IntentStorageError);
    expect(create).not.toHaveBeenCalled();
    expect(await stored()).toBeNull();
  });

  it("verify: refused earlier intent with changed details, then retired at the fresh save: the refused key is never re-sent and the fresh key is sent once later", async () => {
    const old = newIntent({ ...input, title: "Old name" });
    await saveIntent(COACH, old, "wizard");
    refuse = { status: 400, code: "PACKAGE_VALIDATION_FAILED" };
    const realSet = AsyncStorage.setItem;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    spy = jest
      .spyOn(AsyncStorage, "setItem")
      .mockImplementation(async (k: string, v: string) => {
        await realSet(k, v); // on disk now; only the completion is late
        await gate;
      });
    let live = true;
    const p = run(old, () => live);
    let fresh: PackageCreateIntent | null = null;
    for (let i = 0; i < 50 && !(fresh && fresh.key !== old.key); i += 1) {
      await new Promise((r) => setTimeout(r, 0));
      fresh = await stored();
    }
    expect(fresh).not.toBeNull();
    expect(fresh?.key).not.toBe(old.key);
    live = false;
    release();
    await expect(p).rejects.toBeInstanceOf(PackageCreateStoppedError);
    expect(create.mock.calls.map((c) => c[1])).toEqual([old.key]);
    spy.mockRestore();
    spy = null;
    refuse = null;
    const kept = await stored();
    expect(kept?.key).toBe(fresh?.key);
    expect(kept?.input.title).toBe("North coaching");
    await run(kept);
    expect(create.mock.calls.map((c) => c[1])).toEqual([old.key, fresh?.key]);
    expect(rows.size).toBe(1);
  });

  it("verify: a sign-out wipe issued after the retired write removes it (the code comment's ordering claim)", async () => {
    let live = true;
    const p = run(null, () => live);
    const wipe = clearAllStorage(); // issued after the write
    live = false;
    await expect(p).rejects.toBeInstanceOf(PackageCreateStoppedError);
    await wipe;
    expect(await stored()).toBeNull();
    expect(
      (await AsyncStorage.getAllKeys()).filter((k) =>
        k.includes(intentStorageKey(COACH)),
      ),
    ).toEqual([]);
  });

  it("observe C-345-7: a wipe that enumerated keys before the retired write leaves the intent on disk after sign-out (old head cleared it)", async () => {
    const wipe = clearAllStorage(); // enumeration happens now
    let live = true;
    const p = run(null, () => live); // write issued after the enumeration
    live = false;
    await expect(p).rejects.toBeInstanceOf(PackageCreateStoppedError);
    await wipe;
    const kept = await stored();
    expect(kept).not.toBeNull();
    expect(kept?.input.title).toBe("North coaching");
  });

  it("verify: a kept wizard intent never reaches the editor scope or another account", async () => {
    let live = true;
    const p = run(null, () => live);
    live = false;
    await expect(p).rejects.toBeInstanceOf(PackageCreateStoppedError);
    expect(await stored(COACH, "wizard")).not.toBeNull();
    expect(await stored(COACH, "editor")).toBeNull();
    expect(await stored("coach_2", "wizard")).toBeNull();
  });
});
