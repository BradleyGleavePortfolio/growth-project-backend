import { UNRESOLVED_CATALOGUE } from '../../../src/scout/reconciliation/types';
import { UNRESOLVED_CODE, unresolved } from '../../../src/scout/reconstruct/native/native-contract';
import { S9_RUN_REASON_CODES } from '../../../src/scout/lifecycle/lifecycle.service';
import { RUN_REASON_CODES } from '../../../src/scout/lifecycle/reason-codes';
import { S9_REASON_CODES } from '../../../src/scout/reconciliation/types';

/**
 * S9-C Addendum C-9 (docs/decisions/2026-09-25-s9-reconciliation.md): the S9-A reason catalogue
 * versus the S8-C runtime catalogue, pinned as data so a drift in either is a red test, not a
 * silently mis-bucketed histogram key.
 *
 * DEVIATION (reported, not hidden): C-9 asks that the S9-A catalogue "equals" the runtime one.
 * At 771db62a the runtime (`UNRESOLVED_CODE`, 12 codes) is a strict SUBSET of the S9-A catalogue
 * (15 codes): S9-A carries the three S8-DOC §3.7 rows S8-C has not needed to emit yet
 * (`no_native_destination`, `unit_unknown`, `date_zone_unknown`). Equality cannot hold without
 * either deleting S8-DOC rows from the frozen S9-A catalogue or adding unused codes to the S8-C
 * writer contract — both outside the S9-C row of D-S9-8. This spec therefore pins the strongest
 * true statement: every runtime code is in the catalogue with the SAME qualifier shape, and the
 * surplus is exactly the three named rows. Widening S8-C later shrinks the pinned delta here.
 */

/** The S8-C `QUALIFIED` set is not exported; derive it from the writer's own behaviour. */
const runtimeShape = (code: keyof typeof UNRESOLVED_CODE): 'qualified' | 'bare' => {
  let bareThrows = false;
  try {
    unresolved(UNRESOLVED_CODE[code]);
  } catch {
    bareThrows = true;
  }
  return bareThrows ? 'qualified' : 'bare';
};

describe('S9-C C-9 — S9-A unresolved catalogue vs the S8-C runtime catalogue', () => {
  const runtimeCodes = Object.values(UNRESOLVED_CODE).sort();
  const catalogueCodes = Object.keys(UNRESOLVED_CATALOGUE).sort();

  it('every runtime code is a catalogue key (no runtime reason can fold into reason_unrecognised)', () => {
    expect(runtimeCodes).toHaveLength(12);
    for (const code of runtimeCodes) expect(catalogueCodes).toContain(code);
  });

  it('every shared code has the same qualifier shape in both (qualified ⇔ the writer demands one)', () => {
    for (const code of Object.keys(UNRESOLVED_CODE) as Array<keyof typeof UNRESOLVED_CODE>) {
      expect({ code, shape: UNRESOLVED_CATALOGUE[UNRESOLVED_CODE[code]] }).toEqual({
        code,
        shape: runtimeShape(code),
      });
    }
  });

  it('the catalogue surplus is exactly the three S8-DOC §3.7 rows S8-C has not needed (pinned delta)', () => {
    expect(catalogueCodes).toHaveLength(15);
    expect(catalogueCodes.filter((c) => !(runtimeCodes as readonly string[]).includes(c))).toEqual([
      'date_zone_unknown',
      'no_native_destination',
      'unit_unknown',
    ]);
    for (const code of ['date_zone_unknown', 'no_native_destination', 'unit_unknown'] as const) {
      expect(UNRESOLVED_CATALOGUE[code]).toBe('qualified');
    }
  });

  it('a runtime-built qualified reason parses under the S9-A grammar shape the catalogue declares', () => {
    expect(unresolved(UNRESOLVED_CODE.missing_required_field, 'title')).toBe(
      'unresolved:missing_required_field:title',
    );
    expect(unresolved(UNRESOLVED_CODE.identity_conflict)).toBe('unresolved:identity_conflict');
    expect(() => unresolved(UNRESOLVED_CODE.identity_conflict, 'x')).toThrow();
    expect(() => unresolved(UNRESOLVED_CODE.invalid_value)).toThrow();
  });

  it('the three S9 run reason codes are RunReasonCodes appended after the six S7-L codes, order preserved (D-S9-7)', () => {
    // The four S9-A condition codes are all RunReasonCodes (compile-time via S9_RUN_REASON_CODES);
    // `unresolved_family` was already the fifth S7-L code and is reused unchanged (doc L368).
    expect([...S9_RUN_REASON_CODES]).toEqual([...S9_REASON_CODES]);
    for (const code of S9_REASON_CODES) expect(RUN_REASON_CODES).toContain(code);
    expect(RUN_REASON_CODES.slice(0, 6)).toEqual([
      'reconciliation_not_performed',
      'cancelled_by_coach',
      'deadline_exceeded',
      'transfer_failed',
      'unresolved_family',
      'revoked',
    ]);
    expect(RUN_REASON_CODES.slice(6)).toEqual([
      'unresolved_identities',
      'relationship_unverified',
      'coverage_basis_unknown',
    ]);
    expect(RUN_REASON_CODES).toHaveLength(9);
    expect(new Set(RUN_REASON_CODES).size).toBe(9);
  });
});
