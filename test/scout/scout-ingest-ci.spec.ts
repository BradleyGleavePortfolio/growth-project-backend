import { CONTRACT_VERSION } from '../../scripts/importer-contract';
import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';

const workflow = readFileSync(join(__dirname, '../../.github/workflows/ci.yml'), 'utf8');
const guard = workflow.match(
  /run: node -e '(const r=require\("\.\/scout-ingest-live.json"\)[^\n]+)'/,
)?.[1];
function rejected(
  overrides: Partial<{
    numTotalTestSuites: number;
    numPendingTests: number;
    numPassedTests: number;
  }>,
): boolean {
  if (!guard) throw new Error('live selection guard missing');
  const exit = jest.fn();
  runInNewContext(guard, {
    require: () => ({
      numTotalTestSuites: 1,
      numPendingTests: 0,
      numPassedTests: 21,
      ...overrides,
    }),
    process: { exit },
    console: { error: jest.fn(), log: jest.fn() },
  });
  return exit.mock.calls.length > 0;
}
describe('mandatory live ingest CI selection', () => {
  it('versions the tightened validation contract as a major change', () => {
    expect(CONTRACT_VERSION).toBe('2.0.0');
  });
  it('passes a full result and rejects skips, missing suite and incomplete selection', () => {
    expect(rejected({})).toBe(false);
    for (const mutant of [
      { numTotalTestSuites: 0 },
      { numPendingTests: 1 },
      { numPassedTests: 0 },
      { numPassedTests: 20 },
    ]) {
      expect(rejected(mutant)).toBe(true);
    }
  });
  it('supplies confirmation of the explicitly disposable database', () => {
    expect(workflow).toContain('SCOUT_INGEST_TEST_CONFIRM: scout_ingest_throwaway');
    expect(workflow).toContain('test/rls-scout-ingest-uniqueness.spec.ts --runInBand');
  });
});
