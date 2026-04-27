import * as fs from 'fs';
import * as path from 'path';

// Asserts that publicly documented endpoint paths in the README/runbook
// surface still resolve to controllers that mount them. We grep the
// controllers because a path string is the contract; a renamed controller
// with the same path is fine, a removed handler is not.
//
// This is the regression net for the kind of doc drift fixed in this PR
// (e.g. the now-removed /api/ai/context/preview, and `/v1/...` paths
// missing the `/api` global prefix in operator-facing runbooks).

function read(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('Route doc drift — controllers must back every documented endpoint', () => {
  const aiController = read('src/ai/ai.controller.ts');
  const stripeWebhook = read('src/billing/stripe-webhook.controller.ts');
  const systemController = read('src/system/system.controller.ts');
  const mainTs = read('src/main.ts');

  it('AI controller mounts /chat, /context, /structured-context under /api/ai', () => {
    expect(aiController).toMatch(/@Controller\(['"]ai['"]\)/);
    expect(aiController).toMatch(/@Post\(['"]chat['"]\)/);
    expect(aiController).toMatch(/@Get\(['"]context['"]\)/);
    expect(aiController).toMatch(/@Get\(['"]structured-context['"]\)/);
    // global prefix /api is what makes the live URL /api/ai/...
    expect(mainTs).toMatch(/setGlobalPrefix\(['"]api['"]/);
  });

  it('Stripe webhook controller mounts POST /api/v1/webhooks/stripe', () => {
    expect(stripeWebhook).toMatch(/@Controller\(['"]v1\/webhooks['"]\)/);
    expect(stripeWebhook).toMatch(/@Post\(['"]stripe['"]\)/);
  });

  it('System controller mounts GET /api/system/trust-meta and is @Public()', () => {
    expect(systemController).toMatch(/@Controller\(['"]system['"]\)/);
    expect(systemController).toMatch(/@Get\(['"]trust-meta['"]\)/);
    expect(systemController).toMatch(/@Public\(\)/);
  });

  it('No code references the removed /ai/context/preview endpoint', () => {
    // Grep every .ts under src/ and scripts/ for the legacy preview path.
    // It is intentionally absent so smoke checks line up with the real
    // /api/ai/context route.
    const roots = ['src', 'scripts'];
    const offenders: string[] = [];
    function walk(dir: string) {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        const stat = fs.statSync(p);
        if (stat.isDirectory()) walk(p);
        else if (name.endsWith('.ts')) {
          const body = fs.readFileSync(p, 'utf8');
          if (body.includes('/ai/context/preview')) offenders.push(p);
        }
      }
    }
    for (const r of roots) walk(path.join(__dirname, '..', r));
    expect(offenders).toEqual([]);
  });

  it('Operator-facing runbook references /api/v1/webhooks/stripe (not bare /v1/...)', () => {
    const runbook = read('docs/deploy-runbook.md');
    const stripeSetup = read('docs/stripe-setup.md');
    expect(runbook).toContain('/api/v1/webhooks/stripe');
    expect(stripeSetup).toContain('/api/v1/webhooks/stripe');
    // Make sure the unprefixed form does not sneak back into the
    // sections operators copy/paste from.
    const runbookLines = runbook.split('\n');
    const drifters = runbookLines.filter(
      (l) => /\b\/v1\/webhooks\/stripe\b/.test(l) && !/\/api\/v1\/webhooks\/stripe/.test(l),
    );
    expect(drifters).toEqual([]);
  });
});
