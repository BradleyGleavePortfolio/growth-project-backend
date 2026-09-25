// S8-C: real ScoutReconstructService + real generated Prisma client in an independent OS process,
// derived from the accepted test/utils/g2-tq0-worker.cjs (unchanged). The only S8-C delta: the
// owned family registry is built from an explicit fixture source-mapping spec and native rule
// set (parsed through the real S8-A/S8-C parsers) and injected in place of the default registry,
// exactly the seam ScoutReconstructService exposes (`families`). No query result or transaction
// semantic is replaced. Used only by the explicitly guarded live proof test/rls-g2-s8c.spec.ts.
const { join } = require('path');
const { execFileSync } = require('child_process');
const input = JSON.parse(process.env.G2_S8C_WORKER);
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
const Module = require('module');
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  return request === '@prisma/client'
    ? join(input.client, 'index.js')
    : resolveFilename.call(this, request, ...args);
};
const { PrismaClient } = require(input.client);
const { ScoutReconstructService } = require(
  join(input.root, 'src/scout/scout-reconstruct.service'),
);
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
            ...(options.length === 0 && Number.isInteger(input.txTimeout) && input.txTimeout > 0
              ? [{ timeout: input.txTimeout }]
              : options),
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
(async () => {
  let result;
  let failure;
  let families;
  try {
    const prisma = instrument(db);
    const service = new ScoutReconstructService(prisma, analytics);
    if (input.spec !== undefined || input.rules !== undefined) {
      const specs =
        input.spec === undefined ? [] : [parseSourceMappingSpec(input.spec, 'g2-s8c-worker:spec')];
      const rules =
        input.rules === undefined ? [] : [parseNativeRuleSet(input.rules, 'g2-s8c-worker:rules')];
      service.families = buildFamilyRegistry({
        sourceMappers: buildSourceMapperRegistry(specs),
        nativeRules: buildNativeRuleRegistry(rules),
      });
    }
    families = [...service.families.keys()];
    if (input.mapper === 'throw')
      service.families.get(input.family).map = () => {
        throw new Error('fixture private payload');
      };
    result = await service.reconstruct(input.coach, input.intent, input.family);
  } catch (e) {
    failure = {
      status: typeof e.getStatus === 'function' ? e.getStatus() : 500,
      message: typeof e.getStatus === 'function' ? e.message : 'Internal server error',
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
