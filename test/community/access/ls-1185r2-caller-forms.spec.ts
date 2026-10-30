import 'reflect-metadata';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as ts from 'typescript';
import { CommunityMessagesRepository } from '../../../src/community/messages/community-messages.repository';
import { accessWorld } from './member-content-fixture';
import { REPO_ROOT, scanMemberContentReads } from './member-content-scan';

const repository = join(REPO_ROOT, 'src/community/messages/community-messages.repository.ts');
const args = '{ cohortId, before: null, limit: 20 }';
const standard = "import { CommunityMessagesRepository } from './repository';";
const cases: Array<[string, string, string]> = [
  [
    'direct typed receiver positive control',
    standard,
    `constructor(private repo: CommunityMessagesRepository) {} list(cohortId: string) { return this.repo.listCohortMessages(${args}); }`,
  ],
  [
    'declared receiver uses an aliased import',
    "import { CommunityMessagesRepository as MessagesRepo } from './repository';",
    `constructor(private repo: MessagesRepo) {} list(cohortId: string) { return this.repo.listCohortMessages(${args}); }`,
  ],
  [
    'declared receiver calls a literal element method',
    standard,
    `constructor(private repo: CommunityMessagesRepository) {} list(cohortId: string) { return this.repo['listCohortMessages'](${args}); }`,
  ],
  [
    'declared receiver calls a same-repository wrapper',
    standard,
    'constructor(private repo: CommunityMessagesRepository) {} list(cohortId: string) { return this.repo.latestForPreview(cohortId); }',
  ],
];

describe('LS-1185R2 B1: ordinary new callers of a registered reader remain inventory sites', () => {
  it.each(cases)('%s', (name, imported, members) => {
    const root = mkdtempSync(join(tmpdir(), 'ls1185r2-callers-'));
    try {
      copyFileSync(repository, join(root, 'repository.ts'));
      if (name.includes('wrapper')) {
        const original = readFileSync(join(root, 'repository.ts'), 'utf8');
        const constructor = 'constructor(private readonly prisma: PrismaService) {}';
        expect(original).toContain(constructor);
        writeFileSync(
          join(root, 'repository.ts'),
          original.replace(constructor, `${constructor}\nlatestForPreview(cohortId: string) { return this.listCohortMessages(${args}); }`),
        );
      }
      const source = `${imported}\nexport class PreviewService { ${members} }\n`;
      const parsed = ts.createSourceFile('preview.ts', source, ts.ScriptTarget.ES2021, true);
      expect((parsed as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics).toEqual([]);
      writeFileSync(join(root, 'preview.ts'), source);
      const calls = scanMemberContentReads(root).filter(
        (site) => site.file.endsWith('/preview.ts') && site.via === 'caller',
      );
      expect(calls.map((site) => `${site.reader} ${site.model}`)).toContain('PreviewService.list CommunityMessage');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the reused real repository returns blocked-author words unless its new caller filters them', async () => {
    const w = await accessWorld();
    const author = w.member('Hidden Author');
    const words = 'Private words for the caller inventory control';
    await w.messages.send(author, w.cohortId, words);
    await w.messages.send(w.control, w.cohortId, 'Visible control words');
    await w.safety.block(w.viewer, author.id);
    const repo = new CommunityMessagesRepository(
      w.db as unknown as ConstructorParameters<typeof CommunityMessagesRepository>[0],
    );
    const raw = await repo.listCohortMessages({ cohortId: w.cohortId, before: null, limit: 20 });
    expect(raw.some((row) => row.body === words)).toBe(true);
    expect(JSON.stringify(await w.messages.list(w.viewer, w.cohortId, {}))).not.toContain(words);
  });
});
