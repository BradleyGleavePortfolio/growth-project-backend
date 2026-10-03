// Behaviour tests for scripts/ci/audit-gate.mjs, the evaluator behind the
// required check "npm audit (high+critical, whole graph)" (OR-114-2).
//
// Every case runs the REAL script as a child process (no module import, no
// clock or registry override): inputs are JSON fixture files, the clock is the
// real UTC clock (exception dates are generated relative to it) and the
// registry is reached through a fake `npm` on an isolated PATH, so no network
// access occurs. audit-braces-dev.json is the real `npm audit --json` report
// for this lockfile on 2026-10-02; every other audit fixture is SYNTHETIC and
// says so. Pass cases assert exit 0 AND the PASS line; fail cases assert exit 1
// AND the stable failure code, so every case fails while the script is absent.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const GATE = join(ROOT, 'scripts', 'ci', 'audit-gate.mjs');
const FIXTURES = join(__dirname, 'fixtures', 'audit-gate');
const BASH = ['/bin/bash', '/usr/bin/bash'].find((p) => fs.existsSync(p));
if (!BASH) throw new Error('harness cannot resolve bash');

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fixture JSON is mutated freely
type Json = Record<string, any>;
interface Exception {
  ghsa: string;
  package: string;
  max_version: string;
  reason: string;
  expires: string;
  owner_ruling: string;
}
interface Run {
  audit?: Json | string;
  auditExit?: string;
  lock?: Json;
  exceptions?: Json | string;
  registry?: { stdout: string; exit: number };
  argv?: string[];
}

const fixture = (name: string): Json => JSON.parse(fs.readFileSync(join(FIXTURES, name), 'utf8'));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const dayFromToday = (days: number): string =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const BRACES: Exception = {
  ghsa: 'GHSA-vfj7-8cjw-p6xm',
  package: 'braces',
  max_version: '3.0.3',
  reason: 'SYNTHETIC test reason: no patched release exists',
  expires: dayFromToday(10),
  owner_ruling: 'OR-114-2 (test)',
};
const exceptionsFile = (...entries: Exception[]): Json => ({ schema: 1, exceptions: entries });
const REGISTRY_NO_PATCH = { stdout: '["3.0.0","3.0.1","3.0.2","3.0.3"]', exit: 0 };

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const writeInput = (dir: string, name: string, value: Json | string): string => {
  const path = join(dir, name);
  fs.writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  return path;
};

const runGate = (run: Run) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'audit-gate-'));
  tempDirs.push(dir);
  const bin = join(dir, 'bin');
  fs.mkdirSync(bin);
  // Fake npm: only `npm view` is expected from the gate; every call is logged.
  fs.writeFileSync(
    join(bin, 'npm'),
    [
      `#!${BASH}`,
      'printf "%s\\n" "$*" >> "$FAKE_NPM_LOG"',
      'if [ "$1" != view ]; then echo "unexpected npm call" >&2; exit 99; fi',
      'if [ -n "$FAKE_VIEW_STDOUT" ]; then echo "$FAKE_VIEW_STDOUT"; fi',
      'exit "$FAKE_VIEW_EXIT"',
      '',
    ].join('\n'),
  );
  fs.chmodSync(join(bin, 'npm'), 0o755);
  const audit = writeInput(dir, 'audit.json', run.audit ?? fixture('audit-clean.json'));
  const lock = writeInput(dir, 'package-lock.json', run.lock ?? fixture('lock-dev-only.json'));
  const exceptions = writeInput(dir, 'audit-exceptions.json', run.exceptions ?? exceptionsFile());
  const registry = run.registry ?? REGISTRY_NO_PATCH;
  const npmLog = join(dir, 'npm.log');
  const argv = run.argv ?? [
    '--audit',
    audit,
    '--audit-exit',
    run.auditExit ?? '0',
    '--lockfile',
    lock,
    '--exceptions',
    exceptions,
  ];
  const proc = spawnSync(process.execPath, [GATE, ...argv], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 20000,
    killSignal: 'SIGKILL',
    env: {
      PATH: bin,
      HOME: dir,
      FAKE_NPM_LOG: npmLog,
      FAKE_VIEW_STDOUT: registry.stdout,
      FAKE_VIEW_EXIT: String(registry.exit),
    },
  });
  if (proc.error) throw new Error(`harness failure: ${proc.error.message}`);
  if (proc.status === null) throw new Error(`harness failure: killed by ${String(proc.signal)}`);
  return {
    status: proc.status,
    stdout: proc.stdout,
    stderr: proc.stderr,
    npmCalls: fs.existsSync(npmLog)
      ? fs.readFileSync(npmLog, 'utf8').split('\n').filter(Boolean)
      : [],
  };
};

const expectPass = (result: ReturnType<typeof runGate>) => {
  expect(result.stdout).toContain('[audit-gate] PASS');
  expect(result.stdout).not.toContain('[audit-gate] FAIL');
  expect(result.status).toBe(0);
};
const expectFail = (result: ReturnType<typeof runGate>, code: string, text?: string) => {
  expect(result.stdout).toContain(`[audit-gate] FAIL ${code}:`);
  expect(result.stdout).toContain(`::error title=npm audit gate (${code})::`);
  if (text) expect(result.stdout).toContain(text);
  expect(result.stdout).not.toContain('[audit-gate] PASS');
  expect(result.status).toBe(1);
};

// The real braces report (exit 1) with a valid braces exception.
const bracesRun = (overrides: Run = {}): Run => ({
  audit: fixture('audit-braces-dev.json'),
  auditExit: '1',
  exceptions: exceptionsFile(BRACES),
  ...overrides,
});

describe('audit-gate: required outcomes (OR-114-2)', () => {
  it('passes a graph with no vulnerabilities', () => {
    const result = runGate({ audit: fixture('audit-clean.json'), auditExit: '0' });
    expectPass(result);
    expect(result.npmCalls).toEqual([]);
  });

  it('passes the excepted dev-only braces advisory and prints the applied exception loudly', () => {
    const result = runGate(bracesRun());
    expectPass(result);
    expect(result.stdout).toContain(
      `[audit-gate] APPLIED EXCEPTION advisory=GHSA-vfj7-8cjw-p6xm package=braces locked=node_modules/braces@3.0.3 max_version=3.0.3 expires=${BRACES.expires}`,
    );
    expect(result.stdout).toContain(
      '::warning title=Audit exception applied (GHSA-vfj7-8cjw-p6xm)::',
    );
    expect(result.stdout).toContain(`reason: ${BRACES.reason}`);
    expect(result.stdout).toContain(`owner_ruling: ${BRACES.owner_ruling}`);
    // The propagated findings are covered through the chain, not ignored.
    expect(result.stdout).toContain('covered: high "micromatch" (chain: micromatch <- braces)');
    expect(result.stdout).toContain(
      'covered: high "danger" (chain: danger <- micromatch <- braces)',
    );
    expect(result.stdout).toContain('non-blocking moderate: multer');
    expect(result.npmCalls).toEqual(['view braces versions --json']);
  });

  it('fails the same advisory when any lockfile copy of braces is a prod copy', () => {
    const lock = fixture('lock-dev-only.json');
    lock.packages['node_modules/some-prod-lib'] = { version: '1.0.0' };
    lock.packages['node_modules/some-prod-lib/node_modules/braces'] = { version: '3.0.3' };
    const result = runGate(bracesRun({ lock }));
    expectFail(result, 'E_PROD_COPY', 'node_modules/some-prod-lib/node_modules/braces');
  });

  it('fails when the excepted copy is devOptional (also an optional prod dependency)', () => {
    const lock = fixture('lock-dev-only.json');
    lock.packages['node_modules/braces'] = { version: '3.0.3', devOptional: true };
    expectFail(runGate(bracesRun({ lock })), 'E_PROD_COPY', 'node_modules/braces');
  });

  it('fails when the excepted copy is optional-prod or peer-prod (no dev flag)', () => {
    for (const flags of [{ optional: true }, { peer: true }]) {
      const lock = fixture('lock-dev-only.json');
      lock.packages['node_modules/braces'] = { version: '3.0.3', ...flags };
      expectFail(runGate(bracesRun({ lock })), 'E_PROD_COPY', 'node_modules/braces');
    }
  });

  it('fails when a covered vulnerability in the chain sits on a prod lockfile node', () => {
    const lock = fixture('lock-dev-only.json');
    delete lock.packages['node_modules/danger'].dev;
    expectFail(runGate(bracesRun({ lock })), 'E_PROD_COPY', 'node_modules/danger');
  });

  it('fails an expired exception (expiry today or earlier: today must be strictly before expires)', () => {
    for (const expires of [dayFromToday(0), dayFromToday(-1), '2020-01-01']) {
      const result = runGate(bracesRun({ exceptions: exceptionsFile({ ...BRACES, expires }) }));
      expectFail(result, 'E_EXCEPTION_EXPIRED', `expired on ${expires}`);
    }
  });

  it('fails an exception dated beyond the 31-day horizon (no open-ended exceptions)', () => {
    const result = runGate(
      bracesRun({ exceptions: exceptionsFile({ ...BRACES, expires: dayFromToday(40) }) }),
    );
    expectFail(result, 'E_EXCEPTION_HORIZON');
  });

  it('fails a different high advisory even when the braces exception is present', () => {
    const result = runGate({
      audit: fixture('audit-other-high.json'),
      auditExit: '1',
      exceptions: exceptionsFile(BRACES),
    });
    expectFail(result, 'E_UNEXCEPTED', 'GHSA-2222-3333-4444');
  });

  it('fails a mixed via chain (excepted braces plus any other advisory)', () => {
    const result = runGate(bracesRun({ audit: fixture('audit-mixed-chain.json') }));
    expectFail(result, 'E_UNEXCEPTED', 'GHSA-5555-6666-7777');
    expect(result.stdout).toContain('"micromatch" is not covered');
    expect(result.stdout).toContain('"danger" is not covered');
  });

  it('fails once a patched version exists on the registry', () => {
    const result = runGate(
      bracesRun({ registry: { stdout: '["3.0.2","3.0.3","3.0.4"]', exit: 0 } }),
    );
    expectFail(
      result,
      'E_PATCH_AVAILABLE',
      'patched version available: upgrade and delete the exception (braces 3.0.4 > 3.0.3)',
    );
  });

  it.each([
    ['not JSON', '{"schema": 1, "exceptions": ['],
    ['empty file', ''],
    ['top level is an array', '[]'],
    ['unknown top-level key', JSON.stringify({ ...exceptionsFile(BRACES), extra: true })],
    ['wrong schema', JSON.stringify({ schema: 2, exceptions: [BRACES] })],
    ['exceptions not an array', JSON.stringify({ schema: 1, exceptions: {} })],
    [
      'missing owner_ruling',
      JSON.stringify({
        schema: 1,
        exceptions: [
          Object.fromEntries(Object.entries(BRACES).filter(([k]) => k !== 'owner_ruling')),
        ],
      }),
    ],
    ['extra entry key', JSON.stringify({ schema: 1, exceptions: [{ ...BRACES, scope: 'all' }] })],
    ['wildcard ghsa', JSON.stringify(exceptionsFile({ ...BRACES, ghsa: 'GHSA-*' }))],
    ['range max_version', JSON.stringify(exceptionsFile({ ...BRACES, max_version: '3.x' }))],
    ['impossible date', JSON.stringify(exceptionsFile({ ...BRACES, expires: '2026-02-30' }))],
    [
      'datetime expires',
      JSON.stringify(exceptionsFile({ ...BRACES, expires: '2026-10-31T00:00:00Z' })),
    ],
    ['blank reason', JSON.stringify(exceptionsFile({ ...BRACES, reason: '   ' }))],
    ['duplicate entry', JSON.stringify(exceptionsFile(BRACES, BRACES))],
  ])('fails a malformed exception file: %s', (_label, exceptions) => {
    expectFail(runGate(bracesRun({ exceptions })), 'E_EXCEPTIONS_MALFORMED');
  });
});

describe('audit-gate: narrowness and self-verification', () => {
  it('fails when the locked version is above max_version', () => {
    const lock = fixture('lock-dev-only.json');
    lock.packages['node_modules/braces'].version = '3.0.3';
    const result = runGate(
      bracesRun({ lock, exceptions: exceptionsFile({ ...BRACES, max_version: '3.0.2' }) }),
    );
    expectFail(
      result,
      'E_VERSION_ABOVE_MAX',
      'node_modules/braces@3.0.3 is not <= max_version 3.0.2',
    );
  });

  it('fails a near-miss advisory id for the same package', () => {
    const result = runGate(bracesRun({ audit: fixture('audit-braces-other-ghsa.json') }));
    expectFail(result, 'E_UNEXCEPTED', 'GHSA-vfj7-8cjw-p6xx');
  });

  it('fails an exception whose package name does not match the advisory package', () => {
    const result = runGate(
      bracesRun({ exceptions: exceptionsFile({ ...BRACES, package: 'micromatch' }) }),
    );
    expectFail(result, 'E_UNEXCEPTED', 'GHSA-vfj7-8cjw-p6xm');
  });

  it('fails a stale exception that matches no high/critical finding', () => {
    const result = runGate({
      audit: fixture('audit-clean.json'),
      auditExit: '0',
      exceptions: exceptionsFile(BRACES),
    });
    expectFail(result, 'E_EXCEPTION_UNUSED', 'delete the stale exception');
  });

  it('treats an unreachable registry as no patch, says so loudly, and still gates the audit', () => {
    const result = runGate(bracesRun({ registry: { stdout: '', exit: 1 } }));
    expectPass(result);
    expect(result.stdout).toContain('registry check for braces: UNREACHABLE');
    expect(result.stdout).toContain('::warning title=Registry unreachable (braces)::');
    const blocked = runGate({
      audit: fixture('audit-other-high.json'),
      auditExit: '1',
      registry: { stdout: '', exit: 1 },
    });
    expectFail(blocked, 'E_UNEXCEPTED');
  });

  it('treats unparseable registry output as unreachable, never as a pass signal', () => {
    const result = runGate(bracesRun({ registry: { stdout: 'not json', exit: 0 } }));
    expectPass(result);
    expect(result.stdout).toContain('UNREACHABLE');
  });

  it('does not treat a prerelease above max_version as a patch', () => {
    const result = runGate(bracesRun({ registry: { stdout: '["3.0.3","3.0.4-rc.1"]', exit: 0 } }));
    expectPass(result);
  });

  it('keeps moderate findings non-blocking and listed', () => {
    const result = runGate({ audit: fixture('audit-moderate-only.json'), auditExit: '0' });
    expectPass(result);
    expect(result.stdout).toContain('non-blocking moderate: multer (node_modules/multer)');
  });
});

describe('audit-gate: fails closed on audit infrastructure and inconsistency', () => {
  it.each([['42'], ['124'], ['127'], ['-1'], ['']])('fails an npm exit of "%s"', (code) => {
    expectFail(runGate({ auditExit: code }), 'E_AUDIT_EXIT');
  });
  it('fails npm error JSON', () => {
    expectFail(
      runGate({ audit: fixture('audit-npm-error.json'), auditExit: '1' }),
      'E_AUDIT_UNREADABLE',
    );
  });
  it('fails empty or non-JSON audit output', () => {
    expectFail(runGate({ audit: '', auditExit: '1' }), 'E_AUDIT_UNREADABLE');
    expectFail(runGate({ audit: '# npm audit report', auditExit: '1' }), 'E_AUDIT_UNREADABLE');
  });
  it('fails an unexpected report version', () => {
    const audit = { ...fixture('audit-clean.json'), auditReportVersion: 1 };
    expectFail(runGate({ audit }), 'E_AUDIT_UNREADABLE');
  });
  it('fails metadata that disagrees with the vulnerability list', () => {
    expectFail(
      runGate(bracesRun({ audit: fixture('audit-metadata-mismatch.json') })),
      'E_AUDIT_INCONSISTENT',
    );
  });
  it('fails an npm exit that disagrees with the findings', () => {
    expectFail(runGate(bracesRun({ auditExit: '0' })), 'E_AUDIT_INCONSISTENT');
    expectFail(
      runGate({ audit: fixture('audit-clean.json'), auditExit: '1' }),
      'E_AUDIT_INCONSISTENT',
    );
  });
  it('fails a via reference to a vulnerability the report does not list', () => {
    const audit = clone(fixture('audit-braces-dev.json'));
    audit.vulnerabilities.micromatch.via = ['ghost-package'];
    expectFail(runGate(bracesRun({ audit })), 'E_AUDIT_INCONSISTENT', 'ghost-package');
  });
  it('fails an unreadable lockfile or one without a packages map', () => {
    expectFail(
      runGate(bracesRun({ lock: { lockfileVersion: 1, dependencies: {} } })),
      'E_LOCKFILE_UNREADABLE',
    );
  });
  it('rejects unknown arguments, so no clock or registry override can be passed', () => {
    const result = runGate({
      argv: [
        '--audit',
        'a.json',
        '--audit-exit',
        '0',
        '--lockfile',
        'l.json',
        '--exceptions',
        'e.json',
        '--now',
        '2026-10-01',
      ],
    });
    expectFail(result, 'E_USAGE');
    expectFail(runGate({ argv: ['--audit', 'a.json'] }), 'E_USAGE');
  });
});

describe('committed exception file (.github/audit-exceptions.json)', () => {
  const committed = JSON.parse(
    fs.readFileSync(join(ROOT, '.github', 'audit-exceptions.json'), 'utf8'),
  );
  it('holds exactly the one OR-114-2 braces entry, capped at 3.0.3 and expiring 2026-10-31', () => {
    expect(committed.schema).toBe(1);
    expect(committed.exceptions).toHaveLength(1);
    const [entry] = committed.exceptions;
    expect(Object.keys(entry).sort()).toEqual([
      'expires',
      'ghsa',
      'max_version',
      'owner_ruling',
      'package',
      'reason',
    ]);
    expect(entry).toMatchObject({
      ghsa: 'GHSA-vfj7-8cjw-p6xm',
      package: 'braces',
      max_version: '3.0.3',
      expires: '2026-10-31',
    });
    expect(entry.owner_ruling).toMatch(/^OR-114-2\b/);
  });
});
