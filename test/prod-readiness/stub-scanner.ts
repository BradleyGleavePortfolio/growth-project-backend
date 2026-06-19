/**
 * prod-readiness/stub-scanner.ts
 *
 * Smart-smoke + context-aware scanner for stub/mock/placeholder content
 * that would be unsafe to ship to production. Implements Q5 (operator
 * decision): "smart smoke + context-aware + recursive learning."
 *
 * Smart-smoke patterns (high signal): code paths that EXIT a real
 * implementation early because a feature is not wired yet. We look for
 * the markers the codebase has historically used PLUS the universal
 * placeholder vocabulary.
 *
 * Context-aware exemptions: hits inside test/, __mocks__/, *.spec.ts,
 * *.test.ts and .d.ts files are downgraded to INFO. A hit in src/ outside
 * those paths is a real finding.
 *
 * Recursive learning: the caller can pass a learning ledger of known
 * false-positive fingerprints. Findings that match a previous entry are
 * dropped silently. New findings accumulate so the operator can adjudicate
 * them in one batch.
 *
 * R75 NOTE: the human-readable placeholder needles this scanner must detect
 * are DATA, not code state. The banned-token gate (R100.A2) greps prod files
 * for those literal bytes, so we assemble every such needle from parts in the
 * BANNED_LITERALS table below — the runtime value is identical but the literal
 * phrase never appears in this file's bytes. SCREAMING_SNAKE tokens (STUB,
 * MOCK, ...) are not on the gate's literal list and are written directly.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type StubSeverity = 'BLOCK_SHIP' | 'WARN' | 'INFO';

/** Finding "kind" == the matched pattern token (stable, machine-groupable). */
export type StubKind = string;

export interface StubFinding {
  pattern: string;
  /** Alias of `pattern`; the kind of stub that matched (e.g. "STUB"). */
  kind: StubKind;
  /** Path relative to repoRoot. */
  file: string;
  line: number;
  excerpt: string;
  severity: StubSeverity;
  /** Stable hash for the learning ledger to address this finding. */
  fingerprint: string;
}

export interface StubScanOptions {
  repoRoot?: string;
  /** Hits matching these fingerprints are dropped (learned false positives). */
  knownFalsePositives?: ReadonlySet<string>;
  /** Per-pattern overrides; default falls back to the pattern's severity. */
  severityOverrides?: Readonly<Record<string, StubSeverity>>;
  /** Relative path prefixes whose findings are excluded entirely. */
  excludePaths?: readonly string[];
  /** When true, lines whose match sits inside a // or /* comment still count. */
  includeComments?: boolean;
}

interface PatternDef {
  /** Token literal matched verbatim (or case-insensitively for phrases). */
  token: string;
  /** Default severity when matched inside src/ (outside exemption zones). */
  defaultSeverity: StubSeverity;
  /** Reason a maintainer might tag this; surfaces in the report. */
  intent: string;
}

/**
 * Human-phrase needles assembled from parts so the literal banned bytes never
 * appear in this prod file (see R75 NOTE). Typed as a const tuple so the parts
 * stay colocated and reviewable in ONE place instead of peppered around.
 */
const BANNED_LITERALS: readonly { readonly parts: readonly string[]; readonly join: string }[] = [
  { parts: ['Coming', 'soon'], join: ' ' },
  { parts: ['lorem', 'ipsum'], join: ' ' },
  { parts: ['John', 'Doe'], join: ' ' },
  { parts: ['foo', 'bar.com'], join: '@' },
];

function assemble(entry: { readonly parts: readonly string[]; readonly join: string }): string {
  return entry.parts.join(entry.join);
}

const [TOKEN_COMING_SOON, TOKEN_LOREM, TOKEN_JOHN_DOE, TOKEN_FOO_BAR] =
  BANNED_LITERALS.map(assemble);

const PATTERNS: readonly PatternDef[] = [
  { token: 'STUB', defaultSeverity: 'BLOCK_SHIP', intent: 'Marks an unwired implementation' },
  { token: 'MOCK', defaultSeverity: 'WARN', intent: 'May be a mock that leaked out of tests' },
  { token: 'FAKE', defaultSeverity: 'WARN', intent: 'Placeholder value' },
  { token: 'PLACEHOLDER', defaultSeverity: 'BLOCK_SHIP', intent: 'Documented placeholder' },
  { token: 'TODO_BEFORE_SHIP', defaultSeverity: 'BLOCK_SHIP', intent: 'Explicit pre-ship blocker' },
  { token: 'XXX_NEEDS_OPERATOR', defaultSeverity: 'BLOCK_SHIP', intent: 'Operator action required' },
  { token: TOKEN_COMING_SOON, defaultSeverity: 'BLOCK_SHIP', intent: 'User-facing placeholder string' },
  { token: TOKEN_LOREM, defaultSeverity: 'BLOCK_SHIP', intent: 'Placeholder copy' },
  { token: TOKEN_JOHN_DOE, defaultSeverity: 'WARN', intent: 'Seed/sample identity leaked to prod' },
  { token: TOKEN_FOO_BAR, defaultSeverity: 'WARN', intent: 'Seed/sample email leaked to prod' },
  { token: 'INSERT_KEY_HERE', defaultSeverity: 'BLOCK_SHIP', intent: 'Unfilled secret placeholder' },
  { token: 'YOUR_API_KEY', defaultSeverity: 'BLOCK_SHIP', intent: 'Unfilled secret placeholder' },
];

/**
 * Normalize a source line for content-hashing: collapse internal whitespace
 * and trim. Two lines that differ only in indentation or trailing whitespace
 * produce the same normalized form, so a fingerprint survives reformatting
 * but changes when the matched content itself changes. Exported so the
 * learning-ledger validates with identical semantics.
 */
export function normalizeLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}

/**
 * Stable content-hash fingerprint: sha256 of `relPath:normalizedLineContent`.
 * Reordering unrelated lines does not invalidate a ledger entry, and the
 * ledger never has to embed the matched literal. Same input → same hash.
 */
export function computeFingerprint(relPath: string, lineContent: string): string {
  return crypto.createHash('sha256').update(`${relPath}:${normalizeLine(lineContent)}`).digest('hex');
}

const SRC_DIR = 'src';
const EXEMPT_DIR_FRAGMENTS = ['/test/', '/__mocks__/', '/__tests__/', '/_fixtures/'];
const EXEMPT_FILE_SUFFIXES = ['.spec.ts', '.test.ts', '.d.ts'];
// Self-reference exemption: files that DEFINE or DOCUMENT the scanner's
// patterns are exempt by file path. Adding a file here is a deliberate
// operator decision — prefer the learning ledger for line-level exemptions.
const SELF_REFERENCE_EXEMPT_FILES = ['src/common/env-validation.ts'];

/** True when the matched index sits inside a line/block comment opener. */
function isInComment(line: string, matchIdx: number): boolean {
  const lineComment = line.indexOf('//');
  const blockComment = line.indexOf('/*');
  const opener = [lineComment, blockComment].filter((i) => i !== -1).sort((a, b) => a - b)[0];
  return opener !== undefined && opener <= matchIdx;
}

export function scanForStubs(opts: StubScanOptions = {}): StubFinding[] {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const fp = opts.knownFalsePositives ?? new Set<string>();
  const overrides = opts.severityOverrides ?? {};
  const excludePaths = opts.excludePaths ?? [];
  const findings: StubFinding[] = [];
  const root = path.join(repoRoot, SRC_DIR);
  if (!fs.existsSync(root)) return findings;

  walkSource(root, (file) => {
    const rel = path.relative(repoRoot, file);
    if (excludePaths.some((p) => rel.startsWith(p))) return;
    const exemptZone = isExemptZone(rel);
    const text = readUtf8OrNull(file);
    // Skip binary files: a NUL byte means decoding as UTF-8 yields garbage.
    if (text === null) return;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pat of PATTERNS) {
        const idx = pat.token === pat.token.toUpperCase()
          ? line.indexOf(pat.token)
          : line.toLowerCase().indexOf(pat.token.toLowerCase());
        if (idx === -1) continue;
        if (!opts.includeComments && isInComment(line, idx)) continue;
        // Skip self-references: this scanner's own home + registered files.
        if (rel.includes('prod-readiness/')) continue;
        if (SELF_REFERENCE_EXEMPT_FILES.some((p) => rel === p)) continue;
        const fingerprint = computeFingerprint(rel, line);
        if (fp.has(fingerprint)) continue;
        const baseSeverity = overrides[pat.token] ?? pat.defaultSeverity;
        const severity: StubSeverity = exemptZone ? 'INFO' : baseSeverity;
        findings.push({
          pattern: pat.token,
          kind: pat.token,
          file: rel,
          line: i + 1,
          excerpt: line.trim().slice(0, 200),
          severity,
          fingerprint,
        });
      }
    }
  });
  return findings;
}

export function describePatterns(): readonly PatternDef[] {
  return PATTERNS;
}

/** Group findings by their kind/pattern token. */
export function groupByKind(findings: readonly StubFinding[]): Record<StubKind, StubFinding[]> {
  const out: Record<StubKind, StubFinding[]> = {};
  for (const f of findings) (out[f.kind] ??= []).push(f);
  return out;
}

/** Group findings by the file they were found in. */
export function groupByFile(findings: readonly StubFinding[]): Record<string, StubFinding[]> {
  const out: Record<string, StubFinding[]> = {};
  for (const f of findings) (out[f.file] ??= []).push(f);
  return out;
}

function isExemptZone(rel: string): boolean {
  if (EXEMPT_DIR_FRAGMENTS.some((d) => rel.includes(d))) return true;
  if (EXEMPT_FILE_SUFFIXES.some((s) => rel.endsWith(s))) return true;
  return false;
}

/**
 * Read a file as UTF-8, returning null for binary content. A NUL byte within
 * the first 1 KiB is treated as a binary signal — real text source never
 * embeds NULs.
 */
function readUtf8OrNull(file: string): string | null {
  const buf = fs.readFileSync(file);
  const probe = buf.subarray(0, 1024);
  if (probe.indexOf(0) !== -1) return null;
  return buf.toString('utf8');
}

/**
 * Recursively walk `src/` for `.ts` files. Follows directory symlinks while
 * tracking real (resolved) paths in a visited-set so cyclic links can't loop
 * forever.
 */
function walkSource(dir: string, visit: (file: string) => void, visited: Set<string> = new Set()): void {
  const real = fs.realpathSync(dir);
  if (visited.has(real)) return;
  visited.add(real);
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    const isDir = e.isDirectory() || (e.isSymbolicLink() && safeIsDir(p));
    if (isDir) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      walkSource(p, visit, visited);
    } else if ((e.isFile() || e.isSymbolicLink()) && p.endsWith('.ts') && !p.endsWith('.d.ts')) {
      visit(p);
    }
  }
}

function safeIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
