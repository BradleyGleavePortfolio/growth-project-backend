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
 */
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { Logger } from "@nestjs/common";
import { of } from "rxjs";
import { firstValueFrom } from "rxjs";
import { RlsContextInterceptor } from "../rls-context.middleware";
import { getRlsContext, type RlsContext } from "../prisma.context";

function makeContext(user: unknown): ExecutionContext {
  const request = { user };
  return {
    switchToHttp: () => ({ getRequest: <T>(): T => request as T }),
  } as unknown as ExecutionContext;
}

/**
 * A CallHandler whose `handle()` captures the RLS context visible at the moment
 * the downstream pipeline runs, so tests can assert what the interceptor bound.
 */
function makeHandler(): {
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
  let interceptor: RlsContextInterceptor;

  beforeEach(() => {
    interceptor = new RlsContextInterceptor();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("authenticated request: binds context with the user id and gym_ids claim", async () => {
    const { handler, seenContext, ran } = makeHandler();
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
    const { handler, seenContext, ran } = makeHandler();
    const ctx = makeContext(undefined);

    const result = await firstValueFrom(interceptor.intercept(ctx, handler));

    expect(ran()).toBe(true);
    expect(result).toBe("ok");
    // No runWithRlsContext scope was opened — handler saw a null context.
    expect(seenContext()).toBeNull();
  });

  it("no gym_ids claim: fails closed with gymIds = [] (deny-all) and warns", async () => {
    const warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { handler, seenContext } = makeHandler();
    const ctx = makeContext({ id: "user-2" });

    await firstValueFrom(interceptor.intercept(ctx, handler));

    expect(seenContext()).toEqual({ userId: "user-2", gymIds: [] });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("user-2");
    expect(warnSpy.mock.calls[0][0]).toContain("deny-all");
  });
});
