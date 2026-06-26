/**
 * test/prod-readiness.config.ts
 *
 * Central registry for the R100 deploy-readiness board. The orchestrator at
 * `test/deploy-readiness.spec.ts` reads this file to learn which sub-scanners
 * make up the board, in what order they render, and which of the board's seven
 * sections each one feeds. Keeping the registration here (rather than inline in
 * the spec) is the R100 "registration discipline" surface (R100 paragraph 7):
 * when a future builder adds an integration, secret, or feature flag they add a
 * row to the relevant scanner's domain — and, if they add a brand-new scanner,
 * a single entry here — instead of editing the orchestrator's control flow.
 *
 * This module imports NO scanner code and performs NO I/O. It is pure metadata:
 * the seven section ids, their human labels, and the registry/ledger file paths
 * the orchestrator resolves against the repo root. The orchestrator binds these
 * ids to the concrete scanner invocations; that indirection lets the board grow
 * a new section by adding one id here plus its handler in the spec, never by
 * rewriting the aggregation loop.
 */

/**
 * The seven board sections, in render order, exactly mirroring R100 paragraphs
 * 1-4 expanded to the seven merged H4 sub-scanners (H4.A through H4.G). The id
 * is stable and machine-groupable; the orchestrator keys its section handlers
 * and its aggregate-exit tally off these ids.
 */
export const BOARD_SECTIONS = [
  'STUB_VALUES',
  'PROD_SWITCHES',
  'WIRING',
  'ENV_DISCOVERY',
  'AUTO_FLIPPER',
  'OPERATOR_KEYS',
] as const;

/** One board section id. */
export type BoardSection = (typeof BOARD_SECTIONS)[number];

/**
 * Whether a section's findings GATE a deploy (count toward the red-line total
 * and the non-zero exit) or are purely INFORMATIONAL (printed for the operator
 * but never blocking). The auto-flipper plan is informational by design: it
 * reports which switches WOULD flip on a prod-bound deploy, which is context,
 * not a defect.
 */
export type SectionMode = 'GATING' | 'INFORMATIONAL';

/** Registration metadata for one board section / sub-scanner. */
export interface ScannerRegistration {
  /** Stable section id (one of {@link BOARD_SECTIONS}). */
  section: BoardSection;
  /** Human-readable heading rendered in the plain-text board. */
  label: string;
  /** The H4 sub-lane that shipped the scanner this section invokes. */
  origin: string;
  /** Whether this section's red count gates the deploy or is informational. */
  mode: SectionMode;
  /** One-line description of what the section asserts, surfaced in the runbook. */
  asserts: string;
}

/**
 * The scanner registry. ORDER MATTERS: it is the render order of the board.
 * Adding a new integration NEVER requires a new row here — register the
 * integration in `prod-switches.yml` (switches) or in the provider table inside
 * `prod-readiness/provider-wiring.ts` (wiring). A new row here is reserved for a
 * genuinely new BOARD SECTION, which also needs a handler in the orchestrator.
 */
export const SCANNER_REGISTRY: readonly ScannerRegistration[] = [
  {
    section: 'STUB_VALUES',
    label: 'STUB VALUES',
    origin: 'H4.B prod-readiness/stub-scanner.ts',
    mode: 'GATING',
    asserts:
      'No BLOCK_SHIP stub/placeholder token survives in production-bound src/ outside exempt zones.',
  },
  {
    section: 'PROD_SWITCHES',
    label: 'PROD SWITCHES',
    origin: 'H4.A prod-readiness/registry-loader.ts',
    mode: 'GATING',
    asserts:
      'The prod-switches registry is internally coherent (no duplicate names, no MUST_SET-but-auto-flip rows).',
  },
  {
    section: 'WIRING',
    label: 'OAUTH / INTEGRATION WIRING',
    origin: 'H4.E + H4.F prod-readiness/provider-wiring.ts',
    mode: 'GATING',
    asserts:
      'Every provider whose SDK is imported has all required secrets set with non-placeholder values.',
  },
  {
    section: 'ENV_DISCOVERY',
    label: 'ENV DISCOVERY',
    origin: 'H4.C prod-readiness/env-discovery.ts',
    mode: 'GATING',
    asserts:
      'Every env var referenced in ENV_RULES, .env.example, or src/ is registered in prod-switches.yml.',
  },
  {
    section: 'AUTO_FLIPPER',
    label: 'AUTO-FLIPPER',
    origin: 'H4.D prod-readiness/auto-flipper.ts',
    mode: 'INFORMATIONAL',
    asserts:
      'Lists the switches that would be auto-flipped to their prod value on a prod-bound deploy.',
  },
  {
    section: 'OPERATOR_KEYS',
    label: 'OPERATOR KEYS',
    origin: 'H4.G prod-readiness/operator-keys-generator.ts',
    mode: 'GATING',
    asserts:
      'No operator-facing key (MUST_SET switch or stubbed provider credential) is left unprovided.',
  },
];

/**
 * Registry file path, relative to the repo root. The single source of truth for
 * every env-var-shaped switch (R108). The orchestrator resolves this against the
 * repo root before handing it to the registry loader and env-discovery scanner.
 */
export const REGISTRY_PATH = 'prod-switches.yml';

/**
 * Learning-ledger path, relative to the repo root. Holds the operator-adjudicated
 * false-positive and tracked-debt fingerprints the stub scanner honours so the
 * board stays signal-rich as the codebase grows.
 */
export const LEDGER_PATH = 'test/prod-readiness/__fixtures__/learning-ledger.json';

/** Gating sections only — the ones whose red counts sum into the exit total. */
export function gatingSections(): ScannerRegistration[] {
  return SCANNER_REGISTRY.filter((r) => r.mode === 'GATING');
}

/** Look up one registration by section id (throws if the id is unregistered). */
export function registrationFor(section: BoardSection): ScannerRegistration {
  const found = SCANNER_REGISTRY.find((r) => r.section === section);
  if (!found) {
    throw new Error(`no scanner registration for board section "${section}"`);
  }
  return found;
}
