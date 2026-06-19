/**
 * Unit tests for prod-readiness/env-discovery.ts.
 *
 * Exercises the TS-AST extraction directly (no repo dependency) across all
 * four access shapes — `process.env.X`, `process.env['X']`, `process.env[CONST]`
 * with in-file const resolution, and destructuring — plus the cases that MUST
 * NOT resolve (loop variables, dynamic keys). Also covers ENV_RULES extraction
 * with property-order independence (F-B10) and the full discoverEnvVars pass
 * over a synthetic repo, including the binary-file guard (F-A13).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  discoverEnvVars,
  extractEnvRuleNames,
  extractEnvVarRefs,
} from '../env-discovery';

function makeRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'env-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

describe('env-discovery / extractEnvVarRefs — access shapes', () => {
  it('finds a dotted access process.env.FOO', () => {
    expect([...extractEnvVarRefs('const x = process.env.FOO;')]).toEqual(['FOO']);
  });

  it('finds a string-literal bracket access process.env["BAR"]', () => {
    expect([...extractEnvVarRefs("const x = process.env['BAR'];")]).toContain('BAR');
  });

  it('resolves a const-keyed bracket access process.env[CONST]', () => {
    const code = "const KEY = 'FEATURE_X';\nconst v = process.env[KEY];";
    expect([...extractEnvVarRefs(code)]).toContain('FEATURE_X');
  });

  it('finds destructured names const { A, B } = process.env', () => {
    const names = extractEnvVarRefs('const { ALPHA, BETA } = process.env;');
    expect(names.has('ALPHA')).toBe(true);
    expect(names.has('BETA')).toBe(true);
  });

  it('uses the property name (not the alias) for aliased destructuring', () => {
    const names = extractEnvVarRefs('const { GAMMA: g } = process.env;');
    expect(names.has('GAMMA')).toBe(true);
    expect(names.has('g')).toBe(false);
  });

  it('collects multiple distinct references in one file', () => {
    const code = 'const a = process.env.ONE; const b = process.env.TWO;';
    const names = extractEnvVarRefs(code);
    expect(names.has('ONE')).toBe(true);
    expect(names.has('TWO')).toBe(true);
  });

  it('deduplicates repeated references', () => {
    const names = extractEnvVarRefs('process.env.DUP; process.env.DUP;');
    expect([...names].filter((n) => n === 'DUP')).toHaveLength(1);
  });
});

describe('env-discovery / extractEnvVarRefs — non-resolvable cases', () => {
  it('does NOT resolve a loop/dynamic identifier key', () => {
    const code = 'for (const k of keys) { const v = process.env[k]; }';
    const names = extractEnvVarRefs(code);
    // `k` is not a string const; nothing is added.
    expect(names.size).toBe(0);
  });

  it('does NOT treat a lowercase identifier as an env var', () => {
    const code = "const lower = 'value'; const v = process.env[lower];";
    // `lower` resolves to a non-screaming-snake-case string, so it is rejected.
    expect([...extractEnvVarRefs(code)]).not.toContain('value');
  });

  it('ignores access on objects other than process.env', () => {
    const code = 'const v = config.env.FOO; const w = process.argv.BAR;';
    expect(extractEnvVarRefs(code).size).toBe(0);
  });

  it('returns an empty set for a file with no env access', () => {
    expect(extractEnvVarRefs('export const z = 1 + 2;').size).toBe(0);
  });
});

describe('env-discovery / extractEnvRuleNames (AST, F-B10)', () => {
  function writeValidation(body: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-'));
    const file = path.join(root, 'env-validation.ts');
    fs.writeFileSync(file, body);
    return file;
  }

  it('extracts name literals from an ENV_RULES array', () => {
    const file = writeValidation(
      "const ENV_RULES = [\n  { name: 'ALPHA', required: true },\n  { name: 'BETA', required: false },\n];\n",
    );
    expect(extractEnvRuleNames(file).sort()).toEqual(['ALPHA', 'BETA']);
  });

  it('is independent of property order within each rule (F-B10)', () => {
    const file = writeValidation(
      "const ENV_RULES = [\n  { required: true, name: 'GAMMA' },\n  { description: 'd', name: 'DELTA', required: false },\n];\n",
    );
    expect(extractEnvRuleNames(file).sort()).toEqual(['DELTA', 'GAMMA']);
  });

  it('ignores name properties on objects outside the ENV_RULES declaration', () => {
    const file = writeValidation(
      "const OTHER = [{ name: 'NOPE' }];\nconst ENV_RULES = [{ name: 'YES' }];\n",
    );
    expect(extractEnvRuleNames(file)).toEqual(['YES']);
  });

  it('skips name values that are not SCREAMING_SNAKE_CASE', () => {
    const file = writeValidation("const ENV_RULES = [{ name: 'lowercase' }, { name: 'GOOD_ONE' }];\n");
    expect(extractEnvRuleNames(file)).toEqual(['GOOD_ONE']);
  });
});

describe('env-discovery / discoverEnvVars (integration)', () => {
  it('returns an empty map for a repo with nothing to scan', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'env-empty-'));
    expect(discoverEnvVars(root).envVars.size).toBe(0);
  });

  it('marks a var found only in code with inCode + a code ref', () => {
    const root = makeRepo({ 'src/a.ts': 'const x = process.env.CODE_ONLY;\n' });
    const origin = discoverEnvVars(root).envVars.get('CODE_ONLY');
    expect(origin?.inCode).toBe(true);
    expect(origin?.inEnvExample).toBe(false);
    expect(origin?.inEnvRules).toBe(false);
    expect(origin?.codeRefs).toContain(path.join('src', 'a.ts'));
  });

  it('marks a var present in .env.example with inEnvExample', () => {
    const root = makeRepo({ '.env.example': 'DOC_VAR=somevalue\n' });
    expect(discoverEnvVars(root).envVars.get('DOC_VAR')?.inEnvExample).toBe(true);
  });

  it('marks a var present in ENV_RULES with inEnvRules', () => {
    const root = makeRepo({ 'src/common/env-validation.ts': "const ENV_RULES = [{ name: 'RULED_VAR' }];\n" });
    expect(discoverEnvVars(root).envVars.get('RULED_VAR')?.inEnvRules).toBe(true);
  });

  it('merges origins for a var that appears in all three sources', () => {
    const root = makeRepo({
      'src/common/env-validation.ts': "const ENV_RULES = [{ name: 'TRIPLE' }];\n",
      '.env.example': 'TRIPLE=value\n',
      'src/use.ts': 'const x = process.env.TRIPLE;\n',
    });
    const o = discoverEnvVars(root).envVars.get('TRIPLE');
    expect(o).toMatchObject({ inEnvRules: true, inEnvExample: true, inCode: true });
  });

  it('does not duplicate a code ref when the same var is used twice in one file', () => {
    const root = makeRepo({ 'src/a.ts': 'process.env.REPEAT; process.env.REPEAT;\n' });
    expect(discoverEnvVars(root).envVars.get('REPEAT')?.codeRefs).toHaveLength(1);
  });

  it('skips binary files when discovering code references (F-A13)', () => {
    const root = makeRepo({});
    const file = path.join(root, 'src', 'blob.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0x00]), Buffer.from('process.env.BIN')]));
    expect(discoverEnvVars(root).envVars.has('BIN')).toBe(false);
  });
});
