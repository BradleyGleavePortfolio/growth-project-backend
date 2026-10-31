import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as ts from 'typescript';
import { ANY_MODEL, scanMemberContentReads } from './member-content-scan';

const forms: Array<[string, string, string]> = [
  [
    'dynamic delegate positive control',
    'export function read(prisma: any, model: string) { return prisma[model].findMany({}); }',
    ANY_MODEL,
  ],
  [
    'dynamic include positive control',
    'export function read(prisma: any, relation: string) { return prisma.user.findMany({include: {[relation]: true}}); }',
    ANY_MODEL,
  ],
  [
    'shadowed delegate parameter is not the unrelated outer literal',
    "const model = 'user'; export function read(prisma: any, model: string) { return prisma[model].findMany({}); }",
    ANY_MODEL,
  ],
  [
    'shadowed include parameter is not the unrelated outer literal',
    "const relation = 'id'; export function read(prisma: any, relation: string) { return prisma.user.findMany({include: {[relation]: true}}); }",
    ANY_MODEL,
  ],
  [
    'another function local cannot rename a known delegate constant',
    "export function read(prisma: any) { const model = 'communityMessage'; return prisma[model].findMany({}); } function other() { const model = 'user'; return model; }",
    'CommunityMessage',
  ],
  [
    'computed destructuring of an unresolved delegate fails closed',
    'export function read(prisma: any, model: string) { const {[model]: delegate} = prisma; return delegate.findMany({}); }',
    ANY_MODEL,
  ],
];

describe('LS-1185R3 B1: computed read keys respect lexical scope and fail closed', () => {
  it.each(forms)('%s', (_name, source, model) => {
    const root = mkdtempSync(join(tmpdir(), 'ls1185r3-keys-'));
    try {
      const parsed = ts.createSourceFile('reader.ts', source, ts.ScriptTarget.ES2021, true);
      expect(Reflect.get(parsed, 'parseDiagnostics')).toEqual([]);
      writeFileSync(join(root, 'reader.ts'), source);
      expect(scanMemberContentReads(root).filter((site) => site.reader === 'read').map((site) => site.model))
        .toContain(model);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
