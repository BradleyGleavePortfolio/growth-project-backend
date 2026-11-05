import { readFileSync } from 'fs';
import { join } from 'path';

// LO-1180R2 B1: the README's Prisma Models row for NotificationPreferences
// says every setting family has an _inapp, _push and _email flag. The schema
// is the source of truth: any family that lacks one of the three must be
// named in that row, or the row must not claim the full set.
describe('LO-1180R2 B1: the notification README states the real preference flag families', () => {
  it('does not claim an _inapp, _push and _email flag for a family that lacks one', () => {
    const schema = readFileSync(join(__dirname, '../prisma/schema.prisma'), 'utf8');
    const model = schema.match(/^model NotificationPreferences \{[\s\S]*?^\}/m);
    expect(model).not.toBeNull();

    const channels = new Map<string, Set<string>>();
    for (const m of model![0].matchAll(/^\s+(\w+)_(inapp|push|email)\s+Boolean\b/gm)) {
      const family = channels.get(m[1]) ?? new Set<string>();
      family.add(m[2]);
      channels.set(m[1], family);
    }
    const incomplete = [...channels.entries()]
      .filter(([, set]) => set.size < 3)
      .map(([family]) => family)
      .sort();

    const readme = readFileSync(join(__dirname, '../src/notifications/README.md'), 'utf8');
    const row = readme.split('\n').find((line) => /^\|\s*`NotificationPreferences`\s*\|/.test(line));
    expect(row).toBeDefined();

    const claimsFullSet = /`_inapp`, `_push` and `_email` flag for each setting family/.test(row!);
    const unnamed = claimsFullSet ? incomplete.filter((family) => !row!.includes(family)) : [];
    expect(unnamed).toEqual([]);
  });
});
