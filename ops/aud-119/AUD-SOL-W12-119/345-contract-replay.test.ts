// Test-only adversarial evidence for AUD-SOL-S12-117 at mobile #345.
jest.mock("../../../services/api", () => ({
  __esModule: true,
  default: { post: jest.fn(), patch: jest.fn(), get: jest.fn() },
}));
jest.mock("../../../services/sentry", () => ({
  captureError: jest.fn(),
}));
const mockStore = new Map<string, string>();
jest.mock("../../../storage/mmkv", () => ({
  prefsStorage: {
    getStringAsync: async (k: string) => mockStore.get(k),
    set: async (k: string, v: string) => { mockStore.set(k, v); },
    delete: async (k: string) => { mockStore.delete(k); },
  },
}));

import api from "../../../services/api";
import { coachPackagesApi, type PackageCreateInput } from "../../../api/packagesApi";
import { createPackageOnce, newIntent } from "../packageCreateIntent";
import { describeError } from "../errors";
import { captureError } from "../../../services/sentry";

const input: PackageCreateInput = {
  title: "Synthetic coaching", priceCents: 4900, currency: "usd",
  billingInterval: "monthly", intervalCount: 1,
};
const row = () => ({
  id: "pkg_1", name: input.title, amount_cents: 4900, currency: "usd",
  billing_type: "recurring", billing_interval: "month", billing_interval_count: 1,
  is_active: true, published_at: null,
});
const deps = {
  create: (body: PackageCreateInput, key: string) => coachPackagesApi.create(body, key),
  update: (id: string, body: PackageCreateInput) => coachPackagesApi.update(id, body),
};
beforeEach(() => {
  jest.clearAllMocks();
  mockStore.clear();
});

it("control: an unchanged known intent neither re-creates nor patches", async () => {
  const earlier = { ...newIntent(input), packageId: "pkg_1" };
  const result = await createPackageOnce({
    coachId: "coach_1", scope: "wizard", input, earlier, deps, onIntent: jest.fn(),
  });
  expect(result.packageId).toBe("pkg_1");
  expect(api.post).not.toHaveBeenCalled();
  expect(api.patch).not.toHaveBeenCalled();
});

it("changed retry sends the selected one-time cadence through the actual PATCH adapter", async () => {
  const earlier = { ...newIntent(input), packageId: "pkg_1" };
  // The original fixture always returned the unchanged monthly row. Use the
  // server's applied answer; the candidate's new answer check must not be bypassed.
  jest.mocked(api.patch).mockResolvedValue({ data: { ...row(), billing_type: "one_time" } });
  const next: PackageCreateInput = { ...input, billingInterval: "one_time" };
  const result = await createPackageOnce({
    coachId: "coach_1", scope: "wizard", input: next, earlier, deps, onIntent: jest.fn(),
  });
  expect(result.intent.input.billingInterval).toBe("one_time");
  const sent = jest.mocked(api.patch).mock.calls[0][1] as Record<string, unknown>;
  expect(sent.billing_type).toBe("one_time");
});

it("paid-to-free retry can finish against the backend merged-pricing contract", async () => {
  const earlier = { ...newIntent(input), packageId: "pkg_1" };
  jest.mocked(api.patch).mockImplementation(async (_url, body) => {
    const sent = body as Record<string, unknown>;
    // Backend validates PATCH merged with the stored package, not the form's input.
    const mergedType = sent.billing_type ?? "recurring";
    if (sent.amount_cents === 0 && mergedType === "recurring") {
      throw Object.assign(new Error("HTTP 400"), {
        response: { status: 400, data: { code: "PACKAGE_FREE_MUST_BE_ONE_TIME" } },
      });
    }
    return { data: { ...row(), amount_cents: 0, billing_type: mergedType } };
  });
  const next: PackageCreateInput = { ...input, priceCents: 0, billingInterval: "one_time" };
  await expect(createPackageOnce({
    coachId: "coach_1", scope: "wizard", input: next, earlier, deps, onIntent: jest.fn(),
  })).resolves.toMatchObject({ packageId: "pkg_1" });
});

it("an unknown local failure always has an attributable support reference", () => {
  const result = describeError(new Error("synthetic local failure"), "copy the link");
  expect(captureError).toHaveBeenCalledTimes(1);
  expect(result.requestId).toEqual(expect.any(String));
  expect(result.requestId?.length).toBeGreaterThan(0);
});

it("unknown diagnostics do not forward untrusted exception text to Sentry", () => {
  const marker = "synthetic-person@example.invalid";
  describeError(new Error(`Synthetic clipboard refusal for ${marker}`), "copy the link");
  const diagnostic = jest.mocked(captureError).mock.calls[0][0] as Error;
  expect(diagnostic.message).not.toContain(marker);
});
