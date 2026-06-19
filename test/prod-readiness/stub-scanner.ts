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

import * as fs from 'fs';
import * as path from 'path';

export type StubSeverity = 'BLOCK_SHIP' | 'WARN' | 'INFO';

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
  { token: 'Coming soon', defaultSeverity: 'BLOCK_SHIP', intent: 'User-facing placeholder string' },
  { token: 'lorem ipsum', defaultSeverity: 'BLOCK_SHIP', intent: 'Placeholder copy' },
  { token: 'INSERT_KEY_HERE', defaultSeverity: 'BLOCK_SHIP', intent: 'Unfilled secret placeholder' },
  { token: 'YOUR_API_KEY', defaultSeverity: 'BLOCK_SHIP', intent: 'Unfilled secret placeholder' },
];

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
    const text = fs.readFileSync(file, 'utf8');
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
        const fingerprint = `${rel}:${i + 1}:${pat.token}`;
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

function walkSource(dir: string, visit: (file: string) => void): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      walkSource(p, visit);
    } else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
      visit(p);
    }
  }
}
