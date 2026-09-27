// S8-G: real ScoutService + ScoutLifecycleService + ScoutReconstructService + real generated
// Prisma client in an independent OS process. Union of the accepted test/utils/g2-s7l-worker.cjs
// (query log, transaction markers, IPC barriers, lifecycle actions) and test/utils/g2-s8c-worker.cjs
// (candidate head attestation, fixture spec/rules injection into the engine's `families` seam),
// both unchanged at 1c5fbb04. The S8-G deltas: the injected mapper registry is ALSO handed to the
// engine's planner seam (`sourceMappers`), the lifecycle service receives the engine through its
// S8-G constructor seam, and barriers exist for the per-row pass (`after-row`, `before-ledger`).
// Hooks only PAUSE real operations at named barriers; they never replace query results or
// transaction semantics. Used only by the explicitly guarded live proof test/rls-g2-s8g.spec.ts.
//
// input (G2_S8G_WORKER JSON): { root, head, client, url, coach, intent, action, pause?, pauseRow?,
//   txTimeout?, deadlineMs?, body?, spec?, rules?, mapper?, family? }
// action ∈ start | ingest | complete | cancel | fence | settled | status | reconstruct | run-pass
// pause  ∈ before-gate (inside a transaction, before the §3.1 gate UPDATE)
//        | gated (gate UPDATE returned; row lock held; before the transaction's own rows)
//        | before-ledger (before the first ledger upsert of a per-row transaction)
//        | after-row (after the `pauseRow`-th COMMITTED gated per-row transaction of the pass)
//        | before-lock | locked (around the lifecycle FOR NO KEY UPDATE)
const { join } = require('path');
const { execFileSync } = require('child_process');
const input = JSON.parse(process.env.G2_S8G_WORKER);
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
if (Number.isInteger(input.deadlineMs) && input.deadlineMs > 0) {
  process.env.SCOUT_RUN_DEADLINE_MS = String(input.deadlineMs);
}
// G12 spies: count any load of a side-effect module from this process (never replaces a module).
const sideEffectLoads = { notifications: 0, drip: 0, assignment: 0, email: 0, billing: 0 };
const origLoad = Module._load;
Module._load = function (request, ...args) {
  const text = String(request);
  for (const k of Object.keys(sideEffectLoads)) {
    if (text.includes(`/${k}/`) || text.endsWith(`.${k}.service`)) sideEffectLoads[k] += 1;
  }
  return origLoad.call(this, request, ...args);
};

const { PrismaClient } = require(input.client);
const { ScoutService } = require(join(input.root, 'src/scout/scout.service'));
const { ScoutIngestService } = require(join(input.root, 'src/scout/scout-ingest.service'));
const { ScoutLifecycleService } = require(
  join(input.root, 'src/scout/lifecycle/lifecycle.service'),
);
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
// Startup loads are the accepted import graph (ScoutService already depends on notifications);
// the proof counts only what the ACTION loads lazily from here on.
for (const k of Object.keys(sideEffectLoads)) sideEffectLoads[k] = 0;

const db = new PrismaClient({
  datasources: { db: { url: input.url } },
  log: [{ emit: 'event', level: 'query' }],
});
const queries = [];
const events = [];
db.$on('query', (e) => queries.push(e.query)); // Never log query parameters.
const analytics = { capture: (...args) => events.push(args) };
let pushes = 0;
const notifications = {
  pushToUser: async () => {
    pushes += 1;
  },
};

let paused = false;
let committedRows = 0;
async function barrier(phase) {
  if (input.pause !== phase || paused) return;
  paused = true;
  process.send({ ready: phase });
  await new Promise((resolve) => process.once('message', resolve));
}
const isGate = (strings) =>
  Array.isArray(strings) && strings.join('?').includes('last_observed_at');
const isLock = (strings) =>
  Array.isArray(strings) && strings.join('?').includes('FOR NO KEY UPDATE');

// `onGate` is the enclosing transaction's "this transaction issued the §3.1 gate" flag setter
// (null at the top level). Interactive transactions leave fixture markers
// (`-- tx:begin|commit|rollback`) in the query log so a proof can assert statement ORDER across
// transaction boundaries; the FIXTURE-ONLY `txTimeout` widens this process's interactive
// transaction ceiling so a paused writer can hold its row lock deterministically.
function instrument(target, onGate = null) {
  return new Proxy(target, {
    get(object, key) {
      if (key === '$transaction')
        return async (fn, ...options) => {
          if (typeof fn !== 'function') return object.$transaction(fn, ...options);
          queries.push('-- tx:begin');
          let sawGate = false;
          try {
            const out = await object.$transaction(
              (tx) =>
                fn(
                  instrument(tx, () => {
                    sawGate = true;
                  }),
                ),
              ...(options.length === 0 && Number.isInteger(input.txTimeout) && input.txTimeout > 0
                ? [{ timeout: input.txTimeout }]
                : options),
            );
            queries.push('-- tx:commit');
            if (sawGate) {
              committedRows += 1;
              if (input.pause === 'after-row' && committedRows === (input.pauseRow ?? 1)) {
                await barrier('after-row');
              }
            }
            return out;
          } catch (e) {
            queries.push('-- tx:rollback');
            throw e;
          }
        };
      if (key === '$queryRaw')
        return async (strings, ...values) => {
          if (isGate(strings)) await barrier('before-gate');
          if (isLock(strings)) await barrier('before-lock');
          const result = await object.$queryRaw(strings, ...values);
          if (isGate(strings)) {
            if (onGate) onGate();
            await barrier('gated');
          }
          if (isLock(strings)) await barrier('locked');
          return result;
        };
      if (key === 'scoutReconstructionLedger') {
        const delegate = object[key];
        return new Proxy(delegate, {
          get(model, method) {
            if (method === 'upsert')
              return async (...args) => {
                await barrier('before-ledger');
                return model.upsert(...args);
              };
            return typeof model[method] === 'function' ? model[method].bind(model) : model[method];
          },
        });
      }
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
    const reconstruct = new ScoutReconstructService(prisma, analytics);
    if (input.spec !== undefined || input.rules !== undefined) {
      const specs =
        input.spec === undefined ? [] : [parseSourceMappingSpec(input.spec, 'g2-s8g-worker:spec')];
      const rules =
        input.rules === undefined ? [] : [parseNativeRuleSet(input.rules, 'g2-s8g-worker:rules')];
      const sourceMappers = buildSourceMapperRegistry(specs);
      reconstruct.families = buildFamilyRegistry({
        sourceMappers,
        nativeRules: buildNativeRuleRegistry(rules),
      });
      // The planner resolves staged tokens through the SAME mapper registry the families use.
      reconstruct.sourceMappers = sourceMappers;
    }
    families = [...reconstruct.families.keys()];
    if (input.mapper === 'throw')
      reconstruct.families.get(input.family).map = () => {
        throw new Error('fixture private payload');
      };
    const lifecycle = new ScoutLifecycleService(prisma, analytics, reconstruct);
    const scout = new ScoutService(prisma, notifications, analytics, lifecycle);
    const body = input.body ?? {};
    switch (input.action) {
      case 'start':
        result = await lifecycle.start(input.coach, input.intent);
        break;
      case 'cancel':
        result = await lifecycle.cancel(input.coach, input.intent);
        break;
      case 'fence':
        result = await lifecycle.fence(input.coach, input.intent, body.reason ?? 'revoked');
        break;
      case 'settled':
        result = await lifecycle.onTransferSettled(input.coach, input.intent, body.epoch ?? 1);
        break;
      case 'ingest':
        result = await new ScoutIngestService(prisma, analytics, lifecycle).ingest(input.coach, {
          intent_id: input.intent,
          entity_type: body.entity_type ?? 'people',
          entities: (body.entities ?? [{ sourceId: 'a', payload: { name: 'Synthetic a' } }]).map(
            (e) => ({
              sourceId: e.sourceId,
              sourcePlatform: body.sourcePlatform ?? 's8g-proof',
              capturedAt: '2026-09-25T00:00:00.000Z',
              payload: e.payload,
            }),
          ),
        });
        break;
      case 'complete':
        result = await scout.complete(input.coach, {
          intent_id: input.intent,
          terminal_status: body.terminal_status ?? 'success',
          final_counts: body.final_counts,
          error_summary: body.error_summary,
        });
        break;
      case 'status':
        result = await scout.getImportStatus(input.coach, input.intent);
        break;
      case 'reconstruct':
        result = await reconstruct.reconstruct(input.coach, input.intent, input.family);
        break;
      case 'run-pass':
        result = await reconstruct.reconstructRun(input.coach, input.intent, {
          mode: 'server',
          epoch: body.epoch ?? 1,
          gate: (tx) => lifecycle.assertRunOpen(tx, input.coach, input.intent),
        });
        break;
      default:
        throw new Error(`unknown action ${input.action}`);
    }
  } catch (e) {
    failure = {
      status: typeof e.getStatus === 'function' ? e.getStatus() : 500,
      // Emulate Nest's public boundary for unexpected DB failures.
      message: typeof e.getStatus === 'function' ? e.message : 'Internal server error',
      response: typeof e.getResponse === 'function' ? e.getResponse() : undefined,
      code: e.code,
    };
  } finally {
    await db.$disconnect();
  }
  // process.send is asynchronous: disconnect only from the send callback so the final message
  // is never lost on the parent side.
  process.send(
    {
      done: true,
      result,
      failure,
      queries,
      events,
      pushes,
      sideEffectLoads,
      families,
      pid: process.pid,
    },
    () => process.disconnect(),
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
