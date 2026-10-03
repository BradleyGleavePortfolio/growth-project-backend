#!/usr/bin/env node
// Dependency-audit gate (.github/workflows/dependency-audit.yml, job
// "npm audit (high+critical, whole graph)").
//
// WHY: npm audit has no per-advisory exception. A high advisory with NO
// patched release (GHSA-vfj7-8cjw-p6xm, braces <= 3.0.3, dev-only) made the
// fail-closed gate red on every PR. Operator ruling OR-114-2: keep the gate
// fail-closed and add the narrowest time-boxed, self-verifying exception.
//
// WHAT: evaluates the JSON of the SAME whole-graph audit (`npm audit
// --package-lock-only --include=prod --include=dev --include=optional
// --include=peer --audit-level=high --json`) against the committed lockfile
// and .github/audit-exceptions.json. It PASSES only when every high/critical
// vulnerability is fully explained by a valid exception. An exception applies
// only when ALL of these hold:
//   - the advisory URL is exactly https://github.com/advisories/<ghsa> and the
//     advisory names the excepted package;
//   - today (UTC) is strictly before `expires`, and `expires` is at most
//     MAX_EXCEPTION_DAYS ahead (no open-ended exceptions);
//   - EVERY lockfile copy of the package is dev-only (dev:true, never
//     devOptional, never a link), and every lockfile node the audit reports for
//     every covered vulnerability is dev-only;
//   - every locked copy's version is <= max_version;
//   - the registry has no stable release above max_version (a patch exists ->
//     FAIL "patched version available: upgrade and delete the exception");
//     an unreachable registry is reported loudly and treated as no patch.
// A vulnerability is covered only if EVERY advisory in its whole `via` chain
// is excepted. Moderate/low/info stay non-blocking (listed, never gated).
// The gate also fails closed on: an npm exit other than 0/1, unreadable or
// error JSON, metadata that disagrees with the vulnerability list, an npm exit
// that disagrees with the findings, a malformed exception file, and an
// exception that no longer matches anything (stale entries must be deleted).
//
// No dependencies beyond Node built-ins. No date/registry overrides exist: the
// clock is the runner's UTC clock and the registry is `npm view`.
//
// Usage: node scripts/ci/audit-gate.mjs --audit <audit.json> --audit-exit <n>
//          --lockfile <package-lock.json> --exceptions <audit-exceptions.json>
// Exit 0 = pass, 1 = blocked (every reason is printed with a stable code).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const MAX_EXCEPTION_DAYS = 31;
const ADVISORY_URL_PREFIX = 'https://github.com/advisories/';
const GHSA_RE = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;
const PACKAGE_RE = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const STABLE_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
const BLOCKING = new Set(['high', 'critical']);
const EXCEPTION_KEYS = ['expires', 'ghsa', 'max_version', 'owner_ruling', 'package', 'reason'];
const FILE_KEYS = ['exceptions', 'schema'];
const DAY_MS = 24 * 60 * 60 * 1000;
const REGISTRY_TIMEOUT_MS = 60000;

const failures = [];
const fail = (code, message) => {
  failures.push({ code, message });
};
const log = (line) => process.stdout.write(`${line}\n`);
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const parseSemver = (value) => {
  const match = typeof value === 'string' ? STABLE_SEMVER_RE.exec(value) : null;
  return match ? match.slice(1, 4).map(Number) : null;
};
const compareSemver = (a, b) => {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
};

function parseArgs(argv) {
  const wanted = new Set(['--audit', '--audit-exit', '--lockfile', '--exceptions']);
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!wanted.has(key) || value === undefined || key in args) {
      throw new Error(`unexpected or repeated argument: ${String(key)}`);
    }
    args[key] = value;
  }
  for (const key of wanted) if (!(key in args)) throw new Error(`missing argument: ${key}`);
  return args;
}

function readJson(path, code, label) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    fail(code, `${label} is unreadable at ${path}: ${error.message}`);
    return undefined;
  }
  if (text.trim() === '') {
    fail(code, `${label} at ${path} is empty`);
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(code, `${label} at ${path} is not valid JSON: ${error.message}`);
    return undefined;
  }
}

function todayUtc(now) {
  return now.toISOString().slice(0, 10);
}

function validDate(value) {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// Validates the exception file. Returns only entries that are well formed,
// unexpired and inside the horizon; every other entry is a recorded failure.
function loadExceptions(path, today) {
  const raw = readJson(path, 'E_EXCEPTIONS_MALFORMED', 'exception file');
  if (raw === undefined) return [];
  if (!isObject(raw) || JSON.stringify(Object.keys(raw).sort()) !== JSON.stringify(FILE_KEYS)) {
    fail(
      'E_EXCEPTIONS_MALFORMED',
      `exception file must have exactly the keys ${FILE_KEYS.join(', ')}`,
    );
    return [];
  }
  if (raw.schema !== 1) {
    fail(
      'E_EXCEPTIONS_MALFORMED',
      `exception file schema must be 1, got ${JSON.stringify(raw.schema)}`,
    );
    return [];
  }
  if (!Array.isArray(raw.exceptions)) {
    fail('E_EXCEPTIONS_MALFORMED', 'exception file "exceptions" must be an array');
    return [];
  }
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const seen = new Set();
  const valid = [];
  raw.exceptions.forEach((entry, index) => {
    const where = `exceptions[${index}]`;
    if (
      !isObject(entry) ||
      JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(EXCEPTION_KEYS)
    ) {
      fail(
        'E_EXCEPTIONS_MALFORMED',
        `${where} must have exactly the keys ${EXCEPTION_KEYS.join(', ')}`,
      );
      return;
    }
    const problems = [];
    if (typeof entry.ghsa !== 'string' || !GHSA_RE.test(entry.ghsa))
      problems.push('ghsa is not a GHSA id');
    if (typeof entry.package !== 'string' || !PACKAGE_RE.test(entry.package))
      problems.push('package is not an npm package name');
    if (!parseSemver(entry.max_version)) problems.push('max_version is not an x.y.z version');
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '')
      problems.push('reason is empty');
    if (typeof entry.owner_ruling !== 'string' || entry.owner_ruling.trim() === '')
      problems.push('owner_ruling is empty');
    if (!validDate(entry.expires)) problems.push('expires is not a YYYY-MM-DD calendar date');
    if (problems.length > 0) {
      fail('E_EXCEPTIONS_MALFORMED', `${where}: ${problems.join('; ')}`);
      return;
    }
    const key = `${entry.ghsa}|${entry.package}`;
    if (seen.has(key)) {
      fail(
        'E_EXCEPTIONS_MALFORMED',
        `${where}: duplicate exception for ${entry.ghsa} / ${entry.package}`,
      );
      return;
    }
    seen.add(key);
    const expiresMs = Date.parse(`${entry.expires}T00:00:00Z`);
    if (todayMs >= expiresMs) {
      fail(
        'E_EXCEPTION_EXPIRED',
        `${entry.ghsa} (${entry.package}) expired on ${entry.expires} (today UTC ${today}); fix the dependency or obtain a new owner ruling`,
      );
      return;
    }
    if (expiresMs - todayMs > MAX_EXCEPTION_DAYS * DAY_MS) {
      fail(
        'E_EXCEPTION_HORIZON',
        `${entry.ghsa} (${entry.package}) expires ${entry.expires}, more than ${MAX_EXCEPTION_DAYS} days after today UTC ${today}`,
      );
      return;
    }
    valid.push({ ...entry, daysLeft: Math.round((expiresMs - todayMs) / DAY_MS), used: false });
  });
  return valid;
}

function loadAudit(path, exitText) {
  const exit = /^\d+$/.test(exitText) ? Number(exitText) : NaN;
  if (exit !== 0 && exit !== 1) {
    fail(
      'E_AUDIT_EXIT',
      `npm audit exited ${exitText}: not an audit verdict (infrastructure failure, timeout or missing npm)`,
    );
    return undefined;
  }
  const audit = readJson(path, 'E_AUDIT_UNREADABLE', 'npm audit JSON');
  if (audit === undefined) return undefined;
  if (!isObject(audit) || 'error' in audit) {
    fail(
      'E_AUDIT_UNREADABLE',
      `npm audit reported an error instead of a report: ${JSON.stringify(audit).slice(0, 500)}`,
    );
    return undefined;
  }
  if (
    audit.auditReportVersion !== 2 ||
    !isObject(audit.vulnerabilities) ||
    !isObject(audit.metadata) ||
    !isObject(audit.metadata.vulnerabilities)
  ) {
    fail(
      'E_AUDIT_UNREADABLE',
      'npm audit JSON is not an auditReportVersion 2 report with vulnerabilities and metadata',
    );
    return undefined;
  }
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const [name, vuln] of Object.entries(audit.vulnerabilities)) {
    if (
      !isObject(vuln) ||
      vuln.name !== name ||
      !SEVERITIES.includes(vuln.severity) ||
      !Array.isArray(vuln.via) ||
      vuln.via.length === 0 ||
      !Array.isArray(vuln.nodes)
    ) {
      fail(
        'E_AUDIT_INCONSISTENT',
        `vulnerability entry "${name}" is not a well-formed npm audit v2 entry`,
      );
      return undefined;
    }
    counts[vuln.severity] += 1;
  }
  const meta = audit.metadata.vulnerabilities;
  const total = Object.keys(audit.vulnerabilities).length;
  const mismatched = SEVERITIES.filter((s) => meta[s] !== counts[s]);
  if (mismatched.length > 0 || meta.total !== total) {
    fail(
      'E_AUDIT_INCONSISTENT',
      `metadata counts ${JSON.stringify(meta)} disagree with the vulnerability list ${JSON.stringify({ ...counts, total })}`,
    );
    return undefined;
  }
  const blockingCount = counts.high + counts.critical;
  if ((exit === 0) !== (blockingCount === 0)) {
    fail(
      'E_AUDIT_INCONSISTENT',
      `npm audit exited ${exit} but the report lists ${blockingCount} high/critical vulnerabilities`,
    );
    return undefined;
  }
  return audit;
}

function loadLockfile(path) {
  const lock = readJson(path, 'E_LOCKFILE_UNREADABLE', 'lockfile');
  if (lock === undefined) return undefined;
  if (!isObject(lock) || ![2, 3].includes(lock.lockfileVersion) || !isObject(lock.packages)) {
    fail('E_LOCKFILE_UNREADABLE', 'lockfile must be lockfileVersion 2 or 3 with a "packages" map');
    return undefined;
  }
  return lock;
}

// A lockfile entry is dev-only when npm marks it dev:true and never
// devOptional (which means it is ALSO an optional prod dependency). Links can
// point anywhere, so they never qualify.
const devOnly = (entry) =>
  isObject(entry) && entry.dev === true && entry.devOptional !== true && entry.link !== true;
const packageOfPath = (path) => {
  const index = path.lastIndexOf('node_modules/');
  return index === -1 ? null : path.slice(index + 'node_modules/'.length);
};

function lockCopies(lock, pkg) {
  return Object.entries(lock.packages).filter(
    ([path, entry]) =>
      path !== '' && (packageOfPath(path) === pkg || (isObject(entry) && entry.name === pkg)),
  );
}

// Every advisory object reachable through `via` (strings name other entries).
function advisoryClosure(audit, name) {
  const advisories = [];
  const visited = new Set();
  const stack = [name];
  while (stack.length > 0) {
    const current = stack.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    const vuln = audit.vulnerabilities[current];
    if (!vuln) {
      fail(
        'E_AUDIT_INCONSISTENT',
        `"${name}" depends on "${current}", which the report does not list`,
      );
      return null;
    }
    for (const via of vuln.via) {
      if (typeof via === 'string') stack.push(via);
      else if (isObject(via)) advisories.push({ ...via, carrier: current });
      else {
        fail(
          'E_AUDIT_INCONSISTENT',
          `"${current}" has a via entry that is neither a name nor an advisory`,
        );
        return null;
      }
    }
  }
  return { advisories, members: [...visited] };
}

const matchesException = (advisory, exception) =>
  advisory.url === `${ADVISORY_URL_PREFIX}${exception.ghsa}` &&
  advisory.name === exception.package &&
  advisory.dependency === exception.package &&
  advisory.carrier === exception.package;

const describeAdvisory = (a) =>
  `${typeof a.url === 'string' ? a.url : `source ${String(a.source)}`} (${String(a.name)}, ${String(a.severity)})`;

function registryVersions(pkg) {
  try {
    const out = execFileSync('npm', ['view', pkg, 'versions', '--json'], {
      encoding: 'utf8',
      timeout: REGISTRY_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(out);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    if (list.length === 0 || !list.every((v) => typeof v === 'string'))
      throw new Error('unexpected npm view output');
    return list;
  } catch (error) {
    return { error: error.message.split('\n')[0] };
  }
}

function evaluate(args, now) {
  const today = todayUtc(now);
  log(`[audit-gate] today (UTC) ${today}; exception horizon ${MAX_EXCEPTION_DAYS} days`);
  const exceptions = loadExceptions(args['--exceptions'], today);
  const audit = loadAudit(args['--audit'], args['--audit-exit']);
  const lock = loadLockfile(args['--lockfile']);
  if (!audit || !lock) return;

  const vulns = Object.values(audit.vulnerabilities);
  for (const v of vulns.filter((x) => !BLOCKING.has(x.severity))) {
    log(`[audit-gate] non-blocking ${v.severity}: ${v.name} (${v.nodes.join(', ')})`);
  }
  const blocking = vulns.filter((x) => BLOCKING.has(x.severity));
  log(`[audit-gate] high/critical vulnerabilities in the whole graph: ${blocking.length}`);

  for (const vuln of blocking) {
    const closure = advisoryClosure(audit, vuln.name);
    if (!closure) continue;
    if (closure.advisories.length === 0) {
      fail(
        'E_AUDIT_INCONSISTENT',
        `${vuln.severity} "${vuln.name}" has no advisory anywhere in its via chain`,
      );
      continue;
    }
    for (const e of exceptions)
      if (closure.advisories.some((a) => matchesException(a, e))) e.used = true;
    const unexcepted = closure.advisories.filter(
      (a) => !exceptions.some((e) => matchesException(a, e)),
    );
    if (unexcepted.length > 0) {
      fail(
        'E_UNEXCEPTED',
        `${vuln.severity} "${vuln.name}" is not covered by an exception: ${unexcepted.map(describeAdvisory).join('; ')}`,
      );
      continue;
    }
    const prodNodes = closure.members
      .flatMap((member) => audit.vulnerabilities[member].nodes)
      .filter((node) => !devOnly(lock.packages[node]));
    if (prodNodes.length > 0) {
      fail(
        'E_PROD_COPY',
        `${vuln.severity} "${vuln.name}" reaches non-dev-only lockfile nodes: ${prodNodes.join(', ')}`,
      );
      continue;
    }
    log(
      `[audit-gate] covered: ${vuln.severity} "${vuln.name}" (chain: ${closure.members.join(' <- ')})`,
    );
  }

  for (const e of exceptions) {
    if (!e.used) {
      fail(
        'E_EXCEPTION_UNUSED',
        `${e.ghsa} (${e.package}) matches no high/critical finding; delete the stale exception`,
      );
      continue;
    }
    const copies = lockCopies(lock, e.package);
    if (copies.length === 0) {
      fail(
        'E_PROD_COPY',
        `${e.ghsa}: no lockfile copy of ${e.package} found; the exception cannot be verified`,
      );
      continue;
    }
    const prod = copies.filter(([, entry]) => !devOnly(entry)).map(([path]) => path);
    if (prod.length > 0) {
      fail(
        'E_PROD_COPY',
        `${e.ghsa}: ${e.package} has non-dev-only lockfile copies (${prod.join(', ')}); the exception does not apply`,
      );
      continue;
    }
    const max = parseSemver(e.max_version);
    const above = copies.filter(([, entry]) => {
      const version = parseSemver(entry.version);
      return !version || compareSemver(version, max) > 0;
    });
    if (above.length > 0) {
      fail(
        'E_VERSION_ABOVE_MAX',
        `${e.ghsa}: locked ${e.package} ${above.map(([p, x]) => `${p}@${String(x.version)}`).join(', ')} is not <= max_version ${e.max_version}`,
      );
      continue;
    }
    const locked = copies.map(([p, x]) => `${p}@${x.version}`).join(', ');
    log(
      `::warning title=Audit exception applied (${e.ghsa})::${e.package} ${locked} excepted until ${e.expires} (${e.daysLeft} days left). Ruling: ${e.owner_ruling}. Reason: ${e.reason}`,
    );
    log(
      `[audit-gate] APPLIED EXCEPTION advisory=${e.ghsa} package=${e.package} locked=${locked} max_version=${e.max_version} expires=${e.expires} days_left=${e.daysLeft}`,
    );
    log(`[audit-gate]   reason: ${e.reason}`);
    log(`[audit-gate]   owner_ruling: ${e.owner_ruling}`);

    const versions = registryVersions(e.package);
    if (!Array.isArray(versions)) {
      log(
        `::warning title=Registry unreachable (${e.package})::npm view ${e.package} versions failed (${versions.error}); treated as no patched release`,
      );
      log(
        `[audit-gate] registry check for ${e.package}: UNREACHABLE (${versions.error}); treated as no patched release`,
      );
      continue;
    }
    const patched = versions.filter((v) => {
      const parsed = parseSemver(v);
      return parsed && compareSemver(parsed, max) > 0;
    });
    if (patched.length > 0) {
      fail(
        'E_PATCH_AVAILABLE',
        `${e.ghsa}: patched version available: upgrade and delete the exception (${e.package} ${patched.join(', ')} > ${e.max_version})`,
      );
    } else {
      log(
        `[audit-gate] registry check for ${e.package}: no stable release above ${e.max_version} (latest ${versions[versions.length - 1]})`,
      );
    }
  }
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(
      'E_USAGE',
      `${error.message}; usage: audit-gate.mjs --audit <file> --audit-exit <n> --lockfile <file> --exceptions <file>`,
    );
  }
  if (args) evaluate(args, new Date());
  if (failures.length > 0) {
    for (const f of failures) {
      log(`::error title=npm audit gate (${f.code})::${f.message}`);
      log(`[audit-gate] FAIL ${f.code}: ${f.message}`);
    }
    log(`[audit-gate] BLOCKED: ${failures.length} problem(s)`);
    process.exitCode = 1;
    return;
  }
  log(
    '[audit-gate] PASS: every high/critical finding is explained by a valid, dev-only, time-boxed exception (or there are none)',
  );
}

main();
