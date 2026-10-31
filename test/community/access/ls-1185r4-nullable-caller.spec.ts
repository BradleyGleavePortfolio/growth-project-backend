/**
 * LS-1185R4 B1 B-TEST: a runtime key on an optional reader-capable receiver must fail closed, just as
 * on the same receiver without null/undefined. Optional chaining changes availability, not whose rows it reads.
 * Uses the real repository, exactly as the round-3 caller probes do. Test-only; no runtime changes.
 */
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { REPO_ROOT, scanMemberContentReads } from './member-content-scan';

const imported = "import { CommunityMessagesRepository } from './repository';";
const port = 'interface Messages { listCohortMessages(...args: never[]): unknown; listComments(...args: never[]): unknown; }';
const forms: Array<[string, string, string]> = [
  [
    'control: a non-null interface with a runtime key',
    `${port} export class Preview { constructor(private repo: Messages) {} read(k: keyof Messages) { return this.repo[k]; } }`,
    '*',
  ],
  [
    'an optional interface with a runtime key',
    `${port} export class Preview { constructor(private repo: Messages | undefined) {} read(k: keyof Messages) { return this.repo?.[k]; } }`,
    '*',
  ],
  [
    'a nullable interface with a runtime key',
    `${port} export class Preview { constructor(private repo: Messages | null) {} read(k: keyof Messages) { return this.repo?.[k]; } }`,
    '*',
  ],
  [
    'an optional concrete repository with a runtime key',
    'export class Preview { constructor(private repo: CommunityMessagesRepository | undefined) {} read(k: keyof CommunityMessagesRepository) { return this.repo?.[k]; } }',
    '*',
  ],
  [
    'control: an optional interface with a statically named reader',
    `${port} export class Preview { constructor(private repo: Messages | undefined) {} read() { return this.repo?.listCohortMessages; } }`,
    'CommunityMessage',
  ],
];

describe('LS-1185R4 B1: optional typed receivers do not erase a computed reader reference', () => {
  it.each(forms)('%s', (_name, source, model) => {
    const root = mkdtempSync(join(tmpdir(), 'ls1185r4-optional-'));
    try {
      copyFileSync(join(REPO_ROOT, 'src/community/messages/community-messages.repository.ts'), join(root, 'repository.ts'));
      writeFileSync(join(root, 'preview.ts'), `${imported}\n${source}\n`);
      const sites = scanMemberContentReads(root).filter((s) => s.file.endsWith('/preview.ts') && s.via === 'caller');
      expect(sites.map((s) => `${s.reader} ${s.model}`)).toContain(`Preview.read ${model}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
