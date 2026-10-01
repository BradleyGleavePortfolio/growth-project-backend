'use strict';

// Schema parity gate (.github/workflows/schema-parity.yml).
//
// Input: the reconciliation script printed by
//   prisma migrate diff --from-url <db built by `prisma migrate deploy`>
//                       --to-schema-datamodel prisma/schema.prisma --script
// i.e. the DDL that would turn the database the migration chain builds into the
// database prisma/schema.prisma describes. An empty script means parity.
//
// The gate fails closed when:
//   1. the script declares an object the chain never creates (a table, an enum, an
//      enum value or a column). That is the class that took production down in
//      2026-10 ("column User.archived_at does not exist"), so it can never be
//      accepted through the baseline;
//   2. the script contains any drift item that is not in the committed baseline
//      (prisma/schema-parity-baseline.sql), i.e. a change introduced new drift;
//   3. the baseline lists an item that is no longer drift. The baseline only ever
//      shrinks: fixing drift requires deleting its line in the same change;
//   4. the input is missing, empty or unreadable.
//
// The baseline holds the pre-existing drift that predates this gate (tracked as
// BL-MIGRATION-REBASELINE). Reaching zero means deleting every baseline line.
//
// Items: statements split on top-level semicolons, comment lines dropped,
// whitespace collapsed, and each `ALTER TABLE t a, b, c` split into one item per
// clause so a fix to one clause of a table does not disturb the others.
//
// Standalone CommonJS, unit-tested by test/ci/schema-parity-gate.spec.ts.

const fs = require('fs');

const MISSING_OBJECT_RULES = Object.freeze([
  { re: /^CREATE TABLE\b/i, what: 'table' },
  { re: /^CREATE TYPE\b/i, what: 'enum' },
  { re: /^ALTER TYPE\b.*\bADD VALUE\b/i, what: 'enum value' },
  { re: /^ALTER TABLE\b.*\bADD COLUMN\b/i, what: 'column' },
]);

// Split `text` on `sep` at paren depth 0, outside '...' and "..." quotes.
function splitTopLevel(text, sep) {
  const parts = [];
  let current = '';
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote) {
        if (text[i + 1] === quote) {
          current += text[i + 1];
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

const ALTER_TABLE_RE = /^(ALTER TABLE (?:"(?:[^"]|"")*"|[^\s"]+)(?:\.(?:"(?:[^"]|"")*"|[^\s"]+))?) (.+)$/is;

function parseItems(sqlText) {
  const body = String(sqlText)
    .split(/\r?\n/)
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');
  const items = [];
  for (const raw of splitTopLevel(body, ';')) {
    const stmt = raw.replace(/\s+/g, ' ').trim();
    if (!stmt) continue;
    const m = ALTER_TABLE_RE.exec(stmt);
    if (m) {
      for (const clause of splitTopLevel(m[2], ',')) {
        const c = clause.trim();
        if (c) items.push(`${m[1]} ${c}`);
      }
    } else {
      items.push(stmt);
    }
  }
  return [...new Set(items)].sort();
}

function missingObjectKind(item) {
  const rule = MISSING_OBJECT_RULES.find((r) => r.re.test(item));
  return rule ? rule.what : null;
}

function evaluate(driftText, baselineText) {
  const current = parseItems(driftText);
  const baseline = parseItems(baselineText);
  const currentSet = new Set(current);
  const baselineSet = new Set(baseline);
  const missingObjects = current
    .map((item) => ({ item, kind: missingObjectKind(item) }))
    .filter((x) => x.kind !== null);
  const baselinedMissingObjects = baseline.filter((item) => missingObjectKind(item) !== null);
  const newDrift = current.filter((item) => !baselineSet.has(item));
  const resolved = baseline.filter((item) => !currentSet.has(item));
  const ok =
    missingObjects.length === 0 &&
    baselinedMissingObjects.length === 0 &&
    newDrift.length === 0 &&
    resolved.length === 0;
  return { ok, current, baseline, missingObjects, baselinedMissingObjects, newDrift, resolved };
}

const BASELINE_HEADER = [
  '-- Schema parity baseline: drift between the database the migration chain builds and',
  '-- prisma/schema.prisma that predates the blocking gate (BL-MIGRATION-REBASELINE).',
  '-- Read by scripts/ci/schema-parity-gate.js in .github/workflows/schema-parity.yml.',
  '-- One normalized item per line. This file may only shrink: when a change fixes an item,',
  '-- delete its line in the same change. Never add a line to accept new drift; write the',
  '-- migration (or the schema change) that removes it. Tables, enums, enum values and',
  '-- columns missing from the chain can never be listed here; the gate rejects them.',
];

function formatBaseline(items) {
  return `${BASELINE_HEADER.join('\n')}\n\n${items.map((i) => `${i};`).join('\n')}\n`;
}

function readInput(path, label) {
  let text;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`${label} ${path} is not readable: ${err && err.message ? err.message : err}`);
  }
  if (!text.trim()) throw new Error(`${label} ${path} is empty`);
  return text;
}

function parseArgs(argv) {
  const args = { drift: null, baseline: null, printBaseline: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--drift') args.drift = argv[++i];
    else if (a === '--baseline') args.baseline = argv[++i];
    else if (a === '--print-baseline') args.printBaseline = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!args.drift) throw new Error('--drift <file> is required');
  if (!args.printBaseline && !args.baseline) throw new Error('--baseline <file> is required');
  return args;
}

function main(argv, out = process.stdout, err = process.stderr) {
  let args;
  let driftText;
  let baselineText = '';
  try {
    args = parseArgs(argv);
    driftText = readInput(args.drift, 'drift script');
    if (!args.printBaseline) baselineText = readInput(args.baseline, 'baseline');
  } catch (e) {
    err.write(`::error::schema-parity: ${e.message}\n`);
    return 2;
  }

  if (args.printBaseline) {
    out.write(formatBaseline(parseItems(driftText)));
    return 0;
  }

  const r = evaluate(driftText, baselineText);
  out.write(
    `schema-parity: ${r.current.length} drift item(s) at this head; baseline lists ${r.baseline.length}.\n`,
  );
  for (const { item, kind } of r.missingObjects) {
    err.write(
      `::error::schema-parity: schema.prisma declares a ${kind} that no migration creates. Add a migration. Item: ${item}\n`,
    );
  }
  for (const item of r.baselinedMissingObjects) {
    err.write(
      `::error::schema-parity: the baseline lists a missing-object item, which is never allowed. Remove it and add a migration. Item: ${item}\n`,
    );
  }
  for (const item of r.newDrift) {
    if (missingObjectKind(item) !== null) continue;
    err.write(
      `::error::schema-parity: new drift between the migration chain and schema.prisma. Fix the migration or the schema. Item: ${item}\n`,
    );
  }
  for (const item of r.resolved) {
    err.write(
      `::error::schema-parity: the baseline lists drift that no longer exists. Delete this line from prisma/schema-parity-baseline.sql. Item: ${item}\n`,
    );
  }
  if (r.ok) {
    out.write(
      r.current.length === 0
        ? 'schema-parity: OK. The migration chain is at full parity with prisma/schema.prisma.\n'
        : 'schema-parity: OK. No drift beyond the committed baseline, and no missing tables, enums or columns.\n',
    );
    return 0;
  }
  out.write('schema-parity: FAILED. Current drift, in baseline format, for reference:\n');
  out.write(formatBaseline(r.current));
  return 1;
}

module.exports = {
  splitTopLevel,
  parseItems,
  missingObjectKind,
  evaluate,
  formatBaseline,
  main,
  MISSING_OBJECT_RULES,
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
