/**
 * Guard for B8 contract verdict (Option 2): the dead
 * `coach_direct_enabled` column was dropped from NotificationPreferences.
 *
 * No backend code reads it, no current mobile client writes it, and the
 * mobile DM-push gate is `message_push`. Reintroducing the column would
 * re-create a phantom contract surface and re-open the divergence we
 * just closed. This spec fails loudly if any of the touched surfaces
 * regrows the field.
 *
 * The check is intentionally source-text based: we are guarding the
 * *contract*, not runtime behaviour, and the contract lives in the
 * Prisma schema, the DTO, and the service field-map.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'prisma', 'schema.prisma'), 'utf8');
const DTO = fs.readFileSync(
  path.join(ROOT, 'src', 'notifications', 'notifications.dto.ts'),
  'utf8',
);
const SERVICE = fs.readFileSync(
  path.join(ROOT, 'src', 'notifications', 'notifications.service.ts'),
  'utf8',
);
const DROP_MIGRATION = fs.readFileSync(
  path.join(
    ROOT,
    'prisma',
    'migrations',
    '20260615000000_drop_coach_direct_enabled',
    'migration.sql',
  ),
  'utf8',
);

// Helper: strip Prisma // line comments so the schema check only sees
// real declarations. The drop-migration's rollback note legitimately
// names the column inside SQL comments; we must not match those.
function stripPrismaComments(src: string): string {
  return src.replace(/\/\/[^\n]*/g, '');
}

function stripSqlComments(src: string): string {
  return src.replace(/--[^\n]*/g, '');
}

describe('coach_direct_enabled column drop (B8 verdict Option 2)', () => {
  it('NotificationPreferences model no longer declares coach_direct_enabled', () => {
    const declarations = stripPrismaComments(SCHEMA);
    // The forbidden pattern is the column declaration itself, not the
    // substring — a future migration filename or rollback comment that
    // mentions the name is fine.
    expect(declarations).not.toMatch(/coach_direct_enabled\s+Boolean/);
    expect(declarations).not.toMatch(/coach_direct_enabled\s*:/);
    // Belt-and-suspenders: the snake-case identifier must not appear
    // outside comments at all in the schema.
    expect(declarations.includes('coach_direct_enabled')).toBe(false);
  });

  it('UpdateNotificationPreferencesDto does not expose coach_direct_enabled', () => {
    expect(DTO).not.toMatch(/coach_direct_enabled\s*\??\s*:/);
    expect(DTO.includes('coach_direct_enabled')).toBe(false);
  });

  it('NotificationsService default-prefs map and update field-map do not reference coach_direct_enabled', () => {
    // The service formerly listed the column in two places: the
    // get-defaults return block and the explicit update field-map.
    // Both must be gone — Prisma will reject an unknown column at
    // runtime, so leaving either reference behind is a hard regression.
    expect(SERVICE.includes('coach_direct_enabled')).toBe(false);
  });

  it('drop migration exists, is idempotent, and documents rollback SQL', () => {
    // The DROP itself must be present and guarded against re-run.
    const sqlOnly = stripSqlComments(DROP_MIGRATION);
    expect(sqlOnly).toMatch(
      /ALTER\s+TABLE\s+"NotificationPreferences"\s+DROP\s+COLUMN\s+IF\s+EXISTS\s+"coach_direct_enabled"/i,
    );

    // The rollback recipe (ADD COLUMN with the original NOT NULL +
    // DEFAULT true contract) must be present in the migration header
    // comments so an operator can reverse the change without spelunking
    // through git history.
    expect(DROP_MIGRATION).toMatch(/Rollback/i);
    expect(DROP_MIGRATION).toMatch(
      /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"coach_direct_enabled"\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+true/i,
    );
  });

  it('original additive migration is preserved (append-only history)', () => {
    // Per ENGINEERING_RULES.md §2: migrations are append-only. The
    // original ADD COLUMN migration must remain on disk so any
    // environment that has not yet applied either migration still
    // arrives at the same final state by replaying history.
    const originalPath = path.join(
      ROOT,
      'prisma',
      'migrations',
      '20260609000000_add_coach_direct_enabled',
      'migration.sql',
    );
    expect(fs.existsSync(originalPath)).toBe(true);
  });
});
