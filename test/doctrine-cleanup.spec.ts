import * as fs from 'fs';
import * as path from 'path';

/**
 * Doctrine guard: this test stands in for the human discipline of "keep the
 * data model aligned with the product surface." The MVP -> enterprise audit
 * (M-4) called out streaks, badges, and per-win reactions as a P0 doctrine
 * violation. After the cleanup PR landed, schema drift in the wrong direction
 * would silently re-introduce the smell. This spec fails loudly the moment a
 * forbidden token reappears in prisma/schema.prisma.
 */
describe('doctrine-cleanup: prisma/schema.prisma is free of streak/badge/reaction primitives', () => {
  const schemaPath = path.resolve(__dirname, '..', 'prisma', 'schema.prisma');
  const schema = fs.readFileSync(schemaPath, 'utf8');

  // Per the audit: case-sensitive on the model/enum-style identifiers,
  // case-insensitive-style snake substrings on the column-name patterns. The
  // intent is "no Prisma model named *Badge*, *Streak*, *Reaction*; no column
  // named streak_* or badge_*."
  const forbiddenTokens: string[] = [
    'Badge',
    'Streak',
    'Reaction',
    'streak_',
    'badge_',
  ];

  for (const token of forbiddenTokens) {
    it(`schema.prisma must not contain "${token}"`, () => {
      const idx = schema.indexOf(token);
      if (idx !== -1) {
        const lineStart = schema.lastIndexOf('\n', idx) + 1;
        const lineEnd = schema.indexOf('\n', idx);
        const line = schema.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
        const lineNo = schema.slice(0, idx).split('\n').length;
        throw new Error(
          `Doctrine violation: forbidden token "${token}" found in prisma/schema.prisma at line ${lineNo}: ${line.trim()}`,
        );
      }
      expect(idx).toBe(-1);
    });
  }
});
