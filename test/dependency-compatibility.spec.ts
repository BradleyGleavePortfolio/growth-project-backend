import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as nodePath from 'node:path';

interface ProbeOptions {
  // A directory inside a consumer package (usually the one holding its resolved
  // entry file, not necessarily the package root), so bare specifiers resolve
  // upward through that consumer's own node_modules chain, not the repo root's.
  readonly cwd?: string;
  // 'module' runs the script as ESM, which is the only way a bare specifier
  // selects a package's `import` condition; a require-resolved file URL cannot.
  readonly type?: 'commonjs' | 'module';
}

// Run real package APIs in Node, outside Jest's module rewriting. This also
// exercises Prisma's native dynamic-import boundary and Danger's Git subprocess.
function probe(script: string, options: ProbeOptions = {}): void {
  const runsAsModule = options.type === 'module';
  const source = runsAsModule
    ? `import assert from 'node:assert/strict';
       try {
         ${script}
         process.stdout.write('dependency-probe-ok');
       } catch (error) { console.error(error); process.exitCode = 1; }`
    : `const assert = require('node:assert/strict');
       (async () => { ${script} })().then(
         () => process.stdout.write('dependency-probe-ok'),
         error => { console.error(error); process.exitCode = 1; }
       );`;
  const result = spawnSync(
    process.execPath,
    runsAsModule ? ['--input-type=module', '-e', source] : ['-e', source],
    {
      cwd: options.cwd ?? process.cwd(),
      env: process.env,
      encoding: 'utf8',
      timeout: 20000,
    },
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

  it('preserves Prisma deepmerge CommonJS semantics and bounds cyclic input', () => {
    // CommonJS (`require`) condition only; the ESM condition is a separate entry
    // file and is covered by the bare-specifier probe below.
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
      assert.match(local.resolve('deepmerge-ts'), /deepmerge-ts[\\\\/]dist[\\\\/]index\\.cjs$/);
    `);
  });

  it('merges through the deepmerge ESM condition resolved from the Prisma consumer', () => {
    // @prisma/config imports deepmerge-ts by bare specifier, so its real entry is
    // dist/index.mjs, not the dist/index.cjs file `require` selects. The probe runs
    // with the directory holding the consumer's resolved entry file as cwd - that is
    // wherever the entry lives inside the package (commonly a build directory), not
    // necessarily the package root - because Node's node_modules lookup walks upward
    // from there and therefore follows the consumer's own resolution chain rather
    // than the repository root's. `createRequire(__filename)` is used so this path
    // comes from real Node resolution, not Jest's resolver; no package API is
    // loaded in the Jest process.
    const consumerEntryDirectory = nodePath.dirname(
      createRequire(__filename).resolve('@prisma/config'),
    );
    probe(
      `
      const { createRequire } = await import('node:module');
      const path = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      assert.equal(typeof import.meta.resolve, 'function');
      const esmUrl = import.meta.resolve('deepmerge-ts');
      assert.match(esmUrl, /deepmerge-ts\\/dist\\/index\\.mjs$/);
      const requireFromConsumer = createRequire(path.join(process.cwd(), 'esm-probe.cjs'));
      const requirePath = requireFromConsumer.resolve('deepmerge-ts');
      assert.match(requirePath, /deepmerge-ts[\\\\/]dist[\\\\/]index\\.cjs$/);
      assert.equal(
        path.dirname(path.dirname(fileURLToPath(esmUrl))),
        path.dirname(path.dirname(requirePath))
      );
      const { deepmerge, deepmergeInto } = await import('deepmerge-ts');
      assert.notEqual(deepmerge, requireFromConsumer('deepmerge-ts').deepmerge);
      assert.deepEqual(deepmerge(
        { nested: { a: 1 }, list: [1], map: new Map([['a', 1]]), set: new Set([1]) },
        { nested: { b: 2 }, list: [2], map: new Map([['b', 2]]), set: new Set([2]) }
      ), {
        nested: { a: 1, b: 2 }, list: [1, 2],
        map: new Map([['a', 1], ['b', 2]]), set: new Set([1, 2])
      });
      const left = { name: 'left' }; left.self = left;
      const right = { name: 'right' }; right.self = right;
      const merged = deepmerge(left, right);
      assert.equal(merged.name, 'right');
      assert.equal(merged.self, merged);
      const target = { nested: { a: 1 }, list: [1] };
      deepmergeInto(target, { nested: { b: 2 }, list: [2] });
      assert.deepEqual(target, { nested: { a: 1, b: 2 }, list: [1, 2] });
    `,
      { cwd: consumerEntryDirectory, type: 'module' },
    );
  });

  it('loads an actual Prisma config through c12 and the overridden merger', () => {
    probe(`
      const fs = require('node:fs');
      const path = require('node:path');
      const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'prisma-dependency-'));
      // The fixture survives only when the probe fails, so a real failure keeps its
      // exact input inspectable while a passing run leaves no directory behind.
      let retainForDiagnostics = false;
      try {
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
      } catch (error) {
        retainForDiagnostics = true;
        console.error('prisma config fixture retained at ' + dir);
        throw error;
      } finally {
        if (!retainForDiagnostics) {
          fs.rmSync(dir, { recursive: true, force: true });
          assert.equal(fs.existsSync(dir), false);
        }
      }
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
      // First concern: Danger's local Git-object read, with no remote platform.
      const { localGetFileAtSHA } = require('danger/distribution/platforms/git/localGetFileAtSHA');
      const original = await localGetFileAtSHA('package.json', '.', 'HEAD');
      assert.equal(JSON.parse(original).name, 'growth-project-backend');
      // Second, separate concern: ini@5 is installed because danger 13 declares
      // 'ini': '^5.0.0', so it is resolved from danger here. Danger 13 dropped
      // parse-git-config and nothing read in this repository proves that Danger
      // parses .git/config through ini, so the assertions below are about the
      // installed parser's own behaviour only and claim nothing about Danger's
      // Git-config path.
      const { createRequire } = require('node:module');
      const ini = createRequire(require.resolve('danger'))('ini');
      const parsed = ini.parse('[remote "origin"]\\nurl=https://example.invalid/repo\\n');
      assert.equal(parsed['remote "origin"'].url, 'https://example.invalid/repo');
      // Hostile section and key names are the realistic attack shape for any INI
      // document this parser is handed: assert what ini@5 actually produces for
      // them, not merely that a benign document left Object.prototype alone.
      const hostile = ini.parse([
        '[remote "origin"]',
        'url=https://example.invalid/repo',
        '__proto__=key-payload',
        '__proto__[]=array-payload',
        'safe=kept',
        '[__proto__]',
        'polluted=section-payload',
        '["__proto__"]',
        'polluted=quoted-payload',
        '[constructor.prototype]',
        'polluted=nested-payload',
        ''
      ].join('\\n'));
      assert.deepEqual(Object.keys(hostile).sort(), ['constructor', 'remote "origin"']);
      assert.deepEqual(Object.keys(hostile['remote "origin"']).sort(), ['safe', 'url']);
      assert.equal(hostile['remote "origin"'].url, 'https://example.invalid/repo');
      assert.equal(hostile['remote "origin"'].safe, 'kept');
      assert.equal(Object.getPrototypeOf(hostile), null);
      assert.equal(Object.getPrototypeOf(hostile['remote "origin"']), null);
      // A dotted 'constructor.prototype' section becomes inert own data on a
      // null-prototype object; it is not the real Object.prototype.
      assert.equal(hostile.constructor.prototype.polluted, 'nested-payload');
      assert.notEqual(hostile.constructor, Object);
      assert.equal(Object.getPrototypeOf(hostile.constructor.prototype), null);
      assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'safe'), false);
      assert.equal({}.polluted, undefined);
      assert.equal([].polluted, undefined);
      assert.equal(Object.prototype.polluted, undefined);
      assert.equal(ini.parse('__proto__=x\\n').__proto__, undefined);
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

  it('keeps every advisory-patched floor resolved under its real consumer', () => {
    // The three consumer-scoped overrides only apply while their parent stays at
    // the keyed version, so this probe checks the resolved graph rather than the
    // manifest text: if a parent bump, dedupe or override edit drops a patched
    // floor, this fails. Floors and advisory sources are recorded in
    // docs/dependencies/2026-09-op81-dependency-repair.md.
    probe(`
      const fs = require('node:fs');
      const path = require('node:path');
      const { createRequire } = require('node:module');
      // Comparisons use the installed semver, resolved through ts-jest's declared
      // '^7.7.4' dependency, so no manifest entry is added for a test helper. Its
      // prerelease ordering is asserted first because a prerelease of a patched
      // version is below the stable floor and must be reported as a regression.
      const semver = createRequire(require.resolve('ts-jest'))('semver');
      assert.equal(semver.gte('8.0.0-rc.1', '8.0.0'), false);
      assert.equal(semver.gte('8.0.0', '8.0.0'), true);
      assert.equal(semver.gte('8.1.0', '8.0.0'), true);
      // Floors configured from the advisories cited in the docs note, keyed by the
      // major line each patched release belongs to. A major absent here has not
      // been reviewed against an advisory, which is a different statement from
      // 'that major has no patched release'.
      const patchedByMajor = {
        'deepmerge-ts': { 8: '8.0.0' },
        multer: { 2: '2.3.0' },
        qs: { 6: '6.16.0' },
        'js-yaml': { 3: '3.15.2', 4: '4.3.2' },
        minimatch: {
          3: '3.1.3', 4: '4.2.4', 5: '5.1.7', 6: '6.2.1',
          7: '7.4.7', 8: '8.0.5', 9: '9.0.6', 10: '10.2.1'
        },
        diff: { 3: '3.5.1', 4: '4.0.4', 5: '5.2.2', 8: '8.0.3', 9: '9.0.0' }
      };
      // Each chain is walked link by link from the previous link's resolved entry,
      // so a copy nested under an intermediate consumer is found rather than a
      // sibling of the first parent.
      const chains = [
        [['@prisma/config'], 'deepmerge-ts'],
        [['@nestjs/platform-express'], 'multer'],
        [['@nestjs/platform-express', 'express'], 'qs'],
        [['@nestjs/platform-express', 'express', 'body-parser'], 'qs'],
        [['@nestjs/swagger/package.json'], 'js-yaml'],
        [['@istanbuljs/load-nyc-config'], 'js-yaml'],
        [['test-exclude'], 'minimatch'],
        [['ts-node'], 'diff']
      ];
      const manifestVersion = (entry, name) => {
        let dir = path.dirname(entry);
        for (;;) {
          const manifest = path.join(dir, 'package.json');
          if (fs.existsSync(manifest)) {
            const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
            if (parsed.name === name) return parsed.version;
          }
          const parent = path.dirname(dir);
          assert.notEqual(parent, dir);
          dir = parent;
        }
      };
      const resolveChain = (chain, dependency) => {
        let entry = require.resolve(chain[0]);
        for (const link of chain.slice(1)) {
          entry = createRequire(entry).resolve(link);
        }
        return manifestVersion(createRequire(entry).resolve(dependency), dependency);
      };
      const resolved = {};
      const regressions = [];
      for (const [chain, dependency] of chains) {
        const label = chain.join(' -> ') + ' -> ' + dependency;
        const version = resolveChain(chain, dependency);
        resolved[label] = version;
        const floor = patchedByMajor[dependency][semver.major(version)];
        if (floor === undefined) {
          regressions.push(label + '@' + version + ' resolves major ' +
            semver.major(version) + ', which has no configured floor and is unreviewed');
        } else if (!semver.gte(version, floor)) {
          regressions.push(label + '@' + version + ' is below patched floor ' + floor);
        }
      }
      assert.deepEqual(regressions, []);
      // The override-pinned resolutions are exact, so any drift is a manifest change.
      assert.deepEqual({
        deepmerge: resolved['@prisma/config -> deepmerge-ts'],
        multer: resolved['@nestjs/platform-express -> multer'],
        expressQs: resolved['@nestjs/platform-express -> express -> qs'],
        bodyParserQs: resolved['@nestjs/platform-express -> express -> body-parser -> qs'],
        swaggerYaml: resolved['@nestjs/swagger/package.json -> js-yaml'],
        diff: resolved['ts-node -> diff']
      }, {
        deepmerge: '8.0.0', multer: '2.3.0', expressQs: '6.16.0',
        bodyParserQs: '6.16.0', swaggerYaml: '4.3.2', diff: '9.0.0'
      });
    `);
  });
});
