/**
 * prod-readiness/learning-ledger.ts
 *
 * Persistent ledger of operator decisions on stub-scanner findings, so the
 * scanner gets quieter — not noisier — over time (Q5: "recursive learning").
 *
 * Ledger format (test/prod-readiness/__fixtures__/learning-ledger.json):
 *   {
 *     "version": 1,
 *     "entries": [
 *       {
 *         "fingerprint": "src/foo.ts:42:STUB",
 *         "classification": "false_positive" | "tracked_debt",
 *         "rationale": "human-readable reason",
 *         "added_at": "2026-06-18T...",
 *         "added_by": "bradley@bradleytgpcoaching.com"
 *       },
 *       ...
 *     ]
 *   }
 *
 * Behavior:
 *   - false_positive entries are dropped from the scanner output silently.
 *   - tracked_debt entries are downgraded from BLOCK_SHIP to WARN (the
 *     operator has acknowledged but not yet fixed; report keeps surfacing).
 *   - Entries the operator added but the underlying line no longer exists
 *     are flagged as STALE so the operator can prune them.
 */

import * as fs from 'fs';
import * as path from 'path';

export type Classification = 'false_positive' | 'tracked_debt';

export interface LedgerEntry {
  fingerprint: string;
  classification: Classification;
  rationale: string;
  added_at: string;
  added_by: string;
}

export interface LedgerFile {
  version: 1;
  entries: LedgerEntry[];
}

const DEFAULT_PATH = 'test/prod-readiness/__fixtures__/learning-ledger.json';

export function defaultLedgerPath(repoRoot: string = process.cwd()): string {
  return path.join(repoRoot, DEFAULT_PATH);
}

export function loadLedger(ledgerPath: string = defaultLedgerPath()): LedgerFile {
  if (!fs.existsSync(ledgerPath)) {
    return { version: 1, entries: [] };
  }
  const raw = fs.readFileSync(ledgerPath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || (parsed as Record<string, unknown>).version !== 1) {
    throw new Error(`${ledgerPath}: invalid ledger; expected { version: 1, entries: [...] }`);
  }
  const entries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    throw new Error(`${ledgerPath}: entries must be an array`);
  }
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as Record<string, unknown>;
    if (typeof e.fingerprint !== 'string' || typeof e.classification !== 'string' ||
        (e.classification !== 'false_positive' && e.classification !== 'tracked_debt') ||
        typeof e.rationale !== 'string' || typeof e.added_at !== 'string' ||
        typeof e.added_by !== 'string') {
      throw new Error(`${ledgerPath}: entries[${i}] is malformed`);
    }
  }
  return parsed as LedgerFile;
}

export function falsePositives(ledger: LedgerFile): Set<string> {
  return new Set(ledger.entries.filter((e) => e.classification === 'false_positive').map((e) => e.fingerprint));
}

export function trackedDebt(ledger: LedgerFile): Set<string> {
  return new Set(ledger.entries.filter((e) => e.classification === 'tracked_debt').map((e) => e.fingerprint));
}
