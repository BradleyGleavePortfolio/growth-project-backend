// reporter.spec.ts — coverage for the deploy-readiness reporter.
//
// Drives every branch of verdict / summaryLine / renderConsole / renderMarkdown
// with hand-built ReadinessReport fixtures. No I/O: the reporter is pure string
// rendering, so every assertion checks rendered output against the documented
// structural contract.

import {
  verdict,
  summaryLine,
  renderConsole,
  renderMarkdown,
  MAX_STUB_FINDINGS_DISPLAYED,
  MAX_EXCERPT_WIDTH,
  MAX_DESCRIPTION_WIDTH,
  SEVERITY_ORDER,
  type ReadinessReport,
  type StubFinding,
  type StubSeverity,
  type ProviderReport,
  type ProviderStatus,
  type FlipPlan,
  type SwitchEntry,
} from './reporter';

/** A fully-empty (clean) report; override any field under test. */
function report(overrides: Partial<ReadinessReport> = {}): ReadinessReport {
  return {
    generated_at: '2026-06-19T00:00:00.000Z',
    target_env: 'prod',
    registry_size: 223,
    env_var_count: 180,
    unregistered_in_code: [],
    ledger_dead_entries: [],
    switches_unset_in_prod: [],
    stubs: [],
    providers: [],
    flips: [],
    ...overrides,
  };
}

function stub(overrides: Partial<StubFinding> = {}): StubFinding {
  return {
    file: 'src/foo.ts',
    line: 12,
    pattern: 'placeholder-token',
    excerpt: 'const key = replace_me',
    severity: 'BLOCK_SHIP',
    ...overrides,
  };
}

function provider(overrides: Partial<ProviderReport> = {}): ProviderReport {
  return {
    label: 'Stripe',
    status: 'WIRED',
    required_vars: ['STRIPE_SECRET_KEY'],
    env_vars_missing: [],
    env_vars_placeholder: [],
    ...overrides,
  };
}

function flip(overrides: Partial<FlipPlan> = {}): FlipPlan {
  return {
    name: 'ENABLE_FEATURE_X',
    proposed_value: 'true',
    reason: 'auto_flip_on_in_prod is set',
    ...overrides,
  };
}

function entry(overrides: Partial<SwitchEntry> = {}): SwitchEntry {
  return {
    name: 'SOME_SWITCH',
    tier: 'prod',
    owner: 'platform',
    description: 'controls a prod-touching behaviour',
    ...overrides,
  };
}

describe('SEVERITY_ORDER', () => {
  it('ranks BLOCK_SHIP > WARN > INFO', () => {
    expect(SEVERITY_ORDER).toEqual(['BLOCK_SHIP', 'WARN', 'INFO']);
  });

  it('covers exactly the three severities', () => {
    const all: StubSeverity[] = ['BLOCK_SHIP', 'WARN', 'INFO'];
    expect([...SEVERITY_ORDER].sort()).toEqual([...all].sort());
  });
});

describe('verdict', () => {
  it('returns CLEAN for an empty report', () => {
    expect(verdict(report())).toBe('CLEAN');
  });

  it('returns SHIP_BLOCKED when a BLOCK_SHIP stub exists', () => {
    expect(verdict(report({ stubs: [stub({ severity: 'BLOCK_SHIP' })] }))).toBe('SHIP_BLOCKED');
  });

  it('returns SHIP_BLOCKED when there is an unregistered var', () => {
    expect(verdict(report({ unregistered_in_code: ['MYSTERY_VAR'] }))).toBe('SHIP_BLOCKED');
  });

  it('returns NEEDS_OPERATOR for a STUB provider with no blockers', () => {
    expect(verdict(report({ providers: [provider({ status: 'STUB' })] }))).toBe('NEEDS_OPERATOR');
  });

  it('returns NEEDS_OPERATOR when MUST_SET switches are unset', () => {
    expect(verdict(report({ switches_unset_in_prod: [entry()] }))).toBe('NEEDS_OPERATOR');
  });

  it('does not treat WARN/INFO stubs as ship blockers', () => {
    const r = report({ stubs: [stub({ severity: 'WARN' }), stub({ severity: 'INFO' })] });
    expect(verdict(r)).toBe('CLEAN');
  });
});

describe('summaryLine', () => {
  it('matches the documented R100 format for an empty report', () => {
    expect(summaryLine(report())).toBe('R100: 0 blockers, 0 warnings, 0 green');
  });

  it('counts BLOCK_SHIP stubs and unregistered vars as blockers', () => {
    const r = report({
      stubs: [stub({ severity: 'BLOCK_SHIP' }), stub({ severity: 'BLOCK_SHIP' })],
      unregistered_in_code: ['A', 'B', 'C'],
    });
    expect(summaryLine(r)).toBe('R100: 5 blockers, 0 warnings, 0 green');
  });

  it('counts WARN stubs, STUB providers and unset switches as warnings', () => {
    const r = report({
      stubs: [stub({ severity: 'WARN' })],
      providers: [provider({ status: 'STUB' })],
      switches_unset_in_prod: [entry(), entry()],
    });
    expect(summaryLine(r)).toBe('R100: 0 blockers, 4 warnings, 0 green');
  });

  it('counts WIRED providers as green', () => {
    const r = report({ providers: [provider({ status: 'WIRED' }), provider({ status: 'WIRED' })] });
    expect(summaryLine(r)).toBe('R100: 0 blockers, 0 warnings, 2 green');
  });
});

describe('renderConsole', () => {
  it('renders a clean report with a CLEAN verdict and no findings listed', () => {
    const out = renderConsole(report());
    expect(out).toContain('===== Deploy Readiness =====');
    expect(out).toContain('verdict: CLEAN');
    expect(out).toContain('Unregistered vars (R108): 0');
    expect(out).toContain('Stub findings: BLOCK_SHIP=0  WARN=0  INFO=0');
  });

  it('lists each unregistered var on its own line', () => {
    const out = renderConsole(report({ unregistered_in_code: ['ALPHA_VAR', 'BETA_VAR'] }));
    expect(out).toContain('  - ALPHA_VAR');
    expect(out).toContain('  - BETA_VAR');
  });

  it('elides unregistered vars beyond the display cap with a "more" line', () => {
    const many = Array.from({ length: MAX_STUB_FINDINGS_DISPLAYED + 5 }, (_, i) => `VAR_${i}`);
    const out = renderConsole(report({ unregistered_in_code: many }));
    expect(out).toContain(`  … 5 more`);
    expect(out).not.toContain(`VAR_${MAX_STUB_FINDINGS_DISPLAYED + 4}`);
  });

  it('tallies stub findings by severity', () => {
    const r = report({
      stubs: [stub({ severity: 'BLOCK_SHIP' }), stub({ severity: 'WARN' }), stub({ severity: 'WARN' })],
    });
    expect(renderConsole(r)).toContain('Stub findings: BLOCK_SHIP=1  WARN=2  INFO=0');
  });

  it('truncates long stub excerpts to the configured width', () => {
    const longExcerpt = 'x'.repeat(MAX_EXCERPT_WIDTH + 40);
    const out = renderConsole(report({ stubs: [stub({ excerpt: longExcerpt })] }));
    expect(out).toContain('x'.repeat(MAX_EXCERPT_WIDTH));
    expect(out).not.toContain('x'.repeat(MAX_EXCERPT_WIDTH + 1));
  });

  it('summarises provider counts and lists STUB providers', () => {
    const r = report({
      providers: [
        provider({ label: 'Stripe', status: 'WIRED' }),
        provider({ label: 'S3', status: 'STUB', env_vars_missing: ['AWS_KEY'] }),
        provider({ label: 'Twilio', status: 'NOT_USED' }),
      ],
    });
    const out = renderConsole(r);
    expect(out).toContain('Providers: WIRED=1  STUB=1  NOT_USED=1');
    expect(out).toContain('[STUB] S3  missing=AWS_KEY  placeholder=-');
  });

  it('lists every planned auto-flip', () => {
    const out = renderConsole(report({ flips: [flip({ name: 'FLAG_A' }), flip({ name: 'FLAG_B' })] }));
    expect(out).toContain('Switches that would auto-flip in prod: 2');
    expect(out).toContain('+ FLAG_A ← true');
    expect(out).toContain('+ FLAG_B ← true');
  });
});

describe('renderMarkdown', () => {
  it('renders the header block with metadata and verdict', () => {
    const out = renderMarkdown(report());
    expect(out).toContain('# Deploy Readiness Report');
    expect(out).toContain('- **Target env:** `prod`');
    expect(out).toContain('- **Verdict:** `CLEAN`');
    expect(out).toContain('- **Registry switches:** 223');
  });

  it('says the registry is complete when there are no unregistered vars', () => {
    expect(renderMarkdown(report())).toContain('_None. Registry is complete._');
  });

  it('emits one bullet per unregistered var', () => {
    const out = renderMarkdown(report({ unregistered_in_code: ['ALPHA_VAR'] }));
    expect(out).toContain('- `ALPHA_VAR`');
  });

  it('groups stub findings under severity headings in SEVERITY_ORDER', () => {
    const r = report({
      stubs: [stub({ severity: 'INFO', file: 'src/a.ts' }), stub({ severity: 'BLOCK_SHIP', file: 'src/b.ts' })],
    });
    const out = renderMarkdown(r);
    const block = out.indexOf('### BLOCK_SHIP');
    const warn = out.indexOf('### WARN');
    const info = out.indexOf('### INFO');
    expect(block).toBeGreaterThanOrEqual(0);
    expect(block).toBeLessThan(warn);
    expect(warn).toBeLessThan(info);
    expect(out).toContain('### BLOCK_SHIP (1)');
    expect(out).toContain('### WARN (0)');
  });

  it('escapes pipe characters in stub excerpts so table rows stay intact', () => {
    const out = renderMarkdown(report({ stubs: [stub({ excerpt: 'a | b | c' })] }));
    expect(out).toContain('a \\| b \\| c');
    expect(out).not.toContain('`a | b | c`');
  });

  it('renders a provider wiring table with one row per provider', () => {
    const r = report({
      providers: [
        provider({ label: 'Stripe', status: 'WIRED' }),
        provider({ label: 'S3', status: 'STUB', env_vars_missing: ['AWS_KEY'], env_vars_placeholder: ['AWS_SECRET'] }),
      ],
    });
    const out = renderMarkdown(r);
    expect(out).toContain('| Provider | Status | Required vars | Missing | Placeholder |');
    expect(out).toContain('| Stripe | `WIRED` |');
    expect(out).toContain('| S3 | `STUB` | STRIPE_SECRET_KEY | AWS_KEY | AWS_SECRET |');
  });

  it('shows _None._ for flips and unset switches when both are empty', () => {
    const out = renderMarkdown(report());
    const flipsIdx = out.indexOf('## Switches that would auto-flip');
    const unsetIdx = out.indexOf('## Switches with `prod_default: MUST_SET`');
    expect(out.slice(flipsIdx, unsetIdx)).toContain('_None._');
  });

  it('renders auto-flip rows when present', () => {
    const out = renderMarkdown(report({ flips: [flip({ name: 'FLAG_A', proposed_value: 'on', reason: 'x' })] }));
    expect(out).toContain('| `FLAG_A` | `on` | x |');
  });

  it('truncates switch descriptions to MAX_DESCRIPTION_WIDTH in the table', () => {
    const longDesc = 'd'.repeat(MAX_DESCRIPTION_WIDTH + 30);
    const out = renderMarkdown(report({ switches_unset_in_prod: [entry({ description: longDesc })] }));
    expect(out).toContain('d'.repeat(MAX_DESCRIPTION_WIDTH));
    expect(out).not.toContain('d'.repeat(MAX_DESCRIPTION_WIDTH + 1));
  });

  it('omits the stale-ledger section when there are no dead entries', () => {
    expect(renderMarkdown(report())).not.toContain('## Stale learning-ledger entries');
  });

  it('renders the stale-ledger section with one bullet per fingerprint', () => {
    const out = renderMarkdown(report({ ledger_dead_entries: ['abc123', 'def456'] }));
    expect(out).toContain('## Stale learning-ledger entries');
    expect(out).toContain('- `abc123`');
    expect(out).toContain('- `def456`');
  });

  it('is deterministic: identical input yields byte-identical markdown', () => {
    const r = report({
      stubs: [stub({ severity: 'WARN' })],
      providers: [provider({ status: 'STUB', label: 'S3' })],
      flips: [flip()],
    });
    expect(renderMarkdown(r)).toBe(renderMarkdown(r));
  });

  it('reflects the SHIP_BLOCKED verdict in the markdown header', () => {
    const out = renderMarkdown(report({ unregistered_in_code: ['MYSTERY'] }));
    expect(out).toContain('- **Verdict:** `SHIP_BLOCKED`');
  });
});

describe('renderMarkdown — five-finding severity table', () => {
  // A report with five stub findings spread across the severities, asserting
  // both the per-severity counts and that every finding lands under the right
  // heading in the documented order.
  function fiveFindingReport(): ReadinessReport {
    return report({
      stubs: [
        stub({ severity: 'BLOCK_SHIP', file: 'src/a.ts', line: 1, pattern: 'p1', excerpt: 'e1' }),
        stub({ severity: 'BLOCK_SHIP', file: 'src/b.ts', line: 2, pattern: 'p2', excerpt: 'e2' }),
        stub({ severity: 'WARN', file: 'src/c.ts', line: 3, pattern: 'p3', excerpt: 'e3' }),
        stub({ severity: 'WARN', file: 'src/d.ts', line: 4, pattern: 'p4', excerpt: 'e4' }),
        stub({ severity: 'INFO', file: 'src/e.ts', line: 5, pattern: 'p5', excerpt: 'e5' }),
      ],
    });
  }

  it('counts findings per severity heading', () => {
    const out = renderMarkdown(fiveFindingReport());
    expect(out).toContain('### BLOCK_SHIP (2)');
    expect(out).toContain('### WARN (2)');
    expect(out).toContain('### INFO (1)');
  });

  it('lists exactly five finding bullets across the three sections', () => {
    const out = renderMarkdown(fiveFindingReport());
    const bullets = out.split('\n').filter((l) => /^- `src\/[a-e]\.ts:\d` —/.test(l));
    expect(bullets).toHaveLength(5);
  });

  it('renders each finding with file:line, pattern in bold, and excerpt in code', () => {
    const out = renderMarkdown(fiveFindingReport());
    expect(out).toContain('- `src/a.ts:1` — **p1** — `e1`');
    expect(out).toContain('- `src/e.ts:5` — **p5** — `e5`');
  });

  it('orders BLOCK_SHIP findings before WARN before INFO', () => {
    const out = renderMarkdown(fiveFindingReport());
    const a = out.indexOf('src/a.ts:1');
    const c = out.indexOf('src/c.ts:3');
    const e = out.indexOf('src/e.ts:5');
    expect(a).toBeLessThan(c);
    expect(c).toBeLessThan(e);
  });
});

describe('renderConsole — combined real-world report', () => {
  // Exercises every console section at once, the way the orchestrator would
  // hand a populated report to the reporter on a blocked deploy.
  function blockedReport(): ReadinessReport {
    return report({
      target_env: 'staging',
      registry_size: 210,
      env_var_count: 175,
      unregistered_in_code: ['NEW_A', 'NEW_B'],
      stubs: [
        stub({ severity: 'BLOCK_SHIP', file: 'src/pay.ts', line: 9, pattern: 'tok', excerpt: 'x' }),
        stub({ severity: 'WARN' }),
      ],
      providers: [
        provider({ label: 'Stripe', status: 'WIRED' }),
        provider({ label: 'S3', status: 'STUB', env_vars_missing: ['AWS_KEY'], env_vars_placeholder: ['AWS_SECRET'] }),
      ],
      flips: [flip({ name: 'FLAG_X', proposed_value: 'on', reason: 'prod default' })],
    });
  }

  it('reports the SHIP_BLOCKED verdict on the verdict line', () => {
    expect(renderConsole(blockedReport())).toContain('verdict: SHIP_BLOCKED');
  });

  it('echoes the env/registry/discovered header line', () => {
    expect(renderConsole(blockedReport())).toContain(
      'env: staging   registry: 210   env vars discovered: 175',
    );
  });

  it('lists the single BLOCK_SHIP stub with its file:line and pattern', () => {
    expect(renderConsole(blockedReport())).toContain('[BLOCK] src/pay.ts:9  tok');
  });

  it('lists the STUB provider with both missing and placeholder vars', () => {
    expect(renderConsole(blockedReport())).toContain('[STUB] S3  missing=AWS_KEY  placeholder=AWS_SECRET');
  });

  it('renders a dash for a STUB provider with no missing vars', () => {
    const out = renderConsole(
      report({ providers: [provider({ label: 'X', status: 'STUB', env_vars_missing: [], env_vars_placeholder: [] })] }),
    );
    expect(out).toContain('[STUB] X  missing=-  placeholder=-');
  });

  it('does not list WIRED providers in the STUB detail lines', () => {
    expect(renderConsole(blockedReport())).not.toContain('[STUB] Stripe');
  });

  it('caps the BLOCK_SHIP detail list at the display maximum', () => {
    const manyBlock = Array.from({ length: MAX_STUB_FINDINGS_DISPLAYED + 4 }, (_, i) =>
      stub({ severity: 'BLOCK_SHIP', file: `src/x${i}.ts`, line: i }),
    );
    const out = renderConsole(report({ stubs: manyBlock }));
    const blockLines = out.split('\n').filter((l) => l.includes('[BLOCK]'));
    expect(blockLines).toHaveLength(MAX_STUB_FINDINGS_DISPLAYED);
  });
});

describe('output shape invariants', () => {
  it('console output starts with the banner line', () => {
    expect(renderConsole(report()).split('\n')[0]).toBe('===== Deploy Readiness =====');
  });

  it('markdown output starts with the H1 title', () => {
    expect(renderMarkdown(report()).split('\n')[0]).toBe('# Deploy Readiness Report');
  });

  it('console output never contains a markdown table separator row', () => {
    expect(renderConsole(report({ providers: [provider()] }))).not.toContain('|---|');
  });

  it('markdown provider table header appears exactly once', () => {
    const out = renderMarkdown(report({ providers: [provider(), provider({ label: 'S3' })] }));
    const occurrences = out.split('| Provider | Status | Required vars | Missing | Placeholder |').length - 1;
    expect(occurrences).toBe(1);
  });

  it('renders _none_ for a provider with no required vars in markdown', () => {
    const out = renderMarkdown(report({ providers: [provider({ label: 'X', required_vars: [] })] }));
    expect(out).toContain('| X | `WIRED` | _none_ |');
  });

  it('escapes a pipe in a provider label', () => {
    const out = renderMarkdown(report({ providers: [provider({ label: 'A|B' })] }));
    expect(out).toContain('| A\\|B | `WIRED` |');
  });

  it('escapes a pipe in a flip reason', () => {
    const out = renderMarkdown(report({ flips: [flip({ reason: 'because a | b' })] }));
    expect(out).toContain('| because a \\| b |');
  });

  it('escapes a pipe in a switch description cell', () => {
    const out = renderMarkdown(report({ switches_unset_in_prod: [entry({ description: 'left | right' })] }));
    expect(out).toContain('left \\| right');
  });
});

describe('verdict precedence', () => {
  it('prefers SHIP_BLOCKED over NEEDS_OPERATOR when both conditions hold', () => {
    const r = report({
      unregistered_in_code: ['X'],
      providers: [provider({ status: 'STUB' })],
      switches_unset_in_prod: [entry()],
    });
    expect(verdict(r)).toBe('SHIP_BLOCKED');
  });

  it('a lone NOT_USED provider keeps a CLEAN verdict', () => {
    expect(verdict(report({ providers: [provider({ status: 'NOT_USED' })] }))).toBe('CLEAN');
  });

  it('exposes ProviderStatus type for fixtures', () => {
    const s: ProviderStatus = 'WIRED';
    expect(provider({ status: s }).status).toBe('WIRED');
  });
});

describe('renderConsole — unregistered var elision boundaries', () => {
  it('does not print a "more" line when count equals the cap exactly', () => {
    const exact = Array.from({ length: MAX_STUB_FINDINGS_DISPLAYED }, (_, i) => `V_${i}`);
    const out = renderConsole(report({ unregistered_in_code: exact }));
    expect(out).not.toContain('more');
    expect(out).toContain(`V_${MAX_STUB_FINDINGS_DISPLAYED - 1}`);
  });

  it('prints "1 more" when count is one over the cap', () => {
    const over = Array.from({ length: MAX_STUB_FINDINGS_DISPLAYED + 1 }, (_, i) => `V_${i}`);
    const out = renderConsole(report({ unregistered_in_code: over }));
    expect(out).toContain('  … 1 more');
  });

  it('reports the exact unregistered count in the header even when elided', () => {
    const over = Array.from({ length: MAX_STUB_FINDINGS_DISPLAYED + 7 }, (_, i) => `V_${i}`);
    const out = renderConsole(report({ unregistered_in_code: over }));
    expect(out).toContain(`Unregistered vars (R108): ${MAX_STUB_FINDINGS_DISPLAYED + 7}`);
  });
});

describe('renderMarkdown — metadata fidelity', () => {
  it('echoes the generated_at timestamp verbatim', () => {
    const out = renderMarkdown(report({ generated_at: '2026-02-02T03:04:05.678Z' }));
    expect(out).toContain('- **Generated:** 2026-02-02T03:04:05.678Z');
  });

  it('echoes the discovered env var count', () => {
    expect(renderMarkdown(report({ env_var_count: 42 }))).toContain('- **Env vars discovered:** 42');
  });

  it('wraps the target env in backticks', () => {
    expect(renderMarkdown(report({ target_env: 'production' }))).toContain('- **Target env:** `production`');
  });
});

describe('renderMarkdown — MUST_SET unset switch table', () => {
  it('renders a row per unset switch with tier and owner', () => {
    const out = renderMarkdown(
      report({
        switches_unset_in_prod: [
          entry({ name: 'A_KEY', tier: 'prod', owner: 'billing', description: 'a' }),
          entry({ name: 'B_KEY', tier: 'feature', owner: 'core', description: 'b' }),
        ],
      }),
    );
    expect(out).toContain('| `A_KEY` | prod | billing | a |');
    expect(out).toContain('| `B_KEY` | feature | core | b |');
  });

  it('keeps the auto-flip table and the MUST_SET table as distinct sections', () => {
    const out = renderMarkdown(
      report({ flips: [flip({ name: 'F' })], switches_unset_in_prod: [entry({ name: 'S' })] }),
    );
    expect(out.indexOf('## Switches that would auto-flip')).toBeLessThan(
      out.indexOf('## Switches with `prod_default: MUST_SET`'),
    );
  });
});

describe('summaryLine — mixed scenario', () => {
  it('counts blockers, warnings and green independently in one report', () => {
    const r = report({
      stubs: [
        stub({ severity: 'BLOCK_SHIP' }),
        stub({ severity: 'WARN' }),
        stub({ severity: 'WARN' }),
      ],
      unregistered_in_code: ['X', 'Y'],
      providers: [
        provider({ status: 'WIRED' }),
        provider({ status: 'WIRED' }),
        provider({ status: 'WIRED' }),
        provider({ status: 'STUB' }),
      ],
      switches_unset_in_prod: [entry()],
    });
    // blockers = 1 BLOCK_SHIP + 2 unregistered = 3
    // warnings = 2 WARN + 1 STUB provider + 1 unset switch = 4
    // green = 3 WIRED
    expect(summaryLine(r)).toBe('R100: 3 blockers, 4 warnings, 3 green');
  });
});

describe('renderConsole — section presence', () => {
  it('always renders the four section headers in order', () => {
    const out = renderConsole(report());
    const unreg = out.indexOf('Unregistered vars (R108)');
    const stubs = out.indexOf('Stub findings:');
    const providers = out.indexOf('Providers:');
    const flips = out.indexOf('Switches that would auto-flip in prod:');
    expect(unreg).toBeGreaterThanOrEqual(0);
    expect(unreg).toBeLessThan(stubs);
    expect(stubs).toBeLessThan(providers);
    expect(providers).toBeLessThan(flips);
  });

  it('reports zero flips for a clean report', () => {
    expect(renderConsole(report())).toContain('Switches that would auto-flip in prod: 0');
  });

  it('reports all-zero provider counts for a clean report', () => {
    expect(renderConsole(report())).toContain('Providers: WIRED=0  STUB=0  NOT_USED=0');
  });
});

describe('renderMarkdown — empty stub sections', () => {
  it('renders _None._ under each empty severity heading', () => {
    const out = renderMarkdown(report());
    const block = out.indexOf('### BLOCK_SHIP (0)');
    const next = out.indexOf('### WARN (0)');
    expect(out.slice(block, next)).toContain('_None._');
  });

  it('renders the R108 section even when clean', () => {
    expect(renderMarkdown(report())).toContain('## R108 — Unregistered env vars');
  });
});

describe('type re-exports are usable in fixtures', () => {
  it('accepts a StubSeverity literal', () => {
    const sev: StubSeverity = 'INFO';
    expect(stub({ severity: sev }).severity).toBe('INFO');
  });

  it('accepts a SwitchEntry shape', () => {
    const e: SwitchEntry = entry();
    expect(e.name).toBe('SOME_SWITCH');
  });

  it('accepts a FlipPlan shape', () => {
    const f: FlipPlan = flip();
    expect(f.proposed_value).toBe('true');
  });

  it('accepts a StubFinding shape', () => {
    const s: StubFinding = stub();
    expect(s.file).toBe('src/foo.ts');
  });

  it('accepts a ProviderReport shape', () => {
    const p: ProviderReport = provider();
    expect(p.label).toBe('Stripe');
  });
});
