// S10-B: real ObservationController + ObservationService + ScoutLifecycleService +
// ScoutIngestService + ScoutService + real generated Prisma client in an independent OS process.
// Derived by substitution from the S9-C worker test/utils/g2-s9c-worker.cjs (d3a9-s9c-r2,
// read-only): same candidate binding, same @prisma/client redirection, same side-effect module
// spies, same Proxy instrument with named barriers and transaction markers. The S10-B deltas: the
// S8-C/S9-C registry injection (spec/rules/facts) is replaced by the synthetic INDUCTION registry
// injected through the ObservationService options seam, the lifecycle is constructed with the
// base (pre-S9-C) three-parameter signature, and the actions are the two S10 routes. Hooks only
// PAUSE real operations at named barriers or THROW an injected failure at a named insert; they
// never replace query results or transaction semantics. Used only by the explicitly guarded live
// proof test/rls-g2-s10b.spec.ts.
// input (G2_S10B_WORKER JSON): { root, head, client, url, coach, intent, action, pause?,
//   txTimeout?, deadlineMs?, body?, registry?, failAfter?, rawBytes? }
// action ∈ declare | observe | start | ingest | complete | cancel | fence | status
// pause  ∈ before-lock | locked (around the S10-B / lifecycle FOR NO KEY UPDATE)
//        | before-gate | gated (around the §3.1 gate UPDATE of an ingest)
// failAfter: { model: 'scoutRunDeclaration'|'scoutRunObservation', n } — the (n+1)-th create
//   inside a transaction throws (the mid-insert failure of R32).
const { join } = require('path');
const { execFileSync } = require('child_process');
const input = JSON.parse(process.env.G2_S10B_WORKER);
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
const { ObservationService } = require(join(input.root, 'src/scout/induction/observation.service'));
const { ObservationController } = require(
  join(input.root, 'src/scout/induction/observation.controller'),
);
const { rawEvidence, syntheticRegistry } = require(join(input.root, 'test/utils/g2-s10b-fixtures'));
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

// Interactive transactions leave fixture markers (`-- tx:begin|commit|rollback`) in the query log
// so a proof can assert statement ORDER across transaction boundaries; the FIXTURE-ONLY
// `txTimeout` widens this process's interactive transaction ceiling so a paused writer can hold
// its row lock deterministically. `inTx` scopes the injected create failure to one transaction.
function instrument(target, inTx = false) {
  let creates = 0;
  return new Proxy(target, {
    get(object, key) {
      if (key === '$transaction')
        return async (fn, ...options) => {
          if (typeof fn !== 'function') return object.$transaction(fn, ...options);
          queries.push('-- tx:begin');
          try {
            const out = await object.$transaction(
              (tx) => fn(instrument(tx, true)),
              ...(options.length === 0 && Number.isInteger(input.txTimeout) && input.txTimeout > 0
                ? [{ timeout: input.txTimeout }]
                : options),
            );
            queries.push('-- tx:commit');
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
          if (isGate(strings)) await barrier('gated');
          if (isLock(strings)) await barrier('locked');
          return result;
        };
      if (inTx && input.failAfter && key === input.failAfter.model) {
        const delegate = object[key];
        return new Proxy(delegate, {
          get(model, method) {
            if (method === 'create')
              return async (...args) => {
                if (creates >= input.failAfter.n)
                  throw new Error('fixture injected insert failure');
                creates += 1;
                return model.create(...args);
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
  try {
    const prisma = instrument(db);
    const lifecycle = new ScoutLifecycleService(prisma, analytics);
    const observations = new ObservationService(prisma, lifecycle, {
      registry: syntheticRegistry(input.registry ?? {}),
    });
    const controller = new ObservationController(observations);
    const scout = new ScoutService(prisma, notifications, analytics, lifecycle);
    const body = input.body ?? {};
    const req = (raw) => ({ user: { id: input.coach }, rawBody: raw });
    switch (input.action) {
      case 'declare': {
        const dto = { intent_id: input.intent, platforms: body.platforms ?? [] };
        result = await controller.postDeclaration(req(), dto);
        break;
      }
      case 'observe': {
        // body.evidence: synthetic EvidenceSpec list (challengeHex → the statement challenge).
        const items = (body.evidence ?? [{}]).map((spec) =>
          rawEvidence({
            ...spec,
            challenge: spec.challengeHex ? Buffer.from(spec.challengeHex, 'hex') : undefined,
          }),
        );
        const dto = { intent_id: input.intent, observations: items };
        const raw = Buffer.from(JSON.stringify(dto), 'utf8');
        const padded =
          Number.isInteger(input.rawBytes) && input.rawBytes > raw.length
            ? Buffer.concat([raw, Buffer.alloc(input.rawBytes - raw.length, 0x20)])
            : raw;
        result = await controller.postObservation(req(padded), dto);
        break;
      }
      case 'start':
        result = await lifecycle.start(input.coach, input.intent);
        break;
      case 'cancel':
        result = await lifecycle.cancel(input.coach, input.intent);
        break;
      case 'fence':
        result = await lifecycle.fence(input.coach, input.intent, body.reason ?? 'revoked');
        break;
      case 'ingest':
        result = await new ScoutIngestService(prisma, analytics, lifecycle).ingest(input.coach, {
          intent_id: input.intent,
          entity_type: body.entity_type ?? 'clients',
          entities: (body.entities ?? [{ sourceId: 'a', payload: { name: 'Synthetic a' } }]).map(
            (e) => ({
              sourceId: e.sourceId,
              sourcePlatform: body.sourcePlatform ?? 'synthetic-src-a',
              capturedAt: '2026-09-26T00:00:00.000Z',
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
      injected: e instanceof Error && e.message === 'fixture injected insert failure',
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
      pid: process.pid,
    },
    () => process.disconnect(),
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
