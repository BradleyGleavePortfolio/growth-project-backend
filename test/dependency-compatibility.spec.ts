import { spawnSync } from 'node:child_process';

// Run real package APIs in Node, outside Jest's module rewriting. This also
// exercises Prisma's native dynamic-import boundary and Danger's Git subprocess.
function probe(script: string): void {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const assert = require('node:assert/strict');
       (async () => { ${script} })().then(
         () => process.stdout.write('dependency-probe-ok'),
         error => { console.error(error); process.exitCode = 1; }
       );`,
    ],
    { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 20000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect({ status: result.status, stderr: result.stderr }).toEqual({
    status: 0,
    stderr: '',
  });
  expect(result.stdout).toBe('dependency-probe-ok');
}

describe('locked dependency compatibility', () => {
  it('rejects shell operator injection and preserves literal argument round trips', () => {
    probe(`
      const shell = require('shell-quote');
      assert.throws(() => shell.quote([{ op: '\\necho harmless' }]), TypeError);
      const args = ['a b', 'quote"value', "single'quote", '$HOME', ';echo literal'];
      assert.deepEqual(shell.parse(shell.quote(args)), args);
    `);
  });

  it('preserves Prisma deepmerge semantics and bounds cyclic input', () => {
    probe(`
      const { createRequire } = require('node:module');
      const local = createRequire(require.resolve('@prisma/config'));
      const { deepmerge } = local('deepmerge-ts');
      const left = { name: 'left' }; left.self = left;
      const right = { name: 'right' }; right.self = right;
      const merged = deepmerge(left, right);
      assert.equal(merged.name, 'right');
      assert.equal(merged.self, merged);
      assert.deepEqual(deepmerge(
        { nested: { a: 1 }, list: [1], map: new Map([['a', 1]]), set: new Set([1]) },
        { nested: { b: 2 }, list: [2], map: new Map([['b', 2]]), set: new Set([2]) }
      ), {
        nested: { a: 1, b: 2 }, list: [1, 2],
        map: new Map([['a', 1], ['b', 2]]), set: new Set([1, 2])
      });
      const { pathToFileURL } = require('node:url');
      const esm = await import(pathToFileURL(local.resolve('deepmerge-ts')).href);
      assert.equal(typeof esm.deepmerge, 'function');
    `);
  });

  it('loads an actual Prisma config through c12 and the overridden merger', () => {
    probe(`
      const fs = require('node:fs');
      const path = require('node:path');
      const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'prisma-dependency-'));
      // Retain the tiny fixture for reproducible diagnostics.
      fs.writeFileSync(path.join(dir, 'prisma.config.ts'),
        'export default { schema: "./schema.prisma", migrations: { path: "./migrations" } };');
      const { loadConfigFromFile } = require('@prisma/config');
      const loaded = await loadConfigFromFile({ configRoot: dir });
      assert.equal(loaded.error, undefined);
      assert.equal(loaded.resolvedPath, path.join(dir, 'prisma.config.ts'));
      assert.equal(loaded.config.schema, path.join(dir, 'schema.prisma'));
      assert.equal(loaded.config.migrations.path, path.join(dir, 'migrations'));
      const missing = await loadConfigFromFile({ configRoot: dir, configFile: 'absent.ts' });
      assert.equal(missing.error._tag, 'ConfigFileNotFound');
    `);
  });

  it('restores real Istanbul instrumentation selection without a minimatch API override', () => {
    probe(`
      const path = require('node:path');
      const TestExclude = require('test-exclude');
      const selector = new TestExclude({ cwd: process.cwd(), extension: ['.ts'] });
      assert.equal(selector.shouldInstrument(path.resolve('src/main.ts')), true);
      assert.equal(selector.shouldInstrument(path.resolve('test/dependency-compatibility.spec.ts')), false);
    `);
  });

  it('loads YAML through both Swagger and NYC consumers without cross-major replacement', () => {
    probe(`
      const { createRequire } = require('node:module');
      const swagger = createRequire(require.resolve('@nestjs/swagger/package.json'))('js-yaml');
      const nyc = createRequire(require.resolve('@istanbuljs/load-nyc-config'))('js-yaml');
      const input = 'defaults: &base\\n  limit: 3\\ncopy:\\n  <<: *base\\n';
      const expected = { defaults: { limit: 3 }, copy: { limit: 3 } };
      assert.deepEqual(swagger.load(input), expected);
      assert.deepEqual(nyc.safeLoad(input), expected);
      assert.deepEqual(swagger.load(swagger.dump(expected)), expected);
      assert.throws(() => swagger.load('key: 1\\nkey: 2\\n'), /duplicated mapping key/);
      assert.throws(() => nyc.safeLoad('key: 1\\nkey: 2\\n'), /duplicated mapping key/);
    `);
  });

  it('reads a real Git object through Danger without requiring a remote platform', () => {
    probe(`
      const { localGetFileAtSHA } = require('danger/distribution/platforms/git/localGetFileAtSHA');
      const original = await localGetFileAtSHA('package.json', '.', 'HEAD');
      assert.equal(JSON.parse(original).name, 'growth-project-backend');
      const ini = require('ini');
      const parsed = ini.parse('[remote "origin"]\\nurl=https://example.invalid/repo\\n');
      assert.equal(parsed['remote "origin"'].url, 'https://example.invalid/repo');
      assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false);
    `);
  });

  it('parses normal multipart data and rejects a truncated upload with Nest-resolved Multer', () => {
    probe(`
      const { createRequire } = require('node:module');
      const multer = createRequire(require.resolve('@nestjs/platform-express'))('multer');
      const { Readable } = require('node:stream');
      const parse = body => new Promise(resolve => {
        const req = Readable.from([Buffer.from(body)]);
        req.headers = {
          'content-type': 'multipart/form-data; boundary=dependency-boundary',
          'content-length': String(Buffer.byteLength(body))
        };
        const middleware = multer({ limits: { fileSize: 32, files: 1 } }).single('upload');
        middleware(req, {}, error => resolve({ error, req }));
      });
      const prefix = '--dependency-boundary\\r\\nContent-Disposition: form-data; name="upload"; filename="a.txt"\\r\\nContent-Type: text/plain\\r\\n\\r\\n';
      const good = await parse(prefix + 'hello\\r\\n--dependency-boundary--\\r\\n');
      assert.equal(good.error, undefined);
      assert.equal(good.req.file.buffer.toString(), 'hello');
      const bad = await parse(prefix + 'truncated');
      assert.match(bad.error.message, /Unexpected end of form/);
      const large = await parse(prefix + 'x'.repeat(33) + '\\r\\n--dependency-boundary--\\r\\n');
      assert.equal(large.error.code, 'LIMIT_FILE_SIZE');
    `);
  });

  it('decodes normal WebSocket frames and rejects oversized and excess-fragment input', () => {
    probe(`
      const { Receiver } = require('ws');
      const normal = new Receiver({ maxPayload: 4 });
      const message = new Promise(resolve => normal.once('message', data => resolve(data.toString())));
      normal.end(Buffer.from([0x81, 2, 0x6f, 0x6b]));
      assert.equal(await message, 'ok');
      const oversized = new Receiver({ maxPayload: 1 });
      const overflow = new Promise(resolve => oversized.once('error', resolve));
      oversized.end(Buffer.from([0x81, 2, 0x6f, 0x6b]));
      assert.equal((await overflow).code, 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH');
      const fragmented = new Receiver({ maxFragments: 1 });
      const fragments = new Promise(resolve => fragmented.once('error', resolve));
      fragmented.end(Buffer.from([0x01, 1, 0x61, 0x80, 1, 0x62]));
      assert.equal((await fragments).code, 'WS_ERR_TOO_MANY_BUFFERED_PARTS');
    `);
  });
});
