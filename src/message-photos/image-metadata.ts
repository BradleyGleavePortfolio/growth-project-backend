import { createHash } from 'crypto';

/**
 * Server-side image sanitizer for message photos (A6-PHOTOS).
 *
 * Every photo a member sends is rewritten here before anyone else can see it:
 * the bytes the phone uploaded are parsed as a JPEG, PNG or WebP container,
 * every metadata block is dropped, and only the pixels plus the colour data
 * needed to show them correctly are kept. What is removed:
 *
 *  - JPEG: every APPn segment except JFIF (APP0, thumbnail zeroed), the ICC
 *    colour profile (APP2 "ICC_PROFILE") and Adobe colour transform (APP14).
 *    That drops EXIF and its GPS sub-IFD, XMP, IPTC/Photoshop (APP13), MPF
 *    (APP2 "MPF") and vendor blocks, plus COM comments. Everything after the
 *    end-of-image marker is dropped too: phones append secondary images
 *    (Apple/Samsung MPF depth maps, previews) there, and each of those carries
 *    its own EXIF with GPS.
 *    The one EXIF field kept is Orientation (tag 0x0112), re-emitted in a
 *    fresh, minimal EXIF block that holds nothing else, so a portrait photo
 *    still shows upright.
 *  - PNG: only IHDR, PLTE, IDAT, IEND and the colour/transparency chunks
 *    (tRNS, cHRM, gAMA, iCCP, sBIT, sRGB, bKGD, pHYs, cICP) survive. eXIf,
 *    tEXt, zTXt, iTXt, tIME, animation and vendor chunks are dropped, and so
 *    is anything after IEND.
 *  - WebP: EXIF and XMP chunks (and unknown chunks) are dropped, the VP8X
 *    flags that announce them are cleared, and the RIFF size is rewritten.
 *
 * Anything that does not parse cleanly as one of the three formats is
 * refused: the sanitizer never passes through bytes it does not understand.
 * Pure and dependency-free (no native image library), so it runs the same in
 * CI and production.
 */

export type SanitizedImageType = 'image/jpeg' | 'image/png' | 'image/webp';

export interface SanitizedImage {
  bytes: Buffer;
  contentType: SanitizedImageType;
  ext: 'jpg' | 'png' | 'webp';
  width: number;
  height: number;
  /** EXIF orientation that was preserved (1 when none). */
  orientation: number;
  sha256: string;
  /** Names of the metadata blocks that were removed (for tests and logs; no content). */
  removed: string[];
}

export type ImageRejection = 'not_an_image' | 'unsupported_format' | 'dimensions_out_of_range';

export class ImageSanitizeError extends Error {
  constructor(
    readonly reason: ImageRejection,
    detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = 'ImageSanitizeError';
  }
}

/** Largest side, in pixels, a message photo may have (decompression-bomb guard for viewers). */
export const MAX_IMAGE_SIDE_PX = 12000;
/** Largest pixel count (about 60 MP; a 48 MP phone sensor fits). */
export const MAX_IMAGE_PIXELS = 60_000_000;

/** Detect the container from its magic bytes only (never from a declared type). */
export function sniffImageType(buf: Buffer): SanitizedImageType | 'image/heic' | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (
    buf.length >= 12 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12);
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis', 'avif'].includes(brand)) {
      return 'image/heic';
    }
  }
  return null;
}

/** Sanitize an uploaded image. Throws ImageSanitizeError on anything it cannot prove safe. */
export function sanitizeImage(input: Buffer): SanitizedImage {
  const type = sniffImageType(input);
  if (type === 'image/heic') {
    throw new ImageSanitizeError('unsupported_format', 'HEIC/HEIF/AVIF is not accepted');
  }
  let out: Omit<SanitizedImage, 'sha256'>;
  if (type === 'image/jpeg') out = sanitizeJpeg(input);
  else if (type === 'image/png') out = sanitizePng(input);
  else if (type === 'image/webp') out = sanitizeWebp(input);
  else throw new ImageSanitizeError('not_an_image', 'unrecognised file signature');
  assertDimensions(out.width, out.height);
  return { ...out, sha256: createHash('sha256').update(out.bytes).digest('hex') };
}

function assertDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new ImageSanitizeError('not_an_image', 'missing or zero dimensions');
  }
  if (
    width > MAX_IMAGE_SIDE_PX ||
    height > MAX_IMAGE_SIDE_PX ||
    width * height > MAX_IMAGE_PIXELS
  ) {
    throw new ImageSanitizeError('dimensions_out_of_range', `${width}x${height}`);
  }
}

// ─── JPEG ────────────────────────────────────────────────────────────────────

const JFIF_ID = Buffer.from('JFIF\0', 'latin1');
const EXIF_ID = Buffer.from('Exif\0\0', 'latin1');
const ICC_ID = Buffer.from('ICC_PROFILE\0', 'latin1');
const ADOBE_ID = Buffer.from('Adobe', 'latin1');

function startsWith(buf: Buffer, prefix: Buffer): boolean {
  return buf.length >= prefix.length && buf.subarray(0, prefix.length).equals(prefix);
}

function segment(marker: number, payload: Buffer): Buffer {
  if (payload.length + 2 > 0xffff)
    throw new ImageSanitizeError('not_an_image', 'segment too large');
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

/** Read EXIF Orientation (0x0112) from an APP1 Exif payload; 1 when absent or invalid. */
export function readExifOrientation(app1Payload: Buffer): number {
  try {
    if (!startsWith(app1Payload, EXIF_ID)) return 1;
    const tiff = app1Payload.subarray(EXIF_ID.length);
    if (tiff.length < 8) return 1;
    const order = tiff.toString('latin1', 0, 2);
    const le = order === 'II';
    if (!le && order !== 'MM') return 1;
    const u16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
    const u32 = (o: number) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
    if (u16(2) !== 42) return 1;
    const ifd = u32(4);
    if (ifd + 2 > tiff.length) return 1;
    const count = u16(ifd);
    for (let i = 0; i < count; i += 1) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > tiff.length) return 1;
      if (u16(e) === 0x0112 && u16(e + 2) === 3 && u32(e + 4) === 1) {
        const v = u16(e + 8);
        return v >= 1 && v <= 8 ? v : 1;
      }
    }
  } catch {
    return 1;
  }
  return 1;
}

/** A fresh APP1 Exif payload holding ONLY the Orientation tag (big-endian TIFF). */
export function minimalOrientationExif(orientation: number): Buffer {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18);
  tiff.writeUInt32BE(0, 22);
  return Buffer.concat([EXIF_ID, tiff]);
}

function isSof(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function sanitizeJpeg(buf: Buffer): Omit<SanitizedImage, 'sha256'> {
  const kept: Buffer[] = [];
  const removed: string[] = [];
  let width = 0;
  let height = 0;
  let orientation = 1;
  let sawSos = false;
  let sawEoi = false;
  let jfif: Buffer | null = null;
  let pos = 2; // after SOI

  const readMarker = (): number => {
    if (buf[pos] !== 0xff) throw new ImageSanitizeError('not_an_image', 'expected a JPEG marker');
    while (pos < buf.length && buf[pos] === 0xff) pos += 1; // fill bytes
    if (pos >= buf.length) throw new ImageSanitizeError('not_an_image', 'truncated marker');
    const m = buf[pos];
    pos += 1;
    return m;
  };

  while (pos < buf.length) {
    const marker = readMarker();
    if (marker === 0xd9) {
      sawEoi = true;
      break;
    }
    if (marker === 0xd8 || marker === 0x00) {
      throw new ImageSanitizeError('not_an_image', 'unexpected marker in header');
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      kept.push(Buffer.from([0xff, marker]));
      continue;
    }
    if (pos + 2 > buf.length)
      throw new ImageSanitizeError('not_an_image', 'truncated segment length');
    const len = buf.readUInt16BE(pos);
    if (len < 2 || pos + len > buf.length) {
      throw new ImageSanitizeError('not_an_image', 'segment overruns the file');
    }
    const payload = buf.subarray(pos + 2, pos + len);
    pos += len;

    if (marker === 0xda) {
      // Start of scan: keep the header, then copy the entropy-coded data up
      // to the next real marker (0xFF followed by neither 0x00 nor RSTn).
      sawSos = true;
      kept.push(segment(marker, payload));
      const start = pos;
      while (pos < buf.length) {
        if (buf[pos] === 0xff && pos + 1 < buf.length) {
          const next = buf[pos + 1];
          if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7) && next !== 0xff) break;
        }
        pos += 1;
      }
      kept.push(buf.subarray(start, pos));
      continue;
    }
    if (isSof(marker)) {
      if (payload.length < 6) throw new ImageSanitizeError('not_an_image', 'short frame header');
      height = payload.readUInt16BE(1);
      width = payload.readUInt16BE(3);
      kept.push(segment(marker, payload));
      continue;
    }
    if (
      marker === 0xc4 ||
      marker === 0xcc ||
      marker === 0xdb ||
      marker === 0xdd ||
      marker === 0xdc
    ) {
      kept.push(segment(marker, payload));
      continue;
    }
    if (marker === 0xe0 && startsWith(payload, JFIF_ID) && payload.length >= 14 && !jfif) {
      // JFIF header without its optional embedded thumbnail.
      const clean = Buffer.from(payload.subarray(0, 14));
      clean[12] = 0;
      clean[13] = 0;
      jfif = segment(0xe0, clean);
      if (payload.length > 14) removed.push('JFIF thumbnail');
      continue;
    }
    if (marker === 0xe2 && startsWith(payload, ICC_ID)) {
      kept.push(segment(marker, payload));
      continue;
    }
    if (marker === 0xee && startsWith(payload, ADOBE_ID)) {
      kept.push(segment(marker, payload));
      continue;
    }
    if (marker === 0xe1 && startsWith(payload, EXIF_ID)) {
      const o = readExifOrientation(payload);
      if (o !== 1) orientation = o;
      removed.push('EXIF');
      continue;
    }
    removed.push(describeJpegSegment(marker, payload));
  }

  if (!sawSos || !sawEoi || width === 0 || height === 0) {
    throw new ImageSanitizeError('not_an_image', 'incomplete JPEG (no frame, scan or end marker)');
  }
  if (pos < buf.length) removed.push('trailing data after end of image');

  const head: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (jfif) head.push(jfif);
  if (orientation !== 1) head.push(segment(0xe1, minimalOrientationExif(orientation)));
  return {
    bytes: Buffer.concat([...head, ...kept, Buffer.from([0xff, 0xd9])]),
    contentType: 'image/jpeg',
    ext: 'jpg',
    width,
    height,
    orientation,
    removed,
  };
}

function describeJpegSegment(marker: number, payload: Buffer): string {
  if (marker === 0xfe) return 'COM';
  if (marker >= 0xe0 && marker <= 0xef) {
    const id = payload.toString('latin1', 0, Math.min(payload.length, 12)).split('\0')[0];
    return `APP${marker - 0xe0}${id ? ` ${id.replace(/[^A-Za-z0-9_ .:/-]/g, '')}` : ''}`;
  }
  return `marker 0x${marker.toString(16)}`;
}

// ─── PNG ─────────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_KEEP = new Set([
  'IHDR',
  'PLTE',
  'IDAT',
  'IEND',
  'tRNS',
  'cHRM',
  'gAMA',
  'iCCP',
  'sBIT',
  'sRGB',
  'bKGD',
  'pHYs',
  'cICP',
]);

let crcTable: Uint32Array | null = null;
export function crc32(data: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function sanitizePng(buf: Buffer): Omit<SanitizedImage, 'sha256'> {
  const kept: Buffer[] = [PNG_SIGNATURE];
  const removed: string[] = [];
  let pos = 8;
  let width = 0;
  let height = 0;
  let first = true;
  let sawIdat = false;
  let sawEnd = false;
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const end = pos + 12 + len;
    if (len > 0x7fffffff || end > buf.length || !/^[A-Za-z]{4}$/.test(type)) {
      throw new ImageSanitizeError('not_an_image', 'malformed PNG chunk');
    }
    const chunk = buf.subarray(pos, end);
    const crc = buf.readUInt32BE(end - 4);
    if (crc32(buf.subarray(pos + 4, end - 4)) !== crc) {
      throw new ImageSanitizeError('not_an_image', `bad CRC on ${type}`);
    }
    if (first) {
      if (type !== 'IHDR' || len !== 13)
        throw new ImageSanitizeError('not_an_image', 'PNG must start with IHDR');
      width = buf.readUInt32BE(pos + 8);
      height = buf.readUInt32BE(pos + 12);
      first = false;
    }
    if (PNG_KEEP.has(type)) kept.push(chunk);
    else removed.push(type);
    if (type === 'IDAT') sawIdat = true;
    pos = end;
    if (type === 'IEND') {
      sawEnd = true;
      break;
    }
  }
  if (!sawIdat || !sawEnd) throw new ImageSanitizeError('not_an_image', 'incomplete PNG');
  if (pos < buf.length) removed.push('trailing data after IEND');
  return {
    bytes: Buffer.concat(kept),
    contentType: 'image/png',
    ext: 'png',
    width,
    height,
    orientation: 1,
    removed,
  };
}

// ─── WebP ────────────────────────────────────────────────────────────────────

const WEBP_KEEP = new Set(['VP8X', 'VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);

function sanitizeWebp(buf: Buffer): Omit<SanitizedImage, 'sha256'> {
  const riffSize = buf.readUInt32LE(4);
  const total = Math.min(buf.length, riffSize + 8);
  if (riffSize + 8 > buf.length || riffSize < 4)
    throw new ImageSanitizeError('not_an_image', 'truncated RIFF');
  const removed: string[] = [];
  const kept: Buffer[] = [];
  let pos = 12;
  let width = 0;
  let height = 0;
  let vp8x: Buffer | null = null;
  let sawImage = false;
  while (pos + 8 <= total) {
    const fourcc = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const padded = size + (size & 1);
    if (pos + 8 + size > total)
      throw new ImageSanitizeError('not_an_image', 'WebP chunk overruns the file');
    const data = buf.subarray(pos + 8, pos + 8 + size);
    const whole = Buffer.from(buf.subarray(pos, Math.min(pos + 8 + padded, total)));
    if (fourcc === 'VP8X') {
      if (size < 10) throw new ImageSanitizeError('not_an_image', 'short VP8X');
      width = data.readUIntLE(4, 3) + 1;
      height = data.readUIntLE(7, 3) + 1;
      whole[8] = whole[8] & ~0x0c; // clear EXIF (0x08) and XMP (0x04) flags
      vp8x = whole;
      kept.push(whole);
    } else if (WEBP_KEEP.has(fourcc)) {
      if (fourcc === 'VP8 ' || fourcc === 'VP8L' || fourcc === 'ANMF') sawImage = true;
      if (!vp8x && fourcc === 'VP8 ' && data.length >= 10) {
        if (data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) {
          throw new ImageSanitizeError('not_an_image', 'bad VP8 start code');
        }
        width = data.readUInt16LE(6) & 0x3fff;
        height = data.readUInt16LE(8) & 0x3fff;
      } else if (!vp8x && fourcc === 'VP8L' && data.length >= 5) {
        if (data[0] !== 0x2f) throw new ImageSanitizeError('not_an_image', 'bad VP8L signature');
        const bits = data.readUInt32LE(1);
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
      }
      kept.push(whole);
    } else {
      removed.push(fourcc.trim());
    }
    pos += 8 + padded;
  }
  if (!sawImage) throw new ImageSanitizeError('not_an_image', 'WebP has no image data');
  if (buf.length > riffSize + 8) removed.push('trailing data after RIFF');
  const body = Buffer.concat(kept);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return {
    bytes: Buffer.concat([header, body]),
    contentType: 'image/webp',
    ext: 'webp',
    width,
    height,
    orientation: 1,
    removed,
  };
}
