import * as fs from 'fs';
import * as path from 'path';

// Audit #3 P1-1: the global CORS allowedHeaders list must include
// `Idempotency-Key` so browser clients (owner admin console, web coach
// console) succeed their CORS preflight when posting to idempotent
// endpoints introduced by the talent-marketplace and workout-builder
// flows. Without it, the browser short-circuits the request before it
// reaches Nest.
describe('CORS config (audit #3 P1-1)', () => {
  const mainTs = fs.readFileSync(
    path.join(__dirname, '..', 'src/main.ts'),
    'utf8',
  );

  it('declares Idempotency-Key in allowedHeaders', () => {
    const match = mainTs.match(/allowedHeaders:\s*\[([^\]]+)\]/);
    expect(match).not.toBeNull();
    const headers = match![1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    expect(headers).toEqual(
      expect.arrayContaining(['Content-Type', 'Authorization', 'Idempotency-Key']),
    );
  });
});
