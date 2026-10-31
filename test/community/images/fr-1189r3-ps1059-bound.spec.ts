import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { JFIF, SCAN, SOI } from './jpeg-fixtures';

/**
 * FR-1189R3 (LO-1189R3 C1): a Photoshop 1059 that is not a TIFF is skipped (FR-1189R2 N1), and each skip is charged to
 * the check's entry budget like a directory read, so a 10 MB file of them fails closed instead of being read for free.
 * Each shape runs in its own node process so one shape's garbage is not counted against the next.
 */
const compile = (name: string) =>
  transpileModule(readFileSync(join(__dirname, '../../../src/community/images', `${name}.ts`), 'utf8'), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  }).outputText;

const RESOURCE = '8BIM\\x04\\x23\\0\\0\\0\\0\\0\\x04ABCD'; // 1059, empty name, size 4, "ABCD": not a TIFF header
const SHAPES: Record<string, string> = {
  // 10 MB of 1059 resources after EOI (LO-1189R3 bench3 after_ps1059)
  'after EOI': `Buffer.concat([start, scan, rep('${RESOURCE}', max - start.length - scan.length)])`,
  // the same in APP13 Photoshop segments before SOS, read joined (LO-1189R3 bench3 app13_ps1059_joined)
  'in APP13 segments, joined': `(() => {
    const payload = Buffer.concat([Buffer.from('Photoshop 3.0\\0', 'latin1'), rep('${RESOURCE}', 65533 - 14)]);
    const segment = Buffer.concat([Buffer.from([0xff, 0xed, 0xff, 0xff]), payload]);
    const count = Math.floor((max - start.length - scan.length) / segment.length);
    return Buffer.concat([start, ...Array(count).fill(segment), scan]);
  })()`,
};

describe('FR-1189R3 (LO-1189R3 C1): Photoshop 1059 resources that are not TIFFs are charged', () => {
  it.each(Object.keys(SHAPES))('a 10 MB JPEG of 1059 resources %s fails closed, with no copy per resource', (shape) => {
    const script = `
      const metadata = { exports: {} };
      new Function('require', 'module', 'exports', ${JSON.stringify(compile('image-metadata'))})(require, metadata, metadata.exports);
      const location = { exports: {} };
      new Function('require', 'module', 'exports', ${JSON.stringify(compile('image-location'))})(
        (name) => name === './image-metadata' ? metadata.exports : require(name), location, location.exports
      );
      const rep = (unit, length) => { const u = Buffer.from(unit, 'latin1'); const b = Buffer.alloc(length);
        for (let i = 0; i + u.length <= length; i += u.length) u.copy(b, i); return b; };
      const max = 10 * 1024 * 1024;
      const start = Buffer.from(${JSON.stringify([...SOI, ...JFIF])});
      const scan = Buffer.from(${JSON.stringify(SCAN)});
      const photo = ${SHAPES[shape]};
      const subarray = Buffer.prototype.subarray;
      let views = 0;
      Buffer.prototype.subarray = function (...args) { views += 1; return subarray.apply(this, args); };
      global.gc();
      const before = process.memoryUsage();
      const begin = Date.now();
      const located = location.exports.carriesLocation(photo);
      const elapsed = Date.now() - begin;
      const after = process.memoryUsage();
      process.stdout.write(JSON.stringify({ bytes: photo.length, located, elapsed, views,
        heapGrowth: after.heapUsed - before.heapUsed, rssGrowth: after.rss - before.rss }));
    `;
    const child = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=512', '-e', script], {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    const sample = JSON.parse(child.stdout) as { bytes: number; located: boolean; views: number };
    console.log('FR1189R3_C1_PS1059', shape, JSON.stringify(sample));
    expect(sample.bytes).toBeGreaterThan(10 * 1024 * 1024 - 70_000);
    expect(sample.bytes).toBeLessThanOrEqual(10 * 1024 * 1024);
    // More than 200,000 resources: past the entry budget, so located (fail closed).
    expect(sample.located).toBe(true);
    // The work count: 5a992246 made one view per resource (over 600,000); the skip now compares in place.
    expect(sample.views).toBeLessThan(10_000);
  }, 30_000);
});
