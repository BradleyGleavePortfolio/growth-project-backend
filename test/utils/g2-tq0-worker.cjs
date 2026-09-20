// Real service + real generated Prisma client in an independent OS process.
// Hooks only pause actual operations; they never replace query results or
// transaction semantics. Used only by the explicitly guarded live proof.
const { join } = require('path');
const input = JSON.parse(process.env.G2_TQ0_WORKER);
// Bind every service's Prisma error/enum import to the same generated module
// as its instantiated client. In particular, old and T never mix constructors.
const Module = require('module');
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  return request === '@prisma/client' ? join(input.client, 'index.js') :
    resolveFilename.call(this, request, ...args);
};
const { PrismaClient } = require(input.client);
const { ScoutReconstructService } = require(join(input.root, 'src/scout/scout-reconstruct.service'));
const { ScoutRosterService } = require(join(input.root, 'src/scout/scout-roster.service'));
const { ScoutEntitiesService } = require(join(input.root, 'src/scout/scout-entities.service'));
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
      // FIXTURE-ONLY `txTimeout` (ms): widens this process's Prisma interactive-transaction ceiling
      // (default 5000) so a paused claim can be held past E's lock_timeout deterministically. The
      // service passes no options itself; the option is added only when it passes none. This is a
      // test knob, not a production setting, and proves nothing about production T timing.
      if (key === '$transaction') return (fn, ...options) => object.$transaction(
        (tx) => fn(instrument(tx)),
        ...(options.length === 0 && Number.isInteger(input.txTimeout) && input.txTimeout > 0
          ? [{ timeout: input.txTimeout }] : options),
      );
      if (key === 'scoutIngestEntity') return new Proxy(object[key], {
        get(delegate, method) {
          if (method === 'findMany') return async (...args) => {
            const result = await delegate.findMany(...args);
            await barrier('staged');
            return result;
          };
          return typeof delegate[method] === 'function' ? delegate[method].bind(delegate) : delegate[method];
        },
      });
      if (key === 'scoutReconstructionLedger') return new Proxy(object[key], {
        get(delegate, method) {
          if (method === 'upsert') return async (...args) => {
            await barrier('before-ledger');
            return delegate.upsert(...args);
          };
          if (method === 'updateMany') return async (args) => {
            const result = await delegate.updateMany(args);
            if (args.data.source_platform !== undefined) await barrier('claimed');
            return result;
          };
          return typeof delegate[method] === 'function' ? delegate[method].bind(delegate) : delegate[method];
        },
      });
      return typeof object[key] === 'function' ? object[key].bind(object) : object[key];
    },
  });
}
(async () => {
  let result;
  let failure;
  try {
    const prisma = instrument(db);
    if (input.action === 'roster') {
      result = await new ScoutRosterService(prisma, analytics).getRoster(
        input.coach, input.intent, input.cursor, input.limit ?? 1,
      );
    } else if (input.action === 'entities') {
      result = await new ScoutEntitiesService(prisma, analytics).getEntities(
        input.coach, input.intent, input.family, input.cursor, input.limit ?? 1,
      );
    } else {
      const service = new ScoutReconstructService(prisma, analytics);
      // Built-in mappers are total and a fixed (platform,id) always takes the
      // same skip branch. This explicitly labelled fixture mapper exercises a
      // future mapper rejection/throw without faking any DB operation.
      if (input.mapper === 'skip') service.families.get(input.family).map =
        () => ({ ok: false, reason: 'fixture:mapper-skip' });
      if (input.mapper === 'throw') service.families.get(input.family).map =
        () => { throw new Error('fixture private payload'); };
      result = await service.reconstruct(input.coach, input.intent, input.family);
    }
  } catch (e) {
    failure = {
      status: typeof e.getStatus === 'function' ? e.getStatus() : 500,
      // Emulate Nest's public boundary for unexpected DB failures.
      message: typeof e.getStatus === 'function' ? e.message : 'Internal server error',
      code: e.code,
    };
  } finally {
    await db.$disconnect();
  }
  // process.send is asynchronous: disconnecting before the (possibly large) final message has been
  // flushed loses it on the parent side (observed on PG17 runs with 600+ staged rows). Disconnect
  // only from the send callback.
  process.send({ done: true, result, failure, queries, events, pid: process.pid }, () => process.disconnect());
})().catch((e) => { console.error(e); process.exit(1); });
