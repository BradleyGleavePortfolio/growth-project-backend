// A local MCP client config carries bearer tokens, so it must never be in git.

import { execFileSync } from 'child_process';
import { join } from 'path';

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: join(__dirname, '..', '..'), encoding: 'utf8' }).trim();

describe('.mcp.json stays out of git', () => {
  it('is not tracked', () => {
    expect(git('ls-files', '--', '.mcp.json')).toBe('');
  });

  it('is ignored', () => {
    // check-ignore exits non-zero (so execFileSync throws) when the path is not ignored.
    expect(git('check-ignore', '--no-index', '.mcp.json')).toBe('.mcp.json');
  });
});
