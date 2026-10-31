import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../src/prisma.service';
import { stub } from './utils/trial-fakes';

/** Test-only disposable local database. Never consumes the application's URL. */
export async function ls1197Database() {
  const container = execFileSync('docker', [
    'run', '--detach', '--rm', '--publish', '127.0.0.1::5432',
    '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:15',
  ], { encoding: 'utf8' }).trim();
  let prisma: PrismaClient | undefined;
  const stop = async () => {
    await prisma?.$disconnect();
    execFileSync('docker', ['rm', '--force', container], { stdio: 'pipe' });
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        // The image starts a socket-only temporary server during init. Wait
        // for the final TCP server, not that temporary bootstrap process.
        execFileSync('docker', ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], { stdio: 'pipe' });
        ready = true;
        break;
      } catch {
        await new Promise((done) => setTimeout(done, 200));
      }
    }
    if (!ready) throw new Error('Disposable local database did not become ready');
    const port = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').pop();
    const url = `postgresql://postgres@127.0.0.1:${port}/postgres`;
    execFileSync('docker', ['exec', '--interactive', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
      input: readFileSync(resolve(__dirname, '../scripts/ci/supabase-shim.sql')),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
      cwd: resolve(__dirname, '..'),
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
      stdio: 'pipe',
      timeout: 180_000,
    });
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
    return { prisma, db: stub<PrismaService>(prisma), url, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
