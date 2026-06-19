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
 *         "classification": "false_positive" | "tracked_debt" | "open",
 *         "rationale": "human-readable reason (must be non-empty)",
 *         "added_at": "2026-06-18T...",
 *         "added_by": "bradley@bradleytgpcoaching.com",
 *         "reviewed_by": "bradley@bradleytgpcoaching.com",   // optional
 *         "reviewed_at": "2026-06-18T..."                    // optional
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
 *      can be suppressed without re-introducing the literal into the diff.
 *
 * Classification semantics:
 *   - open           — a freshly recorded finding the operator has not yet
 *                      triaged. Surfaces at full severity in reports.
 *   - false_positive — dropped from scanner output silently.
 *   - tracked_debt   — downgraded from BLOCK_SHIP to WARN (acknowledged but
 *                      not yet fixed; the report keeps surfacing it).
 *
 * Integrity (F-A07c): if the LEDGER_SECRET env var is set, loadLedger()
 * additionally verifies an HMAC-SHA256 over the canonical entry list stored
 * under the top-level `hmac` field, and throws if it does not match. When
 * LEDGER_SECRET is unset (the common case — local + CI without the secret),
 * the loader falls back to plain structural validation. computeLedgerHmac()
 * is exported so an operator tool can (re)sign the ledger after edits.
 *
 * Persistence is via saveLedger(), which writes through a sibling temp file
 * and renames it into place so a concurrent reader sees either the old file
 * or the fully-written new file — never a half-written one.
 *
 * Independent scanner: imports only Node built-ins + zod (already in repo).
 */

import { createHmac, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export const CLASSIFICATIONS = ['open', 'false_positive', 'tracked_debt'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

const LedgerEntrySchema = z
  .object({
    fingerprint: z.string().min(1, 'fingerprint must be a non-empty string'),
    source_path: z
      .string()
      .trim()
      .min(1, 'source_path must be a non-empty string'),
    classification: z.enum(CLASSIFICATIONS),
    rationale: z
      .string()
      .trim()
      .min(1, 'rationale must be a non-empty string (every entry needs an operator note)'),
    added_at: z.string().min(1, 'added_at must be a non-empty string'),
    added_by: z.string().min(1, 'added_by must be a non-empty string'),
    reviewed_by: z.string().min(1).optional(),
    reviewed_at: z.string().min(1).optional(),
  })
  .strict();

const LedgerFileSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(LedgerEntrySchema),
    hmac: z.string().min(1).optional(),
  })
  .strict();

export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;
export type LedgerFile = z.infer<typeof LedgerFileSchema>;

/** A scanner finding awaiting (or already carrying) an operator decision. */
export interface Finding {
  fingerprint: string;
  source_path: string;
}

const DEFAULT_PATH = 'test/prod-readiness/__fixtures__/learning-ledger.json';
const DEFAULT_AUTHOR = 'bradley@bradleytgpcoaching.com';

export function defaultLedgerPath(repoRoot: string = process.cwd()): string {
  return join(repoRoot, DEFAULT_PATH);
}

/** Stable ISO-8601 timestamp (seconds precision, UTC) for new entries. */
function nowIso(): string {
  return new Date().toISOString();
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
  return createHmac('sha256', secret).update(canonicalizeEntries(entries)).digest('hex');
}

/** Format a zod issue list into the legacy `entries[i]: msg` shape. */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join('.') : '<root>';
      return `${path}: ${issue.message}`;
    })
    .join('\n  - ');
}

function validateLedger(ledgerPath: string, parsed: unknown): LedgerFile {
  const result = LedgerFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${ledgerPath}: malformed ledger:\n  - ${formatIssues(result.error)}`);
  }
  return result.data;
}

function verifyHmacIfConfigured(ledgerPath: string, ledger: LedgerFile): void {
  // F-A07c — optional integrity check. Only enforced when an operator has
  // provisioned LEDGER_SECRET; otherwise structural validation alone applies.
  const secret = process.env.LEDGER_SECRET;
  if (!secret) {
    return;
  }
  const expected = computeLedgerHmac(ledger.entries, secret);
  if (ledger.hmac !== expected) {
    throw new Error(
      `${ledgerPath}: HMAC verification failed (LEDGER_SECRET is set). ` +
        'Re-sign the ledger with computeLedgerHmac after any edit.',
    );
  }
}

/**
 * Read + validate a ledger. A missing file is treated as an empty ledger so a
 * first run does not need a seeded fixture. Malformed JSON or a schema
 * violation throws with the offending path. Async variant; prefer this.
 */
export async function loadLedger(ledgerPath: string = defaultLedgerPath()): Promise<LedgerFile> {
  if (!existsSync(ledgerPath)) {
    return { version: 1, entries: [] };
  }
  let raw: string;
  try {
    raw = await readFile(ledgerPath, 'utf8');
  } catch (err) {
    throw new Error(`${ledgerPath}: cannot read ledger: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${ledgerPath}: invalid JSON: ${(err as Error).message}`);
  }
  const ledger = validateLedger(ledgerPath, parsed);
  verifyHmacIfConfigured(ledgerPath, ledger);
  return ledger;
}

/** Synchronous loader for the CLI/validate path; same validation as loadLedger. */
export function loadLedgerSync(ledgerPath: string = defaultLedgerPath()): LedgerFile {
  if (!existsSync(ledgerPath)) {
    return { version: 1, entries: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  } catch (err) {
    throw new Error(`${ledgerPath}: invalid JSON: ${(err as Error).message}`);
  }
  const ledger = validateLedger(ledgerPath, parsed);
  verifyHmacIfConfigured(ledgerPath, ledger);
  return ledger;
}

/** Locate an entry by its fingerprint identity, or undefined. */
function findEntry(ledger: LedgerFile, fingerprint: string): LedgerEntry | undefined {
  return ledger.entries.find((e) => e.fingerprint === fingerprint);
}

/**
 * Record a finding if not already present. Dedup is by fingerprint (the
 * content hash that already folds in path + line content). A repeat finding
 * leaves the original entry — and its added_at — untouched, so re-running the
 * scanner never churns first-seen timestamps. Returns the (existing or new)
 * entry. Mutates and returns the same ledger for chaining.
 */
export function appendFinding(
  ledger: LedgerFile,
  finding: Finding,
  addedBy: string = DEFAULT_AUTHOR,
): LedgerEntry {
  const existing = findEntry(ledger, finding.fingerprint);
  if (existing) {
    return existing;
  }
  const entry: LedgerEntry = {
    fingerprint: finding.fingerprint,
    source_path: finding.source_path,
    classification: 'open',
    rationale: 'open finding awaiting operator triage',
    added_at: nowIso(),
    added_by: addedBy,
  };
  ledger.entries.push(entry);
  return entry;
}

function reclassify(
  ledger: LedgerFile,
  finding: Finding,
  classification: Classification,
  note: string,
  reviewedBy: string,
): LedgerEntry {
  const trimmed = note.trim();
  if (trimmed.length === 0) {
    throw new Error('a non-empty rationale is required to classify a finding');
  }
  const existing = findEntry(ledger, finding.fingerprint);
  if (!existing) {
    throw new Error(`no ledger entry for fingerprint ${finding.fingerprint}; appendFinding first`);
  }
  existing.classification = classification;
  existing.rationale = trimmed;
  existing.reviewed_by = reviewedBy;
  existing.reviewed_at = nowIso();
  return existing;
}

/** Mark an existing finding as a false positive (dropped from output). */
export function markFalsePositive(
  ledger: LedgerFile,
  finding: Finding,
  note: string,
  reviewedBy: string = DEFAULT_AUTHOR,
): LedgerEntry {
  return reclassify(ledger, finding, 'false_positive', note, reviewedBy);
}

/** Mark an existing finding as accepted/tracked debt (downgraded to WARN). */
export function markAcceptedDebt(
  ledger: LedgerFile,
  finding: Finding,
  note: string,
  reviewedBy: string = DEFAULT_AUTHOR,
): LedgerEntry {
  return reclassify(ledger, finding, 'tracked_debt', note, reviewedBy);
}

/** Entries still awaiting operator triage. */
export function filterOpen(ledger: LedgerFile): LedgerEntry[] {
  return ledger.entries.filter((e) => e.classification === 'open');
}

export function falsePositives(ledger: LedgerFile): Set<string> {
  return new Set(
    ledger.entries.filter((e) => e.classification === 'false_positive').map((e) => e.fingerprint),
  );
}

export function trackedDebt(ledger: LedgerFile): Set<string> {
  return new Set(
    ledger.entries.filter((e) => e.classification === 'tracked_debt').map((e) => e.fingerprint),
  );
}

/** Canonical on-disk JSON: sorted top-level keys, 2-space indent, trailing NL. */
export function serializeLedger(ledger: LedgerFile): string {
  const ordered = {
    version: ledger.version,
    entries: ledger.entries,
    ...(ledger.hmac ? { hmac: ledger.hmac } : {}),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * Persist the ledger atomically: serialize, write to a unique sibling temp
 * file, fsync-free rename into place. rename(2) is atomic within a filesystem,
 * so a concurrent reader observes either the prior file or the fully-written
 * one — never a truncated/partial write. The temp file is cleaned up on a
 * write failure so we never leave debris behind.
 */
export async function saveLedger(
  ledger: LedgerFile,
  ledgerPath: string = defaultLedgerPath(),
): Promise<void> {
  validateLedger(ledgerPath, ledger);
  const payload = serializeLedger(ledger);
  const tmpPath = join(dirname(ledgerPath), `.${randomBytes(8).toString('hex')}.ledger.tmp`);
  try {
    await writeFile(tmpPath, payload, { encoding: 'utf8', mode: 0o644 });
    await rename(tmpPath, ledgerPath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch (cleanupErr) {
      throw new Error(
        `${ledgerPath}: write failed (${(err as Error).message}); ` +
          `temp cleanup also failed (${(cleanupErr as Error).message})`,
      );
    }
    throw new Error(`${ledgerPath}: atomic write failed: ${(err as Error).message}`);
  }
}
