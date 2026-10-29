// Audit-only bootstrap. An isolated loopback database exists only on the CI runner.
const { execFileSync, spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');

const name = 'ls1173r3-live-probe';
const url = 'postgresql://postgres:postgres@127.0.0.1:55432/rule_d_probe';

module.exports = async function setup() {
  if (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('This optional probe bootstrap runs only in GitHub CI.');
  }
  execFileSync('docker', ['run', '--detach', '--rm', '--name', name,
    '-e', 'POSTGRES_PASSWORD=postgres', '-e', 'POSTGRES_DB=rule_d_probe',
    '-p', '127.0.0.1:55432:5432', 'postgres:15'], { stdio: 'inherit', timeout: 120000 });
  let ready = false;
  for (let n = 0; n < 60; n += 1) {
    if (spawnSync('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
      { stdio: 'ignore', timeout: 5000 }).status === 0) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error('The isolated probe database did not start.');
  execFileSync('docker', ['exec', '-i', name, 'psql', '-XAtq', '-v',
    'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'rule_d_probe'], {
    input: readFileSync('scripts/ci/supabase-shim.sql'), timeout: 30000,
  });
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
    stdio: 'inherit', timeout: 180000,
  });
  process.env.TEST_DATABASE_URL = url;
};
