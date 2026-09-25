// S7-L: real lifecycle services + real generated Prisma client in an independent OS process.
// Pattern from the committed test/utils/g2-tq0-worker.cjs (module binding, query log, IPC
// barriers); the drivers here are the S7-L writers and readers. Hooks only PAUSE actual
// operations at named barriers; they never replace query results or transaction semantics.
// Used only by the explicitly guarded live proof (test/rls-g2-s7l.spec.ts).
//
// input (G2_S7L_WORKER JSON): { root, client, url, coach, intent, action, pause?, txTimeout?,
//   deadlineMs?, body? }
// action ∈ start | cancel | ingest | progress | complete | status | fence | settled
// pause  ∈ before-gate (inside the writer's transaction, before the §3.1 gate UPDATE)
//        | gated (gate UPDATE returned; row lock held; before the writer's own rows)
//        | locked (lifecycle FOR NO KEY UPDATE returned; before the fence/terminal UPDATE)
// The OLD image (root/client of OLD_HEAD) supports legacy actions only: complete | progress |
// status; its ScoutService has no lifecycle parameter.
const { join } = require('path');
const { existsSync } = require('fs');
const input = JSON.parse(process.env.G2_S7L_WORKER);
const Module = require('module');
const resolveFilename = Module._resolveFilename;
// A custom-output client (the OLD image) carries its own runtime copy; the services import the
// error classes from '@prisma/client/runtime/library', so both must resolve to ONE module
// instance or `instanceof` is false. A default-output client has no runtime copy: fall through.
const clientRuntime = join(input.client, 'runtime/library.js');
Module._resolveFilename = function (request, ...args) {
  if (request === '@prisma/client') return join(input.client, 'index.js');
  if (
    (request === '@prisma/client/runtime/library' ||
      request === '@prisma/client/runtime/library.js') &&
    existsSync(clientRuntime)
  ) {
    return clientRuntime;
  }
  return resolveFilename.call(this, request, ...args);
};
if (Number.isInteger(input.deadlineMs) && input.deadlineMs > 0) {
  process.env.SCOUT_RUN_DEADLINE_MS = String(input.deadlineMs);
}
const { PrismaClient } = require(input.client);
const { ScoutService } = require(join(input.root, 'src/scout/scout.service'));
const { ScoutIngestService } = require(join(input.root, 'src/scout/scout-ingest.service'));
let ScoutLifecycleService = null;
try {
  ({ ScoutLifecycleService } = require(join(input.root, 'src/scout/lifecycle/lifecycle.service')));
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') throw e; // the OLD image has no lifecycle module
}
const db = new PrismaClient({
  datasources: { db: { url: input.url } },
  log: [{ emit: 'event', level: 'query' }],
});
const queries = [];
const events = [];
db.$on('query', (e) => queries.push(e.query)); // Never log query parameters.
const analytics = { capture: (...args) => events.push(args) };
const notifications = { pushToUser: async () => undefined };
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
function instrument(target) {
  return new Proxy(target, {
    get(object, key) {
      // FIXTURE-ONLY `txTimeout` (ms): widens this process's Prisma interactive-transaction ceiling
      // (default 5000) so a paused writer can hold its row lock deterministically. The service
      // passes no options itself; added only when it passes none. A test knob, not production.
      // Interactive transactions also leave fixture markers (`-- tx:begin|commit|rollback`) in
      // the query log so a proof can assert statement ORDER across transaction boundaries
      // (e.g. L10: gate UPDATE, rollback, then the fence's lock in a NEW transaction).
      if (key === '$transaction')
        return async (fn, ...options) => {
          if (typeof fn !== 'function') return object.$transaction(fn, ...options);
          queries.push('-- tx:begin');
          try {
            const out = await object.$transaction(
              (tx) => fn(instrument(tx)),
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
          const result = await object.$queryRaw(strings, ...values);
          if (isGate(strings)) await barrier('gated');
          if (isLock(strings)) await barrier('locked');
          return result;
        };
      return typeof object[key] === 'function' ? object[key].bind(object) : object[key];
    },
  });
}
(async () => {
  let result;
  let failure;
  try {
    const prisma = instrument(db);
    const lifecycle = ScoutLifecycleService
      ? new ScoutLifecycleService(prisma, analytics)
      : undefined;
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
          entity_type: body.entity_type ?? 'clients',
          entities: (body.sources ?? ['a']).map((sourceId) => ({
            sourceId,
            sourcePlatform: 'truecoach',
            capturedAt: '2026-09-24T00:00:00.000Z',
            payload: { name: `Synthetic ${sourceId}` },
          })),
        });
        break;
      case 'progress':
        result = await scout.recordProgress(input.coach, {
          intent_id: input.intent,
          deviceId: body.deviceId ?? 'device-1',
          progress: [
            { entity_type: 'clients', count_committed: body.count ?? 1, total_estimated: 10 },
          ],
        });
        // Persist this process's snapshot through the real flush so the read path sees it.
        await scout.flush();
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
    };
  } finally {
    await db.$disconnect();
  }
  // process.send is asynchronous: disconnect only from the send callback so the final message
  // is never lost on the parent side.
  process.send({ done: true, result, failure, queries, events, pid: process.pid }, () =>
    process.disconnect(),
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
