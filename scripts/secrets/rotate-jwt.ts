#!/usr/bin/env ts-node
/**
 * scripts/secrets/rotate-jwt.ts
 *
 * Generates a new JWT signing key and prints:
 *   1. The flyctl command to set the new key (current becomes "previous")
 *   2. A timeline for the rotation (enable dual-key → wait 24h → retire old key)
 *   3. Copy-paste-ready commands for every step
 *
 * WHAT THIS SCRIPT DOES (and does NOT do)
 * ----------------------------------------
 * - DOES: generate a cryptographically secure new signing key
 * - DOES: print the exact `flyctl secrets set` commands you need to run
 * - DOES NOT: execute flyctl directly (Bradley runs the commands manually)
 * - DOES NOT: read or transmit any existing key values
 *
 * Usage:
 *   npx ts-node scripts/secrets/rotate-jwt.ts
 *
 * Follow the printed steps. Total time: ~5 minutes of commands, 24h of
 * waiting for the transition window to expire.
 *
 * HOW THE DUAL-KEY ROTATION WORKS
 * ---------------------------------
 * The app reads two env vars:
 *   JWT_SIGNING_KEY          — the current signing key (signs new tokens)
 *   JWT_SIGNING_KEY_PREVIOUS — the old key (validates tokens issued before rotation)
 *
 * During a 24-hour window BOTH keys are accepted for verification. This means:
 *   - New tokens are signed with the new key immediately
 *   - Existing tokens (signed with the old key) remain valid for 24h
 *   - After 24h, clear JWT_SIGNING_KEY_PREVIOUS to complete the rotation
 *
 * This gives every logged-in user 24h to naturally re-authenticate via token
 * refresh. Zero forced logouts. Zero downtime.
 */

import * as crypto from 'crypto';

// ─── Key generation ──────────────────────────────────────────────────────────

/**
 * Generate a 256-bit (32-byte) random key suitable for HMAC-SHA256.
 * Encoded as hex (64 characters). Safe to use directly as JWT_SIGNING_KEY.
 */
function generateSigningKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

// ─── Output helpers ──────────────────────────────────────────────────────────

const FLY_APP = 'backend-spring-lake-3890';

function box(title: string): void {
  const line = '─'.repeat(60);
  console.log(`\n┌${line}┐`);
  console.log(`│  ${title.padEnd(59)}│`);
  console.log(`└${line}┘`);
}

function step(n: number, title: string): void {
  console.log(`\n  Step ${n}: ${title}`);
  console.log(`  ${'─'.repeat(56)}`);
}

function cmd(command: string): void {
  console.log(`\n  $ ${command}`);
}

function note(text: string): void {
  console.log(`  ℹ  ${text}`);
}

function warn(text: string): void {
  console.log(`  ⚠️  ${text}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  const newKey = generateSigningKey();
  const now = new Date();
  const retireTime = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  box('JWT Signing Key Rotation — Zero-Downtime Playbook');

  console.log(`
  Generated at: ${now.toISOString()}
  New key:      ${newKey}
              ^^^^ This is a 32-byte hex key. Treat it as a secret.
              Do not share it. Do not commit it to git.
`);

  warn('Do NOT log or screenshot the key above beyond what is needed to run the commands.');
  warn('Once you have pasted it into Step 1, close this terminal window.');

  // ── Step 1: Set new key + promote current to "previous" ───────────────────
  step(1, 'Set the new signing key and move the old key to "previous"');

  note('This starts the 24-hour dual-key transition window.');
  note('The app will SIGN new tokens with the new key immediately.');
  note('Tokens signed with the old key are still accepted for 24h.');
  note('');
  note('Run this command. It sets both secrets in a single Fly deploy,');
  note('so there is zero gap where tokens are rejected:');

  cmd(
    `flyctl secrets set \\`,
  );
  cmd(
    `  JWT_SIGNING_KEY="${newKey}" \\`,
  );
  cmd(
    `  JWT_SIGNING_KEY_PREVIOUS="$(flyctl secrets list -a ${FLY_APP} | grep JWT_SIGNING_KEY | head -1)" \\`,
  );
  cmd(
    `  -a ${FLY_APP}`,
  );

  note('');
  note('IMPORTANT: The command above uses the current JWT_SIGNING_KEY value as the');
  note('"previous" key. If flyctl secrets list does not show the value, get the current');
  note('key from 1Password or your secure secrets store, then run:');
  console.log('');

  console.log(`  # Alternative (replace YOUR_CURRENT_KEY with the actual current value):`);
  console.log(`  $ flyctl secrets set \\`);
  console.log(`      JWT_SIGNING_KEY="${newKey}" \\`);
  console.log(`      JWT_SIGNING_KEY_PREVIOUS="YOUR_CURRENT_KEY" \\`);
  console.log(`      -a ${FLY_APP}`);

  // ── Step 2: Record rotation in the admin UI ────────────────────────────────
  step(2, 'Record the rotation in the audit log');

  note('After the flyctl command succeeds, record the rotation so the');
  note('/admin/secrets/status endpoint shows the updated date:');

  cmd(
    `curl -X POST https://api.trygrowthproject.com/api/admin/secrets/JWT_SIGNING_KEY/rotation-log \\`,
  );
  cmd(
    `  -H "Authorization: Bearer YOUR_ADMIN_JWT" \\`,
  );
  cmd(
    `  -H "Content-Type: application/json" \\`,
  );
  cmd(
    `  -d '{"notes": "Routine 90-day rotation"}'`,
  );

  // ── Step 3: Wait 24 hours ──────────────────────────────────────────────────
  step(3, 'Wait 24 hours for the transition window to expire');

  note(`The transition window expires at: ${retireTime.toISOString()}`);
  note('During this window, tokens signed with the old key are still valid.');
  note('New tokens are being signed with the new key from Step 1.');
  note('No users will be logged out.');

  // ── Step 4: Retire the old key ─────────────────────────────────────────────
  step(4, `Retire the old key (run after ${retireTime.toLocaleString()})`);

  note('Clear JWT_SIGNING_KEY_PREVIOUS. After this, only tokens signed with');
  note('the new key are accepted. Any tokens issued before Step 1 will now');
  note('require a re-login (normal token expiry handles this for most users).');

  cmd(`flyctl secrets unset JWT_SIGNING_KEY_PREVIOUS -a ${FLY_APP}`);
  console.log('');

  note('Then record the completion of the previous-key retirement:');
  cmd(
    `curl -X POST https://api.trygrowthproject.com/api/admin/secrets/JWT_SIGNING_KEY_PREVIOUS/rotation-log \\`,
  );
  cmd(
    `  -H "Authorization: Bearer YOUR_ADMIN_JWT" \\`,
  );
  cmd(
    `  -H "Content-Type: application/json" \\`,
  );
  cmd(
    `  -d '{"notes": "Retired old key 24h after rotation"}'`,
  );

  // ── Verification ──────────────────────────────────────────────────────────
  step(5, 'Verify the rotation worked');

  note('Check that the new key is set and the previous key is gone:');
  cmd(`flyctl secrets list -a ${FLY_APP} | grep JWT`);

  note('');
  note('Expected output after Step 4:');
  console.log('    JWT_SIGNING_KEY   [set]');
  console.log('    (JWT_SIGNING_KEY_PREVIOUS should not appear)');

  note('');
  note('Check the admin status endpoint (should show "not stale"):');
  cmd(
    `curl -s https://api.trygrowthproject.com/api/admin/secrets/status \\`,
  );
  cmd(
    `  -H "Authorization: Bearer YOUR_ADMIN_JWT" | jq '.secrets[] | select(.name=="JWT_SIGNING_KEY")'`,
  );

  console.log('\n');
  box('Rotation playbook complete. Total time: ~5 min (plus 24h wait).');
  console.log('');
}

main();
