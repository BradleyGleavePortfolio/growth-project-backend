#!/usr/bin/env ts-node
/**
 * scripts/secrets/list.ts
 *
 * Lists every environment variable the app actually reads (by scanning
 * process.env.X references in the source tree), then compares that list
 * against the secrets tracked in SecretsService.SECRET_INVENTORY.
 *
 * Usage:
 *   npx ts-node scripts/secrets/list.ts
 *
 * Output:
 *   - A table of all env vars found in source code
 *   - Which ones are in the SECRET_INVENTORY (tracked for rotation)
 *   - Which ones are missing from the inventory (add them!)
 *   - Which inventory entries have no matching source reference (dead entries)
 *
 * This script does NOT read actual secret values — it only reads source code
 * and the in-memory SECRET_INVENTORY definition.
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Configuration ──────────────────────────────────────────────────────────

const SRC_ROOT = path.resolve(__dirname, '../../src');
const SCRIPTS_ROOT = path.resolve(__dirname, '../../scripts');
const EXCLUDED_DIRS = ['node_modules', '.git', 'dist', '.next', 'coverage'];
const SOURCE_EXTENSIONS = ['.ts', '.js', '.mjs'];

// ─── Step 1: Scan source tree for process.env.X references ──────────────────

function walkDir(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.includes(entry.name)) {
        files.push(...walkDir(full));
      }
    } else if (SOURCE_EXTENSIONS.includes(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

function extractEnvRefs(files: string[]): Map<string, string[]> {
  // Map: env var name → list of file paths that reference it
  const refs = new Map<string, string[]>();
  const pattern = /process\.env\.([A-Z][A-Z0-9_]*)/g;

  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      let match: RegExpExecArray | null;
      pattern.lastIndex = 0;
      while ((match = pattern.exec(content)) !== null) {
        const varName = match[1];
        if (!refs.has(varName)) refs.set(varName, []);
        // Store relative path for readability
        const relPath = path.relative(process.cwd(), file);
        if (!refs.get(varName)!.includes(relPath)) {
          refs.get(varName)!.push(relPath);
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return refs;
}

// ─── Step 2: Load the SECRET_INVENTORY from the service ─────────────────────

// We import the raw constant rather than instantiating the service to avoid
// needing a full NestJS context.
type SecretDefinition = {
  name: string;
  description: string;
  cadenceDays: number;
  tier: 'critical' | 'high' | 'standard';
};

// Read and eval the SECRET_INVENTORY from secrets.service.ts without
// importing via ts-node module resolution (which needs the full DI graph).
function loadInventory(): SecretDefinition[] {
  const servicePath = path.resolve(
    __dirname,
    '../../src/secrets/secrets.service.ts',
  );
  if (!fs.existsSync(servicePath)) {
    console.error(
      `\n[ERROR] Cannot find secrets.service.ts at: ${servicePath}\n` +
        `Make sure you are running this script from the repo root.\n`,
    );
    process.exit(1);
  }

  // Extract the SECRET_INVENTORY array via regex (avoid full TS compilation)
  const content = fs.readFileSync(servicePath, 'utf-8');
  const match = content.match(
    /export const SECRET_INVENTORY[^=]*=\s*(\[[\s\S]*?\n\];)/,
  );
  if (!match) {
    console.error(
      '[ERROR] Could not locate SECRET_INVENTORY in secrets.service.ts\n',
    );
    process.exit(1);
  }

  // Use Function constructor to evaluate the array literal in isolation
  // (safe because we control the source file and this is a dev script)
  try {
    // eslint-disable-next-line no-new-func
    const inventory = new Function(`return ${match[1]}`)() as SecretDefinition[];
    return inventory;
  } catch (e) {
    console.error(`[ERROR] Failed to parse SECRET_INVENTORY: ${(e as Error).message}\n`);
    process.exit(1);
  }
}

// ─── Step 3: Render output ───────────────────────────────────────────────────

function padRight(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function main() {
  console.log('\n=== Secrets Inventory & Source Reference Check ===\n');

  const allFiles = [
    ...walkDir(SRC_ROOT),
    ...walkDir(SCRIPTS_ROOT),
  ];

  const refs = extractEnvRefs(allFiles);
  const inventory = loadInventory();

  const inventoryNames = new Set(inventory.map((d) => d.name));
  const refNames = new Set(refs.keys());

  // ── Categorise ────────────────────────────────────────────────────────────
  const trackedAndReferenced: string[] = [];
  const referencedButUntracked: string[] = [];
  const trackedButNoSourceRef: string[] = [];

  for (const name of refNames) {
    if (inventoryNames.has(name)) {
      trackedAndReferenced.push(name);
    } else {
      referencedButUntracked.push(name);
    }
  }

  for (const name of inventoryNames) {
    if (!refNames.has(name)) {
      trackedButNoSourceRef.push(name);
    }
  }

  // ── Table: all env vars found in source ───────────────────────────────────
  console.log(
    `${padRight('ENV VAR', 40)} ${padRight('TRACKED', 10)} ${padRight('TIER', 10)} FILES`,
  );
  console.log('-'.repeat(100));

  const sortedRefs = [...refNames].sort();
  for (const name of sortedRefs) {
    const def = inventory.find((d) => d.name === name);
    const tracked = def ? '✅ yes' : '⚠️  no';
    const tier = def ? def.tier : '—';
    const files = refs.get(name)!.slice(0, 3).join(', ');
    const more = (refs.get(name)!.length > 3) ? ` (+${refs.get(name)!.length - 3} more)` : '';
    console.log(
      `${padRight(name, 40)} ${padRight(tracked, 10)} ${padRight(tier, 10)} ${files}${more}`,
    );
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n─── Summary ───────────────────────────────────────────────\n`);
  console.log(`  Total env vars referenced in source: ${refNames.size}`);
  console.log(`  Tracked in SECRET_INVENTORY:         ${trackedAndReferenced.length}`);

  if (referencedButUntracked.length > 0) {
    console.log(
      `\n⚠️  Referenced in source but NOT in inventory (${referencedButUntracked.length}):`,
    );
    for (const name of referencedButUntracked.sort()) {
      console.log(`     - ${name}`);
    }
    console.log(
      `\n   Action: Add these to SECRET_INVENTORY in src/secrets/secrets.service.ts\n` +
        `   if they contain sensitive values.\n`,
    );
  } else {
    console.log(`\n✅ All referenced env vars are in the inventory.`);
  }

  if (trackedButNoSourceRef.length > 0) {
    console.log(
      `\n🔍 In inventory but no source reference found (${trackedButNoSourceRef.length}):`,
    );
    for (const name of trackedButNoSourceRef.sort()) {
      console.log(`     - ${name}`);
    }
    console.log(
      `\n   These may be referenced indirectly (e.g. passed to a library),\n` +
        `   or may be unused. Review before removing from the inventory.\n`,
    );
  }

  console.log('');

  // Exit with non-zero if there are untracked secrets (CI-safe)
  if (referencedButUntracked.length > 0) {
    console.log(
      `Exit code 1: ${referencedButUntracked.length} secret(s) are referenced in source ` +
        `but missing from the rotation inventory.\n`,
    );
    process.exit(1);
  }
}

main();
