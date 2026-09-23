'use strict';
// Run outside Jest so SDK instrumentation starts before Nest/Express is loaded.
// All HTTP and telemetry stay on loopback/in memory; no database is used.
const assert = require('node:assert/strict');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const root = path.resolve(__dirname, '../../..');
require('ts-node').register({ transpileOnly: true, project: path.join(root, 'tsconfig.json') });
const Sentry = require('@sentry/node');
const { buildSentryOptions } = require(path.join(root, 'src/observability/sentry-config.ts'));
const envelopes = [];
Sentry.init({
  ...buildSentryOptions('https://public@example.invalid/1', { NODE_ENV: 'test' }),
  tracesSampleRate: 0,
  // Intentionally retain all default integrations, matching production order.
  transport: () => ({
    send: async (envelope) => {
      envelopes.push(envelope);
      return { statusCode: 200 };
    },
    flush: async () => true,
  }),
});
const { Controller, Get } = require('@nestjs/common');
const { Test } = require('@nestjs/testing');
const { HttpExceptionFilter } = require(path.join(root, 'src/filters/http-exception.filter.ts'));
const marker = `SYNTHETIC_INCOMING_${require('node:crypto').randomUUID()}`;
class ProbeController {
  fail() {
    throw new Error('Unexpected operation failure');
  }
}
Controller('telemetry-fixture')(ProbeController);
Get(':token')(
  ProbeController.prototype,
  'fail',
  Object.getOwnPropertyDescriptor(ProbeController.prototype, 'fail'),
);

async function main() {
  const module = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
  const app = module.createNestApplication({ logger: false });
  app.useGlobalFilters(new HttpExceptionFilter());
  app.use((req, _res, next) => {
    req.requestId = 'synthetic-request-correlation';
    next();
  });
  app.use('/before-route', (_req, _res, next) => next(new Error('Pre-route failure')));
  await app.listen(0, '127.0.0.1');
  try {
    for (const prefix of ['/telemetry-fixture', '/before-route']) {
      envelopes.length = 0;
      const requestPath = `${prefix}/${marker}?credential=${marker}`;
      // A separate, uninstrumented client excludes outgoing-client breadcrumbs
      // from the server proof. Include a credential-bearing Referer as well.
      const { stdout } = await execFile(
        process.execPath,
        [
          '-e',
          `fetch(process.argv[1], {headers:{referer:process.argv[1]}})
          .then(async r => console.log(JSON.stringify({status:r.status,body:await r.json()})))`,
          `${await app.getUrl()}${requestPath}`,
        ],
        { timeout: 5000 },
      );
      const response = JSON.parse(stdout);
      assert.equal(response.status, 500);
      await Sentry.flush(2000);
      const events = envelopes
        .flatMap((envelope) => envelope[1])
        .filter((item) => item[0].type === 'event')
        .map((item) => item[1]);
      assert.equal(events.length, 1);
      assert.equal(JSON.stringify(envelopes).includes(marker), false, JSON.stringify(envelopes));
      assert.equal(events[0].request, undefined);
      assert.equal(events[0].transaction, undefined);
      assert.equal(events[0].tags.request_id, 'synthetic-request-correlation');
      assert.equal(
        events[0].tags['http.path'],
        prefix === '/before-route' ? '[unmatched]' : '/telemetry-fixture/:token',
      );
      assert.match(events[0].exception.values[0].value, /failure/i);
      if (prefix === '/telemetry-fixture') assert.equal(response.body.path, requestPath);
    }
  } finally {
    await app.close();
    await Sentry.close(2000);
  }
  console.log(
    JSON.stringify({
      cases: 2,
      defaultIntegrations: true,
      separateClient: true,
      localTransport: true,
      errorEventMetadataSanitized: true,
    }),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
