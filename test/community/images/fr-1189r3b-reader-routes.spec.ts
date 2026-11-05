import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { JFIF, SCAN, SOI, tiff } from './jpeg-fixtures';

/**
 * FR-1189R3B (LS-1189R3 B1, the whole class): every route into the shared text reader (LS-1189R3's route table), each
 * with a 10 MB location-free JPEG of UTF-32 text, the shape that made 5a992246 decode a copy per read. Each shape runs
 * in its own node process, so one shape's garbage is not counted against the next. Each must post (no location) with
 * no decoded copy: 5a992246 grew the heap 8 to 366 MB on these; the reader now matches the names in the bytes.
 */
const compile = (name: string) =>
  transpileModule(readFileSync(join(__dirname, '../../../src/community/images', `${name}.ts`), 'utf8'), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  }).outputText;

const ROUTES: Record<string, string> = {
  'EXIF APP1 (159 segments), the bytes after its TIFF header': `jpg(many(0xe1, (n) => cat(latin1('Exif\\0\\0'), TIFF, text(n - 6 - TIFF.length))))`,
  'a Parrot APP1, the bytes after its TIFF': `jpg(many(0xe1, (n) => cat(latin1('PARROT\\0'), TIFF, text(n - 7 - TIFF.length))))`,
  'an XMP APP1': `jpg(many(0xe1, (n) => cat(latin1('http://ns.adobe.com/xap/1.0/\\0'), text(n - 29))))`,
  'another APPn (APP2)': `jpg(many(0xe2, (n) => text(n)))`,
  'a GoPro APP6': `jpg(many(0xe6, (n) => cat(latin1('GoPro\\0'), text(n - 6))))`,
  'FLIR chunks, each alone and joined': `(() => {
    const fff = Buffer.alloc(160 * 65000); fff.write('FFF\\0', 0, 'latin1'); fff.writeUInt32BE(100, 0x14);
    fff.writeUInt32BE(0x40, 0x18); fff.writeUInt32BE(1, 0x1c); fff.writeUInt16BE(0x0e, 0x40);
    fff.writeUInt32BE(0x60, 0x4c); fff.writeUInt32BE(fff.length - 0x60, 0x50); text(fff.length - 0x60).copy(fff, 0x60);
    return jpg(Array.from({ length: 160 }, (_, k) =>
      seg(0xe1, cat(latin1('FLIR\\0'), Buffer.from([1, k, 159]), fff.subarray(k * 65000, (k + 1) * 65000)))));
  })()`,
  'Photoshop APP13 segments, joined': `jpg(many(0xed, (n) => cat(latin1('Photoshop 3.0\\0'), text(n - 14))))`,
  'one JUMBF box in 160 APP11 segments, joined': `jpg(Array.from({ length: 160 }, (_, k) =>
    seg(0xeb, cat(latin1('JP\\0\\x01'), be32(k + 1), be32(8 + 160 * 65000), latin1('jumb'), text(65000)))))`,
  'JUMBF segments that repeat a sequence number, each alone': `jpg(Array.from({ length: 160 }, () =>
    seg(0xeb, cat(latin1('JP\\0\\x01'), be32(1), be32(8 + 65000), latin1('jumb'), text(65000)))))`,
  'the bytes after EOI, near-names (lrftargetl...) in UTF-32': `cat(start, scan, text(max - start.length - scan.length, near))`,
};

describe('FR-1189R3B (LS-1189R3 B1): every route into the text reader reads 10 MB of UTF-32 text with no decoded copy', () => {
  it.each(Object.keys(ROUTES))('%s: posts, the heap grows under 4 MB and RSS under 64 MB', (route) => {
    const script = `
      const metadata = { exports: {} };
      new Function('require', 'module', 'exports', ${JSON.stringify(compile('image-metadata'))})(require, metadata, metadata.exports);
      const location = { exports: {} };
      new Function('require', 'module', 'exports', ${JSON.stringify(compile('image-location'))})(
        (name) => name === './image-metadata' ? metadata.exports : require(name), location, location.exports
      );
      const latin1 = (s) => Buffer.from(s, 'latin1');
      const cat = (...parts) => Buffer.concat(parts);
      const be32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
      const seg = (marker, payload) => cat(Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload);
      const near = [...'lrftargetlx'].map((c) => c + '\\0\\0\\0').join('');
      const text = (length, unit = 'A\\0\\0\\0') => { const u = latin1(unit); const b = Buffer.alloc(length);
        for (let i = 0; i < length; i += u.length) u.copy(b, i, 0, Math.min(u.length, length - i)); return b; };
      const max = 10 * 1024 * 1024;
      const start = Buffer.from(${JSON.stringify([...SOI, ...JFIF])});
      const scan = Buffer.from(${JSON.stringify(SCAN)});
      const TIFF = Buffer.from(${JSON.stringify(tiff('II'))});
      const many = (marker, payload) => Array.from({ length: 159 }, () => seg(marker, payload(65533)));
      const jpg = (segments) => cat(start, ...segments, scan);
      const photo = ${ROUTES[route]};
      global.gc();
      const before = process.memoryUsage();
      const begin = Date.now();
      const located = location.exports.carriesLocation(photo);
      const elapsed = Date.now() - begin;
      const after = process.memoryUsage();
      process.stdout.write(JSON.stringify({ bytes: photo.length, located, elapsed,
        heapGrowth: after.heapUsed - before.heapUsed, rssGrowth: after.rss - before.rss }));
    `;
    const child = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=512', '-e', script], {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    const sample = JSON.parse(child.stdout) as { bytes: number; located: boolean; heapGrowth: number; rssGrowth: number };
    console.log('FR1189R3B_ROUTE', route, JSON.stringify(sample));
    expect(sample.bytes).toBeGreaterThan(10 * 1024 * 1024 - 200_000);
    expect(sample.bytes).toBeLessThanOrEqual(10 * 1024 * 1024);
    expect(sample.located).toBe(false);
    expect(sample.heapGrowth).toBeLessThan(4 * 1024 * 1024);
    expect(sample.rssGrowth).toBeLessThan(64 * 1024 * 1024);
  }, 30_000);
});
