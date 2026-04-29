/* eslint-disable @typescript-eslint/no-var-requires */
// Boots the Nest application factory in spec-only mode and writes the
// resolved OpenAPI document to docs/openapi.json. Used by CI to publish
// the spec and to diff for breaking changes between PRs. Does NOT call
// app.listen() so it exits cleanly.
//
// Usage: `npm run openapi:export`

// Stub the env vars required by `assertEnv()` so the export can run
// outside of a real environment (CI, contributor laptop). The script
// never opens a real network socket — these stubs let the AppModule
// instantiate without throwing.
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || 'export-only-service-role-key';
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://export:export@localhost:5432/export';
process.env.USDA_API_KEY = process.env.USDA_API_KEY || 'export-only';
// Force docs on regardless of NODE_ENV.
process.env.ENABLE_API_DOCS = 'true';

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import * as fs from 'fs';
import * as path from 'path';
import { AppModule } from '../src/app.module';
import { buildOpenApiDocument } from '../src/common/openapi';

async function main() {
  const app = await NestFactory.create(AppModule, { logger: false });
  const document = buildOpenApiDocument(app);
  await app.close();

  const outDir = path.resolve(__dirname, '..', 'docs');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  const outPath = path.join(outDir, 'openapi.json');
  fs.writeFileSync(outPath, JSON.stringify(document, null, 2) + '\n', 'utf8');
  // eslint-disable-next-line no-console
  console.log(`Wrote ${outPath} (${Object.keys(document.paths || {}).length} paths)`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
