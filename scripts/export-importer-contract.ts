/* eslint-disable no-console */
// Boots the Nest application factory in spec-only mode, slices the
// importer-only surface out of the resolved OpenAPI document, and writes the
// deterministic artifact to docs/contracts/importer-openapi.json. CI runs this
// and fails if the working tree changes (see test/contracts/
// importer-contract.spec.ts), so the checked-in artifact can never drift from
// the code. Does NOT call app.listen() so it exits cleanly.
//
// Usage: `npm run contract:importer`

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import * as fs from 'fs';
import * as path from 'path';
import { AppModule } from '../src/app.module';
import { buildOpenApiDocument } from '../src/common/openapi';
import { buildImporterContract, serializeContract } from './importer-contract';

export function contractOutPath(): string {
  // IMPORTER_CONTRACT_OUT lets a caller (the cross-process determinism test)
  // redirect the write to a scratch path so a fresh, cold-process regeneration
  // can be diffed against the committed artifact WITHOUT clobbering it. Unset in
  // normal use, so the CLI still writes the canonical location.
  const override = process.env.IMPORTER_CONTRACT_OUT;
  if (override && override.trim().length > 0) return path.resolve(override.trim());
  return path.resolve(__dirname, '..', 'docs', 'contracts', 'importer-openapi.json');
}

// Stub the env vars required by assertEnv() so the export runs outside a real
// environment (CI, contributor laptop). No network socket is opened. This runs
// ONLY inside main() (CLI path) — importing this module for contractOutPath()
// (the drift test does) must NOT mutate the ambient process.env, which would
// leak across the Jest worker's other suites.
function stubExportEnv(): void {
  process.env.NODE_ENV = process.env.NODE_ENV || 'development';
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
  process.env.SUPABASE_SERVICE_ROLE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY || 'export-only-service-role-key';
  process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgresql://export:export@localhost:5432/export';
  process.env.USDA_API_KEY = process.env.USDA_API_KEY || 'export-only';
  // Force docs on regardless of NODE_ENV.
  process.env.ENABLE_API_DOCS = 'true';
}

async function main() {
  stubExportEnv();
  const app = await NestFactory.create(AppModule, { logger: false });
  const document = buildOpenApiDocument(app);
  await app.close();

  const contract = buildImporterContract(document);
  const outPath = contractOutPath();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, serializeContract(contract), 'utf8');
  console.log(
    `Wrote ${outPath} (${Object.keys(contract.paths || {}).length} paths, ` +
      `${Object.keys(contract.components?.schemas || {}).length} schemas)`,
  );
}

// Only boot + write when run as a CLI (`ts-node scripts/export-importer-contract.ts`).
// The drift test imports contractOutPath() from this module and must NOT trigger
// a regeneration as an import side effect — that would let the test pass against
// a freshly-written file even when the committed artifact is stale.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
