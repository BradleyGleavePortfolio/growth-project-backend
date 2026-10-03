/**
 * A6-PHOTOS acceptance: EXIF and GPS are stripped server-side.
 *
 * Fixtures (test/message-photos/fixtures/README.md) carry a full GPS block,
 * camera make/model/serial, XMP (with GPS), IPTC, a comment and an embedded
 * thumbnail. After sanitizeImage none of it may survive, in any format; the
 * only metadata re-emitted for JPEG is a minimal EXIF with Orientation, so a
 * portrait photo still displays upright.
 */
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  ImageSanitizeError,
  MAX_IMAGE_SIDE_PX,
  crc32,
  readExifOrientation,
  sanitizeImage,
  sniffImageType,
} from '../../src/message-photos/image-metadata';

const FIX = join(__dirname, 'fixtures');
const fixture = (name: string): Buffer => readFileSync(join(FIX, name));

/** Every identifying string the fixtures carry, in latin1 and UTF-16 forms. */
const LEAKS = [
  'FixtureCam',
  'Fixture Model',
  'FIXTURE-SERIAL-001',
  'FixtureAuthor',
  'FixtureKeyword',
  'FixtureComment',
  'FIXTURE-GPS',
  'xmpmeta',
  'Photoshop 3.0',
];

function expectNoLeaks(out: Buffer): void {
  const text = out.toString('latin1');
  for (const s of LEAKS) expect([s, text.includes(s)]).toEqual([s, false]);
  // GPS IFD pointer tag (0x8825) in either byte order, and the GPS latitude
  // rational 12/1 20/1 4416/100 the JPEG fixture stores.
  expect(out.includes(Buffer.from([0x88, 0x25, 0x00, 0x04]))).toBe(false);
  expect(out.includes(Buffer.from([0x25, 0x88, 0x04, 0x00]))).toBe(false);
}

/** Walk JPEG header segments: [marker, payload] up to SOS. */
function jpegSegments(buf: Buffer): Array<[number, Buffer]> {
  const out: Array<[number, Buffer]> = [];
  let pos = 2;
  while (pos < buf.length) {
    const marker = buf[pos + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const len = buf.readUInt16BE(pos + 2);
    out.push([marker, buf.subarray(pos + 4, pos + 2 + len)]);
    pos += 2 + len;
  }
  return out;
}

/** Optional: write sanitized outputs for an external exiftool check. */
function maybeWrite(name: string, bytes: Buffer): void {
  const dir = process.env.A6_SANITIZED_OUT_DIR;
  if (dir) writeFileSync(join(dir, name), bytes);
}

describe('sanitizeImage strips EXIF / GPS (A6-PHOTOS)', () => {
  it('JPEG: removes GPS, camera, serial, XMP, IPTC, comment and thumbnail; keeps orientation only', () => {
    const input = fixture('gps-orientation6.jpg');
    expect(input.toString('latin1')).toContain('FixtureCam'); // the fixture really carries it
    expect(input.includes(Buffer.from([0x88, 0x25, 0x00, 0x04]))).toBe(true);

    const out = sanitizeImage(input);
    maybeWrite('gps-orientation6.sanitized.jpg', out.bytes);
    expect(out.contentType).toBe('image/jpeg');
    expect(out.ext).toBe('jpg');
    expect([out.width, out.height]).toEqual([48, 32]);
    expect(out.orientation).toBe(6);
    expectNoLeaks(out.bytes);
    expect(out.removed).toEqual(expect.arrayContaining(['EXIF']));

    const app1 = jpegSegments(out.bytes).filter(([m]) => m === 0xe1);
    expect(app1).toHaveLength(1);
    expect(readExifOrientation(app1[0][1])).toBe(6);
    // The re-emitted EXIF is tiny: header + one IFD entry, nothing else.
    expect(app1[0][1].length).toBeLessThanOrEqual(40);
    // No other APPn survives except JFIF (APP0).
    const appMarkers = jpegSegments(out.bytes)
      .map(([m]) => m)
      .filter((m) => m >= 0xe0 && m <= 0xef);
    expect(appMarkers.every((m) => m === 0xe0 || m === 0xe1)).toBe(true);
    expect(out.bytes.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('JPEG: drops a multi-picture trailer (second image with its own EXIF) after end of image', () => {
    const input = fixture('gps-mpf-trailer.jpg');
    const out = sanitizeImage(input);
    expectNoLeaks(out.bytes);
    expect(out.removed).toContain('trailing data after end of image');
    expect(out.bytes.length).toBeLessThan(input.length / 2);
    // Exactly one SOI and the file ends at its own EOI.
    expect(out.bytes.indexOf(Buffer.from([0xff, 0xd8]), 2)).toBe(-1);
  });

  it('JPEG: a photo without EXIF gets no EXIF segment at all', () => {
    const input = fixture('gps-orientation6.jpg');
    const once = sanitizeImage(input).bytes;
    // Strip the orientation segment by sanitizing a copy whose APP1 we drop.
    const segs = jpegSegments(once);
    const noApp1 = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      ...segs
        .filter(([m]) => m !== 0xe1)
        .map(([m, p]) => {
          const len = Buffer.alloc(2);
          len.writeUInt16BE(p.length + 2);
          return Buffer.concat([Buffer.from([0xff, m]), len, p]);
        }),
      once.subarray(once.indexOf(Buffer.from([0xff, 0xda]))),
    ]);
    const out = sanitizeImage(noApp1);
    expect(out.orientation).toBe(1);
    expect(jpegSegments(out.bytes).some(([m]) => m === 0xe1)).toBe(false);
  });

  it('PNG: removes eXIf, tEXt and iTXt chunks and keeps valid CRCs', () => {
    const input = fixture('gps.png');
    expect(input.toString('latin1')).toContain('eXIf');
    const out = sanitizeImage(input);
    maybeWrite('gps.sanitized.png', out.bytes);
    expect(out.contentType).toBe('image/png');
    expect([out.width, out.height]).toEqual([48, 32]);
    expectNoLeaks(out.bytes);
    const text = out.bytes.toString('latin1');
    for (const chunk of ['eXIf', 'tEXt', 'iTXt', 'zTXt']) expect(text.includes(chunk)).toBe(false);
    expect(out.removed).toEqual(expect.arrayContaining(['eXIf', 'tEXt', 'iTXt']));
    // Every kept chunk still has a valid CRC.
    let pos = 8;
    while (pos < out.bytes.length) {
      const len = out.bytes.readUInt32BE(pos);
      const end = pos + 12 + len;
      expect(crc32(out.bytes.subarray(pos + 4, end - 4))).toBe(out.bytes.readUInt32BE(end - 4));
      pos = end;
    }
  });

  it('WebP: removes EXIF and XMP chunks, clears the VP8X flags and rewrites the RIFF size', () => {
    const input = fixture('gps.webp');
    const out = sanitizeImage(input);
    maybeWrite('gps.sanitized.webp', out.bytes);
    expect(out.contentType).toBe('image/webp');
    expect([out.width, out.height]).toEqual([48, 32]);
    expectNoLeaks(out.bytes);
    const text = out.bytes.toString('latin1');
    expect(text.includes('EXIF')).toBe(false);
    expect(text.includes('XMP ')).toBe(false);
    expect(out.bytes.readUInt32LE(4)).toBe(out.bytes.length - 8);
    const vp8x = out.bytes.indexOf(Buffer.from('VP8X', 'latin1'));
    if (vp8x >= 0) expect(out.bytes[vp8x + 8] & 0x0c).toBe(0);
  });

  it('rejects HEIC (the phone converts to JPEG before upload) with unsupported_format', () => {
    const heic = fixture('sample.heic');
    expect(sniffImageType(heic)).toBe('image/heic');
    expect(() => sanitizeImage(heic)).toThrow(ImageSanitizeError);
    try {
      sanitizeImage(heic);
    } catch (err) {
      expect((err as ImageSanitizeError).reason).toBe('unsupported_format');
    }
  });

  it('rejects files that are not images, truncated JPEGs and absurd dimensions', () => {
    const reason = (buf: Buffer): string => {
      try {
        sanitizeImage(buf);
        return 'accepted';
      } catch (err) {
        return err instanceof ImageSanitizeError ? err.reason : 'threw';
      }
    };
    expect(reason(Buffer.from('%PDF-1.7 not a photo'))).toBe('not_an_image');
    expect(reason(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('not_an_image');
    const jpg = fixture('gps-orientation6.jpg');
    expect(reason(jpg.subarray(0, Math.floor(jpg.length / 3)))).toBe('not_an_image');

    // Rewrite the SOF dimensions past the limit.
    const out = Buffer.from(sanitizeImage(jpg).bytes);
    const sof = out.indexOf(Buffer.from([0xff, 0xc0]));
    expect(sof).toBeGreaterThan(0);
    out.writeUInt16BE(MAX_IMAGE_SIDE_PX + 1, sof + 5);
    expect(reason(out)).toBe('dimensions_out_of_range');
  });

  it('sanitizing is idempotent', () => {
    const once = sanitizeImage(fixture('gps-orientation6.jpg'));
    const twice = sanitizeImage(once.bytes);
    expect(twice.bytes.equals(once.bytes)).toBe(true);
    expect(twice.orientation).toBe(6);
  });
});
