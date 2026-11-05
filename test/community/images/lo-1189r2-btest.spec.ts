/**
 * LO-1189R2 B-TEST (Opus lens on b#1189 @ 5ac57e2c). Fails at that head.
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

/** One IFD entry: tag, type LONG, count 1, value. */
const entry = (tag: number, value: number): Buffer => {
  const e = Buffer.alloc(12);
  e.writeUInt16LE(tag, 0);
  e.writeUInt16LE(4, 2);
  e.writeUInt32LE(1, 4);
  e.writeUInt32LE(value, 8);
  return e;
};
/** A one-entry IFD (entry, next IFD offset). */
const ifd = (e: Buffer, next = 0): Buffer => {
  const b = Buffer.alloc(18);
  b.writeUInt16LE(1, 0);
  e.copy(b, 2);
  b.writeUInt32LE(next, 14);
  return b;
};
/** A GPS IFD: GPSLatitudeRef "N", GPSLatitude 37/1, 48/1, 0/1 (exiftool prints 37 deg 48' 0.00"). */
const gpsIfd = (at: number): Buffer => {
  const b = Buffer.alloc(2 + 24 + 4 + 24);
  b.writeUInt16LE(2, 0);
  b.writeUInt16LE(1, 2);
  b.writeUInt16LE(2, 4);
  b.writeUInt32LE(2, 6);
  b.write('N', 10, 'latin1');
  b.writeUInt16LE(2, 14);
  b.writeUInt16LE(5, 16);
  b.writeUInt32LE(3, 18);
  b.writeUInt32LE(at + 30, 22);
  [37, 1, 48, 1, 0, 1].forEach((n, k) => b.writeUInt32LE(n, 30 + k * 4));
  return b;
};
const TIFF = Buffer.from('II*\0\x08\0\0\0', 'latin1'); // IFD0 at 8
const exif = (tiff: Buffer): Buffer => seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]));
const XMP =
  '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF ' +
  'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" ' +
  'xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="37,0.0N" exif:GPSLongitude="122,0.0W"/>' +
  '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
const utf32 = (text: string, le: boolean): Buffer => {
  const b = Buffer.alloc(text.length * 4);
  for (let k = 0; k < text.length; k += 1) {
    if (le) b.writeUInt32LE(text.charCodeAt(k), k * 4);
    else b.writeUInt32BE(text.charCodeAt(k), k * 4);
  }
  return b;
};
const xmp = (body: Buffer): Buffer => seg(0xe1, Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'), body]));

describe('LO-1189R2 B-TEST', () => {
  // B1 (the LO-1189 B2 class): exiftool reads each position below; 436cf4bc refuses each behind a header past
  // 256 KB; main and b#1189 @ 5ac57e2c post each. EXIF is read at IFD0 only (exifLocated); XMP as Latin-1 and UTF-16.
  it('LO-1189R2 B1: a GPS IFD reached from the Exif IFD or IFD1, or UTF-32 XMP, behind a header past 256 KB is a location', () => {
    const pad = Array.from({ length: 5 }, () => seg(0xe2, Buffer.concat([Buffer.from('ICC_PROFILE\0\x01\x05', 'latin1'), Buffer.alloc(65000)])));
    const items: Record<string, Buffer> = {
      // IFD0 (8): ExifIFD -> 26; Exif IFD (26): GPSInfo -> 44; GPS IFD at 44.
      'GPSInfo in the Exif IFD': exif(Buffer.concat([TIFF, ifd(entry(0x8769, 26)), ifd(entry(0x8825, 44)), gpsIfd(44)])),
      // IFD0 (8): ImageWidth, next IFD1 -> 26; IFD1 (26): GPSInfo -> 44; GPS IFD at 44.
      'GPSInfo in IFD1': exif(Buffer.concat([TIFF, ifd(entry(0x0100, 1), 26), ifd(entry(0x8825, 44)), gpsIfd(44)])),
      'UTF-32LE XMP with GPSLatitude': xmp(utf32(XMP, true)),
      'UTF-32BE XMP with GPSLatitude': xmp(utf32(XMP, false)),
    };
    for (const [name, item] of Object.entries(items)) {
      expect([name, carriesLocation(jpeg(...pad, item))]).toEqual([name, true]);
    }
  });
});
