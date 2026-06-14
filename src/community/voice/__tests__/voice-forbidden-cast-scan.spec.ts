import * as fs from 'fs';
import * as path from 'path';

/**
 * R0 forbidden-pattern scan, pinned as a test so the gate travels with the
 * suite (not just CI grep). The v3-3 voice slice and the messaging.service.ts
 * the upload logic was extracted FROM must contain NONE of the banned
 * type-escape hatches or placeholder copy.
 *
 * The messaging service is included deliberately: its pre-extraction
 * structural double-cast (the documented Supabase version-skew guard) was
 * replaced by the named VoiceUploadProvider interface in this PR, and this test
 * is the regression lock that it never creeps back.
 *
 * `@ts-expect-error <reason>` is permitted by R0 when justified (the unit specs
 * use it for partial structural mocks), so the scan targets only the SHIPPED
 * source files, not the specs.
 */
const VOICE_DIR = path.join(__dirname, '..');
const MESSAGING_SERVICE = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'messaging',
  'messaging.service.ts',
);

// Each pattern is a literal the R0 ban list forbids. `as unknown as` /
// `as never` cover the structural double-cast family; `as any` the blanket
// escape; the `.catch` forms the silent error-swallow; "coming soon" the
// placeholder copy (case-insensitive).
const FORBIDDEN: { label: string; re: RegExp }[] = [
  { label: 'as any', re: /\bas\s+any\b/ },
  { label: 'as unknown as', re: /\bas\s+unknown\s+as\b/ },
  { label: 'as never', re: /\bas\s+never\b/ },
  { label: '@ts-ignore', re: /@ts-ignore/ },
  { label: '@ts-nocheck', re: /@ts-nocheck/ },
  {
    label: 'silent .catch',
    re: /\.catch\(\s*\(\s*\)\s*=>\s*(undefined|null|\{\s*\})\s*\)/,
  },
  { label: 'coming soon', re: /coming\s+soon/i },
];

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Specs may legitimately use justified @ts-expect-error for mocks.
      if (entry.name === '__tests__') continue;
      out.push(...collectSourceFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('R0 forbidden-pattern scan (v3-3 voice slice + messaging.service)', () => {
  const files = [...collectSourceFiles(VOICE_DIR), MESSAGING_SERVICE];

  it('scans at least the voice slice + the extracted-from messaging service', () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
    expect(files).toContain(MESSAGING_SERVICE);
  });

  for (const file of [...collectSourceFiles(VOICE_DIR), MESSAGING_SERVICE]) {
    const rel = path.relative(path.join(VOICE_DIR, '..', '..', '..'), file);
    it(`is free of forbidden patterns: ${rel}`, () => {
      const text = fs.readFileSync(file, 'utf8');
      const hits = FORBIDDEN.filter((p) => p.re.test(text)).map((p) => p.label);
      expect(hits).toEqual([]);
    });
  }
});
