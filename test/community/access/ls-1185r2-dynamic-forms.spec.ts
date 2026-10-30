import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as ts from 'typescript';
import { ANY_MODEL, scanMemberContentReads } from './member-content-scan';

const forms: Array<[string, string]> = [
  [
    'dynamic table positive control',
    'export const read = (prisma: any, table: string) => prisma.$queryRaw`SELECT * FROM ${Prisma.raw(table)}`;',
  ],
  [
    'schema-qualified dynamic table',
    'export const read = (prisma: any, table: string) => prisma.$queryRaw`SELECT * FROM public.${Prisma.raw(table)}`;',
  ],
  [
    'quoted-schema dynamic table',
    'export const read = (prisma: any, table: string) => prisma.$queryRaw`SELECT * FROM "public".${Prisma.raw(table)}`;',
  ],
  [
    'dynamic include positive control',
    'export const read = (prisma: any, relation: string) => prisma.user.findMany({include: {[relation]: true}});',
  ],
  [
    'dynamic include object held in a constant',
    'export const read = (prisma: any, relation: string) => { const include = {[relation]: true}; return prisma.user.findMany({include}); };',
  ],
  [
    'dynamic select object held in a constant',
    'export const read = (prisma: any, relation: string) => { const select = {[relation]: true}; return prisma.user.findMany({select}); };',
  ],
];

describe('LS-1185R2 B2: ordinary dynamic read forms fail closed', () => {
  it.each(forms)('%s', (_name, source) => {
    const root = mkdtempSync(join(tmpdir(), 'ls1185r2-dynamic-'));
    try {
      const parsed = ts.createSourceFile('dynamic-reader.ts', source, ts.ScriptTarget.ES2021, true);
      expect(Reflect.get(parsed, 'parseDiagnostics')).toEqual([]);
      writeFileSync(join(root, 'dynamic-reader.ts'), source);
      expect(scanMemberContentReads(root).map((site) => site.model)).toContain(ANY_MODEL);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
