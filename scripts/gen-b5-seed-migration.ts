/* eslint-disable */
/**
 * One-shot generator for the B5 contract-template seed migration.
 *
 * Reads the 4 markdown seed drafts in src/contracts/templates/seed/ and emits a
 * raw-SQL data-seed migration (idempotent, ON CONFLICT DO NOTHING) that seeds:
 *   - a stable TGP "system coach" User row (fixed id) so the platform-waiver
 *     ContractTemplate.coach_id FK is satisfiable, and
 *   - the 4 ContractTemplate rows (platform waiver + 3 coach starters).
 *
 * Run: ts-node scripts/gen-b5-seed-migration.ts
 * NOTE: developer tool, not shipped runtime code.
 */
import * as fs from 'fs';
import * as path from 'path';

const SEED_DIR = path.join(__dirname, '..', 'src', 'contracts', 'templates', 'seed');
const OUT = path.join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20261215000100_seed_b5_contract_templates',
  'migration.sql',
);

const SYSTEM_COACH_ID = 'b5-system-coach-tgp';

// Stable template ids (referenced by seeded rows + future coach package opt-in).
const TEMPLATES = [
  { file: 'platform-waiver-v1.md', id: 'b5-tpl-platform-waiver-v1', name: 'Platform Liability Waiver', isPlatform: true },
  { file: 'standard-coaching-v1.md', id: 'b5-tpl-standard-coaching-v1', name: 'Standard Coaching Agreement', isPlatform: false },
  { file: 'group-program-v1.md', id: 'b5-tpl-group-program-v1', name: 'Group Program Terms', isPlatform: false },
  { file: 'course-purchase-v1.md', id: 'b5-tpl-course-purchase-v1', name: 'Course Purchase Terms', isPlatform: false },
];

// SQL string literal (single-quote escaped).
function sql(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

// Merge fields referenced by every template body (dynamic_fields_json).
const DYNAMIC_FIELDS = {
  client: ['first_name', 'last_name', 'email', 'signature_block'],
  coach: ['business_name', 'first_name', 'signature_block'],
  package: ['name', 'price', 'duration'],
  platform: ['legal_name', 'jurisdiction', 'signature_block'],
  today: true,
};

let out = '';
out += `-- B5 supplemental — seed the 4 contract templates + TGP system-coach user.\n`;
out += `--\n`;
out += `-- DATA-ONLY migration (no DDL). Mirrors the repo's raw-SQL seed-migration\n`;
out += `-- precedent (e.g. 20261211000001_seed_sleep_consistency_metric_defs).\n`;
out += `-- Idempotent via ON CONFLICT DO NOTHING so re-running is a no-op.\n`;
out += `--\n`;
out += `-- The platform liability waiver (is_platform=true) needs a NOT NULL coach_id\n`;
out += `-- FK; we seed a dedicated TGP system-coach User (fixed id) to satisfy it,\n`;
out += `-- rather than making coach_id nullable. Coach-authored Layer-2 starters are\n`;
out += `-- ALSO owned by the system coach as canonical library templates; a coach who\n`;
out += `-- adopts one gets their own copy through ContractTemplateService.\n`;
out += `--\n`;
out += `-- DISCLAIMER: Draft wording prepared by agent without licensed legal review.\n`;
out += `-- FEATURE_CONTRACTS_ENABLED MUST remain OFF in prod until reviewed by counsel.\n\n`;

out += `INSERT INTO "User" ("id", "supabase_id", "email", "name", "role")\nVALUES (\n`;
out += `  ${sql(SYSTEM_COACH_ID)},\n`;
out += `  ${sql('b5-system-coach-tgp')},\n`;
out += `  ${sql('contracts-system@trygrowthproject.com')},\n`;
out += `  ${sql('Growth Project (System)')},\n`;
out += `  'coach'\n`;
out += `)\nON CONFLICT ("id") DO NOTHING;\n\n`;

for (const t of TEMPLATES) {
  const body = fs.readFileSync(path.join(SEED_DIR, t.file), 'utf8');
  out += `-- ${t.name} (${t.file})\n`;
  out += `INSERT INTO "ContractTemplate"\n`;
  out += `  ("id", "coach_id", "is_platform", "name", "body_markdown", "version", "dynamic_fields_json", "requires_signature")\nVALUES (\n`;
  out += `  ${sql(t.id)},\n`;
  out += `  ${sql(SYSTEM_COACH_ID)},\n`;
  out += `  ${t.isPlatform},\n`;
  out += `  ${sql(t.name)},\n`;
  out += `  ${sql(body)},\n`;
  out += `  1,\n`;
  out += `  ${sql(JSON.stringify(DYNAMIC_FIELDS))}::jsonb,\n`;
  out += `  true\n`;
  out += `)\nON CONFLICT ("id") DO NOTHING;\n\n`;
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out, 'utf8');
console.log('Wrote', OUT, '(', out.length, 'bytes )');
