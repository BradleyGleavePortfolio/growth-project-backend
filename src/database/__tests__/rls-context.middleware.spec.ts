/**
 * Unit tests for the A2 request-scoped RLS interceptor
 * (`RlsContextInterceptor` in rls-context.middleware.ts).
 *
 * No database, no Nest container. A fake `ExecutionContext` + `CallHandler`
 * drive `intercept`, and `getRlsContext()` is observed from inside the handler
 * to assert what context (if any) was bound:
 *   - authenticated request  → context bound with { userId, gymIds }
 *   - unauthenticated request → no context bound, handler still runs
 *   - no gym_ids claim        → gymIds = [] (deny-all) and a warn is logged
 *
 * The middleware carries a module-level "warn once per process boot" guard for
 * the missing-`gym_ids` case, so each test re-imports the module under a fresh
 * `jest.resetModules()` (see `beforeEach`) to reset that guard deterministically
 * — no production reset surface area is introduced.
 */
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { of } from "rxjs";
import { firstValueFrom } from "rxjs";
import type { RlsContextInterceptor as RlsContextInterceptorType } from "../rls-context.middleware";
import type { RlsContext } from "../prisma.context";

function makeContext(user: unknown): ExecutionContext {
  const request = { user };
  return {
    switchToHttp: () => ({ getRequest: <T>(): T => request as T }),
  } as unknown as ExecutionContext;
}

/**
 * A CallHandler whose `handle()` captures the RLS context visible at the moment
 * the downstream pipeline runs, so tests can assert what the interceptor bound.
 *
 * @param getRlsContext - the freshly re-imported context reader (must come from
 *   the same module instance as the interceptor under test).
 */
function makeHandler(getRlsContext: () => RlsContext | null): {
  handler: CallHandler;
  seenContext: () => RlsContext | null;
  ran: () => boolean;
} {
  let seen: RlsContext | null = null;
  let invoked = false;
  return {
    seenContext: () => seen,
    ran: () => invoked,
    handler: {
      handle: () => {
        invoked = true;
        seen = getRlsContext();
        return of("ok");
      },
    },
  };
}

describe("RlsContextInterceptor (A2 request-scoped RLS)", () => {
  let interceptor: RlsContextInterceptorType;
  let getRlsContext: () => RlsContext | null;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    // Fresh module registry so the module-level `warnedMissingGymIdsClaim`
    // guard resets per test. The interceptor, the context reader, and the
    // Logger we spy on MUST all come from the same re-imported module graph —
    // resetModules also re-loads @nestjs/common, so a statically imported
    // Logger would carry a *different* prototype than the one the re-required
    // middleware actually calls, and the spy would never fire.
    jest.resetModules();
    const middleware = require("../rls-context.middleware") as typeof import("../rls-context.middleware");
    const context = require("../prisma.context") as typeof import("../prisma.context");
    const nest = require("@nestjs/common") as typeof import("@nestjs/common");
    warnSpy = jest
      .spyOn(nest.Logger.prototype, "warn")
      .mockImplementation(() => undefined);
    interceptor = new middleware.RlsContextInterceptor();
    getRlsContext = context.getRlsContext;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("authenticated request: binds context with the user id and gym_ids claim", async () => {
    const { handler, seenContext, ran } = makeHandler(getRlsContext);
    const ctx = makeContext({ id: "user-1", gym_ids: ["gym-1", "gym-2"] });

    await firstValueFrom(interceptor.intercept(ctx, handler));

    expect(ran()).toBe(true);
    expect(seenContext()).toEqual({
      userId: "user-1",
      gymIds: ["gym-1", "gym-2"],
    });
    // Context is unbound again once the request scope unwinds.
    expect(getRlsContext()).toBeNull();
  });

  it("unauthenticated request: does NOT bind a context, handler still runs", async () => {
    const { handler, seenContext, ran } = makeHandler(getRlsContext);
    const ctx = makeContext(undefined);

    const result = await firstValueFrom(interceptor.intercept(ctx, handler));

    expect(ran()).toBe(true);
    expect(result).toBe("ok");
    // No runWithRlsContext scope was opened — handler saw a null context.
    expect(seenContext()).toBeNull();
  });

  it("no gym_ids claim: fails closed with gymIds = [] (deny-all) and warns", async () => {
    const { handler, seenContext } = makeHandler(getRlsContext);
    const ctx = makeContext({ id: "user-2" });

    await firstValueFrom(interceptor.intercept(ctx, handler));

    expect(seenContext()).toEqual({ userId: "user-2", gymIds: [] });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("user-2");
    expect(warnSpy.mock.calls[0][0]).toContain("deny-all");
  });

  it("missing gym_ids claim warns ONLY once per process boot across repeated requests", async () => {
    // Three+ separate authenticated requests, all missing the gym_ids claim.
    for (const id of ["user-a", "user-b", "user-c", "user-d"]) {
      const { handler, seenContext } = makeHandler(getRlsContext);
      const ctx = makeContext({ id });
      await firstValueFrom(interceptor.intercept(ctx, handler));
      expect(seenContext()).toEqual({ userId: id, gymIds: [] });
    }

    // The module-level guard collapses the flood to a single boot-time warn.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("once per process boot");
  });
});
