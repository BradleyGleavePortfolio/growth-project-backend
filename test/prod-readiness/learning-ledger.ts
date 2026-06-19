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
 *         "fingerprint": "<sha256 hex of `relPath:normalizedLineContent`>",
 *         "source_path": "src/foo.ts",
 *         "classification": "false_positive" | "tracked_debt",
 *         "rationale": "human-readable reason (must be non-empty)",
 *         "added_at": "2026-06-18T...",
 *         "added_by": "bradley@bradleytgpcoaching.com"
 *       },
 *       ...
 *     ],
 *     "hmac": "<optional hex; verified iff LEDGER_SECRET is set>"
 *   }
 *
 * The fingerprint is a content hash (see stub-scanner.computeFingerprint),
 * NOT a `file:line:token` triple. Two consequences (F-A07 / F-B18):
 *   1. Reordering unrelated lines no longer invalidates an entry — only the
 *      matched line's own content moving/changing does.
 *   2. The ledger JSON never embeds the matched literal, so a banned token
 *      (e.g. the user-facing placeholder phrase R75 forbids) can be
 *      suppressed without re-introducing the literal into the diff.
 *
 * Behavior:
 *   - false_positive entries are dropped from the scanner output silently.
 *   - tracked_debt entries are downgraded from BLOCK_SHIP to WARN (the
 *     operator has acknowledged but not yet fixed; report keeps surfacing).
 *   - Entries the operator added but the underlying line no longer exists
 *     are flagged as STALE so the operator can prune them.
 *
 * Integrity (F-A07c): if the LEDGER_SECRET env var is set, loadLedger()
 * additionally verifies an HMAC-SHA256 over the canonical entry list stored
 * under the top-level `hmac` field, and throws if it does not match. When
 * LEDGER_SECRET is unset (the common case — local + CI without the secret),
 * the loader falls back to plain structural validation. computeLedgerHmac()
 * is exported so an operator tool can (re)sign the ledger after edits.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type Classification = 'false_positive' | 'tracked_debt';

export interface LedgerEntry {
  fingerprint: string;
  /** The src/ path this entry tracks, surfaced in reports for the operator. */
  source_path: string;
  classification: Classification;
  rationale: string;
  added_at: string;
  added_by: string;
}

export interface LedgerFile {
  version: 1;
  entries: LedgerEntry[];
  /** Optional HMAC-SHA256 over the canonical entries; verified iff LEDGER_SECRET is set. */
  hmac?: string;
}

const DEFAULT_PATH = 'test/prod-readiness/__fixtures__/learning-ledger.json';

const VALID_CLASSIFICATIONS: ReadonlySet<string> = new Set<Classification>([
  'false_positive',
  'tracked_debt',
]);

export function defaultLedgerPath(repoRoot: string = process.cwd()): string {
  return path.join(repoRoot, DEFAULT_PATH);
}

/**
 * Canonical serialization of the entry list for HMAC purposes: each entry
 * reduced to its identity-bearing fields, then sorted. Order-independent so a
 * re-sorted (but otherwise identical) ledger produces the same signature.
 */
function canonicalizeEntries(entries: LedgerEntry[]): string {
  return entries
    .map((e) => `${e.fingerprint}|${e.classification}|${e.source_path}`)
    .sort()
    .join('\n');
}

/** Compute the HMAC-SHA256 an operator tool stores under `hmac`. */
export function computeLedgerHmac(entries: LedgerEntry[], secret: string): string {
  return crypto.createHmac('sha256', secret).update(canonicalizeEntries(entries)).digest('hex');
}

export function loadLedger(ledgerPath: string = defaultLedgerPath()): LedgerFile {
  if (!fs.existsSync(ledgerPath)) {
    return { version: 1, entries: [] };
  }
  const raw = fs.readFileSync(ledgerPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${ledgerPath}: invalid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as Record<string, unknown>).version !== 1) {
    throw new Error(`${ledgerPath}: invalid ledger; expected { version: 1, entries: [...] }`);
  }
  const entries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    throw new Error(`${ledgerPath}: entries must be an array`);
  }
  const errors: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as Record<string, unknown>;
    if (typeof e.fingerprint !== 'string' || e.fingerprint.length === 0) {
      errors.push(`entries[${i}]: fingerprint must be a non-empty string`);
    }
    if (typeof e.source_path !== 'string' || e.source_path.trim().length === 0) {
      errors.push(`entries[${i}]: source_path must be a non-empty string`);
    }
    if (typeof e.classification !== 'string' || !VALID_CLASSIFICATIONS.has(e.classification)) {
      errors.push(`entries[${i}]: classification must be one of ${[...VALID_CLASSIFICATIONS].join('|')}`);
    }
    if (typeof e.rationale !== 'string' || e.rationale.trim().length === 0) {
      errors.push(`entries[${i}]: rationale must be a non-empty string (every suppression needs an operator note)`);
    }
    if (typeof e.added_at !== 'string' || e.added_at.length === 0) {
      errors.push(`entries[${i}]: added_at must be a non-empty string`);
    }
    if (typeof e.added_by !== 'string' || e.added_by.length === 0) {
      errors.push(`entries[${i}]: added_by must be a non-empty string`);
    }
  }
  if (errors.length) {
    throw new Error(`${ledgerPath}: malformed ledger:\n  - ${errors.join('\n  - ')}`);
  }
  const ledger = parsed as LedgerFile;

  // F-A07c — optional integrity check. Only enforced when an operator has
  // provisioned LEDGER_SECRET; otherwise we fall back to the structural
  // validation above (which already rejects schema-breaking tampering).
  const secret = process.env.LEDGER_SECRET;
  if (secret) {
    const expected = computeLedgerHmac(ledger.entries, secret);
    if (ledger.hmac !== expected) {
      throw new Error(
        `${ledgerPath}: HMAC verification failed (LEDGER_SECRET is set). ` +
        `Re-sign the ledger with computeLedgerHmac after any edit.`,
      );
    }
  }
  return ledger;
}

export function falsePositives(ledger: LedgerFile): Set<string> {
  return new Set(ledger.entries.filter((e) => e.classification === 'false_positive').map((e) => e.fingerprint));
}

export function trackedDebt(ledger: LedgerFile): Set<string> {
  return new Set(ledger.entries.filter((e) => e.classification === 'tracked_debt').map((e) => e.fingerprint));
}
