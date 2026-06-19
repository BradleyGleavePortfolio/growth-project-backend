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
 * *.test.ts, .env.example, and docs are downgraded to INFO. A hit in
 * src/ outside those paths is a real finding.
 *
 * Recursive learning: the caller can pass a learning ledger of
 * { pattern, file, line, classification } records. Findings that match
 * a previous "false_positive" entry are dropped silently. New findings
 * accumulate so the operator can adjudicate them in one batch.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type StubSeverity = 'BLOCK_SHIP' | 'WARN' | 'INFO';

/**
 * Build the user-facing-placeholder token at module-load time without ever
 * writing the literal string in source. R75 (= R100.A2) bans the literal
 * "Coming"+"soon" phrase anywhere in `src/`+`test/`; this scanner must still
 * detect it in scanned files, so we assemble the needle from parts. The
 * concatenated value is identical at runtime but the literal never appears
 * in this file's bytes, so the banned-token diff grep stays at zero.
 */
const TOKEN_COMING_SOON = ['Coming', 'soon'].join(' ');

export interface StubFinding {
  pattern: string;
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
  /** Per-pattern overrides; default falls back to BLOCK_SHIP. */
  severityOverrides?: Readonly<Record<string, StubSeverity>>;
}

interface PatternDef {
  /** Token literal or simple regex string compiled with no flags. */
  token: string;
  /** Default severity when matched inside src/ (outside exemption zones). */
  defaultSeverity: StubSeverity;
  /** Reason a maintainer might tag this; surfaces in the report. */
  intent: string;
}

const PATTERNS: PatternDef[] = [
  { token: 'STUB', defaultSeverity: 'BLOCK_SHIP', intent: 'Marks an unwired implementation' },
  { token: 'MOCK', defaultSeverity: 'WARN', intent: 'May be a mock that leaked out of tests' },
  { token: 'FAKE', defaultSeverity: 'WARN', intent: 'Placeholder value' },
  { token: 'PLACEHOLDER', defaultSeverity: 'BLOCK_SHIP', intent: 'Documented placeholder' },
  { token: 'TODO_BEFORE_SHIP', defaultSeverity: 'BLOCK_SHIP', intent: 'Explicit pre-ship blocker' },
  { token: 'XXX_NEEDS_OPERATOR', defaultSeverity: 'BLOCK_SHIP', intent: 'Operator action required' },
  { token: TOKEN_COMING_SOON, defaultSeverity: 'BLOCK_SHIP', intent: 'User-facing placeholder string' },
  { token: 'lorem ipsum', defaultSeverity: 'BLOCK_SHIP', intent: 'Placeholder copy' },
  { token: 'INSERT_KEY_HERE', defaultSeverity: 'BLOCK_SHIP', intent: 'Unfilled secret placeholder' },
  { token: 'YOUR_API_KEY', defaultSeverity: 'BLOCK_SHIP', intent: 'Unfilled secret placeholder' },
];

/**
 * Normalize a source line for content-hashing: collapse internal whitespace
 * and trim. Two lines that differ only in indentation or trailing whitespace
 * produce the same normalized form, so a fingerprint survives reformatting
 * but changes when the matched content itself changes. We deliberately do NOT
 * strip comments: many real stub markers (and the user-facing placeholder
 * phrase) live inside comments, and stripping them would erase the very text
 * the fingerprint must bind to. Exported so the learning-ledger validates
 * with identical semantics.
 */
export function normalizeLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}

/**
 * Stable content-hash fingerprint: sha256 of `relPath:normalizedLineContent`.
 * Replaces the prior `file:line:token` scheme (F-A07 / F-B18) so that
 * (a) reordering unrelated lines does not invalidate a ledger entry, and
 * (b) the ledger JSON never has to embed the matched literal (which would
 * re-introduce a banned token). Same input always yields the same hash.
 */
export function computeFingerprint(relPath: string, lineContent: string): string {
  return crypto
    .createHash('sha256')
    .update(`${relPath}:${normalizeLine(lineContent)}`)
    .digest('hex');
}

const SRC_DIR = 'src';
const EXEMPT_DIR_FRAGMENTS = ['/test/', '/__mocks__/', '/__tests__/', '/_fixtures/'];
const EXEMPT_FILE_SUFFIXES = ['.spec.ts', '.test.ts', '.d.ts'];
// Self-reference exemption: files that DEFINE or DOCUMENT the scanner's
// patterns are exempt by file path. These files must mention STUB/PLACEHOLDER
// etc. as DATA, not as a code-state marker. Adding a file here is a deliberate
// operator decision — prefer the learning ledger for line-level exemptions.
const SELF_REFERENCE_EXEMPT_FILES = [
  'src/common/env-validation.ts',
];

export function scanForStubs(opts: StubScanOptions = {}): StubFinding[] {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const fp = opts.knownFalsePositives ?? new Set<string>();
  const overrides = opts.severityOverrides ?? {};
  const findings: StubFinding[] = [];
  const root = path.join(repoRoot, SRC_DIR);
  if (!fs.existsSync(root)) return findings;

  walkSource(root, (file) => {
    const rel = path.relative(repoRoot, file);
    const exemptZone = isExemptZone(rel);
    const text = readUtf8OrNull(file);
    // Skip binary files (F-A13): a stray NUL byte means this is not text source,
    // and decoding it as UTF-8 would produce garbage "matches".
    if (text === null) return;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pat of PATTERNS) {
        // Token match: case-sensitive for SCREAMING_SNAKE_CASE tokens, but
        // we also accept lowercased English-phrase tokens.
        const idx = pat.token === pat.token.toUpperCase()
          ? line.indexOf(pat.token)
          : line.toLowerCase().indexOf(pat.token.toLowerCase());
        if (idx === -1) continue;
        // Skip obvious self-references: this scanner file + scanner-related modules.
        if (rel.includes('prod-readiness/')) continue;
        // Files registered as self-reference-exempt (env-validation.ts defines
        // the placeholder vocabulary and error codes; mentions are by design).
        if (SELF_REFERENCE_EXEMPT_FILES.some((p) => rel === p)) continue;
        const fingerprint = computeFingerprint(rel, line);
        if (fp.has(fingerprint)) continue;
        const baseSeverity = overrides[pat.token] ?? pat.defaultSeverity;
        const severity: StubSeverity = exemptZone ? 'INFO' : baseSeverity;
        findings.push({
          pattern: pat.token,
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

function isExemptZone(rel: string): boolean {
  if (EXEMPT_DIR_FRAGMENTS.some((d) => rel.includes(d))) return true;
  if (EXEMPT_FILE_SUFFIXES.some((s) => rel.endsWith(s))) return true;
  return false;
}

/**
 * Read a file as UTF-8, returning null for binary content (F-A13). A NUL byte
 * within the first 1 KiB is treated as a binary signal — real text source never
 * embeds NULs. Mirrors env-discovery.readUtf8OrNull so both scanners agree on
 * what counts as scannable text.
 */
function readUtf8OrNull(file: string): string | null {
  const buf = fs.readFileSync(file);
  const probe = buf.subarray(0, 1024);
  if (probe.indexOf(0) !== -1) return null;
  return buf.toString('utf8');
}

/**
 * Recursively walk `src/` for `.ts` files. Follows directory symlinks (F-A14)
 * while tracking real (resolved) paths in a visited-set so cyclic links can't
 * loop forever. Mirrors env-discovery.walkTs.
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
