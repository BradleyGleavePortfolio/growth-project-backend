import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { REAL_PHOTOS } from './real-photos';

describe('LS-1189R3 B1: bounded memory on an allowed-size upload', () => {
  it('does not allocate hundreds of MB to read a 10 MB JPEG containing UTF-32 text', () => {
    const compile = (name: string) => transpileModule(
      readFileSync(join(__dirname, '../../../src/community/images', `${name}.ts`), 'utf8'),
      { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } },
    ).outputText;
    const script = `
      const metadata = { exports: {} };
      new Function('require', 'module', 'exports', ${JSON.stringify(compile('image-metadata'))})(require, metadata, metadata.exports);
      const location = { exports: {} };
      new Function('require', 'module', 'exports', ${JSON.stringify(compile('image-location'))})(
        (name) => name === './image-metadata' ? metadata.exports : require(name), location, location.exports
      );
      const picture = Buffer.from(${JSON.stringify(REAL_PHOTOS[0][1].sent)}, 'base64');
      const max = 10 * 1024 * 1024;
      const text = Buffer.alloc(max - picture.length, Buffer.from([65, 0, 0, 0]));
      const photo = Buffer.concat([picture, text]);
      global.gc();
      const before = process.memoryUsage();
      const start = Date.now();
      const located = location.exports.carriesLocation(photo);
      const elapsed = Date.now() - start;
      const after = process.memoryUsage();
      process.stdout.write(JSON.stringify({ bytes:photo.length, located, elapsed,
        heapBefore:before.heapUsed, heapAfter:after.heapUsed,
        rssBefore:before.rss, rssAfter:after.rss,
        heapGrowth:after.heapUsed-before.heapUsed, rssGrowth:after.rss-before.rss }));
    `;
    const child = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=512', '-e', script], {
      encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    const sample = JSON.parse(child.stdout) as {
      bytes: number; located: boolean; elapsed: number;
      heapGrowth: number; rssGrowth: number;
    };
    console.log('LS1189R3_B1_MEMORY', JSON.stringify(sample));
    expect(sample.bytes).toBe(10 * 1024 * 1024);
    expect(sample.located).toBe(false);
    // This allows ten times the upload cap, above the two decoded views and
    // the input buffers, without accepting the observed >200 MB allocation.
    expect(Math.max(sample.heapGrowth, sample.rssGrowth)).toBeLessThan(100 * 1024 * 1024);
  }, 30_000);
});
