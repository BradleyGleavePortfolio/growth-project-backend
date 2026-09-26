// S11 (the ONE S11 harness, docs/decisions/2026-09-26-s11-journey.md D-S11-6): real ScoutService +
// ScoutLifecycleService + ScoutReconstructService + ReconciliationFactsService + ExtensionPairService
// + ScoutRosterService + ScoutEntitiesService + real generated Prisma client in an independent OS
// process. ONE worker process is ONE server host: it has its own ScoutService and therefore its own
// in-process progress cache (H-S (i)); two workers over the same PG are two hosts. Derived by
// literal substitution from the landed test/utils/g2-s9c-worker.cjs (as landed at 92b96715), which stays
// byte-identical. The S11-A1 deltas (and nothing else):
//   - lane descriptor substitution (G2_S11_*, s11-proof);
//   - ADDED actions pair-init | pair-redeem (D-S11-6) with their service construction
//     (ExtensionPairService over the same instrumented client; the extension-session mint is the one
//     stub, `mints`, because the H-C authentication proof stays with the accepted route and auth
//     specs, D-S11-1), and pair-current | pair-session (the setup reads J01/J07 need);
//   - ADDED progress (re-carried from the landed test/utils/g2-s7l-worker.cjs `progress` action:
//     ScoutService.recordProgress, then the `cached` barrier, then an optional flush of THIS
//     process's cache) and roster | entities (the step-11 native review reads), which J03, J04,
//     J07 and step 11 need (flagged in s11a1_builder_summary.md);
//   - `messaging` joins the side-effect load spy keys (J08);
//   - REMOVED donor actions no S11 case uses: settled | report | reconstruct | run-pass.
// Hooks only PAUSE real operations at named barriers; they never replace query results or
// transaction semantics. Used only by the explicitly guarded S11 live proofs.
// input (G2_S11_WORKER JSON): { root, head, client, url, coach, intent, action, pause?, pauseRow?,
//   txTimeout?, deadlineMs?, body?, spec?, rules?, mapper?, family? }
// action ∈ start | ingest | progress | complete | cancel | fence | status
//        | pair-init | pair-redeem | pair-current | pair-session | roster | entities
// pause  ∈ before-gate (inside a transaction, before the §3.1 gate UPDATE)
//        | gated (gate UPDATE returned; row lock held; before the transaction's own rows)
//        | before-ledger (before the first ledger upsert of a per-row transaction)
//        | after-row (after the `pauseRow`-th COMMITTED gated per-row transaction of the pass)
//        | before-lock | locked (around the lifecycle FOR NO KEY UPDATE)
//        | cached (progress only: the snapshot is in THIS process's cache, not yet flushed)
const { join } = require('path');
const { execFileSync } = require('child_process');
const input = JSON.parse(process.env.G2_S11_WORKER);
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
// S11-A1: `messaging` joins the donor keys (J08 names notification, drip, email AND messaging spies).
const sideEffectLoads = {
  notifications: 0,
  drip: 0,
  assignment: 0,
  email: 0,
  billing: 0,
  messaging: 0,
};
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
const { ReconciliationFactsService } = require(
  join(input.root, 'src/scout/reconciliation/facts.service'),
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
const { ExtensionPairService } = require(
  join(input.root, 'src/extension-pair/extension-pair.service'),
);
const { ScoutRosterService } = require(join(input.root, 'src/scout/scout-roster.service'));
const { ScoutEntitiesService } = require(join(input.root, 'src/scout/scout-entities.service'));
// Startup loads are the accepted import graph (ScoutService already depends on notifications);
// the proof counts only what the ACTION loads lazily from here on.
for (const k of Object.keys(sideEffectLoads)) sideEffectLoads[k] = 0;

// S11-A1 fix 3 (J08): OUTBOUND-CALL spies, not load counters. Every exported class of every
// already-loaded notification / email / messaging / drip / nudge / digest module has each prototype
// method replaced by a recording stand-in that THROWS, so any code path that reaches a real
// channel method is both observed (`outbound`) and fails closed; the HTTP(S) and fetch transports
// every push/email/SMS provider uses are replaced the same way. Nothing is loaded here that the
// startup graph did not already load. `outboundSpied` names what was replaced (non-vacuity).
const outbound = [];
const outboundSpied = [];
const OUTBOUND_MODULE =
  /[\\/]src[\\/](notifications|email|messaging|drip|nudges?|digest)[\\/]|[\\/]src[\\/][^\\/]*(drip|email|messag|notif|nudge)[^\\/]*\.(ts|js)$/;
function blockedCall(channel, method, args) {
  const recipient = args.find((a) => typeof a === 'string') ?? null;
  outbound.push({ channel, method, recipient });
  throw new Error(`S11 proof: outbound ${channel}.${method} is not permitted`);
}
for (const [file, mod] of Object.entries(require.cache)) {
  if (!OUTBOUND_MODULE.test(file) || !mod || !mod.exports) continue;
  for (const [name, value] of Object.entries(mod.exports)) {
    if (typeof value !== 'function' || !value.prototype) continue;
    for (const method of Object.getOwnPropertyNames(value.prototype)) {
      if (method === 'constructor') continue;
      const desc = Object.getOwnPropertyDescriptor(value.prototype, method);
      if (!desc || typeof desc.value !== 'function') continue;
      value.prototype[method] = function (...args) {
        return blockedCall(name, method, args);
      };
      outboundSpied.push(`${name}.${method}`);
    }
  }
}
const hostOf = (a) =>
  typeof a === 'string' ? a : a instanceof URL ? a.host : a && a.hostname ? String(a.hostname) : a;
for (const [label, transport] of [
  ['http', require('http')],
  ['https', require('https')],
]) {
  for (const method of ['request', 'get']) {
    transport[method] = (...args) => blockedCall(label, method, args.map(hostOf));
    outboundSpied.push(`${label}.${method}`);
  }
}
if (typeof globalThis.fetch === 'function') {
  globalThis.fetch = (...args) => blockedCall('fetch', 'fetch', args.map(hostOf));
  outboundSpied.push('fetch');
}

const db = new PrismaClient({
  datasources: { db: { url: input.url } },
  log: [{ emit: 'event', level: 'query' }],
});
const queries = [];
const events = [];
db.$on('query', (e) => queries.push(e.query)); // Never log query parameters.
const analytics = { capture: (...args) => events.push(args) };
let pushes = 0;
// The injected notifications stand-in records each push ON THE CALL: recipient and kind (fix 3).
const pushCalls = [];
const notifications = {
  pushToUser: async (userId, _title, _body, data) => {
    pushes += 1;
    pushCalls.push({ userId, kind: data && typeof data.kind === 'string' ? data.kind : null });
  },
};
// The extension-session token authority stub (the only non-real dependency of the pairing
// service): it counts mints and returns synthetic, non-JWT strings. Authentication of the phone and
// extension principals is out of this proof (D-S11-1).
let mints = 0;
const auth = {
  mintExtensionSessionForCoach: async () => {
    mints += 1;
    return {
      access_token: `synthetic-access-${mints}`,
      refresh_token: `synthetic-refresh-${mints}`,
    };
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
  let factsOptions = {};
  try {
    const prisma = instrument(db);
    const reconstruct = new ScoutReconstructService(prisma, analytics);
    if (input.spec !== undefined || input.rules !== undefined) {
      const specs =
        input.spec === undefined ? [] : [parseSourceMappingSpec(input.spec, 'g2-s11-worker:spec')];
      const rules =
        input.rules === undefined ? [] : [parseNativeRuleSet(input.rules, 'g2-s11-worker:rules')];
      const sourceMappers = buildSourceMapperRegistry(specs);
      reconstruct.families = buildFamilyRegistry({
        sourceMappers,
        nativeRules: buildNativeRuleRegistry(rules),
      });
      // The planner resolves staged tokens through the SAME mapper registry the families use.
      reconstruct.sourceMappers = sourceMappers;
      // S11: the facts service classifies through the SAME registries (S9-B options seam).
      factsOptions = { sourceMappers, nativeRules: buildNativeRuleRegistry(rules) };
    }
    families = [...reconstruct.families.keys()];
    if (input.mapper === 'throw')
      reconstruct.families.get(input.family).map = () => {
        throw new Error('fixture private payload');
      };
    const facts = new ReconciliationFactsService(factsOptions);
    const lifecycle = new ScoutLifecycleService(prisma, analytics, reconstruct, facts);
    const scout = new ScoutService(prisma, notifications, analytics, lifecycle);
    const pairing = new ExtensionPairService(prisma, auth);
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
      case 'ingest':
        result = await new ScoutIngestService(prisma, analytics, lifecycle).ingest(input.coach, {
          intent_id: input.intent,
          entity_type: body.entity_type ?? 'people',
          entities: (body.entities ?? [{ sourceId: 'a', payload: { name: 'Synthetic a' } }]).map(
            (e) => ({
              sourceId: e.sourceId,
              sourcePlatform: body.sourcePlatform ?? 's11-proof',
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
      case 'progress':
        // H-S (i): the snapshot is cached in THIS process only; `cached` pauses with it pending.
        await scout.recordProgress(input.coach, {
          intent_id: input.intent,
          deviceId: body.deviceId ?? 'device-ext',
          progress: body.progress ?? [
            { entity_type: 'people', count_committed: 1, total_estimated: 2 },
          ],
          lastError: body.lastError,
        });
        await barrier('cached');
        if (body.flush === true) await scout.flush();
        result = { recorded: true, flushed: body.flush === true };
        break;
      case 'pair-init':
        result = await pairing.init(input.coach, body.chosen_platform ?? 's11-label', body.nonce);
        break;
      case 'pair-redeem':
        result = await pairing.redeem(body.code);
        break;
      case 'pair-current':
        result = await pairing.current(input.coach, body.nonce);
        break;
      case 'pair-session':
        result = await pairing.session(input.coach, input.intent);
        break;
      case 'roster':
        result = await new ScoutRosterService(prisma, analytics).getRoster(
          input.coach,
          input.intent,
          undefined,
          undefined,
        );
        break;
      case 'entities':
        result = await new ScoutEntitiesService(prisma, analytics).getEntities(
          input.coach,
          input.intent,
          body.family ?? 'workouts',
          undefined,
          undefined,
        );
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
      pushCalls,
      outbound,
      outboundSpied,
      mints,
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
