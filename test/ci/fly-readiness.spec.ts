import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// This is a literal configuration contract, not a TOML parser or deployed probe.
// Independent TOML parsing and real platform outage/recovery evidence are separate.
const configuration = readFileSync(join(__dirname, '../../fly.toml'), 'utf8');
const activeLines = configuration
  .split(/\r?\n/)
  .filter((line) => !line.trimStart().startsWith('#'))
  .map((line) => line.trim())
  .filter(Boolean);
const checkStart = activeLines.indexOf('[[http_service.checks]]');
const nextTable = activeLines.findIndex(
  (line, index) => index > checkStart && line.startsWith('['),
);
const checkLines =
  checkStart < 0 ? [] : activeLines.slice(checkStart + 1, nextTable < 0 ? undefined : nextTable);

describe('Fly readiness routing configuration', () => {
  it('installs exactly one service-level check rather than a monitoring-only check', () => {
    expect(activeLines.filter((line) => line === '[[http_service.checks]]')).toHaveLength(1);
    expect(activeLines).not.toContain('[checks]');
    expect(activeLines.some((line) => /^\[checks\./.test(line))).toBe(false);
  });

  it('uses a credential-free readiness request instead of database-independent liveness', () => {
    expect(checkLines).toEqual(
      expect.arrayContaining(['method = "GET"', 'path = "/readyz"', 'protocol = "http"']),
    );
    expect(checkLines.filter((line) => line.startsWith('path ='))).toEqual(['path = "/readyz"']);
    expect(checkLines.some((line) => /authorization|token|password/i.test(line))).toBe(false);
  });

  it('declares a startup grace, recurring interval and finite consumer timeout', () => {
    expect(checkLines).toHaveLength(6);
    expect(checkLines).toEqual(
      expect.arrayContaining(['grace_period = "30s"', 'interval = "15s"', 'timeout = "5s"']),
    );
  });

  it('keeps the private-network probe consistent with HTTPS proxy forwarding', () => {
    const headersStart = activeLines.indexOf('[http_service.checks.headers]');
    expect(headersStart).toBeGreaterThan(checkStart);
    expect(activeLines[headersStart + 1]).toBe('X-Forwarded-Proto = "https"');
    expect(activeLines.some((line) => /^tls_skip_verify\s*=/.test(line))).toBe(false);
    expect(activeLines).toContain('force_https = true');
  });

  it('retains the application port, process scope and minimum running instance', () => {
    expect(activeLines).toContain('internal_port = 3000');
    expect(activeLines).toContain("processes = ['app']");
    expect(activeLines).toContain('min_machines_running = 1');
  });
});
