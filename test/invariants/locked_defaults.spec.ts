// test/invariants/locked_defaults.spec.ts
//
// R51 invariant guard — schema / migration / code MUST agree on
// operator-locked default values. Anything that drifts here is a real
// product defect (a user's first save lands on a value the operator
// did not approve). The test reads the three sources at test time so
// it can never be silently bypassed by a hand-edit to one of them.
//
// Each `case` block names the locked rule and the exact literal the
// triple has to agree on. To add a new locked default, append a case.
//
// Pre-existing locked defaults:
//   - CoachBriefPreferences.notification_time = '05:00' (A5-P1-1).
//     Operator directive 2026-05-25: "One per day, per coach's
//     timezone, at coach's chosen notification_time -> it does default
//     to a time, right? Go 5am their time".

import * as fs from 'node:fs';
import * as path from 'node:path';

import { readFileSync } from 'node:fs';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

describe('R51 — locked-default invariants (schema / migration / code)', () => {
  describe('CoachBriefPreferences.notification_time', () => {
    const LOCKED = '05:00';

    it("Prisma schema declares @default(\"05:00\") on notification_time", () => {
      const schema = read('prisma/schema.prisma');
      // Find the CoachBriefPreferences model block, then assert the
      // notification_time line carries the locked default. We anchor on
      // the field name to avoid matching some other model's column.
      const modelMatch = schema.match(
        /model\s+CoachBriefPreferences\s*\{[\s\S]*?\n\}/,
      );
      expect(modelMatch).not.toBeNull();
      const modelBlock = modelMatch![0];
      const line = modelBlock
        .split('\n')
        .find((l) => /^\s*notification_time\b/.test(l));
      expect(line).toBeDefined();
      expect(line).toMatch(new RegExp(`@default\\("${LOCKED}"\\)`));
    });

    it("SQL migration creates CoachBriefPreferences with DEFAULT '05:00'", () => {
      const sql = read(
        'prisma/migrations/20260525120000_add_coach_brief_tables/migration.sql',
      );
      // Reduce to the CREATE TABLE "CoachBriefPreferences" block and
      // search for the notification_time column line within it.
      const tableMatch = sql.match(
        /CREATE TABLE IF NOT EXISTS "CoachBriefPreferences"[\s\S]*?\);/,
      );
      expect(tableMatch).not.toBeNull();
      const tableBlock = tableMatch![0];
      const line = tableBlock
        .split('\n')
        .find((l) => /"notification_time"/.test(l));
      expect(line).toBeDefined();
      expect(line).toMatch(new RegExp(`DEFAULT '${LOCKED}'`));
    });

    it("CoachBriefPreferencesService constant DEFAULT_NOTIFICATION_TIME = '05:00'", () => {
      const ts = read('src/coach/brief/coach-brief-preferences.service.ts');
      // Match the const declaration with the locked literal. Whitespace
      // and quote style (single vs double) is tolerated.
      const re = new RegExp(
        `const\\s+DEFAULT_NOTIFICATION_TIME\\s*=\\s*['\"]${LOCKED}['\"]`,
      );
      expect(ts).toMatch(re);
    });
  });
});
