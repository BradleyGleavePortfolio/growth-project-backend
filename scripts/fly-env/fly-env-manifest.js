'use strict';
/*
 * scripts/fly-env/fly-env-manifest.js (B-FLAGS-2, T4)
 *
 * Loader, validator, planner and verifier for the production Fly desired
 * state in .github/fly-env-desired-state.json. Used by
 * .github/workflows/fly-env-sync.yml (plan -> apply -> verify) and by
 * test/ci/fly-env-manifest.spec.ts. Runbook: docs/runbooks/launch-flags.md.
 *
 * What it decides
 *   For every name the manifest manages it compares the declared state with
 *   (a) the structured `flyctl secrets list --json` listing (name + status
 *   only; the workflow's jq projection drops digests before this file sees
 *   anything) and (b) an optional in-machine check that says, per name,
 *   whether the value the running machine holds equals the declared value
 *   (match / differs / absent). It then plans the minimum change set:
 *     - set   a declared value that Fly lacks, or holds with a different or
 *             unprovable value;
 *     - unset a name declared "unset" that Fly lists in any status;
 *     - keep  everything else. A value that is deployed on every machine and
 *             matches in the machine is never re-set, so an apply that changes
 *             nothing restarts nothing.
 *   Fly's listing digest is a server-side HSM authenticator tag, not a hash a
 *   client can reproduce, so "unchanged" is proven inside the machine instead.
 *
 * VALUE SAFETY
 *   - Flag values are closed-choice literals from the checked-in manifest and
 *     are not secret; they may be printed.
 *   - GitHub-sourced secret values are read from the step env only to (1)
 *     check them for emptiness / shape (booleans out) and (2) compute
 *     sha256(salt || 0x00 || value) with a random 32-byte per-run salt. The
 *     salted hashes travel only inside the in-machine check command (a 0600
 *     scratch file handed to `flyctl ssh console -C`), never to stdout, a log
 *     line, the job summary or plan.json.
 *   - The in-machine program prints one marked JSON line of match / differs /
 *     absent words. No value, prefix, length or hash leaves the machine.
 *
 * Zero dependencies (Node built-ins only), CommonJS, so the workflow needs no
 * npm install and the in-machine program can ship inline.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const APP = 'backend-spring-lake-3890';
const UNSET = 'unset';
const SECRET_STATES = ['github-secret', 'present', UNSET];
const FLY_STATUSES = ['Deployed', 'Staged', 'Partial', 'Unknown'];
const TOP_LEVEL_KEYS = ['$comment', 'app', 'flags', 'secrets', 'gates', 'excluded'];
const ENTRY_SECTIONS = ['flags', 'secrets', 'gates', 'excluded'];
const COMPARE_ENV = 'FLY_ENV_COMPARE_B64';
const COMPARE_MARKER = 'FLY_ENV_COMPARE_JSON:';
const COMPARE_SCHEMA = 'fly-env-compare/v1';
const COMPARE_RESULTS = ['match', 'differs', 'absent', 'present'];

/** Community surface flags that do nothing unless FEATURE_COMMUNITY_API is on. */
const COMMUNITY_SUBFLAGS = [
  'FEATURE_COMMUNITY_POSTS',
  'FEATURE_COMMUNITY_MESSAGES',
  'FEATURE_COMMUNITY_PUSH',
  'FEATURE_COMMUNITY_REALTIME',
  'FEATURE_COMMUNITY_VOICE_NOTES',
  'FEATURE_COMMUNITY_DM',
  'FEATURE_COMMUNITY_ACKS',
  'FEATURE_COMMUNITY_PLAN_TAGS',
  'FEATURE_COMMUNITY_SEARCH',
  'FEATURE_COMMUNITY_TELEMETRY',
  'FEATURE_COMMUNITY_WEARABLE_PROMPTS',
  'FEATURE_COMMUNITY_AI_TRIAGE',
  'FEATURE_COMMUNITY_CHALLENGES',
  'FEATURE_COMMUNITY_EVENTS',
  'FEATURE_COMMUNITY_CLASSROOM_POSTS',
];

/**
 * Declared-state preconditions. Each returns null when satisfied, else a
 * specific message that says what is wrong and what to change. They run on
 * the manifest alone (no Fly access), so a bad flip fails `validate`, the PR's
 * jest run and the plan, before anything is written.
 */
const PRECONDITIONS = [
  {
    id: 'mwb-autosave-needs-lock-secret',
    names: ['FEATURE_MWB_AUTOSAVE_UNDO', 'MWB_AUTOSAVE_LOCK_TOKEN_SECRET'],
    check: (m) =>
      m.flags.FEATURE_MWB_AUTOSAVE_UNDO === 'true' &&
      !['github-secret', 'present'].includes(m.secrets.MWB_AUTOSAVE_LOCK_TOKEN_SECRET)
        ? 'FEATURE_MWB_AUTOSAVE_UNDO is declared "true" but MWB_AUTOSAVE_LOCK_TOKEN_SECRET is declared "unset", and the autosave service throws on every request without that secret. Fix: create the GitHub secret with \'openssl rand -hex 32 | gh secret set MWB_AUTOSAVE_LOCK_TOKEN_SECRET\' and declare secrets.MWB_AUTOSAVE_LOCK_TOKEN_SECRET "github-secret" in the same PR, or keep FEATURE_MWB_AUTOSAVE_UNDO "unset".'
        : null,
  },
  {
    id: 'community-subflag-needs-api',
    names: ['FEATURE_COMMUNITY_API', ...COMMUNITY_SUBFLAGS],
    check: (m) => {
      if (m.flags.FEATURE_COMMUNITY_API === 'true') return null;
      const on = COMMUNITY_SUBFLAGS.filter((n) => m.flags[n] === 'true');
      return on.length
        ? `${on.join(', ')} ${on.length === 1 ? 'is' : 'are'} declared "true" but FEATURE_COMMUNITY_API is not, and every community route stays 503 while the master switch is off. Fix: declare flags.FEATURE_COMMUNITY_API "true" in the same PR, or keep ${on.length === 1 ? 'that flag' : 'those flags'} "unset".`
        : null;
    },
  },
  {
    id: 'community-api-needs-schema',
    names: ['FEATURE_COMMUNITY_API', 'FEATURE_COMMUNITY_SCHEMA'],
    check: (m) =>
      m.flags.FEATURE_COMMUNITY_API === 'true' && m.flags.FEATURE_COMMUNITY_SCHEMA === 'false'
        ? 'FEATURE_COMMUNITY_API is declared "true" but FEATURE_COMMUNITY_SCHEMA is declared "false", which turns the community mounts back off. Fix: declare FEATURE_COMMUNITY_SCHEMA "true" or "unset" (unset = on).'
        : null,
  },
  {
    id: 'voice-entitlement-needs-voice',
    names: ['FEATURE_COMMUNITY_VOICE_NOTES', 'FEATURE_COMMUNITY_VOICE_NOTES_REQUIRE_ENTITLEMENT'],
    check: (m) =>
      m.flags.FEATURE_COMMUNITY_VOICE_NOTES_REQUIRE_ENTITLEMENT === 'true' &&
      m.flags.FEATURE_COMMUNITY_VOICE_NOTES !== 'true'
        ? 'FEATURE_COMMUNITY_VOICE_NOTES_REQUIRE_ENTITLEMENT is declared "true" but FEATURE_COMMUNITY_VOICE_NOTES is not, so the entitlement gate guards a feature that is off. Fix: declare FEATURE_COMMUNITY_VOICE_NOTES "true" in the same PR, or keep the entitlement flag "unset".'
        : null,
  },
];

/**
 * Shape checks for GitHub-sourced values, run on the runner. Each returns a
 * fixed reason code (never the value) or null. Names without an entry only
 * need a non-blank value.
 */
const SOURCE_SHAPES = {
  GOOGLE_CLIENT_IDS: (v) =>
    v.split(',').every((e) => e.trim().length > 0) ? null : 'empty-client-id-entry',
  MWB_AUTOSAVE_LOCK_TOKEN_SECRET: (v) =>
    /^[0-9a-fA-F]{64,}$/.test(v.trim()) ? null : 'not-64-plus-hex-characters',
};
const SOURCE_SHAPE_FIX = {
  'empty-client-id-entry':
    'it must be a comma list of Google OAuth client ids with no empty entry (for example ios-id.apps.googleusercontent.com,web-id.apps.googleusercontent.com)',
  'not-64-plus-hex-characters':
    "it must be at least 32 random bytes of hex (64+ characters); create it with 'openssl rand -hex 32 | gh secret set MWB_AUTOSAVE_LOCK_TOKEN_SECRET'",
};

class ManifestError extends Error {}

// ---------------------------------------------------------------------------
// ENV_RULES extraction (runner side; no TypeScript toolchain on the runner)
// ---------------------------------------------------------------------------

/**
 * Extract every ENV_RULES name and its closed `values` set from the
 * env-validation.ts source text. Strict: a `values:` line that is not the
 * one-line `values: ['a', 'b'],` shape, or that is not inside a rule with a
 * name, throws (fail closed) instead of being skipped. The jest spec proves
 * the result equals the imported ENV_RULES.
 */
function extractEnvRules(source) {
  const start = source.indexOf('export const ENV_RULES');
  if (start < 0) {
    throw new ManifestError(
      'ENV_RULES not found in src/common/env-validation.ts (looked for "export const ENV_RULES"), so the manifest cannot be checked against the registry. Fix: keep that declaration name, or update extractEnvRules in scripts/fly-env/fly-env-manifest.js and its spec.',
    );
  }
  const end = source.indexOf('\n];', start);
  if (end < 0) {
    throw new ManifestError(
      'The ENV_RULES array end was not found (a line that is exactly "];"), so the manifest cannot be checked against the registry. Fix: restore that closing line in src/common/env-validation.ts.',
    );
  }
  const rules = new Map();
  let current = null;
  const lines = source.slice(start, end).split('\n');
  for (const line of lines) {
    const name = /^\s{4}name:\s*'([A-Z][A-Z0-9_]*)',\s*$/.exec(line);
    if (name) {
      current = name[1];
      if (!rules.has(current)) rules.set(current, { values: null });
      continue;
    }
    if (/^\s{4}values\??\s*:/.test(line)) {
      const m = /^\s{4}values:\s*\[((?:'[^'\\]*'(?:,\s*'[^'\\]*')*)?)\],\s*$/.exec(line);
      if (!m || current === null) {
        throw new ManifestError(
          `An ENV_RULES values line could not be read (${current === null ? 'it is not inside a rule with a name line' : `rule ${current}`}). Fix: write it on one line as "values: ['a', 'b']," directly inside the rule, after its name line.`,
        );
      }
      const values = m[1] === '' ? [] : m[1].split(',').map((s) => s.trim().slice(1, -1));
      rules.get(current).values = values;
      continue;
    }
    if (/^\s{2}\},?\s*$/.test(line)) current = null;
  }
  return rules;
}

// ---------------------------------------------------------------------------
// Manifest parsing and validation (no Fly access)
// ---------------------------------------------------------------------------

/**
 * Parse the manifest text. Besides JSON.parse it enforces the one-entry-per-
 * line layout of each section (so every flip is a one-line diff and a
 * duplicated key, which JSON.parse would silently collapse, is an error).
 */
function parseManifestText(text) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (e) {
    throw new ManifestError(
      `The desired-state manifest is not valid JSON (${e && e.message ? e.message.replace(/[^\w .,:;()'-]/g, '') : 'parse error'}). Fix: run 'node -e "JSON.parse(require(\\"fs\\").readFileSync(\\".github/fly-env-desired-state.json\\",\\"utf8\\"))"' locally, fix the syntax, and push the PR again.`,
    );
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new ManifestError(
      'The desired-state manifest must be a JSON object. Fix: restore the file from main and re-apply your one-line change.',
    );
  }
  const keys = Object.keys(manifest);
  if (keys.join(',') !== TOP_LEVEL_KEYS.join(',')) {
    throw new ManifestError(
      `The desired-state manifest must have exactly these top-level keys in this order: ${TOP_LEVEL_KEYS.join(', ')} (found ${keys.join(', ') || 'none'}). Fix: restore the file layout from main and re-apply your change.`,
    );
  }
  const lines = text.split('\n');
  for (const section of ENTRY_SECTIONS) {
    const open = lines.findIndex((l) => l === `  "${section}": {`);
    if (open < 0) {
      throw new ManifestError(
        `The "${section}" section must open on its own line as two spaces, "${section}": { (one entry per line below it). Fix: restore the layout from main.`,
      );
    }
    const seen = new Set();
    let i = open + 1;
    for (; i < lines.length && !/^  \},?$/.test(lines[i]); i += 1) {
      const m = /^ {4}"([A-Z][A-Z0-9_]*)": "((?:[^"\\]|\\.)*)",?$/.exec(lines[i]);
      if (!m) {
        throw new ManifestError(
          `Line ${i + 1} of the manifest is not one "NAME": "value" entry on its own line inside "${section}". Fix: put exactly one entry per line, four spaces in, so each flip stays a one-line diff.`,
        );
      }
      if (seen.has(m[1])) {
        throw new ManifestError(
          `${m[1]} appears twice in "${section}" (line ${i + 1}); JSON keeps only the last one, which could hide a flip. Fix: keep exactly one line for ${m[1]}.`,
        );
      }
      seen.add(m[1]);
    }
    const obj = manifest[section];
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new ManifestError(
        `"${section}" must be an object of NAME: string entries. Fix: restore the layout from main.`,
      );
    }
    const parsed = Object.keys(obj);
    if (parsed.length !== seen.size || parsed.some((k) => !seen.has(k))) {
      throw new ManifestError(
        `The "${section}" section's lines do not match its parsed keys. Fix: put exactly one "NAME": "value" entry per line, four spaces in.`,
      );
    }
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v !== 'string') {
        throw new ManifestError(`${section}.${k} must be a string. Fix: quote the value.`);
      }
    }
  }
  return manifest;
}

/** Static validation against ENV_RULES. Returns a list of error messages (empty = OK). */
function validateManifest(manifest, rules) {
  const errors = [];
  if (manifest.app !== APP) {
    errors.push(
      `app must be "${APP}" (found ${JSON.stringify(manifest.app)}). Fix: this manifest only describes the production backend app.`,
    );
  }
  const owner = new Map();
  const claim = (name, where) => {
    if (!ENV_NAME_RE.test(name))
      errors.push(`${where}.${name} is not an env var name. Fix: use the exact ENV_RULES name.`);
    else if (!rules.has(name))
      errors.push(
        `${where}.${name} is not registered in src/common/env-validation.ts ENV_RULES. Fix: register it there first (with its values set for a flag), or fix the name.`,
      );
    if (owner.has(name))
      errors.push(
        `${name} appears in both ${owner.get(name)} and ${where}. Fix: keep it in exactly one section.`,
      );
    else owner.set(name, where);
  };
  for (const [name, value] of Object.entries(manifest.flags)) {
    claim(name, 'flags');
    const rule = rules.get(name);
    if (!rule) continue;
    if (!Array.isArray(rule.values) || rule.values.length === 0) {
      errors.push(
        `flags.${name} has no closed value set in ENV_RULES. Fix: add "values: [...]," to its rule in src/common/env-validation.ts (the exact strings its code reads), or move it out of flags.`,
      );
      continue;
    }
    if (rule.values.includes(UNSET))
      errors.push(
        `ENV_RULES values for ${name} include the reserved word "unset". Fix: remove it; "unset" means the name is absent on Fly.`,
      );
    if (value !== UNSET && !rule.values.includes(value)) {
      errors.push(
        `flags.${name} is "${value}", which its code does not read as a distinct value. Fix: use one of ${rule.values.map((v) => `"${v}"`).join(', ')} or "unset".`,
      );
    }
  }
  for (const [name, state] of Object.entries(manifest.secrets)) {
    claim(name, 'secrets');
    if (!SECRET_STATES.includes(state)) {
      errors.push(`secrets.${name} is "${state}". Fix: use "github-secret", "present" or "unset".`);
    }
    const rule = rules.get(name);
    if (rule && Array.isArray(rule.values)) {
      errors.push(
        `secrets.${name} has a closed value set in ENV_RULES, so it is a flag. Fix: move it to flags.`,
      );
    }
  }
  for (const [name, reason] of Object.entries(manifest.excluded)) {
    if (!rules.has(name))
      errors.push(
        `excluded.${name} is not registered in ENV_RULES. Fix: fix the name or drop the entry.`,
      );
    if (owner.has(name))
      errors.push(
        `${name} is both managed (${owner.get(name)}) and excluded. Fix: keep it in one place.`,
      );
    if (reason.trim() === '')
      errors.push(
        `excluded.${name} needs a reason. Fix: say why this manifest does not manage it.`,
      );
  }
  const managed = [...owner.keys()];
  for (const name of managed) {
    if (typeof manifest.gates[name] !== 'string' || manifest.gates[name].trim() === '') {
      errors.push(
        `gates.${name} is missing. Fix: add one line saying what must be true before ${name} changes.`,
      );
    }
  }
  for (const name of Object.keys(manifest.gates)) {
    if (!owner.has(name))
      errors.push(
        `gates.${name} has no flags or secrets entry. Fix: remove the gate or add the entry.`,
      );
  }
  for (const [name, rule] of rules) {
    if (Array.isArray(rule.values) && !(name in manifest.flags) && !(name in manifest.excluded)) {
      errors.push(
        `${name} has a closed value set in ENV_RULES but the manifest neither manages nor excludes it. Fix: add it to flags (as "unset" if it is off today) or to excluded with a reason.`,
      );
    }
  }
  if (errors.length === 0) {
    for (const p of PRECONDITIONS) {
      const msg = p.check(manifest);
      if (msg) errors.push(`precondition ${p.id}: ${msg}`);
    }
  }
  return errors;
}

function loadManifest(manifestFile, envValidationFile) {
  const text = fs.readFileSync(manifestFile, 'utf8');
  const manifest = parseManifestText(text);
  const rules = extractEnvRules(fs.readFileSync(envValidationFile, 'utf8'));
  const errors = validateManifest(manifest, rules);
  const digest = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  return { manifest, rules, errors, digest };
}

// ---------------------------------------------------------------------------
// Runtime inputs: GitHub-sourced values, Fly listing, in-machine check
// ---------------------------------------------------------------------------

/**
 * Classify every "github-secret" source from the step env. Returns
 * { NAME: 'ok' | 'empty' | '<shape reason code>' }. Never returns a value.
 */
function sourceChecks(manifest, env) {
  const out = {};
  for (const [name, state] of Object.entries(manifest.secrets)) {
    if (state !== 'github-secret') continue;
    const v = env[name];
    if (typeof v !== 'string' || v.trim() === '') out[name] = 'empty';
    else out[name] = (SOURCE_SHAPES[name] && SOURCE_SHAPES[name](v)) || 'ok';
  }
  return out;
}

/** Declared value for a managed name, or null when it is declared unset / present. */
function declaredValue(manifest, env, name) {
  if (name in manifest.flags) return manifest.flags[name] === UNSET ? null : manifest.flags[name];
  if (manifest.secrets[name] === 'github-secret')
    return typeof env[name] === 'string' ? env[name] : null;
  return null;
}

/**
 * Build the in-machine check input:
 *   expect    salted hash per name with a declared value (flags with a value,
 *             github-secret names whose source is ok) -> match | differs | absent
 *   presence  every other managed name (declared "unset" or "present")
 *             -> present | absent, so a staged unset that the running machine
 *             still has is visible, and a rollback is proven after deploy.
 */
function buildCompareInput(manifest, env, sources, salt) {
  const s = salt || crypto.randomBytes(32);
  const expect = {};
  const presence = [];
  const managed = [...Object.keys(manifest.flags), ...Object.keys(manifest.secrets)].sort();
  for (const name of managed) {
    const isSource = manifest.secrets[name] === 'github-secret';
    const v = isSource && sources[name] !== 'ok' ? null : declaredValue(manifest, env, name);
    if (v !== null) {
      expect[name] = crypto
        .createHash('sha256')
        .update(s)
        .update('\0')
        .update(v, 'utf8')
        .digest('hex');
    } else if (!isSource) {
      presence.push(name);
    }
  }
  return { salt: s.toString('hex'), expect, presence };
}

/** Every name the in-machine check reports on, in a stable order. */
function compareNames(input) {
  return [...Object.keys(input.expect), ...input.presence].sort();
}

/**
 * The program that runs INSIDE the Fly machine, as constant source text (not
 * Function#toString, so coverage instrumentation can never change what ships).
 * It reads the salted expected hashes from FLY_ENV_COMPARE_B64, hashes the
 * machine's value the same way and prints one marked line of match / differs /
 * absent per name. Nothing else is ever written to stdout.
 */
const REMOTE_PROGRAM = [
  '(function () {',
  "  var crypto = require('crypto');",
  "  var out = { schema: 'fly-env-compare/v1', results: {} };",
  '  var input = null;',
  '  try {',
  "    input = JSON.parse(Buffer.from(process.env.FLY_ENV_COMPARE_B64 || '', 'base64').toString('utf8'));",
  '  } catch (e) {',
  '    input = null;',
  '  }',
  "  if (!input || typeof input.salt !== 'string' || !/^[0-9a-f]{64}$/.test(input.salt) || !input.expect || typeof input.expect !== 'object') {",
  "    out.error = 'bad_input';",
  '  } else {',
  "    var salt = Buffer.from(input.salt, 'hex');",
  '    (Array.isArray(input.presence) ? input.presence : []).forEach(function (name) {',
  '      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return;',
  "      out.results[name] = typeof process.env[name] === 'string' ? 'present' : 'absent';",
  '    });',
  '    Object.keys(input.expect).forEach(function (name) {',
  '      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return;',
  '      var want = String(input.expect[name]);',
  '      if (!/^[0-9a-f]{64}$/.test(want)) return;',
  '      var v = process.env[name];',
  "      if (typeof v !== 'string') {",
  "        out.results[name] = 'absent';",
  '        return;',
  '      }',
  "      var got = crypto.createHash('sha256').update(salt).update('\\0').update(v, 'utf8').digest();",
  "      out.results[name] = crypto.timingSafeEqual(got, Buffer.from(want, 'hex')) ? 'match' : 'differs';",
  '    });',
  '  }',
  "  process.stdout.write('FLY_ENV_COMPARE_JSON:' + JSON.stringify(out) + '\\n');",
  '})();',
  '',
].join('\n');

/**
 * The `flyctl ssh console -C` command: `env FLY_ENV_COMPARE_B64=<b64> node -e
 * "eval(Buffer.from('<b64 program>','base64').toString('utf8'))"`. The program
 * text is constant; only the base64 input changes. Both payloads are base64,
 * so the command needs no shell escaping.
 */
function buildCompareCommand(input) {
  const prog = Buffer.from(REMOTE_PROGRAM, 'utf8').toString('base64');
  const payload = Buffer.from(JSON.stringify(input), 'utf8').toString('base64');
  if (!/^[A-Za-z0-9+/=]+$/.test(prog) || !/^[A-Za-z0-9+/=]+$/.test(payload)) {
    throw new ManifestError(
      'The in-machine check payload is not base64, so it is not safe to pass to flyctl ssh console -C. Fix: this is a bug in buildCompareCommand; run test/ci/fly-env-manifest.spec.ts.',
    );
  }
  return `env ${COMPARE_ENV}=${payload} node -e "eval(Buffer.from('${prog}','base64').toString('utf8'))"`;
}

/** Parse the in-machine check output. Strict: every expected name, known words only. */
function parseCompareOutput(text, expectedNames) {
  const line = String(text)
    .split(/\r?\n/)
    .find((l) => l.startsWith(COMPARE_MARKER));
  if (!line) {
    throw new ManifestError(
      `no line starting with ${COMPARE_MARKER} in the in-machine check output`,
    );
  }
  let report;
  try {
    report = JSON.parse(line.slice(COMPARE_MARKER.length));
  } catch (e) {
    throw new ManifestError('the in-machine check line is not JSON');
  }
  if (
    !report ||
    report.schema !== COMPARE_SCHEMA ||
    report.error ||
    !report.results ||
    typeof report.results !== 'object'
  ) {
    throw new ManifestError('the in-machine check reported bad input or a different schema');
  }
  const results = {};
  for (const name of expectedNames) {
    const r = report.results[name];
    if (!COMPARE_RESULTS.includes(r))
      throw new ManifestError(`the in-machine check has no result for ${name}`);
    results[name] = r;
  }
  return results;
}

/**
 * Parse the jq projection of `flyctl secrets list --json` (NAME<TAB>STATUS
 * lines). Returns Map name -> status (unrecognised statuses read as Unknown).
 */
function parseFlyState(tsv) {
  const state = new Map();
  for (const line of String(tsv).split('\n')) {
    if (line === '') continue;
    const [name, status] = line.split('\t');
    if (!name) continue;
    state.set(name, FLY_STATUSES.includes(status) ? status : 'Unknown');
  }
  return state;
}

// ---------------------------------------------------------------------------
// Plan and verify
// ---------------------------------------------------------------------------

/**
 * Plan the minimum change set.
 *   flyState  Map name -> Deployed | Staged | Partial | Unknown (absent = not in the map)
 *   machine   { results: { NAME: match | differs | absent | present } } from the
 *             in-machine check, or { unavailable: true, errorClass } when it failed
 *   sources   sourceChecks() output
 * Returns { rows, errors, setFlags: [[name, value]], setSecrets: [name], unset: [name], pending: [name] }.
 * `pending` = names whose Fly state is already right but the running machine
 * does not have it yet (staged earlier, not deployed); they need a deploy, not
 * another write.
 */
function planChanges(manifest, flyState, machine, sources) {
  const rows = [];
  const errors = [];
  const setFlags = [];
  const setSecrets = [];
  const unset = [];
  const pending = [];
  const results = machine && !machine.unavailable && machine.results ? machine.results : null;
  const entries = [
    ...Object.entries(manifest.flags).map(([n, v]) => ({ name: n, kind: 'flag', declared: v })),
    ...Object.entries(manifest.secrets).map(([n, v]) => ({ name: n, kind: 'secret', declared: v })),
  ];
  for (const e of entries) {
    const fly = flyState.has(e.name) ? flyState.get(e.name) : 'absent';
    const inMachine =
      results && results[e.name] ? results[e.name] : results ? 'not checked' : 'unavailable';
    let action = 'keep';
    let reason;
    if (e.declared === UNSET) {
      if (fly !== 'absent') {
        action = 'unset';
        reason = `declared unset; Fly lists it (${fly})`;
      } else if (inMachine === 'present') {
        pending.push(e.name);
        reason = 'unset is staged on Fly; the running machine still has it until the next deploy';
      } else reason = 'absent, as declared';
    } else if (e.declared === 'present') {
      if (fly === 'absent') {
        errors.push(
          `${e.name} is declared "present" (its value is owned outside this manifest) but Fly does not list it. Fix: set it with the workflow that owns it, or declare it "unset" in a PR if it is no longer needed.`,
        );
        action = 'error';
        reason = 'declared present; Fly does not list it';
      } else if (fly !== 'Deployed' || inMachine === 'absent') {
        pending.push(e.name);
        reason = `present on Fly (${fly}) but not yet in the running machine; needs a deploy`;
      } else reason = 'present and deployed; value owned outside this manifest';
    } else {
      const src = e.kind === 'secret' ? sources[e.name] : 'ok';
      if (src === 'empty') {
        errors.push(
          `${e.name} is declared "github-secret" but the GitHub Actions secret ${e.name} is empty or not set for this workflow. Fix: create it with 'gh secret set ${e.name}', or declare it "unset" again in a PR.`,
        );
        action = 'error';
        reason = 'GitHub secret empty or not set';
      } else if (src !== 'ok') {
        errors.push(
          `${e.name} is declared "github-secret" but the GitHub secret fails its shape check (${src}): ${SOURCE_SHAPE_FIX[src] || 'it must be a non-blank value'}. Fix: update it with 'gh secret set ${e.name}', then re-run.`,
        );
        action = 'error';
        reason = `GitHub secret shape check failed (${src})`;
      } else if (fly === 'absent') {
        action = 'set';
        reason = 'not on Fly';
      } else if (fly !== 'Deployed') {
        action = 'set';
        reason = `${fly} on Fly: a staged value cannot be read back, so the declared value is staged again (no restart)`;
      } else if (!results) {
        action = 'set';
        reason =
          'deployed, but the in-machine check did not run, so the value is unproven; staged again (no restart)';
      } else if (inMachine === 'match') {
        reason = 'deployed and the machine holds the declared value';
      } else {
        action = 'set';
        reason = `deployed, but the machine value ${inMachine === 'absent' ? 'is missing' : inMachine === 'differs' ? 'differs' : 'was not checked'}`;
      }
      if (action === 'set') {
        if (e.kind === 'flag') setFlags.push([e.name, e.declared]);
        else setSecrets.push(e.name);
      }
    }
    if (action === 'unset') unset.push(e.name);
    rows.push({
      name: e.name,
      kind: e.kind,
      declared: e.declared,
      fly,
      machine: inMachine,
      action,
      reason,
    });
  }
  // `flyctl secrets deploy` applies EVERY staged secret on the app, including
  // ones staged by other workflows, so the plan names them (malformed names
  // are counted, never shown: they can be fragments of a value).
  const managed = new Set(entries.map((e) => e.name));
  const otherStaged = [];
  let otherStagedMalformed = 0;
  for (const [name, status] of flyState) {
    if (managed.has(name) || status === 'Deployed') continue;
    if (ENV_NAME_RE.test(name)) otherStaged.push(name);
    else otherStagedMalformed += 1;
  }
  otherStaged.sort();
  return { rows, errors, setFlags, setSecrets, unset, pending, otherStaged, otherStagedMalformed };
}

/**
 * Verify Fly against the manifest after staging (phase "staged") or after
 * `flyctl secrets deploy` (phase "deployed"). Presence and absence are exact
 * for every managed name. In the deployed phase every name declared with a
 * value must be Deployed and, when the in-machine check ran, the machine must
 * hold the declared value (match) and must not hold any declared-unset name.
 * Returns { errors, warnings, lines, pending } (pending = declared-present
 * names not yet Deployed).
 */
function verifyState(manifest, flyState, phase, machine) {
  const errors = [];
  const warnings = [];
  const lines = [];
  const all = [
    ...Object.entries(manifest.flags).map(([n, v]) => [n, v === UNSET ? 'absent' : 'present']),
    ...Object.entries(manifest.secrets).map(([n, v]) => [n, v === UNSET ? 'absent' : 'present']),
  ];
  const missing = [];
  const extra = [];
  const notDeployed = [];
  for (const [name, want] of all) {
    const fly = flyState.has(name) ? flyState.get(name) : 'absent';
    if (want === 'absent' && fly !== 'absent') extra.push(name);
    if (want === 'present' && fly === 'absent') missing.push(name);
    if (want === 'present' && fly !== 'absent' && fly !== 'Deployed') notDeployed.push(name);
    lines.push(`${name}: declared ${want}; Fly ${fly}`);
  }
  if (missing.length) {
    errors.push(
      `These names are declared with a value but Fly does not list them: ${missing.join(' ')}. Fix: re-run this workflow in apply mode (staging the same values again is safe); if they stay missing, run 'fly secrets list -a ${APP}' from a trusted terminal and read the stage step log above.`,
    );
  }
  if (extra.length) {
    errors.push(
      `These names are declared "unset" but Fly still lists them: ${extra.join(' ')}. Fix: re-run this workflow in apply mode; if they stay listed, run 'fly secrets unset --stage -a ${APP} <name>' from a trusted terminal, then re-run in plan mode.`,
    );
  }
  if (phase === 'deployed') {
    if (notDeployed.length) {
      warnings.push(
        `flyctl secrets deploy succeeded, but Fly does not report these names as Deployed yet: ${notDeployed.join(' ')}. Fix: run 'fly status -a ${APP}' to check that the rolling restart finished, then re-run this workflow in plan mode; if they still show Staged, re-run in apply mode with deploy_staged=true.`,
      );
    }
    if (machine && machine.unavailable) {
      warnings.push(
        `The in-machine check after deploy did not run (error class ${machine.errorClass || 'unclassified'}), so the running values are proven by the Fly listing only. Fix: re-run this workflow in plan mode once 'fly ssh console -a ${APP}' works; every row should read keep.`,
      );
    } else if (machine && machine.results) {
      const wrong = [];
      for (const [name, want] of all) {
        const r = machine.results[name];
        if (r === undefined) continue;
        if (want === 'absent' ? r !== 'absent' : r !== 'match' && r !== 'present')
          wrong.push(`${name} (${r})`);
      }
      if (wrong.length) {
        errors.push(
          `After flyctl secrets deploy the running machine does not match the manifest for: ${wrong.join(' ')}. Fix: run 'fly status -a ${APP}' and wait for the rolling restart to finish, then re-run this workflow in plan mode; if it still differs, re-run in apply mode with deploy_staged=true.`,
        );
      }
    }
  }
  return { errors, warnings, lines, pending: phase === 'staged' ? notDeployed : [] };
}

function renderPlan(plan, digest, machine) {
  const out = [];
  const m = machine.unavailable
    ? `unavailable (error class ${machine.errorClass || 'unclassified'}); deployed values are unproven`
    : 'ran (per name: match / differs / absent for declared values, present / absent otherwise)';
  out.push(`Desired state: .github/fly-env-desired-state.json sha256 ${digest}`);
  out.push(`In-machine value check: ${m}`);
  out.push('NAME | kind | declared | on Fly | in machine | action | why');
  for (const r of plan.rows) {
    out.push(
      `${r.name} | ${r.kind} | ${r.declared} | ${r.fly} | ${r.machine} | ${r.action} | ${r.reason}`,
    );
  }
  const changes = plan.setFlags.length + plan.setSecrets.length + plan.unset.length;
  out.push(
    `Plan: ${plan.setFlags.length + plan.setSecrets.length} to set, ${plan.unset.length} to unset, ${plan.pending.length} staged earlier and waiting for a deploy, ${plan.rows.filter((r) => r.action === 'keep').length} unchanged.`,
  );
  if (plan.otherStaged.length || plan.otherStagedMalformed) {
    out.push(
      `Not managed here but staged on Fly (deploy_staged=true would apply these too): ${plan.otherStaged.join(' ') || 'none'}${plan.otherStagedMalformed ? ` plus ${plan.otherStagedMalformed} malformed name(s), not shown` : ''}.`,
    );
  }
  out.push(
    changes === 0 && plan.pending.length === 0
      ? 'Fly already matches the manifest: apply would write nothing and restart nothing.'
      : `Apply stages ${changes} change(s) without a restart; they take effect at the next deploy, or now with deploy_staged=true (one rolling restart).`,
  );
  return out;
}

// ---------------------------------------------------------------------------
// CLI (runner side). Scratch files live in a 0700 directory under RUNNER_TEMP;
// the workflow runs every subcommand from inside it.
// ---------------------------------------------------------------------------

function fail(msg) {
  process.stderr.write(`::error::${msg}\n`);
  process.exit(1);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeLines(file, items) {
  fs.writeFileSync(file, items.map((i) => `${i}\n`).join(''), { mode: 0o600 });
}

const SUBCOMMANDS = ['validate', 'prepare', 'parse-compare', 'plan', 'verify'];

function main(argv) {
  const [cmd, manifestFile, envValidationFile, dir, extra] = argv;
  if (!SUBCOMMANDS.includes(cmd) || !manifestFile || !envValidationFile) {
    fail(
      `usage: fly-env-manifest.js ${SUBCOMMANDS.join('|')} <manifest.json> <env-validation.ts> [<scratch dir> [before|after|staged|deployed]]. Fix: call it the way .github/workflows/fly-env-sync.yml does.`,
    );
  }
  let loaded;
  try {
    loaded = loadManifest(manifestFile, envValidationFile);
  } catch (e) {
    fail(`desired-state manifest: ${e.message}`);
  }
  const { manifest, errors, digest } = loaded;
  if (errors.length) {
    for (const e of errors) process.stderr.write(`::error::desired-state manifest: ${e}\n`);
    process.exit(1);
  }
  if (cmd === 'validate') {
    const declared = Object.values(manifest.flags).filter((v) => v !== UNSET).length;
    process.stdout.write(
      `Desired state OK: ${Object.keys(manifest.flags).length} flags (${declared} declared with a value), ${Object.keys(manifest.secrets).length} secrets, ${Object.keys(manifest.excluded).length} excluded; manifest sha256 ${digest}\n`,
    );
    return;
  }
  if (!dir || !fs.existsSync(dir)) {
    fail(
      'the scratch directory is missing. Fix: run the steps of .github/workflows/fly-env-sync.yml in order.',
    );
  }
  const f = (name) => path.join(dir, name);
  if (cmd === 'prepare') {
    const sources = sourceChecks(manifest, process.env);
    fs.writeFileSync(f('sources.json'), `${JSON.stringify(sources)}\n`, { mode: 0o600 });
    const input = buildCompareInput(manifest, process.env, sources);
    fs.writeFileSync(f('compare.cmd'), buildCompareCommand(input), { mode: 0o600 });
    fs.writeFileSync(f('compare-names.json'), `${JSON.stringify(compareNames(input))}\n`, {
      mode: 0o600,
    });
    process.stdout.write(
      `In-machine check prepared: ${Object.keys(input.expect).length} declared value(s) to compare, ${input.presence.length} name(s) to check for presence.\n`,
    );
    return;
  }
  if (cmd === 'parse-compare') {
    const out = f(extra === 'after' ? 'machine-after.json' : 'machine.json');
    try {
      const results = parseCompareOutput(
        fs.readFileSync(f('ssh-stdout.txt'), 'utf8'),
        readJson(f('compare-names.json')),
      );
      fs.writeFileSync(out, `${JSON.stringify({ results })}\n`, { mode: 0o600 });
    } catch (e) {
      fs.writeFileSync(
        out,
        `${JSON.stringify({ unavailable: true, errorClass: 'bad_output' })}\n`,
        { mode: 0o600 },
      );
      process.stdout.write(
        `::warning::The in-machine check returned no usable result (${e.message}), so deployed values are unproven. Fix: check that a machine is started ('fly status -a ${APP}') and that the image has node ('fly ssh console -a ${APP} -C "node --version"'), then re-run in plan mode.\n`,
      );
    }
    return;
  }
  if (cmd === 'plan') {
    const sources = readJson(f('sources.json'));
    const machine = fs.existsSync(f('machine.json'))
      ? readJson(f('machine.json'))
      : { unavailable: true, errorClass: 'not_run' };
    const plan = planChanges(
      manifest,
      parseFlyState(fs.readFileSync(f('fly-state.tsv'), 'utf8')),
      machine,
      sources,
    );
    const lines = renderPlan(plan, digest, machine);
    process.stdout.write(`${lines.join('\n')}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        ['## Fly env sync plan', '', '```text', ...lines, '```', ''].join('\n'),
      );
    }
    if (plan.errors.length) {
      for (const e of plan.errors) process.stderr.write(`::error::${e}\n`);
      process.exit(1);
    }
    writeLines(
      f('set-flags.txt'),
      plan.setFlags.map(([n, v]) => `${n}=${v}`),
    );
    writeLines(f('set-secrets.txt'), plan.setSecrets);
    writeLines(f('unset.txt'), plan.unset);
    writeLines(f('pending.txt'), plan.pending);
    return;
  }
  // verify
  const phase = extra === 'deployed' ? 'deployed' : 'staged';
  const flyState = parseFlyState(
    fs.readFileSync(
      f(phase === 'deployed' ? 'fly-state-deployed.tsv' : 'fly-state-staged.tsv'),
      'utf8',
    ),
  );
  const machineAfter =
    phase === 'deployed' && fs.existsSync(f('machine-after.json'))
      ? readJson(f('machine-after.json'))
      : null;
  const v = verifyState(manifest, flyState, phase, machineAfter);
  process.stdout.write(`${v.lines.join('\n')}\n`);
  for (const w of v.warnings) process.stdout.write(`::warning::${w}\n`);
  if (v.errors.length) {
    for (const e of v.errors) process.stderr.write(`::error::${e}\n`);
    process.exit(1);
  }
  if (phase === 'staged') {
    const prior = fs.existsSync(f('pending.txt'))
      ? fs.readFileSync(f('pending.txt'), 'utf8').split('\n').filter(Boolean)
      : [];
    writeLines(f('pending.txt'), [...new Set([...prior, ...v.pending])].sort());
    process.stdout.write(
      'Verified: every managed name is present or absent on Fly exactly as declared. Staged values take effect at the next deploy, or now with deploy_staged=true.\n',
    );
  } else {
    process.stdout.write(
      'Verified after deploy: every managed name is present or absent exactly as declared, and the running machine matches.\n',
    );
  }
}

module.exports = {
  APP,
  UNSET,
  ENV_NAME_RE,
  SECRET_STATES,
  COMMUNITY_SUBFLAGS,
  PRECONDITIONS,
  SOURCE_SHAPES,
  COMPARE_ENV,
  COMPARE_MARKER,
  COMPARE_SCHEMA,
  ManifestError,
  extractEnvRules,
  parseManifestText,
  validateManifest,
  loadManifest,
  sourceChecks,
  buildCompareInput,
  compareNames,
  REMOTE_PROGRAM,
  buildCompareCommand,
  parseCompareOutput,
  parseFlyState,
  planChanges,
  verifyState,
  renderPlan,
  main,
};

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    // Messages from this file never contain a value (see VALUE SAFETY above).
    fail(
      `fly-env-manifest: ${e && e.message ? e.message : 'unexpected error'}. Fix: re-run; if it repeats, run test/ci/fly-env-manifest.spec.ts against this commit.`,
    );
  }
}
