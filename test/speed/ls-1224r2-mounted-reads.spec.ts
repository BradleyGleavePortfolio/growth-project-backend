import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';
import ts from 'typescript';

interface Read {
  screen: string;
  path: string;
}
const file = join(__dirname, 'coach-busy-reads.speed.spec.ts');

function catalogue(): Read[] {
  const captured: { lensReads?: (now: Date) => Read[] } = {};
  const noSuite = () => undefined;
  const code = ts.transpileModule(
    readFileSync(file, 'utf8') + '\nmodule.exports.lensReads = reads;',
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  runInNewContext(code, {
    require, URL, URLSearchParams, module: { exports: captured }, exports: captured,
    process: { env: {} }, console: { log: noSuite },
    describe: Object.assign(noSuite, { skip: noSuite }),
  }, { filename: file });
  if (!captured.lensReads) throw new Error('Actual speed-read catalogue missing');
  return captured.lensReads(new Date('2026-11-05T12:00:00Z'));
}

function canonical(path: string): string {
  const url = new URL(path, 'http://fixture.invalid');
  url.searchParams.sort();
  return url.pathname + url.search;
}

describe('LS-1224R2 B2: opening reads in mounted screen children', () => {
  // mobile c26961a3 CommandCenterScreen:165 mounts the setup child;
  // CoachSetupChecklist:153,169-172 -> setupStatus:78-116 fires four reads.
  // These happen before the completed checklist later hides itself.
  it.each([
    ['Home setup package list', 'Needs you', '/v1/coach/packages?include_archived=true'],
    ['Home setup client existence', 'Needs you', '/coach/clients?status=all&take=1'],
    ['Home setup first payment', 'Needs you', '/v1/coach/money/charges?status=paid&limit=1'],
    ['Home setup saved Connect state', 'Needs you', '/coach/connect/status'],
    // CoachInboxV2:330-331 mounts both entries, not their destinations.
    // BroadcastsEntry:20 -> broadcastsApi:201 probes on mount.
    ['Inbox broadcast entry list', 'Inbox', '/coach/broadcasts?limit=1'],
    // CommunityReportsEntry:26 -> useCoachCommunity:173 -> API:905.
    ['Inbox moderation entry count', 'Inbox', '/community/moderation/flagged'],
    // CommandCenterScreen:201 -> CreditMomentsHost:34 -> useCoachCredits:26
    // -> useCoachRoleType:53 -> coachTeamApi:87 (flag coachAiCredits).
    ['Home credit-role membership', 'Needs you', '/coach/team/members'],
  ])('times %s', (_label, screen, path) => {
    const actual = catalogue().filter((r) => r.screen === screen).map((r) => canonical(r.path));
    expect(actual).toContain(canonical(path));
  });

  it('control: captures the real catalogue and already-covered Home metrics', () => {
    expect(catalogue().filter((r) => r.screen === 'Needs you').map((r) => canonical(r.path)))
      .toContain('/coach/command-center/ltv-metrics');
  });
});
