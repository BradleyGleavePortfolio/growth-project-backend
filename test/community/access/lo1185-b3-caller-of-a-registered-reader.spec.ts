/**
 * LO-1185 B-TEST B3 (b#1185 round 1, Claude Opus lens): many registry rows are repository readers whose block, ban
 * and departure rules are applied by their caller (for example CommunityMessagesRepository.listCohortMessages:
 * "block: CommunityMessagesService.list: filterBlocked with the space as place"). A new caller that returns those rows
 * without the filter adds no new delegate read, so the KT-2 gate stays green. The scan must report the new caller of
 * such a reader as a read site, so the builder has to register it with its four rules. Red at 5ca78135.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { scanMemberContentReads } from './member-content-scan';

describe('LO-1185 B3: a new caller of a reader whose rules live in its caller is a read site', () => {
  it('reports a new service method that returns listCohortMessages rows without filterBlocked', () => {
    const root = mkdtempSync(join(tmpdir(), 'lo1185-b3-'));
    try {
      mkdirSync(join(root, 'community/messages'), { recursive: true });
      copyFileSync(
        join(__dirname, '../../../src/community/messages/community-messages.repository.ts'),
        join(root, 'community/messages/community-messages.repository.ts'),
      );
      writeFileSync(
        join(root, 'community/messages/space-digest.service.ts'),
        "import { CommunityMessagesRepository } from './community-messages.repository';\n" +
          'export class SpaceDigestService {\n' +
          '  constructor(private readonly repo: CommunityMessagesRepository) {}\n' +
          '  async latest(cohortId: string) {\n' +
          '    return this.repo.listCohortMessages({ cohortId, before: null, limit: 20 });\n' +
          '  }\n' +
          '}\n',
      );
      const sites = scanMemberContentReads(root).filter((s) => s.file.includes('space-digest.service.ts'));
      expect(sites.map((s) => `${s.reader} ${s.model}`)).toContain('SpaceDigestService.latest CommunityMessage');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
