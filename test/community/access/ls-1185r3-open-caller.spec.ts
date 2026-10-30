import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as ts from 'typescript';
import { REPO_ROOT, scanMemberContentReads } from './member-content-scan';

const imported = "import { CommunityMessagesRepository } from './repository';";
const port = 'interface Messages { listCohortMessages(...args: never[]): unknown; listComments(...args: never[]): unknown; }';
const args = '{cohortId: c, before: null, limit: 20}';
const cases: Array<[string, string, string]> = [
  [
    'direct interface positive control',
    `${port} export class Preview { constructor(private repo: Messages) {} read(c: string) { return this.repo.listCohortMessages(${args}); } }`,
    'CommunityMessage',
  ],
  [
    'computed concrete repository positive control',
    `export class Preview { constructor(private repo: CommunityMessagesRepository) {} read(k: keyof CommunityMessagesRepository) { return this.repo[k]; } }`,
    '*',
  ],
  [
    'computed method on the compatible interface fails closed',
    `${port} export class Preview { constructor(private repo: Messages) {} read(k: keyof Messages) { return this.repo[k]; } }`,
    '*',
  ],
  [
    'computed destructuring on the concrete repository fails closed',
    'export class Preview { constructor(private repo: CommunityMessagesRepository) {} read(k: keyof CommunityMessagesRepository) { const {[k]: method} = this.repo; return method; } }',
    '*',
  ],
];

describe('LS-1185R3 B2: unresolved references on reader-capable values fail closed', () => {
  it.each(cases)('%s', (_name, members, model) => {
    const root = mkdtempSync(join(tmpdir(), 'ls1185r3-open-'));
    try {
      copyFileSync(join(REPO_ROOT, 'src/community/messages/community-messages.repository.ts'), join(root, 'repository.ts'));
      const source = `${imported}\n${members}\n`;
      const parsed = ts.createSourceFile('preview.ts', source, ts.ScriptTarget.ES2021, true);
      expect(Reflect.get(parsed, 'parseDiagnostics')).toEqual([]);
      writeFileSync(join(root, 'preview.ts'), source);
      const calls = scanMemberContentReads(root).filter((site) => site.file.endsWith('/preview.ts') && site.via === 'caller');
      expect(calls.map((site) => `${site.reader} ${site.model}`)).toContain(`Preview.read ${model}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
