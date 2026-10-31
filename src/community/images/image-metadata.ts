/**
 * PERM-W5 (FR-1187, LS-1187 B1; FR-1187R2, LS-1187R2 B1): the copy of a
 * space photo that the photo check sends to OpenAI carries no metadata, so
 * the Privacy Policy's line "It receives the photo and its caption, with no
 * name or account details." (#184-W8, approved) is true for what is inside
 * the photo too. The stored photo is not changed; only the bytes sent are.
 *
 * The photo check accepts JPEG only (the bucket is JPEG only, and the upload
 * check and the photo check both refuse other first bytes), so JPEG is the one
 * format stripped here. walkJpeg walks every marker segment from SOI to the
 * first EOI; the location reader (image-location.ts) uses the same walk, so
 * the two agree on where every segment sits. stripJpegMetadata keeps only what
 * draws the picture (an allowlist, FR-1187R2):
 *   kept     the frame (SOF0 to SOF15 but JPG, 0xC8), DHT, DAC, DQT, DNL, DRI,
 *            DHP, EXP and the scans, byte for byte, in place;
 *   rebuilt  an APP0 that is a JFIF header (JFIF 1.02: "JFIF\0", major
 *            version 1, units 0 to 2), as 16 bytes: its version, units and
 *            densities as they are, thumbnail size 0 x 0 and no thumbnail;
 *            an APP14 that is an Adobe header ("Adobe" and at least the 12
 *            byte fixed part), as its fixed part only: version, flags0,
 *            flags1 and the colour transform as they are (the transform says
 *            how to read the colours, so it is never dropped);
 *   dropped  every other APP0 (JFXX and its thumbnail, Canon CIFF, any other
 *            writer's), every other APP14, APP1 to APP13 and APP15 (EXIF, XMP,
 *            ExtendedXMP, ICC, MPF, IPTC, Photoshop and every other writer's
 *            block), COM, JPG (0xC8), JPGn (0xF0 to 0xFD) and the reserved
 *            markers, wherever they sit (before the first scan or between the
 *            scans of a progressive JPEG), plus everything after EOI (MPF's
 *            extra images and their own EXIF, trailing data).
 * It never guesses: a segment whose length runs past the end, a stray marker
 * or bytes that end outside a scan answer null, and the check fails closed
 * (no photo is sent). A scan that runs to the end of the bytes is ended with
 * EOI (the bytes kept are picture data only).
 */

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const APP0 = 0xe0;
const APP14 = 0xee;
const JFIF_HEADER = Buffer.from('JFIF\0', 'latin1');
const ADOBE_HEADER = Buffer.from('Adobe', 'latin1');

/** One part of a JPEG: a marker segment (bytes [start, end), the payload after its 4 header bytes) or a scan's picture data. */
export type JpegPart = { kind: 'segment'; marker: number; start: number; end: number } | { kind: 'scan'; start: number; end: number };

/**
 * Walks a JPEG from SOI to its first EOI, handing each part to `visit` in
 * order. Answers where the bytes after the first EOI begin (the length when a
 * scan runs to the end), or null when the bytes cannot be walked.
 */
export function walkJpeg(jpeg: Uint8Array, visit: (part: JpegPart) => void): number | null {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== SOI) return null;
  let i = 2;
  for (;;) {
    if (i >= jpeg.length || jpeg[i] !== 0xff) return null;
    while (i < jpeg.length && jpeg[i] === 0xff) i += 1; // fill bytes before a marker
    if (i >= jpeg.length) return null;
    const marker = jpeg[i];
    if (marker === EOI) return i + 1;
    // Markers with no length (TEM, RSTn, SOI) or a stuffed zero do not belong outside a scan.
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= SOI)) return null;
    if (i + 2 >= jpeg.length) return null;
    const length = (jpeg[i + 1] << 8) | jpeg[i + 2];
    const next = i + 1 + length;
    if (length < 2 || next > jpeg.length) return null;
    visit({ kind: 'segment', marker, start: i - 1, end: next });
    i = next;
    if (marker !== SOS) continue;
    // The scan's picture data runs to the next marker that is not a stuffed zero, a restart (RSTn) or fill.
    const from = i;
    while (i < jpeg.length) {
      if (jpeg[i] !== 0xff || i + 1 >= jpeg.length) {
        i += 1;
        continue;
      }
      const after = jpeg[i + 1];
      if (after === 0x00 || (after >= 0xd0 && after <= 0xd7) || after === 0xff) {
        i += after === 0xff ? 1 : 2;
        continue;
      }
      break;
    }
    visit({ kind: 'scan', start: from, end: Math.min(i, jpeg.length) });
    if (i >= jpeg.length) return jpeg.length;
  }
}

/** The segments that draw the picture, kept byte for byte: SOFn (not JPG, 0xC8), DHT, DAC, DQT, SOS, DNL, DRI, DHP, EXP. */
export const isPictureMarker = (marker: number): boolean =>
  (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc8) || (marker >= 0xda && marker <= 0xdf);

const startsWith = (payload: Uint8Array, header: Buffer): boolean =>
  payload.length >= header.length && header.every((c, k) => payload[k] === c);

/**
 * An APP0 or APP14 payload as it is sent: the JFIF header's encoding fields
 * with no thumbnail, or the Adobe header's fixed fields; null (dropped) for
 * every other form (JFXX, CIFF, a short or unknown header).
 */
export function keptHeader(marker: number, payload: Uint8Array): Buffer | null {
  if (marker === APP0) {
    // "JFIF\0", major, minor, units, Xdensity (2), Ydensity (2), Xthumbnail, Ythumbnail: 14 bytes.
    if (payload.length < 14 || !startsWith(payload, JFIF_HEADER) || payload[5] !== 1 || payload[7] > 2) return null;
    return Buffer.from([...payload.subarray(0, 12), 0, 0]);
  }
  if (marker === APP14) {
    // "Adobe", DCTEncodeVersion (2), APP14Flags0 (2), APP14Flags1 (2), ColorTransform: 12 bytes.
    if (payload.length < 12 || !startsWith(payload, ADOBE_HEADER)) return null;
    return Buffer.from(payload.subarray(0, 12));
  }
  return null;
}

/** The JPEG with only its picture segments, its JFIF and Adobe headers and its scans, or null when it cannot be walked. */
export function stripJpegMetadata(jpeg: Uint8Array): Buffer | null {
  const kept: Uint8Array[] = [Uint8Array.of(0xff, SOI)];
  const end = walkJpeg(jpeg, (part) => {
    if (part.kind === 'scan' || isPictureMarker(part.marker)) {
      kept.push(jpeg.subarray(part.start, part.end));
      return;
    }
    const header = keptHeader(part.marker, jpeg.subarray(part.start + 4, part.end));
    if (header) kept.push(Uint8Array.of(0xff, part.marker, 0, header.length + 2), header);
  });
  if (end === null) return null;
  return Buffer.concat([...kept, Uint8Array.of(0xff, EOI)]);
}
