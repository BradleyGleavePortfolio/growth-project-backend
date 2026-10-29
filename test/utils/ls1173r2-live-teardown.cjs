// Paired with the optional LS-1173R2 CI-only bootstrap.
const { execFileSync } = require('node:child_process');

module.exports = async function teardown() {
  execFileSync('docker', ['rm', '--force', 'ls1173r2-live-probe'],
    { stdio: 'ignore', timeout: 30000 });
};
