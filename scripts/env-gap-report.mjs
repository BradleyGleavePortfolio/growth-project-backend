#!/usr/bin/env node
/**
 * Report environment-key gaps without ever displaying a value.
 *
 * The inventory is deliberately assembled from the runtime ENV_RULES registry
 * plus .env.example.  Do not add an independent key list here: a new runtime
 * rule or documented key must appear in this report automatically.
 *
 * Usage:
 *   node scripts/env-gap-report.mjs --env path/to/.env
 *   node scripts/env-gap-report.mjs --names fly-secrets-list.txt
 *   node scripts/env-gap-report.mjs --write-docs
 *   node scripts/env-gap-report.mjs --check-docs
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import process from 'node:process';

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
const ENV_EXAMPLE_PATH = resolve(repoRoot, '.env.example');
const DOC_PATH = resolve(repoRoot, 'docs/ops/KEYS_NEEDED.md');
const VALUE_NEVER_PRINTED = 'Values are never printed in report output.';

function loadEnvRules() {
  const registryPath = resolve(repoRoot, 'src/common/env-validation.ts');
  const source = readFileSync(registryPath, 'utf8');
  const start = source.indexOf('export const ENV_RULES: EnvRule[] = [');
  const end = source.indexOf('\n];\n\nexport interface EnvValidationResult', start);
  if (start < 0 || end < 0) {
    throw new Error('Could not load ENV_RULES from src/common/env-validation.ts.');
  }
  // ENV_RULES is the runtime registry. Evaluating its array expression avoids
  // a second list while keeping this .mjs executable without a TypeScript
  // loader. The slice ends before any TypeScript-only declarations.
  const registryExpression = source
    .slice(start, end + 3)
    .replace('export const ENV_RULES: EnvRule[] =', 'const ENV_RULES =');
  return Function(`${registryExpression}\nreturn ENV_RULES;`)();
}

const ENV_RULES = loadEnvRules();

function usage() {
  return [
    'Usage: node scripts/env-gap-report.mjs (--env <file> | --names <file>)',
    '       node scripts/env-gap-report.mjs --write-docs',
    '       node scripts/env-gap-report.mjs --check-docs',
    '',
    '--env parses NAME=value lines locally; values are used only to classify SET / EMPTY.',
    '--names accepts the name-only table emitted by fly secrets list (or one name per line).',
  ].join('\n');
}

function parseArgs(argv) {
  const args = { env: null, names: null, writeDocs: false, checkDocs: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--env' || arg === '--names') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a file path.`);
      args[arg.slice(2)] = value;
    } else if (arg === '--write-docs') {
      args.writeDocs = true;
    } else if (arg === '--check-docs') {
      args.checkDocs = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if ((args.env && args.names) || ((args.env || args.names) && (args.writeDocs || args.checkDocs))) {
    throw new Error('Choose exactly one input mode or one documentation mode.');
  }
  if (!args.help && !args.env && !args.names && !args.writeDocs && !args.checkDocs) {
    throw new Error('An input mode or documentation mode is required.');
  }
  return args;
}

function normalizeTier(tier) {
  return tier === 'hard' || tier === 'prod' ? tier : 'optional';
}

function cleanDescription(value) {
  const compact = value.replace(/\s+/g, ' ').trim();
  const firstSentence = compact.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? compact;
  return firstSentence.replace(/\|/g, '\\|');
}

function parseEnvExample() {
  const lines = readFileSync(ENV_EXAMPLE_PATH, 'utf8').split(/\r?\n/);
  const documented = new Map();
  const requiredWhenEnabled = new Map();
  let comments = [];

  for (const line of lines) {
    const comment = line.match(/^\s*#\s?(.*)$/);
    if (comment) {
      comments.push(comment[1].trim());
      continue;
    }
    const assignment = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=(.*)$/);
    if (!assignment) {
      if (line.trim()) comments = [];
      continue;
    }
    const [, name] = assignment;
    const context = comments.join(' ');
    documented.set(name, cleanDescription(context) || 'Documented environment setting.');

    // Keep conditional requirements in the source documentation rather than
    // a second hand-maintained mapping. Both supported phrasings occur in the
    // checked-in example file.
    const requiresBeforeFlag = context.match(
      /requires?\s+([A-Z][A-Z0-9_]*)\b[\s\S]*?\bwhen enabled\b/i,
    );
    if (requiresBeforeFlag) {
      requiredWhenEnabled.set(requiresBeforeFlag[1], name);
    }
    const flagBeforeTarget = context.match(
      /required\s+whenever\s+([A-Z][A-Z0-9_]*)\s*=\s*true/i,
    );
    if (flagBeforeTarget) {
      requiredWhenEnabled.set(flagBeforeTarget[1], name);
    }
    comments = [];
  }
  return { documented, requiredWhenEnabled };
}

function buildCatalog() {
  const { documented, requiredWhenEnabled } = parseEnvExample();
  const rules = new Map(ENV_RULES.map((rule) => [rule.name, rule]));
  const names = new Set([...documented.keys(), ...rules.keys()]);
  const catalog = [...names].map((name) => {
    const rule = rules.get(name);
    const dependentFlag = requiredWhenEnabled.get(name);
    const description = rule ? cleanDescription(rule.reason) : documented.get(name);
    const condition = dependentFlag ? ` Required when ${dependentFlag}=true.` : '';
    return {
      name,
      tier: normalizeTier(rule?.tier),
      feature: `${description ?? 'Documented environment setting.'}${condition}`,
      requiredWhenEnabledBy: dependentFlag ?? null,
    };
  });
  return catalog.sort((a, b) => {
    if (a.name === 'ANTHROPIC_API_KEY') return -1;
    if (b.name === 'ANTHROPIC_API_KEY') return 1;
    return a.name.localeCompare(b.name);
  });
}

function parseEnvFile(filePath, knownNames) {
  const statuses = new Map();
  const names = new Set(knownNames);
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const assignment = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=(.*)$/);
    if (!assignment || !names.has(assignment[1])) continue;
    statuses.set(assignment[1], normalizeEnvValue(assignment[2]).length === 0 ? 'EMPTY' : 'SET');
  }
  return statuses;
}

function parseNamesFile(filePath, knownNames) {
  const statuses = new Map();
  const names = new Set(knownNames);
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    for (const token of line.match(/[A-Z][A-Z0-9_]*/g) ?? []) {
      if (names.has(token)) statuses.set(token, 'SET');
    }
  }
  return statuses;
}

function normalizeEnvValue(raw) {
  const trimmed = raw.trim();
  const quoted = trimmed.match(/^(['"])([\s\S]*)\1$/);
  return (quoted ? quoted[2] : trimmed).trim();
}

function isEnabled(value) {
  return typeof value === 'string' && /^(true|on|1|yes)$/i.test(normalizeEnvValue(value));
}

function parseEnvValuesForFlags(filePath) {
  const values = new Map();
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const assignment = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=(.*)$/);
    if (assignment) values.set(assignment[1], normalizeEnvValue(assignment[2]));
  }
  return values;
}

function renderReport(catalog, statuses, enabledFlags) {
  const rows = catalog.map((entry) => {
    const status = statuses.get(entry.name) ?? 'MISSING';
    const requiredByEnabledFlag =
      entry.requiredWhenEnabledBy && enabledFlags.has(entry.requiredWhenEnabledBy);
    const note = requiredByEnabledFlag ? 'NEEDED BY USER — enabled flag dependency.' : 'NEEDED BY USER.';
    return { ...entry, status, requiredByEnabledFlag, note };
  });
  const width = {
    name: Math.max(4, ...rows.map((row) => row.name.length)),
    tier: Math.max(4, ...rows.map((row) => row.tier.length)),
    status: Math.max(6, ...rows.map((row) => row.status.length)),
  };
  const pad = (value, length) => value + ' '.repeat(Math.max(0, length - value.length));
  const output = [
    '[env-gap-report] Environment key inventory',
    `[env-gap-report] ${VALUE_NEVER_PRINTED}`,
    '',
    `${pad('NAME', width.name)}  ${pad('TIER', width.tier)}  ${pad('STATUS', width.status)}  FEATURE OR FLAG`,
    `${'-'.repeat(width.name)}  ${'-'.repeat(width.tier)}  ${'-'.repeat(width.status)}  ---------------`,
    ...rows.map(
      (row) =>
        `${pad(row.name, width.name)}  ${pad(row.tier, width.tier)}  ${pad(row.status, width.status)}  ${row.feature} ${row.note}`,
    ),
  ];
  return { output: output.join('\n'), rows };
}

function renderDocs(catalog) {
  const rows = catalog.map(
    (entry) =>
      `| \`${entry.name}\` | ${entry.tier} | ${entry.feature} | MISSING | NEEDED BY USER |`,
  );
  return [
    '# Keys needed',
    '',
    '> Generated by `node scripts/env-gap-report.mjs --write-docs`; do not edit by hand.',
    '>',
    `> ${VALUE_NEVER_PRINTED}`,
    '',
    'This inventory is generated from `src/common/env-validation.ts` and `.env.example`.',
    'It represents an empty local environment, so every listed key is shown as `MISSING`.',
    'Use `node scripts/env-gap-report.mjs --env path/to/.env` or `--names fly-secrets-list.txt`',
    'to inspect a local file or the names-only Fly listing. A non-zero result means a hard/prod',
    'key is empty or missing, or a documented dependency is missing while its flag is enabled.',
    '',
    '| Name | Tier | Feature or flag served | Status in empty inventory | Operator note |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return 0;
  }
  const catalog = buildCatalog();

  if (args.writeDocs || args.checkDocs) {
    const expected = renderDocs(catalog);
    if (args.checkDocs) {
      const actual = existsSync(DOC_PATH) ? readFileSync(DOC_PATH, 'utf8') : '';
      if (actual !== expected) {
        console.error('[env-gap-report] docs/ops/KEYS_NEEDED.md is stale. Run --write-docs.');
        return 1;
      }
      console.log('[env-gap-report] docs/ops/KEYS_NEEDED.md is up to date.');
      return 0;
    }
    mkdirSync(dirname(DOC_PATH), { recursive: true });
    writeFileSync(DOC_PATH, expected, 'utf8');
    console.log(`[env-gap-report] wrote ${relative(repoRoot, DOC_PATH)}`);
    return 0;
  }

  const inputPath = resolve(repoRoot, args.env ?? args.names);
  if (!existsSync(inputPath)) throw new Error(`Input file does not exist: ${args.env ? '--env' : '--names'} path.`);
  const statuses = args.env
    ? parseEnvFile(inputPath, catalog.map((entry) => entry.name))
    : parseNamesFile(inputPath, catalog.map((entry) => entry.name));
  const values = args.env ? parseEnvValuesForFlags(inputPath) : new Map();
  const enabledFlags = new Set(
    [...values.entries()].filter(([, value]) => isEnabled(value)).map(([name]) => name),
  );
  const { output, rows } = renderReport(catalog, statuses, enabledFlags);
  console.log(output);
  return rows.some(
    (row) =>
      row.status !== 'SET' &&
      (row.tier === 'hard' || row.tier === 'prod' || row.requiredByEnabledFlag),
  )
    ? 1
    : 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`[env-gap-report] ${error instanceof Error ? error.message : 'Unexpected error.'}`);
  process.exitCode = 2;
}
