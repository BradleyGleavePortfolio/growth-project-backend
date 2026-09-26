// S9-B: real ReconciliationFactsService (+ the frozen S9-A `reconcile`) and, to produce genuine
// rows, the real ScoutReconstructService, each with the real generated Prisma client in an
// independent OS process. Derived from the accepted test/utils/g2-s8c-worker.cjs (unchanged).
// The S9-B deltas: `mode: 'facts'` (default) builds the facts registries from the explicit fixture
// source-mapping spec(s) + native rule set(s) (parsed through the real S8-A/S8-C parsers) and
// injects them through the service's `RECONCILIATION_FACTS_OPTIONS` seam, then runs
// `collect(tx, coach, intent)` inside ONE `RepeatableRead` interactive transaction (the isolation
// the transaction actually runs at is read back from PostgreSQL itself, so the proof does not
// depend on Prisma's log wording) and feeds the facts to `reconcile`; `mode: 'reconstruct'` is
// the S8-C writer exactly as g2-s8c-worker.cjs drives it. No query result or transaction semantic
// is replaced. Used only by the explicitly guarded live proof test/rls-g2-s9.spec.ts.
const { join } = require('path');
const { execFileSync } = require('child_process');
const input = JSON.parse(process.env.G2_S9_WORKER);
// Candidate binding: the worker loads source from input.root, so that root must be at the attested
// head the harness was bound to; a mismatch is a hard failure before any client is constructed.
const workerHead = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: input.root,
  encoding: 'utf8',
}).trim();
if (workerHead !== input.head) {
  throw new Error(
    `worker root ${input.root} is at ${workerHead}, not the attested candidate ${input.head}`,
  );
}
const mode = input.mode === undefined ? 'facts' : input.mode;
if (mode !== 'facts' && mode !== 'reconstruct') {
  throw new Error(`g2-s9-worker: unknown mode ${String(mode)} (facts | reconstruct)`);
}
const Module = require('module');
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  return request === '@prisma/client'
    ? join(input.client, 'index.js')
    : resolveFilename.call(this, request, ...args);
};
const { PrismaClient } = require(input.client);
const { buildFamilyRegistry } = require(join(input.root, 'src/scout/reconstruct/families'));
const { parseSourceMappingSpec } = require(join(input.root, 'src/scout/reconstruct/mapping-spec'));
const { buildSourceMapperRegistry } = require(
  join(input.root, 'src/scout/reconstruct/source-mapper-registry'),
);
const { parseNativeRuleSet } = require(
  join(input.root, 'src/scout/reconstruct/native/native-rules'),
);
const { buildNativeRuleRegistry } = require(
  join(input.root, 'src/scout/reconstruct/native/native-rule-registry'),
);
const db = new PrismaClient({
  datasources: { db: { url: input.url } },
  log: [{ emit: 'event', level: 'query' }],
});
const queries = [];
const events = [];
db.$on('query', (e) => queries.push(e.query)); // Never log query parameters.
const analytics = { capture: (...args) => events.push(args) };
// `spec` / `rules` accept one raw document or an array (several fixture platforms in one run).
const asList = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const injected = input.spec !== undefined || input.rules !== undefined;
const specs = asList(input.spec).map((raw, n) =>
  parseSourceMappingSpec(raw, `g2-s9-worker:spec[${n}]`),
);
const ruleSets = asList(input.rules).map((raw, n) =>
  parseNativeRuleSet(raw, `g2-s9-worker:rules[${n}]`),
);
const txOptions =
  Number.isInteger(input.txTimeout) && input.txTimeout > 0 ? { timeout: input.txTimeout } : {};
let paused = false;
async function barrier(phase) {
  if (input.pause !== phase || paused) return;
  paused = true;
  process.send({ ready: phase });
  await new Promise((resolve) => process.once('message', resolve));
}
function instrument(target) {
  return new Proxy(target, {
    get(object, key) {
      if (key === '$transaction')
        return (fn, ...options) =>
          object.$transaction(
            (tx) => fn(instrument(tx)),
            ...(options.length === 0 && txOptions.timeout !== undefined ? [txOptions] : options),
          );
      // Pause after the native target INSERT and before its provenance/ledger rows: proves that a
      // concurrent identical run converges on ONE target (the paused transaction either commits
      // first or loses the identity race and rolls its target back with the whole transaction).
      if (key === 'workoutPlan' || key === 'workoutProgram')
        return new Proxy(object[key], {
          get(delegate, method) {
            if (method === 'create')
              return async (...args) => {
                const result = await delegate.create(...args);
                await barrier('after-target');
                return result;
              };
            return typeof delegate[method] === 'function'
              ? delegate[method].bind(delegate)
              : delegate[method];
          },
        });
      if (key === 'scoutReconstructionLedger')
        return new Proxy(object[key], {
          get(delegate, method) {
            if (method === 'upsert')
              return async (...args) => {
                await barrier('before-ledger');
                return delegate.upsert(...args);
              };
            return typeof delegate[method] === 'function'
              ? delegate[method].bind(delegate)
              : delegate[method];
          },
        });
      return typeof object[key] === 'function' ? object[key].bind(object) : object[key];
    },
  });
}
async function reconstruct() {
  const { ScoutReconstructService } = require(
    join(input.root, 'src/scout/scout-reconstruct.service'),
  );
  const prisma = instrument(db);
  const service = new ScoutReconstructService(prisma, analytics);
  if (injected) {
    service.families = buildFamilyRegistry({
      sourceMappers: buildSourceMapperRegistry(specs),
      nativeRules: buildNativeRuleRegistry(ruleSets),
    });
  }
  const families = [...service.families.keys()];
  if (input.mapper === 'throw')
    service.families.get(input.family).map = () => {
      throw new Error('fixture private payload');
    };
  const result = await service.reconstruct(input.coach, input.intent, input.family);
  return { result, families };
}
async function facts() {
  const { ReconciliationFactsService } = require(
    join(input.root, 'src/scout/reconciliation/facts.service'),
  );
  const { reconcile } = require(join(input.root, 'src/scout/reconciliation/reconcile'));
  const options = injected
    ? {
        sourceMappers: buildSourceMapperRegistry(specs),
        nativeRules: buildNativeRuleRegistry(ruleSets),
      }
    : {};
  const service = new ReconciliationFactsService(options);
  // One interactive transaction at REPEATABLE READ (Addendum A C-9: the caller sets the
  // isolation; the service only reads). The level PostgreSQL reports for THIS transaction is
  // returned alongside the facts so the spec asserts the snapshot guarantee from the server, not
  // from the client's log wording.
  const collected = await db.$transaction(
    async (tx) => {
      const probe = await tx.$queryRaw`SELECT current_setting('transaction_isolation') AS level`;
      const collectedFacts = await service.collect(tx, input.coach, input.intent);
      return { isolation: probe[0].level, facts: collectedFacts };
    },
    { isolationLevel: 'RepeatableRead', ...txOptions },
  );
  const reconciled = reconcile(collected.facts);
  return {
    result: {
      isolation: collected.isolation,
      facts: collected.facts,
      verdict: reconciled.verdict,
      report: reconciled.report,
    },
    families: injected ? specs.map((spec) => spec.sourcePlatform) : undefined,
  };
}
(async () => {
  let result;
  let failure;
  let families;
  try {
    const outcome = mode === 'reconstruct' ? await reconstruct() : await facts();
    result = outcome.result;
    families = outcome.families;
  } catch (e) {
    // Facts mode reads only and never sees a payload, so its error text is safe to surface.
    failure = {
      status: typeof e.getStatus === 'function' ? e.getStatus() : 500,
      message:
        typeof e.getStatus === 'function' || mode === 'facts' ? e.message : 'Internal server error',
      code: e.code,
    };
  } finally {
    await db.$disconnect();
  }
  process.send({ done: true, result, failure, queries, events, pid: process.pid, families }, () =>
    process.disconnect(),
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
