/**
 * prod-readiness/learning-ledger.ts — persistent ledger of operator decisions
 * on stub-scanner findings, so the scanner gets quieter over time (Q5).
 * Entries are keyed by a content fingerprint (sha256 of path + matched line),
 * so reordering unrelated lines never invalidates an entry and the matched
 * literal never re-enters the diff. Classifications: open (untriaged),
 * false_positive (dropped silently), tracked_debt (BLOCK_SHIP -> WARN). When
 * LEDGER_SECRET is set, loadLedger() verifies an HMAC over `hmac`; saveLedger()
 * writes atomically via temp + rename. Independent: only Node built-ins + zod.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export const CLASSIFICATIONS = ['open', 'false_positive', 'tracked_debt'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

const LedgerEntrySchema = z
  .object({
    fingerprint: z.string().min(1, 'fingerprint must be a non-empty string'),
    source_path: z.string().trim().min(1, 'source_path must be a non-empty string'),
    classification: z.enum(CLASSIFICATIONS),
    rationale: z.string().trim().min(1, 'rationale must be a non-empty string'),
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

/** Order-independent canonical form of the entries, for HMAC signing. */
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

function validateLedger(ledgerPath: string, parsed: unknown): LedgerFile {
  const result = LedgerFileSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.length ? i.path.join('.') : '<root>'}: ${i.message}`)
      .join('\n  - ');
    throw new Error(`${ledgerPath}: malformed ledger:\n  - ${detail}`);
  }
  return result.data;
}

/**
 * Read + validate a ledger. A missing file is an empty ledger so a first run
 * needs no seed. Malformed JSON, a schema violation, or (when LEDGER_SECRET is
 * set) an HMAC mismatch all throw with the offending path.
 */
export async function loadLedger(ledgerPath: string = defaultLedgerPath()): Promise<LedgerFile> {
  if (!existsSync(ledgerPath)) {
    return { version: 1, entries: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(ledgerPath, 'utf8'));
  } catch (err) {
    throw new Error(`${ledgerPath}: invalid JSON: ${(err as Error).message}`);
  }
  const ledger = validateLedger(ledgerPath, parsed);
  const secret = process.env.LEDGER_SECRET;
  if (secret && ledger.hmac !== computeLedgerHmac(ledger.entries, secret)) {
    throw new Error(
      `${ledgerPath}: HMAC verification failed (LEDGER_SECRET is set); ` +
        're-sign with computeLedgerHmac after any edit.',
    );
  }
  return ledger;
}

function findEntry(ledger: LedgerFile, fingerprint: string): LedgerEntry | undefined {
  return ledger.entries.find((e) => e.fingerprint === fingerprint);
}

/**
 * Record a finding if absent. Dedup is by fingerprint, so a repeat finding
 * leaves the original entry — and its added_at — untouched. Returns the
 * existing-or-new entry; mutates the ledger in place.
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
    added_at: new Date().toISOString(),
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
  existing.reviewed_at = new Date().toISOString();
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

/** Canonical on-disk JSON: version then entries, 2-space indent, trailing NL. */
export function serializeLedger(ledger: LedgerFile): string {
  const ordered = {
    version: ledger.version,
    entries: ledger.entries,
    ...(ledger.hmac ? { hmac: ledger.hmac } : {}),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * Persist atomically: write a unique sibling temp file then rename(2) into
 * place (atomic within a filesystem), so a concurrent reader sees either the
 * prior file or the fully-written one. The temp file is removed on failure.
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
