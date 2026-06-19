/**
 * prod-readiness/env-discovery.ts
 *
 * Discovers every env-var-shaped switch in the codebase from THREE sources:
 *   1. src/common/env-validation.ts (ENV_RULES) — the runtime authority.
 *   2. .env.example — the developer-onboarding authority.
 *   3. process.env.X references under src/ — what the code actually reads.
 *
 * Returns the union, plus per-source attribution so reports can show
 * "DATABASE_URL: appears in ENV_RULES + .env.example + code (3/3)" vs
 * "BOOTSTRAP_SECRET: appears in code only (1/3)".
 *
 * Three sources are deliberate: a var present in all three is wired
 * end-to-end; a var present in only one is a smell (e.g. removed from
 * code but lingering in .env.example, or used in code but unrustled in
 * ENV_RULES so boot never validates it).
 */

import * as fs from 'fs';
import * as path from 'path';

export interface DiscoveryResult {
  envVars: Map<string, EnvVarOrigin>;
}

export interface EnvVarOrigin {
  inEnvRules: boolean;
  inEnvExample: boolean;
  inCode: boolean;
  /** File paths under src/ that reference this var (relative paths). */
  codeRefs: string[];
}

export function discoverEnvVars(repoRoot: string = process.cwd()): DiscoveryResult {
  const result = new Map<string, EnvVarOrigin>();
  const upsert = (name: string): EnvVarOrigin => {
    let v = result.get(name);
    if (!v) {
      v = { inEnvRules: false, inEnvExample: false, inCode: false, codeRefs: [] };
      result.set(name, v);
    }
    return v;
  };

  // 1) ENV_RULES — parse the static source file. We don't import the module
  // because importing src/common/env-validation runs its top-level checks
  // and can throw under a partial test env.
  const validationPath = path.join(repoRoot, 'src/common/env-validation.ts');
  if (fs.existsSync(validationPath)) {
    const src = fs.readFileSync(validationPath, 'utf8');
    // Match every `name: '...'` inside ENV_RULES rule objects. Each rule object
    // begins with `{ name:` so a tolerant regex over the whole file works.
    const re = /\{\s*name:\s*'([A-Z][A-Z0-9_]*)'\s*,\s*tier:\s*'(hard|prod|feature|optional)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      upsert(m[1]).inEnvRules = true;
    }
  }

  // 2) .env.example — every line of shape `NAME=...` is a var.
  const envExamplePath = path.join(repoRoot, '.env.example');
  if (fs.existsSync(envExamplePath)) {
    const lines = fs.readFileSync(envExamplePath, 'utf8').split('\n');
    for (const line of lines) {
      const m = /^([A-Z][A-Z0-9_]*)\s*=/.exec(line.trim());
      if (m) upsert(m[1]).inEnvExample = true;
    }
  }

  // 3) process.env.X under src/ — recursive walk.
  const srcRoot = path.join(repoRoot, 'src');
  if (fs.existsSync(srcRoot)) {
    walkTs(srcRoot, (file) => {
      const text = fs.readFileSync(file, 'utf8');
      const re = /process\.env\.([A-Z][A-Z0-9_]*)/g;
      const seenInFile = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const name = m[1];
        if (seenInFile.has(name)) continue;
        seenInFile.add(name);
        const o = upsert(name);
        o.inCode = true;
        o.codeRefs.push(path.relative(repoRoot, file));
      }
    });
  }

  return { envVars: result };
}

function walkTs(dir: string, visit: (file: string) => void): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      walkTs(p, visit);
    } else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
      visit(p);
    }
  }
}
