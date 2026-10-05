// CI lane only (AUD-OPUS-661E-120; never in a PR): start the runner's own PostgreSQL and point
// the MWB3 live gate at a throwaway database, as the mwb-3-live-tests service container does.
const { execSync } = require('child_process');
module.exports = async () => {
  const sh = (c) => execSync(c, { stdio: 'inherit', cwd: '/tmp' });
  sh('sudo systemctl start postgresql.service');
  for (let i = 0; i < 60; i += 1) {
    try {
      execSync('sudo -u postgres psql -tAc "select 1"', { stdio: 'ignore', cwd: '/tmp' });
      break;
    } catch (err) {
      execSync('sleep 1');
    }
  }
  sh(`sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER USER postgres WITH PASSWORD 'postgres'"`);
  sh('sudo -u postgres psql -c "DROP DATABASE IF EXISTS ao661e"');
  sh('sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE ao661e"');
  sh('sudo -u postgres psql -tAc "select version()"');
  const url = 'postgresql://postgres:postgres@localhost:5432/ao661e';
  process.env.MWB3_TEST_DATABASE_URL = url;
  process.env.DATABASE_URL = url;
  process.env.DIRECT_URL = url;
};
