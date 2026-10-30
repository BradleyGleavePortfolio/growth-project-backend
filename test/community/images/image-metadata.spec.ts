/**
 * FR-1187 (LS-1187 B1, operator ruling): the copy of a space photo sent to
 * OpenAI carries no metadata. stripJpegMetadata drops APP1 to APP13, APP15 and
 * COM wherever they sit, and everything after EOI; it keeps APP0, APP14, the
 * frame, the tables and the scans byte for byte; and it answers null for bytes
 * it cannot walk, so the check fails closed. JPEG is the only format the photo
 * check accepts (community-photo-check.e2e.spec.ts: every other format is
 * refused before any call to OpenAI).
 */
import { isMetadataMarker, stripJpegMetadata } from '../../../src/community/images/image-metadata';
import { JFIF, SCAN, SOI, segment, exifApp1, xmpApp1, xmpPacket, extendedXmpApp1, EXTENDED_GUID, tiff } from './jpeg-fixtures';

const NAME = 'Example Photo Author';
const latin1 = (s: string): number[] => [...Buffer.from(s, 'latin1')];
const named = (prefix: string): number[] => [...latin1(prefix), ...latin1(NAME), 0];

// What draws the picture: Adobe APP14, a quantisation table, a baseline frame, a Huffman table.
const ADOBE = segment(0xee, [...latin1('Adobe'), 0, 100, 0, 0, 0, 0, 1]);
const DQT = segment(0xdb, [0, ...Array.from({ length: 64 }, (_, k) => k + 1)]);
const SOF0 = segment(0xc0, [8, 0, 16, 0, 16, 1, 1, 0x11, 0]);
const SOF2 = segment(0xc2, [8, 0, 16, 0, 16, 1, 1, 0x11, 0]);
const DHT = segment(0xc4, [0, ...Array.from({ length: 16 }, (_, k) => (k === 0 ? 1 : 0)), 0]);
const DRI = segment(0xdd, [0, 4]);
const SOS = segment(0xda, [1, 1, 0, 0, 0x3f, 0]);
/** Scan data with a stuffed zero, a restart marker and a fill byte before the end. */
const DATA = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff];
const EOI = [0xff, 0xd9];
const PICTURE = [...JFIF, ADOBE, DQT, SOF0, DHT, DRI].flat();
const BARE = [...SOI, ...PICTURE, ...SOS, ...DATA, ...EOI];

const exifArtist = (() => {
  const u16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff];
  const u32 = (n: number) => [...u16(n), ...u16(n >>> 16)];
  const nameBytes = [...latin1(NAME), 0];
  return exifApp1([0x49, 0x49, ...u16(42), ...u32(8), ...u16(1), ...u16(0x013b), ...u16(2), ...u32(nameBytes.length), ...u32(26), ...u32(0), ...nameBytes]);
})();

/** Every writer's block the check could meet, each carrying the name. */
const METADATA: Array<[string, number[]]> = [
  ['APP1 EXIF (Artist)', exifArtist],
  ['APP1 EXIF (orientation only)', exifApp1(tiff('MM'))],
  ['APP1 XMP (dc:creator)', xmpApp1(xmpPacket(`xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="${NAME}"`))],
  ['APP1 ExtendedXMP', extendedXmpApp1(EXTENDED_GUID, 64, 0, `<dc:creator>${NAME}</dc:creator>`)],
  ['APP2 ICC profile', segment(0xe2, named('ICC_PROFILE\0\x01\x01desc'))],
  ['APP2 MPF', segment(0xe2, named('MPF\0MM\0*'))],
  ['APP3 to APP12', [0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xeb, 0xec].flatMap((m) => segment(m, named('w')))],
  ['APP12 Ducky', segment(0xec, named('Ducky\0'))],
  ['APP13 Photoshop IPTC (By-line)', segment(0xed, named('Photoshop 3.0\x008BIM\x04\x04\0\0\0\0\0\x18\x1c\x02\x50\0\x14'))],
  ['APP15', segment(0xef, named('x'))],
  ['COM', segment(0xfe, latin1(NAME))],
];

describe('stripJpegMetadata (FR-1187: what reaches OpenAI)', () => {
  it.each(METADATA)('drops %s before the frame and keeps the rest byte for byte', (_label, meta) => {
    const out = stripJpegMetadata(Uint8Array.from([...SOI, ...JFIF, ...meta, ...PICTURE.slice(JFIF.length), ...SOS, ...DATA, ...EOI]));
    expect(out?.toString('latin1')).not.toContain(NAME);
    expect(out).toEqual(Buffer.from(BARE));
  });

  it.each(METADATA)('drops %s between the scans of a progressive JPEG', (_label, meta) => {
    const scans = [...SOS, ...DATA, ...DHT, ...SOS, 0x77, 0x88];
    const out = stripJpegMetadata(Uint8Array.from([...SOI, ...JFIF, ...DQT, ...SOF2, ...DHT, ...SOS, ...DATA, ...meta, ...DHT, ...SOS, 0x77, 0x88, ...EOI]));
    expect(out?.toString('latin1')).not.toContain(NAME);
    expect(out).toEqual(Buffer.from([...SOI, ...JFIF, ...DQT, ...SOF2, ...DHT, ...scans, ...EOI]));
  });

  it('drops everything after EOI: an MPF second image with its own EXIF, and trailing bytes', () => {
    const second = [...SOI, ...exifArtist, ...SCAN];
    const out = stripJpegMetadata(Uint8Array.from([...BARE, ...second, ...latin1(NAME)]));
    expect(out).toEqual(Buffer.from(BARE));
  });

  it('keeps a JPEG with no metadata exactly as it is (APP0 JFIF and APP14 Adobe stay)', () => {
    expect(stripJpegMetadata(Uint8Array.from(BARE))).toEqual(Buffer.from(BARE));
    const plain = [...SOI, ...JFIF, ...SCAN];
    expect(stripJpegMetadata(Uint8Array.from(plain))).toEqual(Buffer.from(plain));
  });

  it('ends a scan that runs to the end of the bytes with EOI', () => {
    expect(stripJpegMetadata(Uint8Array.from([...SOI, ...PICTURE, ...SOS, ...DATA.slice(0, 6)]))).toEqual(
      Buffer.from([...SOI, ...PICTURE, ...SOS, ...DATA.slice(0, 6), ...EOI]),
    );
  });

  it.each<[string, number[]]>([
    ['empty', []],
    ['not a JPEG (PNG signature)', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    ['SOI only', [...SOI]],
    ['a segment length past the end', [...SOI, 0xff, 0xe1, 0x40, 0x00, ...latin1('Exif')]],
    ['a segment length under 2', [...SOI, 0xff, 0xe1, 0x00, 0x01, ...SCAN]],
    ['a byte that is not a marker between segments', [...SOI, ...JFIF, 0x00, ...SCAN]],
    ['a second SOI before the scan', [...SOI, ...JFIF, ...SOI, ...SCAN]],
    ['a restart marker outside a scan', [...SOI, ...JFIF, 0xff, 0xd3, ...SCAN]],
    ['TEM outside a scan', [...SOI, ...JFIF, 0xff, 0x01, ...SCAN]],
    ['bytes that end before any scan', [...SOI, ...JFIF]],
    ['a stray SOI after the scan', [...SOI, ...JFIF, ...SOS, 0x12, 0xff, 0xd8, 0x34, ...EOI]],
    ['a header cut short after the scan', [...SOI, ...JFIF, ...SOS, 0x12, 0xff, 0xdb, 0x00]],
  ])('answers null (the check fails closed) for %s', (_label, bytes) => {
    expect(stripJpegMetadata(Uint8Array.from(bytes))).toBeNull();
  });

  it('names APP1 to APP13, APP15 and COM as metadata, and nothing else', () => {
    const all = Array.from({ length: 256 }, (_, m) => m).filter(isMetadataMarker);
    expect(all).toEqual([0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xeb, 0xec, 0xed, 0xef, 0xfe]);
  });
});
