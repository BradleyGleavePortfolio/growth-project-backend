import * as fs from 'fs';
import * as path from 'path';

// Audit #3 P1-1 / Audit #5 P1-1: the global CORS allowedHeaders list must
// include `Idempotency-Key` (talent-marketplace / workout-builder) and
// `X-Recent-Auth-Token` (sensitive-action re-auth flow, PR #167) so browser
// clients succeed their CORS preflight. Without these, the browser
// short-circuits the request before it reaches Nest.
describe('CORS config (audit #3 P1-1, audit #5 P1-1)', () => {
  const mainTs = fs.readFileSync(
    path.join(__dirname, '..', 'src/main.ts'),
    'utf8',
  );

  it('declares Idempotency-Key and X-Recent-Auth-Token in allowedHeaders', () => {
    const match = mainTs.match(/allowedHeaders:\s*\[([^\]]+)\]/);
    expect(match).not.toBeNull();
    const headers = match![1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    expect(headers).toEqual(
      expect.arrayContaining([
        'Content-Type',
        'Authorization',
        'Idempotency-Key',
        'X-Recent-Auth-Token',
      ]),
    );
  });
});
