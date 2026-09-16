import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';
import { transpileModule, ModuleKind } from 'typescript';

const spec = readFileSync(join(__dirname, '../rls-scout-ingest-uniqueness.spec.ts'), 'utf8');
async function evaluate(url: string, confirmation?: string) {
  const urls: string[] = [];
  const calls: Array<{ args: string[]; options: { timeout?: number } }> = [];
  const sql: string[] = [];
  const setup: Array<() => Promise<void>> = [];
  const connect = jest.fn();
  const describe = Object.assign((_name: string, cb: () => void) => cb(), { skip: () => {} });
  let error: unknown;
  try {
    runInNewContext(
      transpileModule(spec, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText,
      {
        exports: {},
        __dirname: join(__dirname, '..'),
        require: (name: string) => {
          if (name === 'child_process')
            return {
              execFileSync: (_exe: string, args: string[], options: { timeout?: number }) => {
                calls.push({ args, options });
                return '';
              },
            };
          if (name === '@prisma/client')
            return {
              PrismaClient: class {
                constructor(options: { datasources: { db: { url: string } } }) {
                  urls.push(options.datasources.db.url);
                }
                $connect = connect;
                $executeRawUnsafe = async (statement: string) => {
                  sql.push(statement);
                };
              },
            };
          if (name.startsWith('.')) return require(join(__dirname, '..', name));
          return require(name);
        },
        process: {
          env: { SCOUT_INGEST_TEST_DATABASE_URL: url, SCOUT_INGEST_TEST_CONFIRM: confirmation },
        },
        describe,
        it: Object.assign(() => {}, { each: () => () => {} }),
        beforeAll: (cb: () => Promise<void>) => setup.push(cb),
        afterAll: () => {},
        beforeEach: () => {},
        console: { warn: () => {} },
      },
    );
    for (const cb of setup) await cb();
  } catch (caught) {
    error = caught;
  }
  return { error, calls, sql, connect, urls };
}
const safe = 'postgresql://postgres@127.0.0.1:55433/tgp_importer_fix_r2';
describe('destructive ingest harness boundary without network', () => {
  it.each([
    'postgresql://postgres@prod.example.com:5432/scout_ingest_throwaway',
    'postgresql://postgres@127.0.0.1:55433/production',
    `${safe}?schema=private`,
    `${safe}?host=prod.example.com`,
    `${safe}?options=-csearch_path%3Dprivate`,
    `${safe}?sslmode=invalid`,
    `${safe}?sslcert=client.pem`,
    `${safe}?sslkey=client.key`,
    `${safe}?connect_timeout=0`,
    `${safe}?connect_timeout=99999`,
    `${safe}?schema=public&schema=private`,
  ])('rejects unsafe or inconsistent target %s before connection', async (url) => {
    const result = await evaluate(url, 'tgp_importer_fix_r2');
    expect(result.error).toBeDefined();
    expect(result.connect).not.toHaveBeenCalled();
    expect(result.calls).toEqual([]);
    expect(result.sql).toEqual([]);
  });
  it('requires a confirmation exactly matching the disposable database name', async () => {
    const result = await evaluate(safe);
    expect(result.error).toBeDefined();
    expect(result.connect).not.toHaveBeenCalled();
  });
  it('preserves security parameters, uses -X, and bounds every child process', async () => {
    const result = await evaluate(
      `${safe}?schema=public&sslmode=verify-full&sslrootcert=%2Ftmp%2Fca.pem&connect_timeout=5`,
      'tgp_importer_fix_r2',
    );
    expect(result.error).toBeUndefined();
    expect(result.calls.length).toBeGreaterThanOrEqual(3);
    expect(result.urls).toHaveLength(1);
    expect(result.urls[0]).toContain('sslmode=require');
    expect(result.urls[0]).toContain('sslaccept=strict');
    expect(result.urls[0]).toContain('sslcert=');
    expect(result.urls[0]).not.toContain('sslrootcert=');
    for (const { args, options } of result.calls) {
      expect(args).toContain('-X');
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.timeout).toBeLessThanOrEqual(60000);
      const url = args.find((a) => a.startsWith('postgres'));
      expect(url).toContain('sslmode=verify-full');
      expect(url).toContain('sslrootcert=');
      expect(url).toContain('connect_timeout=5');
      expect(url).not.toContain('schema=');
    }
  });
});
