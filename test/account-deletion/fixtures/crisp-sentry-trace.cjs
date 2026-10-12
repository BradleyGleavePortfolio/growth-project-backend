'use strict';
// B-918-2 (probe by the Sol lens): the real vendor service under default Sentry
// fetch tracing must not put the Crisp email into any envelope. Loopback only.
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
require('ts-node').register({ transpileOnly: true, project: path.join(root, 'tsconfig.json') });
const Sentry = require('@sentry/node');
const { buildSentryOptions } = require(path.join(root, 'src/observability/sentry-config.ts'));
const envelopes = [];
Sentry.init({
  ...buildSentryOptions('https://public@example.invalid/1', { NODE_ENV: 'test' }),
  tracesSampleRate: 1,
  transport: () => ({ send: async (e) => (envelopes.push(e), { statusCode: 200 }), flush: async () => true }),
});
const http = require('node:http');
const net = require('node:net');
const { Agent } = require('undici');
const { AccountDeletionVendorsService } = require(path.join(root, 'src/account-deletion/account-deletion.vendors.ts'));
const EMAIL = 'synthetic-918@example.invalid';

async function main() {
  const paths = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.method === 'GET' ? { data: [] } : { reason: 'deleted' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  // Keep the real https://api.crisp.chat URL; only the socket goes to loopback.
  const dispatcher = new Agent({
    connect: (_o, cb) => net.connect({ host: '127.0.0.1', port }).once('connect', function () { cb(null, this); }),
  });
  const realFetch = global.fetch;
  global.fetch = (input, init) => realFetch(input, { ...init, dispatcher });
  process.env.CRISP_WEBSITE_ID = 'synthetic-site';
  process.env.CRISP_API_TOKEN = 'synthetic:token';
  const service = new AccountDeletionVendorsService({});
  const outcome = await Sentry.startSpan({ name: 'account deletion' }, () =>
    service.erase('synthetic-user', { vendors: ['crisp'], email: EMAIL, stripe_customer_ids: [] }));
  assert.equal(outcome.outcomes.crisp, 'done');
  assert.ok(paths.length === 2 && paths.every((p) => p.includes(encodeURIComponent(EMAIL))));
  await Sentry.flush(3000);
  const sent = JSON.stringify(envelopes.flatMap((e) => e[1]).filter((i) => i[0].type === 'transaction')
    .map((i) => i[1]).filter((t) => t.transaction === 'account deletion'));
  assert.ok(sent.includes('api.crisp.chat'), 'fetch spans must be captured');
  assert.ok(!sent.includes('%40example') && !sent.includes(EMAIL), `email reached Sentry: ${sent}`);
  await dispatcher.close();
  server.close();
  await Sentry.close(3000);
}
main().catch((error) => { console.error(error); process.exit(1); });
