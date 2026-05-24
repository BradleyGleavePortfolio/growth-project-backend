import { readFileSync } from 'fs';
import { join } from 'path';

// Static-source assertion: the CORS `allowedHeaders` list in `src/main.ts`
// must include every request header that any guarded endpoint requires.
// Missing entries cause silent browser preflight failures with no signal in
// server logs, so this test exists to prevent regressions where a new
// endpoint requires a header (RecentAuthGuard → X-Recent-Auth-Token,
// IdempotencyInterceptor → Idempotency-Key) but the CORS config is not
// updated alongside it.
describe('CORS allowedHeaders (src/main.ts)', () => {
  const REQUIRED_HEADERS = [
    'Content-Type',
    'Authorization',
    'Idempotency-Key',
    'X-Recent-Auth-Token',
  ];

  let mainSource: string;
  let allowedHeadersLine: string;

  beforeAll(() => {
    mainSource = readFileSync(
      join(__dirname, '..', 'src', 'main.ts'),
      'utf8',
    );
    const match = mainSource.match(/allowedHeaders:\s*\[([^\]]+)\]/);
    if (!match) {
      throw new Error('Could not locate `allowedHeaders: [...]` in src/main.ts');
    }
    allowedHeadersLine = match[1];
  });

  it.each(REQUIRED_HEADERS)('allowedHeaders contains %s', (header) => {
    expect(allowedHeadersLine).toContain(`'${header}'`);
  });

  it('allowedHeaders has no duplicate entries', () => {
    const entries = allowedHeadersLine
      .split(',')
      .map((s) => s.trim().replace(/['"`]/g, ''))
      .filter(Boolean);
    const lower = entries.map((s) => s.toLowerCase());
    const dedup = new Set(lower);
    expect(lower.length).toBe(dedup.size);
  });
});
