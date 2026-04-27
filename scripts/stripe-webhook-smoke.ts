/* eslint-disable no-console */
/**
 * Local Stripe-webhook replay smoke script.
 *
 * Feeds fixture events from `test/fixtures/stripe/*.json` to the running
 * dev server, signed with whatever value `STRIPE_WEBHOOK_SECRET` holds at
 * invocation time. Does NOT call Stripe; there is no network egress and no
 * real key required. Useful when iterating on `BillingService` without a
 * Stripe account.
 *
 * Usage:
 *   # in one terminal
 *   STRIPE_WEBHOOK_SECRET=whsec_dev_local npm run start:dev
 *
 *   # in another terminal
 *   STRIPE_WEBHOOK_SECRET=whsec_dev_local \
 *     npx ts-node scripts/stripe-webhook-smoke.ts
 *
 *   # or feed a single fixture by name (omit the .json suffix):
 *   npx ts-node scripts/stripe-webhook-smoke.ts subscription.created
 *
 * Environment:
 *   STRIPE_WEBHOOK_SECRET   required — must match the running server.
 *   STRIPE_SMOKE_URL        defaults to http://localhost:3000/api/v1/webhooks/stripe.
 *
 * Exit codes:
 *   0  every fixture returned 2xx and the parsed body matched expectation.
 *   1  any fixture failed (signature reject, 5xx, network error, etc.).
 */
import { createHmac } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const FIXTURE_DIR = join(__dirname, '..', 'test', 'fixtures', 'stripe');
const DEFAULT_URL = 'http://localhost:3000/api/v1/webhooks/stripe';

function signPayload(payload: string, secret: string, ts: number): string {
  const sig = createHmac('sha256', secret)
    .update(`${ts}.${payload}`, 'utf8')
    .digest('hex');
  return `t=${ts},v1=${sig}`;
}

async function postFixture(opts: {
  url: string;
  secret: string;
  fixturePath: string;
  fixtureName: string;
}): Promise<{ ok: boolean; status: number; body: string }> {
  const raw = readFileSync(opts.fixturePath, 'utf8');
  // Re-serialize via JSON.parse → JSON.stringify so the byte sequence we
  // sign matches what we send (both ends use deterministic stringify).
  const payload = JSON.stringify(JSON.parse(raw));
  const ts = Math.floor(Date.now() / 1000);
  const signature = signPayload(payload, opts.secret, ts);

  const res = await fetch(opts.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signature,
    },
    body: payload,
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text };
}

function listFixtures(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
}

async function main() {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error(
      'STRIPE_WEBHOOK_SECRET is required (must match the running server).',
    );
    process.exit(1);
  }
  const url = process.env.STRIPE_SMOKE_URL ?? DEFAULT_URL;

  const argv = process.argv.slice(2);
  const requested = argv.length > 0 ? argv : null;
  const fixtures = requested
    ? requested.map((name) =>
        name.endsWith('.json') ? name : `${name}.json`,
      )
    : listFixtures();

  if (!fixtures.length) {
    console.error(`No fixtures found in ${FIXTURE_DIR}`);
    process.exit(1);
  }

  let failures = 0;
  console.log(`POST → ${url}`);
  for (const fixture of fixtures) {
    const fixturePath = join(FIXTURE_DIR, fixture);
    try {
      const result = await postFixture({
        url,
        secret,
        fixturePath,
        fixtureName: fixture,
      });
      const tag = result.ok ? 'OK ' : 'ERR';
      console.log(`  [${tag}] ${fixture} → ${result.status} ${result.body}`);
      if (!result.ok) failures++;
    } catch (err) {
      console.log(`  [ERR] ${fixture} → ${(err as Error).message}`);
      failures++;
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} fixture(s) failed.`);
    process.exit(1);
  }
  console.log(`\nAll ${fixtures.length} fixture(s) accepted.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
