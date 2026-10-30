import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createProbeCopy } from './ls-1185-probe-copy';

function runContract(root: string) {
  const scratch = mkdtempSync(join(tmpdir(), 'ls1185-control-'));
  const report = join(scratch, 'result.json');
  try {
    const run = spawnSync(process.execPath, [
      require.resolve('jest/bin/jest'), '--runInBand', '--no-cache', '--json', `--outputFile=${report}`,
      'test/community/access/member-content-access.spec.ts',
    ], { cwd: root, encoding: 'utf8', timeout: 110000, maxBuffer: 1024 * 1024 });
    if (run.error) throw run.error;
    const result = JSON.parse(readFileSync(report, 'utf8')) as { numFailedTests: number; numPassedTests: number };
    return { ...result, diagnostic: `${run.stdout}\n${run.stderr}` };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe('LS-1185 independent bite positive controls', () => {
  const sourceForms: Array<[string, string]> = [
    ['direct', 'export const read = (prisma: any) => prisma.communityMessage.findMany({});'],
    ['delegate alias', 'export const read = (prisma: any) => { const rows = prisma.communityMessage; return rows.findMany({}); };'],
    ['bound method', 'export const read = (prisma: any) => { const list = prisma.communityMessage.findMany.bind(prisma.communityMessage); return list({}); };'],
    ['helper one level down', 'function helper(prisma: any) { return prisma.communityMessage.findMany({}); } export const read = helper;'],
    ['raw query', 'export const read = (prisma: any) => prisma.$queryRaw`SELECT * FROM "community_messages"`;'],
    ['re-exported helper', 'export const read = (prisma: any) => prisma.communityMessage.findMany({});'],
  ];
  it.each(sourceForms)('new unregistered %s read turns red and names the file', (name, source) => {
    const root = createProbeCopy();
    const file = join(root, 'src/ls-1185-probe-reader.ts');
    const barrel = join(root, 'src/ls-1185-probe-barrel.ts');
    try {
      writeFileSync(file, source);
      if (name === 're-exported helper') writeFileSync(barrel, 'export { read } from "./ls-1185-probe-reader";');
      const result = runContract(root);
      expect(result.numFailedTests).toBeGreaterThan(0);
      expect(result.diagnostic).toContain('src/ls-1185-probe-reader.ts');
      console.log(`LS-1185 bite ${name}: ${result.numFailedTests} red tests, reader filename present`);
    } finally {
      rmSync(file, { force: true });
      rmSync(barrel, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }, 120000);

  const mutations: Array<[string, string, string, string]> = [
    [
      'outgoing block removed',
      'src/community/safety/community-safety.service.ts',
      'where: { OR: [{ blocker_id: viewerId }, { blocked_id: viewerId }] },',
      'where: { blocked_id: viewerId },',
    ],
    [
      'incoming block removed',
      'src/community/safety/community-safety.service.ts',
      'where: { OR: [{ blocker_id: viewerId }, { blocked_id: viewerId }] },',
      'where: { blocker_id: viewerId },',
    ],
    [
      'registered message ban/departure guard removed',
      'src/community/messages/community-messages.service.ts',
      'this.safety.filterBlocked(user.id, rows, (m) => m.sender_id, placeOf)',
      'this.safety.filterBlocked(user.id, rows, (m) => m.sender_id)',
    ],
    [
      'registered removed-message words exposed',
      'src/community/messages/community-messages.service.ts',
      'if (coachRemoved(m) && chat) return this.placeholder(m, chat, true);',
      '',
    ],
    [
      'covered reaction gap genuinely fixed',
      'src/community/posts/community-posts.service.ts',
      'this.safety.filterBlocked(viewer.id, rows, (r) => r.user_id)',
      'this.safety.filterBlocked(viewer.id, rows, (r) => r.user_id, () => [workspaceId ?? "", null])',
    ],
  ];
  it.each(mutations)('%s turns the contract red', (name, file, before, after) => {
    const root = createProbeCopy();
    const runtime = join(root, file);
    const original = readFileSync(runtime, 'utf8');
    expect(original.includes(before)).toBe(true);
    try {
      let mutated = original.replace(before, after);
      if (name === 'registered removed-message words exposed') {
        mutated = mutated.replace('body: m.deleted_at ? null : m.body,', 'body: m.body,');
      }
      writeFileSync(runtime, mutated);
      const result = runContract(root);
      expect(result.numFailedTests).toBeGreaterThan(0);
      if (name === 'covered reaction gap genuinely fixed') expect(result.diagnostic).toContain('KNOWN GAP fixed:');
      console.log(`LS-1185 bite ${name}: ${result.numFailedTests} red tests; reader filename present=${result.diagnostic.includes(file)}`);
    } finally {
      writeFileSync(runtime, original);
      rmSync(root, { recursive: true, force: true });
    }
  }, 120000);
});
