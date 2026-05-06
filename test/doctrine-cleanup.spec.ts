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
  //
  // Allowlist: PTM is an internal advisory scoring model whose signal-type
  // and alert-type enums are NOT user-visible product surface — clients
  // never see the values. `checkin_streak` and `streak_dropped` are
  // observational signals (a streak length seen on submit; a 50%+ drop
  // in cadence) emitted into ClientSignal so the heuristic + weighted
  // engines can reason over them. They are not gamification primitives
  // and do not belong on the forbidden list. The guard below scopes the
  // check to schema content OUTSIDE of comments and OUTSIDE of the PTM
  // enums (PtmSignalType, PtmOutcomeType, PtmPredictionBasis).
  const forbiddenTokens: string[] = [
    'Badge',
    'Streak',
    'Reaction',
    'streak_',
    'badge_',
  ];

  // Strip line comments and the bodies of PTM enums so a forbidden token
  // appearing only inside a comment or only as a PTM enum value does not
  // count as a violation. This keeps the guard precise about what the
  // doctrine actually outlaws (models / columns / non-PTM enums) without
  // pretending PTM signal labels do not exist.
  function stripCommentsAndPtmEnums(src: string): string {
    // Remove // ... line comments (Prisma supports them).
    let out = src.replace(/\/\/[^\n]*/g, '');
    // Remove the body (between { and }) of any enum whose name starts with
    // "Ptm". We do this conservatively block-by-block so we never gobble
    // unrelated content.
    out = out.replace(/enum\s+Ptm\w*\s*{[\s\S]*?}/g, (block) => {
      const headerEnd = block.indexOf('{');
      const tailStart = block.lastIndexOf('}');
      // Keep the header ("enum PtmFoo {") and the closing brace; drop the
      // body. The header still contains "Ptm" but no forbidden tokens.
      return block.slice(0, headerEnd + 1) + block.slice(tailStart);
    });
    return out;
  }

  const stripped = stripCommentsAndPtmEnums(schema);

  for (const token of forbiddenTokens) {
    it(`schema.prisma must not contain "${token}" outside comments and PTM enums`, () => {
      const idx = stripped.indexOf(token);
      if (idx !== -1) {
        const lineStart = stripped.lastIndexOf('\n', idx) + 1;
        const lineEnd = stripped.indexOf('\n', idx);
        const line = stripped.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
        const lineNo = stripped.slice(0, idx).split('\n').length;
        throw new Error(
          `Doctrine violation: forbidden token "${token}" found in prisma/schema.prisma (post-strip) near line ${lineNo}: ${line.trim()}`,
        );
      }
      expect(idx).toBe(-1);
    });
  }
});
