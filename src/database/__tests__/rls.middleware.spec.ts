/**
 * Unit tests for the A1 RLS Prisma middleware skeleton.
 *
 * These run with NO database: the Prisma client is replaced by a tiny fake that
 * records `$executeRaw` invocations, and `getRlsContext` is mocked per-case to
 * simulate request vs. admin/migration execution. They pin the middleware's
 * contract:
 *
 *   - null context  -> no session vars set (admin/migration mode)
 *   - present context -> exactly two `set_config(..., true)` calls, correct args
 *   - enabled: false -> total pass-through, context never consulted
 *   - the underlying query result is returned untouched in every case
 */
import { Prisma } from "@prisma/client";
import {
  applyRlsToOperation,
  createRlsMiddleware,
  rlsAllOperations,
  type RlsOperationParams,
} from "../rls.middleware";
import * as context from "../prisma.context";

type ExecuteRawCall = { strings: readonly string[]; values: unknown[] };

/**
 * Minimal stand-in for a Prisma client's raw-SQL surface. Captures each
 * `$executeRaw` template literal so assertions can read back the interpolated
 * key/value pairs.
 */
function makeFakeClient() {
  const calls: ExecuteRawCall[] = [];
  return {
    calls,
    $executeRaw: jest.fn(
      (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ): Promise<number> => {
        calls.push({ strings: [...strings], values });
        return Promise.resolve(1);
      },
    ),
  };
}

function makeParams(
  client: unknown,
  result: unknown = { id: "row-1" },
): { params: RlsOperationParams; query: jest.Mock } {
  const query = jest.fn((_args: unknown) => Promise.resolve(result));
  const params: RlsOperationParams = {
    args: { where: { id: "x" } },
    query,
    client,
  };
  return { params, query };
}

describe("applyRlsToOperation", () => {
  let getRlsContext: jest.SpyInstance;

  beforeEach(() => {
    getRlsContext = jest.spyOn(context, "getRlsContext");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("does NOT set session vars when context is null (admin/migration mode)", async () => {
    getRlsContext.mockReturnValue(null);
    const client = makeFakeClient();
    const { params, query } = makeParams(client);

    await applyRlsToOperation(true, params);

    expect(client.$executeRaw).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("sets app.gym_ids and app.user_id (in order) when context is present", async () => {
    getRlsContext.mockReturnValue({ userId: "u1", gymIds: ["g1", "g2"] });
    const client = makeFakeClient();
    const { params, query } = makeParams(client);

    await applyRlsToOperation(true, params);

    expect(client.$executeRaw).toHaveBeenCalledTimes(2);
    expect(client.calls[0].strings.join("?")).toContain("app.gym_ids");
    expect(client.calls[0].values).toEqual(["g1,g2"]);
    expect(client.calls[1].strings.join("?")).toContain("app.user_id");
    expect(client.calls[1].values).toEqual(["u1"]);
    // set_config must run before the wrapped query.
    expect(client.$executeRaw.mock.invocationCallOrder[1]).toBeLessThan(
      query.mock.invocationCallOrder[0],
    );
  });

  it("serializes an empty gymIds list to an empty string", async () => {
    getRlsContext.mockReturnValue({ userId: "u1", gymIds: [] });
    const client = makeFakeClient();
    const { params } = makeParams(client);

    await applyRlsToOperation(true, params);

    expect(client.calls[0].values).toEqual([""]);
  });

  it("short-circuits and never consults context when disabled", async () => {
    getRlsContext.mockReturnValue({ userId: "u1", gymIds: ["g1"] });
    const client = makeFakeClient();
    const { params, query } = makeParams(client);

    await applyRlsToOperation(false, params);

    expect(getRlsContext).not.toHaveBeenCalled();
    expect(client.$executeRaw).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("skips set_config when the client lacks $executeRaw", async () => {
    getRlsContext.mockReturnValue({ userId: "u1", gymIds: ["g1"] });
    const { params, query } = makeParams({ notARawClient: true });

    await expect(applyRlsToOperation(true, params)).resolves.toEqual({
      id: "row-1",
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("returns the underlying query result untouched", async () => {
    getRlsContext.mockReturnValue({ userId: "u1", gymIds: ["g1"] });
    const client = makeFakeClient();
    const sentinel = [{ id: "a" }, { id: "b" }];
    const { params } = makeParams(client, sentinel);

    await expect(applyRlsToOperation(true, params)).resolves.toBe(sentinel);
  });

  it("passes the original args through to the wrapped query", async () => {
    getRlsContext.mockReturnValue(null);
    const client = makeFakeClient();
    const { params, query } = makeParams(client);

    await applyRlsToOperation(true, params);

    expect(query).toHaveBeenCalledWith(params.args);
  });
});

describe("createRlsMiddleware", () => {
  it("defaults to enabled and returns a usable Prisma extension", () => {
    const ext = createRlsMiddleware();
    expect(typeof ext).toBe("function");
    // Sanity: it can be handed to $extends without throwing on the args form.
    expect(() => Prisma.defineExtension(ext)).not.toThrow();
  });

  it("builds the $allOperations interceptor closure that resolves its client from `this`", async () => {
    // The closure resolves the live client via Prisma.getExtensionContext(this);
    // invoking it with the fake client as `this` reproduces the extension's
    // runtime binding without standing up the full engine pipeline.
    jest
      .spyOn(context, "getRlsContext")
      .mockReturnValue({ userId: "u9", gymIds: ["g1"] });
    const client = makeFakeClient();
    const query = jest.fn((_args: unknown) => Promise.resolve({ id: "u9" }));

    const interceptor = rlsAllOperations(true);
    const result = await interceptor.call(client, {
      args: { where: { id: "u9" } },
      query,
    });

    expect(result).toEqual({ id: "u9" });
    expect(client.$executeRaw).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledTimes(1);
    jest.restoreAllMocks();
  });

  it("honors enabled: false through the closure (no context, no raw calls)", async () => {
    const ctxSpy = jest.spyOn(context, "getRlsContext");
    const client = makeFakeClient();
    const query = jest.fn((_args: unknown) => Promise.resolve({ ok: true }));

    const interceptor = rlsAllOperations(false);
    await interceptor.call(client, { args: {}, query });

    expect(ctxSpy).not.toHaveBeenCalled();
    expect(client.$executeRaw).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
    jest.restoreAllMocks();
  });
});
