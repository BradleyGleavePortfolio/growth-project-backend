/**
 * scripts/gen-operator-keys.ts
 *
 * Deterministic generator + drift check for the checked-in
 * OPERATOR_KEYS_NEEDED.md artifact (H4.G).
 *
 * The artifact answers one operator question: "before a from-scratch
 * production deploy, which env vars / provider credentials must I provide?"
 * To keep the committed file DETERMINISTIC and TRUTHFUL without ever reading
 * or printing a real secret, the input is assembled from committed source
 * ONLY, against an EMPTY environment:
 *
 *   - Section 1 (MUST_SET switches): every `prod_default: MUST_SET` row in
 *     `prod-switches.yml`. With an empty env every one reads as unset, so the
 *     document lists the full set the operator must set. Source of truth:
 *     the registry (real runtime names — DATABASE_URL, SUPABASE_URL, … — not
 *     invented placeholders).
 *   - Section 2 (providers imported but not credentialed): every provider in
 *     `provider-wiring.ts` whose SDK is actually imported under `src/`,
 *     classified against the empty env so each required var (the real runtime
 *     names — STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, …) surfaces as missing.
 *   - Section 3 (R108 unregistered-in-code): intentionally empty, mirroring the
 *     orchestrator's own invocation in `deploy-readiness.spec.ts` (R108 is
 *     enforced by the env-discovery board section, not this operator doc), so
 *     the artifact stays stable across unrelated `src/` env-var churn.
 *
 * Empty env in, source-only out: the same repo produces byte-identical content
 * on every run (modulo the single volatile timestamp line, which `assertNoDrift`
 * strips before comparing). No secret VALUES are ever read — only names.
 *
 * CLI:
 *   ts-node scripts/gen-operator-keys.ts          # regenerate the artifact
 *   ts-node scripts/gen-operator-keys.ts --check   # fail (exit 1) if stale
 */

import * as path from 'node:path';

import { loadRegistry, getProdRequired } from '../test/prod-readiness/registry-loader';
import {
  scanProvidersFromProcess,
  getProductionBlockers,
} from '../test/prod-readiness/provider-wiring';
import {
  assertNoDrift,
  writeOperatorKeysMarkdown,
  type OperatorKeysInput,
  type ProviderReport as OperatorProviderReport,
  type SwitchEntry,
} from '../test/prod-readiness/operator-keys-generator';

/** The single fixed environment the artifact is generated against: no secrets. */
export const GENERATION_ENV: NodeJS.ProcessEnv = {};

export interface AssembleOptions {
  repoRoot: string;
  /** ISO timestamp for the volatile marker line; defaults to now. */
  generatedAt?: string;
}

/**
 * Assemble the DETERMINISTIC OperatorKeysInput from committed source only. Pure
 * with respect to secrets: providers are scanned against {@link GENERATION_ENV}
 * (empty), so no real credential value is ever read. The only non-source input
 * is `generatedAt`, which lives on the volatile line the drift check ignores.
 */
export async function assembleOperatorKeysInput(opts: AssembleOptions): Promise<OperatorKeysInput> {
  const registry = await loadRegistry(path.join(opts.repoRoot, 'prod-switches.yml'));
  const switches_unset_required: SwitchEntry[] = getProdRequired(registry).map((r) => ({
    name: r.name,
    tier: r.tier,
    owner: r.owner,
    description: r.description,
  }));

  const providerReports = scanProvidersFromProcess(opts.repoRoot, GENERATION_ENV);
  const providers_stubbed: OperatorProviderReport[] = getProductionBlockers([
    ...providerReports,
  ]).map((p) => ({
    label: p.label,
    env_vars_missing: p.env_vars_missing,
    env_vars_placeholder: p.env_vars_placeholder,
  }));

  return {
    generated_at: opts.generatedAt ?? new Date().toISOString(),
    switches_unset_required,
    // R108 unregistered-in-code is enforced by the deploy-readiness board's
    // env-discovery section, not this doc; kept empty here to match the
    // orchestrator's own generator invocation and keep the artifact stable.
    unregistered_in_code: [],
    providers_stubbed,
  };
}

async function main(): Promise<void> {
  const repoRoot = path.join(__dirname, '..');
  const check = process.argv.includes('--check');
  const input = await assembleOperatorKeysInput({ repoRoot });

  if (check) {
    const { drifted, detail } = assertNoDrift(repoRoot, input);
    if (drifted) {
      console.error(
        `[gen-operator-keys] OPERATOR_KEYS_NEEDED.md is stale: ${detail}\n` +
          'Run `npm run readiness:keys` and commit the result.',
      );
      process.exit(1);
    }
    // eslint-disable-next-line no-console -- CLI status line to stdout
    console.log('[gen-operator-keys] OPERATOR_KEYS_NEEDED.md is up to date.');
    return;
  }

  const target = writeOperatorKeysMarkdown(repoRoot, input);
  // eslint-disable-next-line no-console -- CLI status line to stdout
  console.log(`[gen-operator-keys] wrote ${path.relative(repoRoot, target)}`);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('[gen-operator-keys] failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
