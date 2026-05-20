import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { NestContainer } from '@nestjs/core';
import { MODULE_METADATA } from '@nestjs/common/constants';
import type { DynamicModule, ForwardReference, Type } from '@nestjs/common';
import { AppModule } from '../src/app.module';

/**
 * Module dependency-graph cycle guard.
 *
 * Compiles AppModule via @nestjs/testing (which exercises the same scanner
 * that crashes at boot when a real cycle exists), then walks every module
 * declared in the container and reconstructs the *author-written* import
 * graph from `Reflect.getMetadata(MODULE_METADATA.IMPORTS, ...)`. A
 * directed-DFS cycle search runs over that graph and the build fails if
 * any cycle exists, with the single explicitly-documented exception of
 * the AdminModule ↔ CoachModule pair resolved via `forwardRef()` on both
 * sides.
 *
 * ## Why we don't walk `container.getModules()` directly
 *
 * Nest's internal `Module.imports` Set is NOT the metadata the developer
 * wrote in `@Module({ imports: [...] })`. After scanning, the container
 * runs `bindGlobalsToImports(moduleRef)` which injects every `@Global()`
 * module into every other module's `.imports`. That makes the runtime
 * graph dense and almost entirely cyclic — globals naturally form
 * everyone-points-at-everyone star edges. Walking that graph would
 * report 300+ "cycles" that don't represent author-intentional
 * dependencies and would never have surfaced in #243.
 *
 * Reading the original metadata via `Reflect.getMetadata` recovers the
 * exact set of imports the developer wrote — which is what we want to
 * cycle-check.
 *
 * The container compilation step is still load-bearing: it asserts the
 * graph actually boots (Test.createTestingModule throws
 * UndefinedModuleException for a hard cycle just like the prod boot did),
 * and it ensures dynamic modules registered via .forRoot() / forRootAsync()
 * are discoverable in the modules map.
 *
 * ## Why this test exists
 *
 * Hotfix #243 (prod-down, 2026-05-20) traced a boot-time
 * `UndefinedModuleException` to two new module cycles introduced by the
 * Phase 2 hybrid-coach-pricing PR:
 *
 *   Cycle 1: AuthModule → InviteCodesModule → BillingModule
 *            → CheckoutModule → AuthModule
 *   Cycle 2: CheckoutModule → PackagesModule → BillingModule
 *            → CheckoutModule
 *
 * Both compiled and tested cleanly because no test exercised
 * `AppModule.compile()`. This test exists so a future re-introduction
 * fails CI loudly and prints the cycle path for instant diagnosis.
 *
 * ## Allowed cycles
 *
 * `KNOWN_FORWARDREF_CYCLES` is the curated allow-list of edge pairs that
 * are intentionally cyclical and resolved via `forwardRef()` at the
 * import sites. Adding a new entry requires:
 *
 *   1. `forwardRef(() => OtherModule)` applied on both sides of the
 *      import edge
 *   2. A code comment at each import site explaining why the cycle is
 *      necessary and what was tried instead
 *   3. An explicit entry below, with a description of the cycle
 *
 * Bar is high on purpose — every forwardRef is a load-bearing affordance
 * that future maintainers will inherit, and the value of this test is
 * cut in half for every cycle on the allow-list. Keeping the list short
 * is the whole point of SecurityGuardsModule.
 */

// Each entry is an unordered pair of module names that form a 2-cycle
// resolved via forwardRef() on both sides. Pair is normalized
// alphabetically so lookup is order-independent.
const KNOWN_FORWARDREF_CYCLES: ReadonlyArray<readonly [string, string]> = [
  // AdminPtmService (admin/ptm) is consumed by coach-scoped risk-board
  // surfaces in CoachModule; CoachOnboardingService + CoachAlertsService
  // (CoachModule) are consumed by AdminModule. Both sides forwardRef()
  // each other at their imports. See src/admin/admin.module.ts L52-58
  // and src/coach/coach.module.ts L38-43 for the justification.
  ['AdminModule', 'CoachModule'],
];

type ModuleLike =
  | Type<unknown>
  | DynamicModule
  | ForwardReference<unknown>
  | Promise<DynamicModule>;

function normalizePair(a: string, b: string): readonly [string, string] {
  return a < b ? [a, b] : [b, a];
}

function isKnownForwardRefCycle(cycle: readonly string[]): boolean {
  // A 2-cycle is rendered as `[A, B, A]`. Reject anything longer — longer
  // cycles are not forwardRef'd intentionally, they are bugs.
  if (cycle.length !== 3) return false;
  if (cycle[0] !== cycle[2]) return false;
  const pair = normalizePair(cycle[0], cycle[1]);
  return KNOWN_FORWARDREF_CYCLES.some(
    ([x, y]) => x === pair[0] && y === pair[1],
  );
}

/**
 * Resolve a value found inside an `@Module({ imports: [...] })` array to
 * its underlying module class. Handles:
 *   - Plain class:       `MyModule`              → MyModule
 *   - DynamicModule:     `MyModule.forRoot(...)` → { module: MyModule, ... } → MyModule
 *   - ForwardReference:  `forwardRef(() => M)`   → calls .forwardRef() → M
 *
 * Returns `null` for values we cannot statically resolve to a class
 * (typically a Promise from forRootAsync — those are dynamic-only and
 * the container is the authoritative source for them, but they are
 * extremely rare in this codebase: ConfigModule and ThrottlerModule
 * use forRoot/forRootAsync but neither participates in feature-module
 * cycles).
 */
function resolveImport(entry: ModuleLike | undefined | null): Type<unknown> | null {
  if (!entry) return null;
  // ForwardReference: { forwardRef: () => T }
  if (typeof (entry as ForwardReference).forwardRef === 'function') {
    const resolved = (entry as ForwardReference).forwardRef();
    return resolveImport(resolved as ModuleLike);
  }
  // DynamicModule: { module: Type, imports?, providers?, ... }
  if (typeof entry === 'object' && 'module' in entry) {
    return (entry as DynamicModule).module;
  }
  // Plain class
  if (typeof entry === 'function') {
    return entry as Type<unknown>;
  }
  return null;
}

/**
 * Build the author-written import graph by reading
 * Reflect.getMetadata('imports', ModuleClass) for every module reachable
 * from the supplied roots.
 */
function buildAuthoredImportGraph(
  roots: ReadonlyArray<Type<unknown>>,
): {
  nodes: string[];
  edges: Map<string, Set<string>>;
} {
  const edges = new Map<string, Set<string>>();
  const seen = new Set<Type<unknown>>();
  const queue: Type<unknown>[] = [...roots];

  while (queue.length > 0) {
    const mod = queue.shift()!;
    if (seen.has(mod)) continue;
    seen.add(mod);

    const fromName = mod.name;
    const out = new Set<string>();

    const raw = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, mod) ?? []) as ModuleLike[];
    for (const entry of raw) {
      const target = resolveImport(entry);
      if (!target) continue;
      out.add(target.name);
      if (!seen.has(target)) queue.push(target);
    }

    edges.set(fromName, out);
  }

  return { nodes: Array.from(edges.keys()), edges };
}

/**
 * DFS that records every directed cycle reachable from the supplied
 * roots. Cycles are returned as `['A', 'B', 'C', 'A']` arrays.
 *
 * Cycles are deduped by canonicalizing each cycle's rotation to put the
 * lexicographically-smallest node first, so `[A,B,C,A]` and `[B,C,A,B]`
 * collapse into one entry.
 */
function findAllCycles(
  nodes: ReadonlyArray<string>,
  edges: ReadonlyMap<string, ReadonlySet<string>>,
): string[][] {
  const cycles: string[][] = [];
  const seenCycleSignatures = new Set<string>();
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const stack: string[] = [];

  function recordCycle(startIndex: number, closingNode: string) {
    const cycle = stack.slice(startIndex).concat(closingNode);
    const ring = cycle.slice(0, -1);
    let pivot = 0;
    for (let i = 1; i < ring.length; i++) {
      if (ring[i] < ring[pivot]) pivot = i;
    }
    const rotated = ring.slice(pivot).concat(ring.slice(0, pivot));
    rotated.push(rotated[0]);
    const signature = rotated.join('→');
    if (seenCycleSignatures.has(signature)) return;
    seenCycleSignatures.add(signature);
    cycles.push(rotated);
  }

  function dfs(node: string) {
    visited.add(node);
    onStack.add(node);
    stack.push(node);

    const outgoing = edges.get(node) ?? new Set<string>();
    for (const next of outgoing) {
      if (onStack.has(next)) {
        const idx = stack.indexOf(next);
        if (idx !== -1) recordCycle(idx, next);
      } else if (!visited.has(next)) {
        dfs(next);
      }
    }

    onStack.delete(node);
    stack.pop();
  }

  for (const node of nodes) {
    if (!visited.has(node)) dfs(node);
  }

  return cycles;
}

describe('AppModule dependency graph', () => {
  jest.setTimeout(30000);

  let containerModuleCount = 0;
  let nodes: string[] = [];
  let edges: Map<string, Set<string>> = new Map();

  beforeAll(async () => {
    // Step 1: compile AppModule end-to-end. This is the same code path
    // that crashed in production with UndefinedModuleException. If a
    // hard cycle is reintroduced and Nest can no longer wire the graph,
    // this line throws and the test fails before any DFS runs.
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    // Step 2: read the runtime container so we can assert that the
    // scanner discovered a reasonable number of modules. Dense `<20`
    // would imply a regression that ate the import tree.
    const container = (moduleRef as unknown as { container: NestContainer })
      .container;
    containerModuleCount = container.getModules().size;

    // Step 3: build the author-written import graph from
    // @Module() metadata, so global modules' implicit broadcast edges
    // don't pollute the cycle search.
    const graph = buildAuthoredImportGraph([AppModule]);
    nodes = graph.nodes;
    edges = graph.edges;

    await moduleRef.close();
  });

  it('compiles AppModule without throwing UndefinedModuleException', () => {
    // beforeAll did not throw → the live container booted. The 20-module
    // threshold is sanity; the real codebase declares ~70 feature modules.
    expect(containerModuleCount).toBeGreaterThan(20);
    expect(nodes.length).toBeGreaterThan(20);
  });

  it('has no unexpected directed import cycles', () => {
    const allCycles = findAllCycles(nodes, edges);

    const disallowed: string[][] = [];
    const allowedSeen = new Set<string>();

    for (const cycle of allCycles) {
      if (isKnownForwardRefCycle(cycle)) {
        const pair = normalizePair(cycle[0], cycle[1]).join('↔');
        allowedSeen.add(pair);
      } else {
        disallowed.push(cycle);
      }
    }

    if (disallowed.length > 0) {
      const rendered = disallowed
        .map((c, i) => `  [${i + 1}] ${c.join(' → ')}`)
        .join('\n');
      throw new Error(
        [
          `Found ${disallowed.length} disallowed module dependency cycle(s).`,
          '',
          'This is the same class of bug that crashed production in hotfix #243.',
          'Either:',
          '  (a) break the cycle by moving the offending guard or service',
          '      into SecurityGuardsModule (or another @Global module that',
          '      has no feature-module imports), or',
          '  (b) if the cycle is genuinely unavoidable, wrap BOTH import',
          '      sites with forwardRef() and add the pair to',
          '      KNOWN_FORWARDREF_CYCLES in test/module-graph.spec.ts with',
          '      a justification comment at each import site.',
          '',
          'Cycles:',
          rendered,
        ].join('\n'),
      );
    }

    // If a documented forwardRef cycle has been silently broken, surface
    // it so the now-stale justification comment can be removed.
    const expectedPairs = new Set(
      KNOWN_FORWARDREF_CYCLES.map(([a, b]) => `${a}↔${b}`),
    );
    const unexpectedlyMissing: string[] = [];
    for (const pair of expectedPairs) {
      if (!allowedSeen.has(pair)) unexpectedlyMissing.push(pair);
    }
    expect(unexpectedlyMissing).toEqual([]);
  });
});
