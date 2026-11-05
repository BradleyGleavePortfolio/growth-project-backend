/**
 * LO-1185R2 B-TEST B2 (b#1185 round 2, Claude Opus lens): a caller of a registered reader is a read site (round 1
 * LO-1185 B3). At b2c97643 the scan's caller pass (member-content-scan.ts) skips a call on `this`, and only a method
 * with its own delegate read becomes a repository reader. So a new repository method that wraps a registered reader
 * (`listLatest() { return this.listCohortMessages(...) }`, the same shape as CommunityVoiceRepository.createVoiceNote
 * calling this.findByStorageKey) is not a reader, and a new service that returns its rows with no block, ban or
 * departure filter is not reported: the KT-2 gate stays green (lens bite run 41108676409). Red at b2c97643.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { REPO_ROOT, scanMemberContentReads } from './member-content-scan';

const REPO = 'community/messages/community-messages.repository.ts';
const WRAPPER =
  '\n  listLatest(cohortId: string) {\n    return this.listCohortMessages({ cohortId, before: null, limit: 20 });\n  }\n}\n';
const SERVICE =
  "import { CommunityMessagesRepository } from './community-messages.repository';\n" +
  'export class SpaceDigestService {\n' +
  '  constructor(private readonly repo: CommunityMessagesRepository) {}\n' +
  '  latest(cohortId: string) {\n' +
  '    return this.repo.listLatest(cohortId);\n' +
  '  }\n' +
  '}\n';

function scanWith(wrap: boolean): string[] {
  const root = mkdtempSync(join(tmpdir(), 'lo1185r2-b2-'));
  try {
    mkdirSync(join(root, 'community/messages'), { recursive: true });
    if (wrap) {
      const src = readFileSync(join(REPO_ROOT, 'src', REPO), 'utf8');
      const end = src.indexOf('\n}\n', src.indexOf('export class CommunityMessagesRepository'));
      writeFileSync(join(root, REPO), src.slice(0, end) + '\n' + WRAPPER + src.slice(end + 3));
      writeFileSync(join(root, 'community/messages/space-digest.service.ts'), SERVICE);
    } else {
      copyFileSync(join(REPO_ROOT, 'src', REPO), join(root, REPO));
      writeFileSync(
        join(root, 'community/messages/space-digest.service.ts'),
        SERVICE.replace('this.repo.listLatest(cohortId)', 'this.repo.listCohortMessages({ cohortId, before: null, limit: 20 })'),
      );
    }
    return scanMemberContentReads(root)
      .filter((s) => s.file.includes('space-digest.service.ts'))
      .map((s) => `${s.reader} ${s.model}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('LO-1185R2 B2: a caller of a same-class wrapper of a registered reader is a read site', () => {
  it('reports a service that returns CommunityMessagesRepository.listLatest (wraps listCohortMessages) rows', () => {
    expect(scanWith(true)).toContain('SpaceDigestService.latest CommunityMessage');
  });

  it('reports the direct caller (the control: the round-1 fix)', () => {
    expect(scanWith(false)).toContain('SpaceDigestService.latest CommunityMessage');
  });
});
