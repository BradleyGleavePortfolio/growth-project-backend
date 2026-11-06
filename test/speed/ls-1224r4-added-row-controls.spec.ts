import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';
import ts from 'typescript';

interface Read {
  screen: string;
  path: string;
  check: (body: string) => string | null;
}
interface Row {
  problem: string | null;
}

const file = join(__dirname, 'coach-busy-reads.speed.spec.ts');
const source = readFileSync(file, 'utf8');
const transpile = (text: string): string => ts.transpileModule(text, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const now = new Date('2026-11-06T12:00:00Z');
const clientIds = Array.from({ length: 45 }, (_, i) =>
  `5bee0000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);

function catalogue(): Read[] {
  const captured: { lensReads?: (date: Date) => Read[] } = {};
  const noSuite = () => undefined;
  runInNewContext(transpile(source + '\nmodule.exports.lensReads = reads;'), {
    require, URL, URLSearchParams, exports: captured, module: { exports: captured },
    process: { env: {} }, console: { log: noSuite },
    describe: Object.assign(noSuite, { skip: noSuite }),
  }, { filename: file });
  if (!captured.lensReads) throw new Error('Actual speed-read catalogue missing');
  return captured.lensReads(now);
}

function actualLoop(): string {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let loop: string | undefined;
  const walk = (node: ts.Node): void => {
    if (ts.isForOfStatement(node) && node.expression.getText(ast) === 'reads(now)') {
      loop = node.getText(ast);
    }
    ts.forEachChild(node, walk);
  };
  walk(ast);
  if (!loop) throw new Error('Actual speed timing loop missing');
  return loop;
}

const allReads = catalogue();
const fixtures = [
  {
    screen: 'Client file',
    path: '/coach/clients?status=all&take=50',
    valid: JSON.stringify(clientIds.map((id) => ({ id }))),
    wrong: JSON.stringify(clientIds.slice(1).map((id) => ({ id }))),
  },
  {
    screen: 'Client list',
    path: '/notifications/unread-count',
    valid: '{"count":45}',
    wrong: '{"count":44}',
  },
  {
    screen: 'Client file',
    path: '/notifications/unread-count',
    valid: '{"count":45}',
    wrong: '{"count":44}',
  },
];

async function probe(read: Read, valid: string, badAt: number | null, badBody: string, status = 200): Promise<Row> {
  const results: Row[] = [];
  let calls = 0;
  let clock = 0;
  await runInNewContext(transpile(`(async () => { ${actualLoop()} })()`), {
    reads: () => [read],
    now,
    base: 'http://fixture.invalid/api',
    TOKEN: 'reviewer-row-control',
    WARMUP: 1,
    TIMED: 15,
    performance: { now: () => ++clock },
    Buffer,
    median: (values: number[]) => [...values].sort((a, b) => a - b)[7],
    results,
    fetch: async () => {
      calls += 1;
      const bad = badAt !== null && calls === badAt + 1;
      return { status: bad ? status : 200, text: async () => bad ? badBody : valid };
    },
  }, { filename: 'actual-speed-added-row-loop.js' });
  expect(calls).toBe(16);
  expect(results).toHaveLength(1);
  return results[0];
}

describe.each(fixtures)('LS-1224R4 added row: $screen $path', ({ screen, path, valid, wrong }) => {
  const matches = allReads.filter((read) => read.screen === screen && read.path === path);
  const read = matches[0];

  it('maps the actual catalogue exactly once', () => {
    expect(matches).toHaveLength(1);
  });

  it('accepts the seeded value and rejects an incomplete or wrong seeded value', () => {
    expect(read.check(valid)).toBeNull();
    expect(read.check(wrong)).not.toBeNull();
  });

  it.each(['{}', '[]', 'null', '{"count":0}', '<html>error</html>'])('rejects empty/error body %s', (body) => {
    expect(read.check(body)).not.toBeNull();
  });

  it('rejects a JSON error even if the seeded data is also present', () => {
    const payload = screen === 'Client file' && path.startsWith('/coach/clients')
      ? { clients: clientIds.map((id) => ({ id })), error: 'unavailable' }
      : { count: 45, error: 'unavailable' };
    expect(read.check(JSON.stringify(payload))).not.toBeNull();
  });

  it('control: all fifteen valid timed bodies pass the actual timing loop', async () => {
    expect((await probe(read, valid, null, '{}')).problem).toBeNull();
  });

  it.each(Array.from({ length: 15 }, (_, i) => i + 1))('retains invalid data at timed sample %i', async (sample) => {
    const row = await probe(read, valid, sample, wrong);
    expect(row.problem).toContain(`timed call ${sample} `);
  });

  it.each(Array.from({ length: 15 }, (_, i) => i + 1))('retains HTTP failure at timed sample %i', async (sample) => {
    const row = await probe(read, valid, sample, valid, 503);
    expect(row.problem).toContain(`timed call ${sample} answered 503:`);
  });
});
