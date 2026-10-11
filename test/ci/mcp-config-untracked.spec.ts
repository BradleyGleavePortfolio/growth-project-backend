// A local MCP client config carries bearer tokens, so it must never be in git.

import { execFileSync } from 'child_process';
import { join } from 'path';

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: join(__dirname, '..', '..'), encoding: 'utf8' }).trim();

describe('.mcp.json stays out of git', () => {
  it('is not tracked at any depth', () => {
    expect(git('ls-files', '--', ':(glob)**/.mcp.json')).toBe('');
  });

  it('is ignored by the repo .gitignore', () => {
    // check-ignore exits non-zero (so execFileSync throws) when the path is not ignored;
    // -v names the deciding file, so a developer's global ignore cannot pass this.
    expect(git('check-ignore', '-v', '--no-index', '.mcp.json')).toMatch(
      /^\.gitignore:\d+:\.mcp\.json\t\.mcp\.json$/,
    );
  });
});
