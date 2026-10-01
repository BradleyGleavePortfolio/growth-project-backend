#!/usr/bin/env node
/**
 * S-ENVTRUTH desired-state manifest for fly-env-sync.yml
 * (.github/fly-env-desired-state.json).
 *
 *   secrets        names copied from the GitHub Actions secret of the same name
 *   flags          launch-flag values the workflow STAGES ("true" | "false")
 *   pending_flags  documented, NOT applied; the operator enables an entry by
 *                  moving it to `flags` in a PR (one audited change per flip)
 *   excluded       names deliberately left out, with the reason
 *
 * CLI (used by the workflow; prints names, or NAME=value for flags only):
 *   node fly-env-desired-state.js validate <manifest> <env-validation.ts>
 *   node fly-env-desired-state.js secrets  <manifest> <env-validation.ts>
 *   node fly-env-desired-state.js flags    <manifest> <env-validation.ts>
 *
 * Plain CommonJS, no dependencies.
 */
'use strict';

const fs = require('fs');
const { extractRegisteredNames } = require('./fly-env-classifier');

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const FLAG_VALUES = new Set(['true', 'false']);

/** Validate a parsed manifest. Returns a list of human-readable errors (empty = OK). */
function validateDesiredState(manifest, registeredNames) {
  const errors = [];
  const registered = new Set(registeredNames);
  if (!manifest || typeof manifest !== 'object') return ['manifest is not an object'];
  const secrets = manifest.secrets;
  const flags = manifest.flags;
  const pending = manifest.pending_flags;
  const excluded = manifest.excluded || {};
  if (!Array.isArray(secrets)) errors.push('secrets must be an array of names');
  if (!flags || typeof flags !== 'object' || Array.isArray(flags))
    errors.push('flags must be an object');
  if (!pending || typeof pending !== 'object' || Array.isArray(pending)) {
    errors.push('pending_flags must be an object');
  }
  if (errors.length) return errors;

  const seen = new Map();
  const claim = (name, where) => {
    if (!ENV_NAME_RE.test(name))
      errors.push(`${where}: ${JSON.stringify(name)} is not an env name`);
    else if (!registered.has(name))
      errors.push(`${where}: ${name} is not registered in env-validation.ts`);
    if (seen.has(name)) errors.push(`${name} appears in both ${seen.get(name)} and ${where}`);
    seen.set(name, where);
  };
  for (const name of secrets) claim(name, 'secrets');
  for (const [name, value] of Object.entries(flags)) {
    claim(name, 'flags');
    if (!FLAG_VALUES.has(value))
      errors.push(`flags.${name}: value must be the string "true" or "false"`);
  }
  for (const [name, entry] of Object.entries(pending)) {
    claim(name, 'pending_flags');
    if (!entry || !FLAG_VALUES.has(entry.value)) {
      errors.push(`pending_flags.${name}: value must be the string "true" or "false"`);
    }
    for (const field of ['wave', 'needed_by', 'gate']) {
      if (!entry || typeof entry[field] !== 'string' || entry[field].trim() === '') {
        errors.push(`pending_flags.${name}: ${field} is required`);
      }
    }
  }
  for (const name of Object.keys(excluded)) {
    if (seen.has(name)) errors.push(`${name} is both excluded and in ${seen.get(name)}`);
  }
  return errors;
}

/** `NAME=value` lines for the APPLIED flags only (pending_flags never included). */
function flagAssignments(manifest) {
  return Object.entries(manifest.flags).map(([name, value]) => `${name}=${value}`);
}

function loadDesiredState(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

module.exports = { validateDesiredState, flagAssignments, loadDesiredState };

if (require.main === module) {
  const [cmd, manifestFile, validationFile] = process.argv.slice(2);
  if (!['validate', 'secrets', 'flags'].includes(cmd) || !manifestFile || !validationFile) {
    process.stderr.write(
      'usage: fly-env-desired-state.js validate|secrets|flags <manifest> <env-validation.ts>\n',
    );
    process.exit(2);
  }
  const manifest = loadDesiredState(manifestFile);
  const errors = validateDesiredState(
    manifest,
    extractRegisteredNames(fs.readFileSync(validationFile, 'utf8')),
  );
  if (errors.length) {
    for (const e of errors) process.stderr.write(`::error::desired-state: ${e}\n`);
    process.exit(1);
  }
  if (cmd === 'secrets') process.stdout.write(manifest.secrets.map((n) => `${n}\n`).join(''));
  else if (cmd === 'flags')
    process.stdout.write(
      flagAssignments(manifest)
        .map((l) => `${l}\n`)
        .join(''),
    );
  else {
    process.stdout.write(
      `desired-state OK: ${manifest.secrets.length} secrets, ${Object.keys(manifest.flags).length} flags, ` +
        `${Object.keys(manifest.pending_flags).length} pending flags (not applied)\n`,
    );
  }
}
