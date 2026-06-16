/**
 * Unit tests for the A2 AsyncLocalStorage RLS context store
 * (`runWithRlsContext` + `getRlsContext`).
 *
 * No database. These pin the request-scoping contract the rest of Wave 1.5
 * depends on:
 *   - `getRlsContext()` is `null` outside any `runWithRlsContext` scope
 *   - inside a scope it returns the bound context
 *   - nested scopes shadow the parent (inner wins), parent restored on unwind
 *   - the context survives `await` boundaries (async propagation)
 *   - concurrent `Promise.all` scopes stay isolated (no cross-pollination)
 */
import { getRlsContext, runWithRlsContext, type RlsContext } from "../prisma.context";

const ctxA: RlsContext = { userId: "user-a", gymIds: ["gym-1"] };
const ctxB: RlsContext = { userId: "user-b", gymIds: ["gym-2", "gym-3"] };

describe("getRlsContext / runWithRlsContext (A2 AsyncLocalStorage)", () => {
  it("returns null outside any runWithRlsContext scope", () => {
    expect(getRlsContext()).toBeNull();
  });

  it("returns the bound context inside a runWithRlsContext scope", () => {
    const seen = runWithRlsContext(ctxA, () => getRlsContext());
    expect(seen).toBe(ctxA);
  });

  it("clears the context again after the scope unwinds", () => {
    runWithRlsContext(ctxA, () => {
      expect(getRlsContext()).toBe(ctxA);
    });
    expect(getRlsContext()).toBeNull();
  });

  it("nested scopes shadow the parent (inner wins) then restore it", () => {
    runWithRlsContext(ctxA, () => {
      expect(getRlsContext()).toBe(ctxA);
      runWithRlsContext(ctxB, () => {
        expect(getRlsContext()).toBe(ctxB);
      });
      // Parent context restored once the inner scope unwinds.
      expect(getRlsContext()).toBe(ctxA);
    });
  });

  it("propagates the context across await boundaries", async () => {
    const result = await runWithRlsContext(ctxA, async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 1));
      // Still bound after multiple async hops.
      return getRlsContext();
    });
    expect(result).toBe(ctxA);
  });

  it("keeps parallel Promise.all scopes isolated (no cross-pollination)", async () => {
    const probe = (ctx: RlsContext): Promise<RlsContext | null> =>
      Promise.resolve(
        runWithRlsContext(ctx, async () => {
          // Yield so the two scopes are genuinely interleaved on the event loop.
          await new Promise((resolve) => setTimeout(resolve, 1));
          return getRlsContext();
        }),
      );

    const [seenA, seenB] = await Promise.all([probe(ctxA), probe(ctxB)]);

    expect(seenA).toBe(ctxA);
    expect(seenB).toBe(ctxB);
    // And the outer scope is still clean afterwards.
    expect(getRlsContext()).toBeNull();
  });
});
