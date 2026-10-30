/**
 * LO-1189 B-TESTs (Opus lens on b#1189 @ dadf8d2f). Each test fails at that head.
 * Photos are built byte by byte here; carriesLocation is src/community/images/image-location.ts.
 */
import { carriesLocation } from '../../../src/community/images/image-location';

const seg = (marker: number, payload: Buffer): Buffer => {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
};
const SOI = Buffer.from([0xff, 0xd8]);
const SCAN = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x00, 0x12, 0x34, 0xff, 0xd9]);
const jpeg = (...segments: Buffer[]): Buffer => Buffer.concat([SOI, ...segments, SCAN]);

/** n EXIF headers ("Exif\0\0II*\0" + IFD0 offset), all pointing at one shared IFD0 of 65535 entries, none GPSInfo. */
const sharedIfdHeaders = (n: number): Buffer => {
  const headers = Buffer.alloc(n * 14);
  for (let k = 0; k < n; k += 1) {
    headers.write('Exif\0\0II*\0', k * 14, 'latin1');
    headers.writeUInt32LE(n * 14 - (k * 14 + 6), k * 14 + 10);
  }
  const ifd = Buffer.alloc(2 + 65535 * 12 + 4);
  ifd.writeUInt16LE(65535, 0);
  for (let e = 0; e < 65535; e += 1) ifd.writeUInt16LE(0x0100, 2 + e * 12); // ImageWidth, not GPSInfo
  return Buffer.concat([headers, ifd]);
};
/** An FFF block (version 100, little endian, empty directory) around `body`, cut into "FLIR\0" APP1 chunks. */
const flirChunks = (body: Buffer): Buffer[] => {
  const header = Buffer.alloc(0x40);
  header.write('FFF\0', 0, 'latin1');
  header.writeUInt32LE(100, 0x14);
  header.writeUInt32LE(0x40, 0x18);
  const fff = Buffer.concat([header, body]);
  const per = 65000;
  const count = Math.ceil(fff.length / per);
  return Array.from({ length: count }, (_, k) =>
    seg(0xe1, Buffer.concat([Buffer.from('FLIR\0', 'latin1'), Buffer.from([1, k, count - 1]), fff.subarray(k * per, (k + 1) * per)])),
  );
};
const timed = (photo: Buffer): number => {
  const t = Date.now();
  carriesLocation(photo);
  return Date.now() - t;
};

describe('LO-1189 B-TESTs', () => {
  // OWN-PR B1 (exifInBytesLocated, image-location.ts:181-188, from b#1187; b#1189's flirLocated adds the FLIR door).
  it('LO-1189 B1: many EXIF headers sharing one large IFD (after EOI or in FLIR chunks) are read in bounded time', () => {
    const tail = sharedIfdHeaders(60000); // about 1.6 MB; a 10 MB upload holds about 11 times as many
    expect(timed(Buffer.concat([jpeg(), tail]))).toBeLessThan(1000);
    expect(timed(jpeg(...flirChunks(tail)))).toBeLessThan(1000);
  });

  // OWN-PR B2 (b#1187 regression class): refused at 436cf4bc (a header past 256 KB), posted at main and at b#1189.
  it('LO-1189 B2: a position 436cf4bc refused behind a header past 256 KB is still a location', () => {
    const pad = Array.from({ length: 5 }, () => seg(0xe2, Buffer.concat([Buffer.from('ICC_PROFILE\0\x01\x05', 'latin1'), Buffer.alloc(65000)])));
    const tiffGps = Buffer.alloc(40);
    tiffGps.write('II*\0', 0, 'latin1');
    tiffGps.writeUInt32LE(8, 4);
    tiffGps.writeUInt16LE(1, 8); // IFD0: one entry, GPSInfo -> GPS IFD at 26
    tiffGps.writeUInt16LE(0x8825, 10);
    tiffGps.writeUInt16LE(4, 12);
    tiffGps.writeUInt32LE(1, 14);
    tiffGps.writeUInt32LE(26, 18);
    tiffGps.writeUInt16LE(1, 26); // GPS IFD: one entry, GPSLatitudeRef "N"
    tiffGps.writeUInt16LE(1, 28);
    tiffGps.writeUInt16LE(2, 30);
    tiffGps.writeUInt32LE(2, 32);
    tiffGps.write('N', 36, 'latin1');
    const irb1058 = Buffer.concat([Buffer.from('8BIM\x04\x22\0\0', 'latin1'), Buffer.alloc(4), tiffGps]);
    irb1058.writeUInt32BE(tiffGps.length, 8);
    const items: Record<string, Buffer> = {
      'Parrot APP1 TIFF with a GPS IFD': seg(0xe1, Buffer.concat([Buffer.from('PARROT\0', 'latin1'), tiffGps])),
      'Photoshop 1058 EXIF with a GPS IFD': seg(0xed, Buffer.concat([Buffer.from('Photoshop 3.0\0', 'latin1'), irb1058])),
      'UTF-16 XMP with GPSLatitude': seg(0xe1, Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'),
        Buffer.from('<rdf:Description exif:GPSLatitude="34,4.5N"/>', 'utf16le')])),
    };
    for (const [name, item] of Object.entries(items)) {
      expect([name, carriesLocation(jpeg(...pad, item))]).toEqual([name, true]);
    }
  });
});
