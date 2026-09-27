import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  COMPLETENESS_BASIS_KINDS,
  EVIDENCE_KEYS,
  MANIFEST_KEYS,
  OBSERVATION_CONFLICT_CODES,
  PROVING_BASIS_KINDS,
  STATEMENT_KEYS,
} from '../../../src/scout/induction/contract';
import { RUN_CONFLICT_CODES } from '../../../src/scout/lifecycle/reason-codes';
import { COMPLETENESS_BASIS_NONE } from '../../../src/scout/reconciliation/types';

/**
 * S10-A — the closed vocabularies are exactly the D-S10-2 / D-S10-4 text (the S10-D gate item 7
 * freezes them), and no source-name literal enters `src/scout/induction/*.ts` (R28, D-S10-8).
 */

const INDUCTION_SRC = join(__dirname, '../../../src/scout/induction');

describe('closed vocabularies', () => {
  it('COMPLETENESS_BASIS_KINDS is exactly none + source_signed_enumeration, none first', () => {
    expect([...COMPLETENESS_BASIS_KINDS]).toEqual(['none', 'source_signed_enumeration']);
    expect(COMPLETENESS_BASIS_KINDS[0]).toBe(COMPLETENESS_BASIS_NONE);
    expect([...PROVING_BASIS_KINDS]).toEqual(
      COMPLETENESS_BASIS_KINDS.filter((kind) => kind !== COMPLETENESS_BASIS_NONE),
    );
    // No page-chain kind in v1 (deferred, §5); no kind names a source.
    expect(COMPLETENESS_BASIS_KINDS.some((kind) => /chain|page|extension/.test(kind))).toBe(false);
  });

  it('OBSERVATION_CONFLICT_CODES is exactly the D-S10-4 list and disjoint from RUN_CONFLICT_CODES', () => {
    expect([...OBSERVATION_CONFLICT_CODES]).toEqual([
      'declaration_conflict',
      'declaration_after_ingest',
      'declaration_missing',
      'observation_conflict',
      'observation_after_claim',
      'observation_not_declared',
    ]);
    const run: readonly string[] = RUN_CONFLICT_CODES;
    expect(OBSERVATION_CONFLICT_CODES.filter((code) => run.includes(code))).toEqual([]);
  });

  it('statement keys are the canonical (code-point sorted) SourceEnumerationStatementV1 keys', () => {
    expect([...STATEMENT_KEYS]).toEqual([...STATEMENT_KEYS].sort());
    expect(STATEMENT_KEYS).toHaveLength(11);
    expect(new Set(EVIDENCE_KEYS).size).toBe(9);
    expect(new Set(MANIFEST_KEYS).size).toBe(6);
  });
});

describe('R28 — no source-name literal in src/scout/induction/*.ts', () => {
  const files = readdirSync(INDUCTION_SRC).filter((name) => name.endsWith('.ts'));

  it('scans the five S10-A modules', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        'contract.ts',
        'digest.ts',
        'manifest-registry.ts',
        'parse.ts',
        'verify.ts',
      ]),
    );
  });

  it.each(['s10_unseen', 'truecoach', 'conformance_alpha', 'conformance_beta', 'trainerize'])(
    'no file mentions %s',
    (slug) => {
      for (const name of files) {
        expect([name, readFileSync(join(INDUCTION_SRC, name), 'utf8').includes(slug)]).toEqual([
          name,
          false,
        ]);
      }
    },
  );
});
