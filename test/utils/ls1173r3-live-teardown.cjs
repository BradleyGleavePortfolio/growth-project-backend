// Paired with the audit-only bootstrap.
const { execFileSync } = require('node:child_process');

module.exports = async function teardown() {
  execFileSync('docker', ['rm', '--force', 'ls1173r3-live-probe'],
    { stdio: 'ignore', timeout: 30000 });
};
