import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';
import ts from 'typescript';

interface TimedRead {
  screen: string;
  path: string;
  check: (body: string) => string | null;
}

// Evaluate only the fixture's pure route catalogue, without booting AppModule,
// running its describe callback, or reading any database URL from this process.
function catalogue(): TimedRead[] {
  const file = join(__dirname, 'coach-busy-reads.speed.spec.ts');
  const source = readFileSync(file, 'utf8') + '\nmodule.exports.lensReads = reads;';
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const captured: { lensReads?: (now: Date) => TimedRead[] } = {};
  const noSuite = () => undefined;
  runInNewContext(compiled, {
    require,
    URL,
    URLSearchParams,
    exports: captured,
    module: { exports: captured },
    process: { env: {} },
    console: { log: noSuite },
    describe: Object.assign(noSuite, { skip: noSuite }),
  }, { filename: file });
  if (!captured.lensReads) throw new Error('speed catalogue was not captured');
  return captured.lensReads(new Date('2026-11-05T12:00:00Z'));
}

describe('LS-1224 B1: busy-screen reads at mobile c26961a3', () => {
  // Sources: ClientLookupScreen.tsx:91-107,143-149 and
  // home-v11/planEndedData.ts:24,54-62; MoneyScreen.tsx:226-229 and
  // hooks/useAIBudget.ts:52-58. Home sources: useCoachHomeV11.ts:82-84,
  // 124-129, command-center/coachHomeSources.ts:22-25, notificationsApi.ts:500,
  // coachAiExecutionApi.ts:137,242-247. ClientDetailScreen.tsx:427-432 mounts
  // DisputePausedPlansCard.tsx:40-53 -> coachDisputeRestart.ts:90-102.
  it.each([
    ['Client list', '/v1/coach/churned-clients'],
    ['Client file', '/v1/coach/purchases'],
    ['Money', '/coach/ai/budget'],
    ['Money', '/coach/connect/status'],
    ['Money', '/coach/connect/payouts'],
    ['Needs you', '/coach/command-center/ltv-metrics'],
    ['Needs you', '/coach/command-center/at-risk'],
    ['Needs you', '/ai/gateway/drafts'],
    ['Needs you', '/notifications/unread-count'],
  ])('times the %s opening read %s', (_screen, path) => {
    const paths = catalogue().map((read) => read.path.split('?')[0]);
    expect(paths).toContain(path);
  });
});
