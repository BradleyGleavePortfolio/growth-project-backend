import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { REPO_ROOT } from './member-content-scan';

describe('LS-1185 B2: each fixed KNOWN GAP must invalidate its registry row', () => {
  const unexercisedGaps: Array<[string, string, (source: string) => string, string]> = [
    [
      'contactRings',
      'src/coach/command-center/coach-home-day.ts',
      (source) => source
        .replace('  const lastReply = new Map<string, number>();',
          '  const closedThreads = await inBlockWith(prisma, scope.coachId, clientIds);\n  const visibleReceived = received.filter((m) => m.client_id && !closedThreads.has(m.client_id));\n  const lastReply = new Map<string, number>();')
        .replace('const answered = received.filter(', 'const answered = visibleReceived.filter(')
        .replace('replies: { answered, received: received.length }', 'replies: { answered, received: visibleReceived.length }')
        + '\nexport { contactRings as __LS1185_contactRings };\n',
      'const { __LS1185_contactRings } = require("../../../src/coach/command-center/coach-home-day"); const read = async () => (await __LS1185_contactRings(w.db, {coachId: w.coach.id, findMany: async () => []}, w.coach.id, [author.id, w.control.id], [], [], new Date(0), new Date("2100-01-01T00:00:00Z"))).replies.received;',
    ],
    [
      'CoachHomeService.countReview',
      'src/coach/home/coach-home.service.ts',
      (source) => source.replace(
        '    const totalConversations = senders.filter(\n      (s) => s.client_id != null,',
        '    const closedThreads = new Set(await (await import("../../messaging/block-pair")).everyoneInBlockWith(this.prisma, coachId));\n    const totalConversations = senders.filter(\n      (s) => s.client_id != null && !closedThreads.has(s.client_id),'),
      'const { CoachHomeService } = require("../../../src/coach/home/coach-home.service"); const service = Object.create(CoachHomeService.prototype); service.prisma = w.db; const read = async () => (await service.countReview(w.coach.id, new Date(0), new Date("2100-01-01T00:00:00Z"))).totalConversations;',
    ],
    [
      'DigestService._buildCoachDigestData',
      'src/notifications/digest.service.ts',
      (source) => source
        .replace('    const unreadMessages = await this.prisma.coachMessage.count({',
          '    const closedThreads = await (await import("../messaging/block-pair")).everyoneInBlockWith(this.prisma, coachId);\n    const unreadMessages = await this.prisma.coachMessage.count({')
        .replace('        sender_id: { not: coachId },\n        read_at: null,',
          '        sender_id: { not: coachId },\n        client_id: { notIn: closedThreads },\n        read_at: null,'),
      'const { DigestService } = require("../../../src/notifications/digest.service"); const service = Object.create(DigestService.prototype); service.prisma = w.db; const read = async () => (await service._buildCoachDigestData(w.coach.id, "daily")).rosterStats.unreadMessages;',
    ],
  ];
  it.each(unexercisedGaps)('fixing %s makes its stale GAP declaration red', (name, file, fix, reader) => {
    const runtime = join(REPO_ROOT, file);
    const smoke = join(__dirname, 'ls-1185-generated-gap.spec.ts');
    const scratch = mkdtempSync(join(tmpdir(), 'ls1185-gap-'));
    const report = join(scratch, 'result.json');
    const original = readFileSync(runtime, 'utf8');
    const fixed = fix(original);
    expect(fixed).not.toBe(original);
    try {
      writeFileSync(runtime, fixed);
      writeFileSync(smoke, [
        "import 'reflect-metadata'; import { accessWorld } from './member-content-fixture';",
        `it(${JSON.stringify(`${name} really hides the blocked thread and keeps control`)}, async () => {`,
        'const w = await accessWorld(); const author = w.member("Hidden Sender");',
        'for (const sender of [author, w.control]) w.db.seed("coachMessage", {coach_id: w.coach.id, client_id: sender.id, sender_id: sender.id, body: "Words", read_at: null, deleted_at: null});',
        reader,
        'expect(await read()).toBe(2); await w.safety.block(w.coach, author.id); expect(await read()).toBe(1);',
        '});',
      ].join('\n'));
      const run = spawnSync(process.execPath, [
        require.resolve('jest/bin/jest'), '--runInBand', '--no-cache', '--json', `--outputFile=${report}`,
        'test/community/access/member-content-access.spec.ts',
        'test/community/access/ls-1185-generated-gap.spec.ts',
      ], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 110000, maxBuffer: 1024 * 1024 });
      if (run.error) throw run.error;
      const result = JSON.parse(readFileSync(report, 'utf8')) as {
        numFailedTests: number;
        numPassedTests: number;
        testResults: Array<{ name: string; status: string; message: string }>;
      };
      const smokeResult = result.testResults.find((r) => r.name.endsWith('ls-1185-generated-gap.spec.ts'));
      if (smokeResult?.status !== 'passed') console.log(smokeResult?.message ?? run.stderr);
      expect(smokeResult?.status).toBe('passed');
      console.log(`LS-1185 fixed-gap ${name}: ${result.numPassedTests} passed, ${result.numFailedTests} failed; real reader smoke passed`);
      expect(result.numFailedTests).toBeGreaterThan(0);
    } finally {
      writeFileSync(runtime, original);
      rmSync(smoke, { force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 120000);

  it('fixing the single-target reactions ban/departure gap makes the existing contract red', () => {
    const runtime = join(REPO_ROOT, 'src/community/reactions/community-reactions.service.ts');
    const smoke = join(__dirname, 'ls-1185-generated-gap.spec.ts');
    const scratch = mkdtempSync(join(tmpdir(), 'ls1185-gap-'));
    const report = join(scratch, 'result.json');
    const original = readFileSync(runtime, 'utf8');
    const before = 'return this.safety.filterBlocked(user.id, rows, (r) => r.user_id);';
    const after = 'return this.safety.filterBlocked(user.id, rows, (r) => r.user_id, () => [t.workspaceId, null]);';
    expect(original.includes(before)).toBe(true);
    try {
      writeFileSync(runtime, original.replace(before, after));
      writeFileSync(smoke, [
        "import { accessWorld } from './member-content-fixture';",
        "const { CommunityReactionsService } = require('../../../src/community/reactions/community-reactions.service');",
        "it.each(['banned from the community', 'departed (moved to another coach)'])('fixed real reaction reader hides %s, keeping control', async (rule: any) => {",
        '  const w = await accessWorld(); const author = w.member("Hidden Reactor");',
        '  const rows = [{user_id: author.id}, {user_id: w.control.id}];',
        '  const svc = new CommunityReactionsService(null, {listForTarget: async () => rows}, null, null, null, w.safety);',
        '  const target = {workspaceId: w.wsId, targetType: "post", targetId: w.postId};',
        '  expect(await svc.visibleReactions(w.viewer, target)).toHaveLength(2);',
        '  await w.apply(rule, author);',
        '  expect(await svc.visibleReactions(w.viewer, target)).toEqual([{user_id: w.control.id}]);',
        '});',
      ].join('\n'));
      const run = spawnSync(process.execPath, [
        require.resolve('jest/bin/jest'), '--runInBand', '--no-cache', '--json', `--outputFile=${report}`,
        'test/community/access/member-content-access.spec.ts',
        'test/community/access/ls-1185-generated-gap.spec.ts',
      ], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 110000, maxBuffer: 1024 * 1024 });
      if (run.error) throw run.error;
      const result = JSON.parse(readFileSync(report, 'utf8')) as {
        numFailedTests: number;
        numPassedTests: number;
        testResults: Array<{ name: string; status: string }>;
      };
      const smokeResult = result.testResults.find((r) => r.name.endsWith('ls-1185-generated-gap.spec.ts'));
      expect(smokeResult?.status).toBe('passed');
      console.log(`LS-1185 fixed-gap proof: ${result.numPassedTests} passed, ${result.numFailedTests} failed; real ban/departure smoke passed`);
      // The runtime gap was genuinely fixed, but its stale GAP declarations must now fail.
      expect(result.numFailedTests).toBeGreaterThan(0);
    } finally {
      writeFileSync(runtime, original);
      rmSync(smoke, { force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 120000);
});
