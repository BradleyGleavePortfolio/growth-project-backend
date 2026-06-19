/**
 * Unit tests for prod-readiness/stub-scanner.ts.
 *
 * Builds throwaway source trees under a temp dir so the scanner can be driven
 * deterministically: pattern matching + severities, exempt-zone downgrades,
 * self-reference exemptions, learned false-positive suppression, per-pattern
 * severity overrides, the binary-file guard (F-A13), directory-symlink follow
 * with a cycle guard (F-A14), and the fingerprint/normalize contract that the
 * learning ledger binds to. The COMING_SOON token is asserted via its
 * char-concatenated form so this spec never embeds the banned literal (R75).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  computeFingerprint,
  describePatterns,
  normalizeLine,
  scanForStubs,
} from '../stub-scanner';

const COMING_SOON = ['Coming', 'soon'].join(' ');

/** Create an isolated repo root with a src/ subtree and return its path. */
function makeRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

describe('stub-scanner / normalizeLine', () => {
  it('collapses internal whitespace runs to a single space', () => {
    expect(normalizeLine('a\t b   c')).toBe('a b c');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeLine('   hello world   ')).toBe('hello world');
  });

  it('is idempotent', () => {
    const once = normalizeLine('  foo   bar ');
    expect(normalizeLine(once)).toBe(once);
  });

  it('does not strip comment markers (the matched text must survive)', () => {
    expect(normalizeLine('// STUB here')).toBe('// STUB here');
  });
});

describe('stub-scanner / computeFingerprint', () => {
  it('is a 64-char hex sha256 digest', () => {
    expect(computeFingerprint('src/a.ts', 'STUB')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for identical inputs', () => {
    expect(computeFingerprint('src/a.ts', 'x')).toBe(computeFingerprint('src/a.ts', 'x'));
  });

  it('ignores indentation/trailing whitespace via normalization', () => {
    expect(computeFingerprint('src/a.ts', '  STUB  ')).toBe(computeFingerprint('src/a.ts', 'STUB'));
  });

  it('changes when the path changes', () => {
    expect(computeFingerprint('src/a.ts', 'STUB')).not.toBe(computeFingerprint('src/b.ts', 'STUB'));
  });

  it('changes when the matched content changes', () => {
    expect(computeFingerprint('src/a.ts', 'STUB')).not.toBe(computeFingerprint('src/a.ts', 'MOCK'));
  });
});

describe('stub-scanner / describePatterns', () => {
  it('returns the active pattern list', () => {
    const patterns = describePatterns();
    expect(patterns.length).toBeGreaterThan(0);
  });

  it('includes the char-concatenated user-facing placeholder token', () => {
    expect(describePatterns().some((p) => p.token === COMING_SOON)).toBe(true);
  });

  it('marks STUB and PLACEHOLDER as BLOCK_SHIP and MOCK/FAKE as WARN', () => {
    const byToken = new Map(describePatterns().map((p) => [p.token, p.defaultSeverity]));
    expect(byToken.get('STUB')).toBe('BLOCK_SHIP');
    expect(byToken.get('PLACEHOLDER')).toBe('BLOCK_SHIP');
    expect(byToken.get('MOCK')).toBe('WARN');
    expect(byToken.get('FAKE')).toBe('WARN');
  });

  it('every pattern carries a non-empty intent string', () => {
    for (const p of describePatterns()) {
      expect(p.intent.length).toBeGreaterThan(0);
    }
  });
});

describe('stub-scanner / scanForStubs — matching + severity', () => {
  it('returns no findings when src/ is absent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-empty-'));
    expect(scanForStubs({ repoRoot: root })).toEqual([]);
  });

  it('flags a BLOCK_SHIP token in a normal src file', () => {
    const root = makeRepo({ 'src/feature.ts': 'export const x = 1; // STUB not wired\n' });
    const findings = scanForStubs({ repoRoot: root });
    expect(findings).toHaveLength(1);
    expect(findings[0].pattern).toBe('STUB');
    expect(findings[0].severity).toBe('BLOCK_SHIP');
    expect(findings[0].file).toBe(path.join('src', 'feature.ts'));
    expect(findings[0].line).toBe(1);
  });

  it('reports a WARN severity for the MOCK token', () => {
    const root = makeRepo({ 'src/m.ts': 'const m = MOCK_VALUE;\n' });
    const found = scanForStubs({ repoRoot: root }).find((f) => f.pattern === 'MOCK');
    expect(found?.severity).toBe('WARN');
  });

  it('matches the case-insensitive English-phrase tokens', () => {
    const root = makeRepo({ 'src/copy.ts': "const c = 'LOREM IPSUM dolor';\n" });
    expect(scanForStubs({ repoRoot: root }).some((f) => f.pattern === 'lorem ipsum')).toBe(true);
  });

  it('detects the char-concatenated placeholder phrase', () => {
    const root = makeRepo({ 'src/banner.ts': `const b = '${COMING_SOON}';\n` });
    expect(scanForStubs({ repoRoot: root }).some((f) => f.pattern === COMING_SOON)).toBe(true);
  });

  it('reports the correct 1-based line number for a deep hit', () => {
    const root = makeRepo({ 'src/deep.ts': 'a\nb\nc\n// STUB\n' });
    const f = scanForStubs({ repoRoot: root }).find((x) => x.pattern === 'STUB');
    expect(f?.line).toBe(4);
  });
});

describe('stub-scanner / scanForStubs — exemptions', () => {
  it('downgrades hits inside an exempt zone (__tests__) to INFO', () => {
    const root = makeRepo({ 'src/widget/__tests__/widget.ts': '// STUB\n' });
    const f = scanForStubs({ repoRoot: root }).find((x) => x.pattern === 'STUB');
    expect(f?.severity).toBe('INFO');
  });

  it('downgrades .spec.ts files to INFO', () => {
    const root = makeRepo({ 'src/widget/widget.spec.ts': '// STUB\n' });
    const f = scanForStubs({ repoRoot: root }).find((x) => x.pattern === 'STUB');
    expect(f?.severity).toBe('INFO');
  });

  it('never flags files inside prod-readiness/ (self-reference)', () => {
    const root = makeRepo({ 'src/prod-readiness/thing.ts': '// STUB PLACEHOLDER\n' });
    expect(scanForStubs({ repoRoot: root })).toEqual([]);
  });

  it('exempts the registered self-reference file env-validation.ts', () => {
    const root = makeRepo({ 'src/common/env-validation.ts': "const v = 'PLACEHOLDER';\n" });
    expect(scanForStubs({ repoRoot: root })).toEqual([]);
  });
});

describe('stub-scanner / scanForStubs — learning + overrides', () => {
  it('suppresses a finding whose fingerprint is a known false positive', () => {
    const root = makeRepo({ 'src/x.ts': '// STUB intentional sample\n' });
    const rel = path.join('src', 'x.ts');
    const fp = computeFingerprint(rel, '// STUB intentional sample');
    expect(scanForStubs({ repoRoot: root, knownFalsePositives: new Set([fp]) })).toEqual([]);
  });

  it('leaves unrelated findings intact when suppressing one fingerprint', () => {
    const root = makeRepo({
      'src/a.ts': '// STUB one\n',
      'src/b.ts': '// STUB two\n',
    });
    const fpA = computeFingerprint(path.join('src', 'a.ts'), '// STUB one');
    const remaining = scanForStubs({ repoRoot: root, knownFalsePositives: new Set([fpA]) });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].file).toBe(path.join('src', 'b.ts'));
  });

  it('honors a per-pattern severity override', () => {
    const root = makeRepo({ 'src/x.ts': '// STUB sample\n' });
    const f = scanForStubs({ repoRoot: root, severityOverrides: { STUB: 'WARN' } }).find((x) => x.pattern === 'STUB');
    expect(f?.severity).toBe('WARN');
  });
});

describe('stub-scanner / scanForStubs — binary + symlink hardening', () => {
  it('skips a binary file with an embedded NUL byte (F-A13)', () => {
    const root = makeRepo({});
    const file = path.join(root, 'src', 'blob.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Real text "STUB" preceded by a NUL byte → must be treated as binary.
    fs.writeFileSync(file, Buffer.from([0x00, 0x53, 0x54, 0x55, 0x42]));
    expect(scanForStubs({ repoRoot: root })).toEqual([]);
  });

  it('follows a directory symlink to find a stub (F-A14)', () => {
    const root = makeRepo({ 'real/lib.ts': '// STUB linked\n' });
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'src', 'linked'), 'dir');
    const findings = scanForStubs({ repoRoot: root });
    expect(findings.some((f) => f.pattern === 'STUB')).toBe(true);
  });

  it('does not loop forever on a cyclic symlink', () => {
    const root = makeRepo({ 'src/a.ts': '// STUB cyclic\n' });
    // src/loop -> src (a cycle); visited-set must break it.
    fs.symlinkSync(path.join(root, 'src'), path.join(root, 'src', 'loop'), 'dir');
    const findings = scanForStubs({ repoRoot: root });
    // Exactly one finding — the cycle must not multiply it.
    expect(findings.filter((f) => f.pattern === 'STUB')).toHaveLength(1);
  });
});

describe('stub-scanner / scanForStubs — determinism', () => {
  it('produces identical fingerprints across runs on the same tree', () => {
    const root = makeRepo({ 'src/a.ts': '// STUB stable\n' });
    const a = scanForStubs({ repoRoot: root }).map((f) => f.fingerprint);
    const b = scanForStubs({ repoRoot: root }).map((f) => f.fingerprint);
    expect(a).toEqual(b);
  });
});
