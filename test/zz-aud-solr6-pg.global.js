// CI lane only (B-661-R6-117; never in the PR): start the runner's own
// PostgreSQL and point the MWB3 live gate at a throwaway database, the way
// the mwb-3-live-tests job's service container does.
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
  sh('sudo -u postgres psql -c "DROP DATABASE IF EXISTS l661"');
  sh('sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE l661"');
  sh('sudo -u postgres psql -tAc "select version()"');
  const url = 'postgresql://postgres:postgres@localhost:5432/l661';
  process.env.MWB3_TEST_DATABASE_URL = url;
  process.env.DATABASE_URL = url;
  process.env.DIRECT_URL = url;
};
