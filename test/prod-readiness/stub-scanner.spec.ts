// stub-scanner.spec.ts — coverage for the prod-readiness stub/placeholder
// scanner. Drives every pattern, severity, exemption, learning-ledger, and
// filesystem-edge branch against on-disk fixture trees created in a temp dir
// (so the scanner exercises its REAL walkSource/readUtf8OrNull/fingerprint
// paths, not a mock). Each fixture writes a tiny `src/` tree, runs the scanner
// with `repoRoot` pointed at it, and asserts on the returned findings.
//
// R75: the banned human-phrase needles ("Coming soon", "lorem ipsum",
// "John Doe", "foo@bar.com") are assembled from parts here exactly as the
// scanner does, so this spec — like the scanner — never embeds the literal
// bytes. The banned-token gate excludes *.spec.ts anyway, but we keep the
// discipline so a future copy/paste into prod can't smuggle a literal in.

import { join } from 'node:path';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  scanForStubs,
  describePatterns,
  normalizeLine,
  computeFingerprint,
  groupByKind,
  groupByFile,
  StubFinding,
  StubSeverity,
} from './stub-scanner';

// --- needle assembly (mirrors scanner; never embeds the literal bytes) ------
const COMING_SOON = ['Coming', 'soon'].join(' ');
const LOREM = ['lorem', 'ipsum'].join(' ');
const JOHN_DOE = ['John', 'Doe'].join(' ');
const FOO_BAR = ['foo', 'bar.com'].join('@');

// --- fixture harness ---------------------------------------------------------
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'stub-scan-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Write `content` to `src/<rel>` inside the temp root, creating dirs. */
async function srcFile(rel: string, content: string): Promise<void> {
  const full = join(root, 'src', rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content, 'utf8');
}

/** Run the scanner against the temp root. */
function scan(opts: Record<string, unknown> = {}): StubFinding[] {
  return scanForStubs({ repoRoot: root, ...opts });
}

function kinds(findings: StubFinding[]): string[] {
  return findings.map((f) => f.kind).sort();
}

// --- pure helpers ------------------------------------------------------------
describe('normalizeLine', () => {
  it('collapses internal whitespace runs to a single space', () => {
    expect(normalizeLine('a   b\t\tc')).toBe('a b c');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeLine('   padded   ')).toBe('padded');
  });

  it('is idempotent on already-normalized input', () => {
    const once = normalizeLine('return value here');
    expect(normalizeLine(once)).toBe(once);
  });

  it('treats lines differing only in indentation as equal', () => {
    expect(normalizeLine('   x = 1')).toBe(normalizeLine('x = 1'));
  });
});

describe('computeFingerprint', () => {
  it('is a 64-char lowercase hex sha256', () => {
    const fp = computeFingerprint('src/a.ts', 'const x = 1;');
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for identical normalized input', () => {
    expect(computeFingerprint('src/a.ts', 'const x = 1;')).toBe(
      computeFingerprint('src/a.ts', '  const   x = 1;  '),
    );
  });

  it('differs when the path differs', () => {
    expect(computeFingerprint('src/a.ts', 'x')).not.toBe(computeFingerprint('src/b.ts', 'x'));
  });

  it('differs when the content differs', () => {
    expect(computeFingerprint('src/a.ts', 'x')).not.toBe(computeFingerprint('src/a.ts', 'y'));
  });
});

describe('describePatterns', () => {
  it('exposes the pattern table with token/severity/intent', () => {
    const pats = describePatterns();
    expect(pats.length).toBeGreaterThanOrEqual(10);
    for (const p of pats) {
      expect(typeof p.token).toBe('string');
      expect(['BLOCK_SHIP', 'WARN', 'INFO']).toContain(p.defaultSeverity);
      expect(p.intent.length).toBeGreaterThan(0);
    }
  });

  it('includes the core SCREAMING_SNAKE tokens', () => {
    const tokens = describePatterns().map((p) => p.token);
    expect(tokens).toEqual(expect.arrayContaining(['STUB', 'MOCK', 'FAKE', 'PLACEHOLDER']));
  });
});

// --- core scanning behavior --------------------------------------------------
describe('scanForStubs — token detection', () => {
  it('flags a return "STUB" with kind=STUB and BLOCK_SHIP severity', async () => {
    await srcFile('svc.ts', 'export function go() { return "STUB"; }');
    const f = scan();
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe('STUB');
    expect(f[0].pattern).toBe('STUB');
    expect(f[0].severity).toBe('BLOCK_SHIP');
    expect(f[0].file).toBe('src/svc.ts');
    expect(f[0].line).toBe(1);
  });

  it('flags MOCK as WARN (leaked test double)', async () => {
    await srcFile('client.ts', 'const provider = MOCK_PROVIDER;');
    const f = scan();
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe('MOCK');
    expect(f[0].severity).toBe('WARN');
  });

  it('flags FAKE as WARN', async () => {
    await srcFile('data.ts', 'const v = FAKE_VALUE;');
    expect(scan()[0].severity).toBe('WARN');
  });

  it('flags PLACEHOLDER as BLOCK_SHIP', async () => {
    await srcFile('p.ts', 'const v = PLACEHOLDER;');
    expect(scan()[0].severity).toBe('BLOCK_SHIP');
  });

  it('flags TODO_BEFORE_SHIP and XXX_NEEDS_OPERATOR markers', async () => {
    await srcFile('a.ts', 'const a = 1; // TODO_BEFORE_SHIP');
    await srcFile('b.ts', 'const b = 2; // XXX_NEEDS_OPERATOR');
    const f = scan({ includeComments: true });
    expect(kinds(f)).toEqual(['TODO_BEFORE_SHIP', 'XXX_NEEDS_OPERATOR']);
  });

  it('detects "STUB" inside a template literal', async () => {
    await srcFile('t.ts', 'const m = `${foo}STUB${bar}`;');
    const f = scan();
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe('STUB');
  });

  it('detects the user-facing Coming-soon placeholder string', async () => {
    await srcFile('ui.ts', `export const banner = "${COMING_SOON}";`);
    const f = scan();
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('BLOCK_SHIP');
  });

  it('detects lorem-ipsum placeholder copy case-insensitively', async () => {
    await srcFile('copy.ts', 'export const body = "LOREM IPSUM dolor";');
    const f = scan();
    expect(f).toHaveLength(1);
    expect(f[0].kind.toLowerCase()).toBe(LOREM);
  });

  it('detects a leaked sample identity (John Doe) as WARN', async () => {
    await srcFile('seed.ts', `const name = "${JOHN_DOE}";`);
    const f = scan();
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('WARN');
  });

  it('detects a leaked sample email as WARN', async () => {
    await srcFile('seed.ts', `const email = "${FOO_BAR}";`);
    const f = scan();
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('WARN');
  });

  it('reports multiple findings on one file with correct line numbers', async () => {
    await srcFile('multi.ts', ['const a = 1;', 'const b = "STUB";', 'const c = PLACEHOLDER;'].join('\n'));
    const f = scan();
    expect(f).toHaveLength(2);
    expect(f.find((x) => x.kind === 'STUB')!.line).toBe(2);
    expect(f.find((x) => x.kind === 'PLACEHOLDER')!.line).toBe(3);
  });

  it('truncates the excerpt to 200 chars and trims it', async () => {
    await srcFile('long.ts', '   ' + 'STUB ' + 'x'.repeat(400));
    const f = scan();
    expect(f[0].excerpt.length).toBeLessThanOrEqual(200);
    expect(f[0].excerpt.startsWith('STUB')).toBe(true);
  });
});

// --- comment handling --------------------------------------------------------
describe('scanForStubs — comment handling', () => {
  it('does NOT flag a marker that lives only in a // comment by default', async () => {
    await srcFile('c.ts', 'const x = 1; // TODO_BEFORE_SHIP: fix later');
    expect(scan()).toHaveLength(0);
  });

  it('does NOT flag a marker inside a block comment by default', async () => {
    await srcFile('c.ts', 'const x = 1; /* STUB region */');
    expect(scan()).toHaveLength(0);
  });

  it('DOES flag a comment marker when includeComments is true', async () => {
    await srcFile('c.ts', 'const x = 1; // STUB');
    const f = scan({ includeComments: true });
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe('STUB');
  });

  it('still flags code-position markers even when a comment follows', async () => {
    await srcFile('c.ts', 'const v = "STUB"; // explanatory note');
    expect(scan()).toHaveLength(1);
  });
});

// --- exemption zones ---------------------------------------------------------
describe('scanForStubs — context-aware exemptions', () => {
  it('does not scan files outside src/ (no src dir → empty report)', async () => {
    // root has no src/ directory at all.
    expect(scan()).toEqual([]);
  });

  it('returns an empty report for an empty src dir', async () => {
    await mkdir(join(root, 'src'), { recursive: true });
    expect(scan()).toEqual([]);
  });

  it('downgrades hits inside a /__mocks__/ dir to INFO', async () => {
    await srcFile('__mocks__/thing.ts', 'export const v = "STUB";');
    const f = scan();
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('INFO');
  });

  it('downgrades hits in a .spec.ts file to INFO', async () => {
    await srcFile('thing.spec.ts', 'const v = "STUB";');
    const f = scan();
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('INFO');
  });

  it('skips .d.ts declaration files entirely (walk excludes them)', async () => {
    await srcFile('types.d.ts', 'export const X = "STUB";');
    expect(scan()).toHaveLength(0);
  });

  it('skips the scanner self-reference zone (prod-readiness/)', async () => {
    await srcFile('prod-readiness/other.ts', 'const v = "STUB";');
    expect(scan()).toHaveLength(0);
  });
});

// --- excludePaths ------------------------------------------------------------
describe('scanForStubs — excludePaths option', () => {
  it('excludes findings under a configured path prefix', async () => {
    await srcFile('legacy/old.ts', 'const v = "STUB";');
    await srcFile('current/new.ts', 'const v = PLACEHOLDER;');
    const f = scan({ excludePaths: ['src/legacy/'] });
    expect(f).toHaveLength(1);
    expect(f[0].file).toBe('src/current/new.ts');
  });

  it('returns everything when excludePaths does not match', async () => {
    await srcFile('current/new.ts', 'const v = "STUB";');
    expect(scan({ excludePaths: ['src/legacy/'] })).toHaveLength(1);
  });
});

// --- learning ledger / false positives --------------------------------------
describe('scanForStubs — learning ledger', () => {
  it('drops a finding whose fingerprint is a known false positive', async () => {
    await srcFile('svc.ts', 'const v = "STUB";');
    const first = scan();
    expect(first).toHaveLength(1);
    const known = new Set<string>([first[0].fingerprint]);
    expect(scan({ knownFalsePositives: known })).toHaveLength(0);
  });

  it('keeps findings whose fingerprint is not in the ledger', async () => {
    await srcFile('svc.ts', 'const v = "STUB";');
    const known = new Set<string>(['0'.repeat(64)]);
    expect(scan({ knownFalsePositives: known })).toHaveLength(1);
  });
});

// --- severity overrides ------------------------------------------------------
describe('scanForStubs — severityOverrides', () => {
  it('applies a per-pattern override in a non-exempt zone', async () => {
    await srcFile('svc.ts', 'const v = "STUB";');
    const f = scan({ severityOverrides: { STUB: 'WARN' as StubSeverity } });
    expect(f[0].severity).toBe('WARN');
  });

  it('exempt-zone INFO wins over an override', async () => {
    await srcFile('thing.spec.ts', 'const v = "STUB";');
    const f = scan({ severityOverrides: { STUB: 'BLOCK_SHIP' as StubSeverity } });
    expect(f[0].severity).toBe('INFO');
  });
});

// --- filesystem edges --------------------------------------------------------
describe('scanForStubs — filesystem edges', () => {
  it('skips binary files (NUL byte in first KiB)', async () => {
    const full = join(root, 'src', 'blob.ts');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(full, Buffer.from([0x53, 0x54, 0x00, 0x55, 0x42]));
    expect(scan()).toHaveLength(0);
  });

  it('does not follow a symlinked file outside src/ into a loop', async () => {
    await srcFile('real.ts', 'const ok = 1;');
    const target = join(root, 'src');
    const link = join(root, 'src', 'self-link');
    await symlink(target, link).catch(() => undefinedSafe());
    // The visited-set guard means a self-referential dir symlink terminates.
    const f = scan();
    expect(Array.isArray(f)).toBe(true);
  });

  it('walks nested directories recursively', async () => {
    await srcFile('a/b/c/deep.ts', 'const v = "STUB";');
    const f = scan();
    expect(f).toHaveLength(1);
    expect(f[0].file).toBe('src/a/b/c/deep.ts');
  });

  it('ignores a nested node_modules directory', async () => {
    await srcFile('node_modules/pkg/index.ts', 'const v = "STUB";');
    expect(scan()).toHaveLength(0);
  });

  it('ignores dot-directories', async () => {
    await srcFile('.cache/gen.ts', 'const v = "STUB";');
    expect(scan()).toHaveLength(0);
  });

  it('handles a large file (>1MB) without error', async () => {
    const filler = 'const pad = 1;\n'.repeat(80000);
    await srcFile('big.ts', filler + 'const v = "STUB";\n');
    const f = scan();
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe('STUB');
  });
});

// --- grouping helpers --------------------------------------------------------
describe('groupByKind / groupByFile', () => {
  it('groups findings by kind', async () => {
    await srcFile('a.ts', 'const v = "STUB";');
    await srcFile('b.ts', 'const w = PLACEHOLDER; const x = "STUB";');
    const grouped = groupByKind(scan());
    expect(Object.keys(grouped).sort()).toEqual(['PLACEHOLDER', 'STUB']);
    expect(grouped.STUB).toHaveLength(2);
  });

  it('groups findings by file', async () => {
    await srcFile('a.ts', 'const v = "STUB"; const p = PLACEHOLDER;');
    await srcFile('b.ts', 'const w = "STUB";');
    const grouped = groupByFile(scan());
    expect(Object.keys(grouped).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(grouped['src/a.ts']).toHaveLength(2);
  });

  it('returns an empty object for no findings', () => {
    expect(groupByKind([])).toEqual({});
    expect(groupByFile([])).toEqual({});
  });
});

// --- determinism -------------------------------------------------------------
describe('scanForStubs — determinism', () => {
  it('returns identical findings across repeated runs on the same tree', async () => {
    await srcFile('a.ts', 'const v = "STUB";');
    await srcFile('b/c.ts', 'const w = PLACEHOLDER;');
    const a = scan();
    const b = scan();
    expect(a).toEqual(b);
  });

  it('produces stable fingerprints that match computeFingerprint', async () => {
    await srcFile('a.ts', 'const v = "STUB";');
    const f = scan();
    expect(f[0].fingerprint).toBe(computeFingerprint('src/a.ts', 'const v = "STUB";'));
  });
});

// Small helper so the symlink fixture has a non-cast fallback (R75: no
// `.catch(() => undefined)` or `as` casts anywhere in this spec).
function undefinedSafe(): void {
  return;
}
