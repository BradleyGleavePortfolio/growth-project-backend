/**
 * LS-1185R7 B1: composing ordinary aliases or constant property keys with a
 * later write must not discard that write. These are local, statically named
 * reads and keys, not any of the documented L1 to L9 boundaries.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as ts from 'typescript';
import { createProbeCopy } from './ls-1185-probe-copy';
import { ANY_MODEL, scanMemberContentReads } from './member-content-scan';

const AUTHORED = 'const authored = { some: { body: { contains: "query" } } };';
type Form = [name: string, source: string, reader: string];
const forms: Form[] = [
  ['constant-key holder property', `${AUTHORED} const KEY = 'where';
    export function read(p: any) {
      const holder = { where: {} as Record<string, unknown> };
      holder[KEY].community_posts_authored = authored;
      return p.user.findMany({ where: holder.where });
    }`, 'read'],
  ['constant-key class field mutation', `${AUTHORED} const KEY = 'where';
    export class Reader {
      private where: Record<string, unknown> = {};
      read(p: any) {
        this[KEY].community_posts_authored = authored;
        return p.user.findMany({ where: this.where });
      }
    }`, 'Reader.read'],
  ['constant-key class field replacement', `${AUTHORED} const KEY = 'where';
    export class Reader {
      private where: object = {};
      read(p: any) {
        this[KEY] = { community_posts_authored: authored };
        return p.user.findMany({ where: this.where });
      }
    }`, 'Reader.read'],
  ['object binding followed by a write', `${AUTHORED}
    export function read(p: any) {
      const holder = { where: {} as Record<string, unknown> };
      const { where } = holder;
      where.community_posts_authored = authored;
      return p.user.findMany({ where });
    }`, 'read'],
  ['array binding followed by a write', `${AUTHORED}
    export function read(p: any) {
      const [where] = [{} as Record<string, unknown>];
      where.community_posts_authored = authored;
      return p.user.findMany({ where });
    }`, 'read'],
  ['write through a property-held alias', `${AUTHORED}
    export function read(p: any) {
      const where: Record<string, unknown> = {};
      const holder = { target: where };
      holder.target.community_posts_authored = authored;
      return p.user.findMany({ where });
    }`, 'read'],
  ['splice adds an AND condition', `${AUTHORED}
    export function read(p: any) {
      const and: object[] = [];
      const condition = { community_posts_authored: authored };
      and.splice(0, 0, condition);
      return p.user.findMany({ where: { AND: and } });
    }`, 'read'],
  ['constant-key held selection write', `const KEY = 'select';
    export function read(p: any) {
      const holder = { select: {} as Record<string, unknown> };
      const selected = { select: { body: true } };
      holder[KEY].community_posts_authored = selected;
      return p.user.findMany({ select: holder.select });
    }`, 'read'],
];

function scan(source: string) {
  const root = mkdtempSync(join(tmpdir(), 'ls1185r7-write-'));
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

const TYPED_SELECT = `
  import type { Prisma, PrismaClient } from '@prisma/client';
  const KEY = 'select';
  export function unsafeHeldWrite(prisma: PrismaClient) {
    const holder = { select: {} as Prisma.UserSelect };
    const selected: Prisma.CommunityPostFindManyArgs = { select: { body: true } };
    holder[KEY].community_posts_authored = selected;
    return prisma.user.findMany({ select: holder.select });
  }
`;
const TYPED_BINDING = `
  import type { Prisma, PrismaClient } from '@prisma/client';
  const authored: Prisma.CommunityPostListRelationFilter = {
    some: { body: { contains: 'query' } },
  };
  export function unsafeHeldWrite(prisma: PrismaClient) {
    const holder = { where: {} as Prisma.UserWhereInput };
    const { where } = holder;
    where.community_posts_authored = authored;
    return prisma.user.findMany({ where });
  }
`;
const TYPED_SCALAR = `
  import type { Prisma, PrismaClient } from '@prisma/client';
  const KEY = 'select';
  export function scalarOnly(prisma: PrismaClient) {
    const holder = { select: {} as Prisma.UserSelect };
    holder[KEY].id = true;
    return prisma.user.findMany({ select: holder.select });
  }
`;

/** Compile a real Prisma fixture, then run the unmodified inventory gate. */
function gate(source: string): { failed: number; output: string } {
  const root = createProbeCopy();
  const resultDir = mkdtempSync(join(tmpdir(), 'ls1185r7-write-result-'));
  try {
    const file = join(root, 'src/ls-1185r7-held-write.ts');
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
    console.log(`LS-1185R7 held-write real gate: exit=${run.status}, failed=${result.numFailedTests}`);
    return { failed: result.numFailedTests, output: run.stdout + run.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(resultDir, { recursive: true, force: true });
  }
}

describe('LS-1185R7 B1: later-write compositions retain read obligations', () => {
  it.each(forms)('%s is followed or fails closed', (_name, source, reader) => {
    expect(scan(source).filter((s) => s.reader === reader)
      .some((s) => s.model === 'CommunityPost' || s.model === ANY_MODEL)).toBe(true);
  });

  it.each(forms)('%s stays quiet on a non-content-reaching model', (_name, source) => {
    expect(scan(source.replaceAll('p.user', 'p.buildWeekEnrollment')
      .replaceAll('community_posts_authored', 'completions'))).toEqual([]);
  });

  it.each([
    ['constant-key selection', TYPED_SELECT],
    ['destructured where mutation', TYPED_BINDING],
  ])('the real gate rejects an unregistered typed %s', (_name, source) => {
    const result = gate(source);
    expect(result.failed).toBe(1);
    expect(result.output).toContain('unsafeHeldWrite');
  }, 120000);

  it('the real gate rejects the equivalent dotted selection as a positive control', () => {
    const result = gate(TYPED_SELECT.replace('holder[KEY]', 'holder.select'));
    expect(result.failed).toBe(1);
    expect(result.output).toContain('unsafeHeldWrite');
  }, 120000);

  it('the real gate accepts a typed scalar-only selection twin', () => {
    expect(gate(TYPED_SCALAR).failed).toBe(0);
  }, 120000);
});
