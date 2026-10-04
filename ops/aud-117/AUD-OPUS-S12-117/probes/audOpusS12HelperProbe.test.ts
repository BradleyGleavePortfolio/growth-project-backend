/**
 * AUD-OPUS-S12-117 (agent 117, Claude Opus 5.5 lens) — audit probe, never merge.
 *
 * B-345-1: createPackageOnce step 3 ("details changed after the package was
 * made -> that package is updated with the coach's current details") goes
 * through coachPackagesApi.update, whose request body drops billingInterval /
 * intervalCount. Backend UpdatePackageDto accepts billing_type,
 * billing_interval and billing_interval_count, so the cadence the coach
 * picked never reaches the server. Real helper + real request builder over a
 * mocked axios instance.
 */
jest.mock("../../../../services/api", () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(async () => ({ data: { id: "pkg_1" } })),
    put: jest.fn(),
    patch: jest.fn(async (_url: string, body: Record<string, unknown>) => ({
      data: { id: "pkg_1", ...body },
    })),
    delete: jest.fn(),
  },
}));

const mockStore = new Map<string, string>();
jest.mock("../../../../storage/mmkv", () => ({
  prefsStorage: {
    getStringAsync: async (k: string) => mockStore.get(k),
    set: async (k: string, v: string) => {
      mockStore.set(k, v);
    },
    delete: async (k: string) => {
      mockStore.delete(k);
    },
  },
}));

import api from "../../../../services/api";
import { coachPackagesApi } from "../../../../api/packagesApi";
import type { PackageCreateInput } from "../../../../api/packagesApi";
import {
  createPackageOnce,
  newIntent,
} from "../../../../lib/coachSetup/packageCreateIntent";

const monthly: PackageCreateInput = {
  title: "North coaching",
  description: null,
  priceCents: 4900,
  currency: "usd",
  billingInterval: "monthly",
  intervalCount: 1,
  trialDays: 0,
  features: [],
};

const deps = {
  create: (b: PackageCreateInput, k: string) => coachPackagesApi.create(b, k),
  update: (id: string, b: PackageCreateInput) => coachPackagesApi.update(id, b),
};

const patchMock = () => api.patch as unknown as jest.Mock;

beforeEach(() => {
  mockStore.clear();
  patchMock().mockClear();
});

it("control: unchanged details after the package was made send no PATCH", async () => {
  const made = { ...newIntent(monthly), packageId: "pkg_1" };
  const out = await createPackageOnce({
    coachId: "coach_1",
    scope: "wizard",
    input: { ...monthly },
    earlier: made,
    deps,
    onIntent: () => undefined,
  });
  expect(out.packageId).toBe("pkg_1");
  expect(patchMock()).not.toHaveBeenCalled();
});

it("B-345-1: monthly made, coach now picks one-time: the PATCH carries billing_type one_time", async () => {
  const made = { ...newIntent(monthly), packageId: "pkg_1" };
  await createPackageOnce({
    coachId: "coach_1",
    scope: "wizard",
    input: { ...monthly, billingInterval: "one_time" },
    earlier: made,
    deps,
    onIntent: () => undefined,
  });
  expect(patchMock()).toHaveBeenCalledTimes(1);
  expect(patchMock().mock.calls[0][1]).toMatchObject({
    billing_type: "one_time",
  });
});

it("B-345-1: monthly made, coach now picks free: the PATCH makes it one-time $0", async () => {
  const made = { ...newIntent(monthly), packageId: "pkg_1" };
  await createPackageOnce({
    coachId: "coach_1",
    scope: "wizard",
    input: { ...monthly, priceCents: 0, billingInterval: "one_time" },
    earlier: made,
    deps,
    onIntent: () => undefined,
  });
  expect(patchMock().mock.calls[0][1]).toMatchObject({
    amount_cents: 0,
    billing_type: "one_time",
  });
});

it("B-345-1: one-time made, coach now picks monthly: the PATCH carries recurring + month", async () => {
  const oneTime = { ...monthly, billingInterval: "one_time" as const };
  const made = { ...newIntent(oneTime), packageId: "pkg_1" };
  await createPackageOnce({
    coachId: "coach_1",
    scope: "wizard",
    input: { ...monthly },
    earlier: made,
    deps,
    onIntent: () => undefined,
  });
  expect(patchMock().mock.calls[0][1]).toMatchObject({
    billing_type: "recurring",
    billing_interval: "month",
  });
});
