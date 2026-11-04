/**
 * LS-1185R7 B2: a statically named read method handed to a local helper must
 * retain its obligation after an ordinary delegate binding or conditional.
 * No reflection, runtime method name, package lookup or retained rows.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as ts from 'typescript';
import { createProbeCopy } from './ls-1185-probe-copy';
import { ANY_MODEL, scanMemberContentReads } from './member-content-scan';

const HELD = `
  const authored = { some: { body: { contains: 'query' } } };
  const where = { community_posts_authored: authored };
  function invoke(f: (args: object) => unknown) { return f({ where }); }
`;
type Form = [name: string, source: string];
const forms: Form[] = [
  ['object-bound delegate', `${HELD}
    export function read(p: any) {
      const { user } = p;
      return invoke(user.findMany);
    }`],
  ['renamed object-bound delegate', `${HELD}
    export function read(p: any) {
      const { user: people } = p;
      return invoke(people.findMany);
    }`],
  ['conditional delegate', `${HELD}
    export function read(p: any, flag: boolean) {
      const people = flag ? p.user : p.user;
      return invoke(people.findMany);
    }`],
  ['parameter-bound delegate', `${HELD}
    export function read({ user }: any) { return invoke(user.findMany); }`],
  ['explicitly bound object-bound delegate', `${HELD}
    export function read(p: any) {
      const { user } = p;
      return invoke(user.findMany.bind(user));
    }`],
];

function scan(source: string) {
  const root = mkdtempSync(join(tmpdir(), 'ls1185r7-handoff-'));
  try {
    const file = join(root, 'probe.ts');
    writeFileSync(file, source);
    expect(ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2021 },
      reportDiagnostics: true,
    }).diagnostics).toEqual([]);
    return scanMemberContentReads(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const TYPED = `
  import type { Prisma, PrismaClient } from '@prisma/client';
  const authored: Prisma.CommunityPostListRelationFilter = {
    some: { body: { contains: 'query' } },
  };
  const where: Prisma.UserWhereInput = { community_posts_authored: authored };
  function invoke(f: (args: Prisma.UserFindManyArgs) => PromiseLike<unknown>) {
    return f({ where });
  }
  export function unsafeDelegateHandoff(prisma: PrismaClient) {
    const { user } = prisma;
    return invoke(user.findMany.bind(user));
  }
`;

function gate(source: string): { failed: number; output: string } {
  const root = createProbeCopy();
  const resultDir = mkdtempSync(join(tmpdir(), 'ls1185r7-handoff-result-'));
  try {
    const file = join(root, 'src/ls-1185r7-delegate-handoff.ts');
    writeFileSync(file, source);
    const program = ts.createProgram([file], {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2021,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      types: [],
    });
    expect(ts.getPreEmitDiagnostics(program).map((d) =>
      ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
    const report = join(resultDir, 'result.json');
    const run = spawnSync(process.execPath, [
      require.resolve('jest/bin/jest'), '--runInBand', '--no-cache', '--json',
      `--outputFile=${report}`, '--testNamePattern=finds no unregistered read',
      'test/community/access/member-content-access.spec.ts',
    ], { cwd: root, encoding: 'utf8', timeout: 110000, maxBuffer: 8 * 1024 * 1024 });
    if (run.error) throw run.error;
    const result = JSON.parse(readFileSync(report, 'utf8')) as { numFailedTests: number; numPassedTests: number };
    expect(result.numFailedTests + result.numPassedTests).toBe(1);
    console.log(`LS-1185R7 delegate-handoff real gate: exit=${run.status}, failed=${result.numFailedTests}`);
    return { failed: result.numFailedTests, output: run.stdout + run.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(resultDir, { recursive: true, force: true });
  }
}

describe('LS-1185R7 B2: delegate handoffs retain read obligations', () => {
  it.each(forms)('%s is followed or fails closed', (_name, source) => {
    expect(scan(source).filter((s) => s.reader === 'read')
      .some((s) => s.model === 'CommunityPost' || s.model === ANY_MODEL)).toBe(true);
  });

  it.each(forms)('%s stays quiet on a non-content-reaching model', (_name, source) => {
    expect(scan(source.replaceAll('p.user', 'p.buildWeekEnrollment')
      .replaceAll('{ user } = p', '{ buildWeekEnrollment: user } = p')
      .replaceAll('{ user: people } = p', '{ buildWeekEnrollment: people } = p')
      .replaceAll('read({ user }: any)', 'read({ buildWeekEnrollment: user }: any)')
      .replaceAll('community_posts_authored', 'completions'))).toEqual([]);
  });

  it('the direct-delegate helper handoff remains a positive control', () => {
    expect(scan(`${HELD} export function read(p: any) { return invoke(p.user.findMany); }`)
      .some((s) => s.reader === 'read' && (s.model === 'CommunityPost' || s.model === ANY_MODEL))).toBe(true);
  });

  it('the real gate rejects a typed, explicitly bound unregistered handoff', () => {
    const result = gate(TYPED);
    expect(result.failed).toBe(1);
    expect(result.output).toContain('unsafeDelegateHandoff');
  }, 120000);

  it('the real gate rejects the typed direct-delegate handoff control', () => {
    const result = gate(TYPED.replace('const { user } = prisma;', 'const user = prisma.user;'));
    expect(result.failed).toBe(1);
    expect(result.output).toContain('unsafeDelegateHandoff');
  }, 120000);
});
