/**
 * PERM-W5 (FR-1187, LS-1187 B1): the copy of a space photo that the photo
 * check sends to OpenAI carries no metadata, so the Privacy Policy's line
 * "It receives the photo and its caption, with no name or account details."
 * (#184-W8, approved) is true for what is inside the photo too. The stored
 * photo is not changed; only the bytes sent are.
 *
 * The photo check accepts JPEG only (the bucket is JPEG only, and the upload
 * check and the photo check both refuse other first bytes), so JPEG is the one
 * format stripped here. A walk over every marker segment from SOI to the first
 * EOI keeps only what draws the picture:
 *   dropped  APP1 to APP13 and APP15 (EXIF, XMP, ExtendedXMP, ICC, MPF, IPTC,
 *            Photoshop and every other writer's block) and COM, wherever they
 *            sit (before the first scan or between the scans of a progressive
 *            JPEG), plus everything after EOI (MPF's extra images and their
 *            own EXIF, trailing data);
 *   kept     APP0 (JFIF) and APP14 (Adobe colour transform), which carry no
 *            text, the frame, tables and scans, byte for byte.
 * It never guesses: a segment whose length runs past the end, a stray marker
 * or bytes that end outside a scan answer null, and the check fails closed
 * (nothing is sent). A scan that runs to the end of the bytes is ended with
 * EOI (the bytes kept are picture data only).
 */

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const COM = 0xfe;

/** APP1 (0xE1) to APP13 (0xED), APP15 (0xEF) and COM: the segments that can hold text. */
export const isMetadataMarker = (marker: number): boolean =>
  (marker >= 0xe1 && marker <= 0xed) || marker === 0xef || marker === COM;

/** The JPEG with its metadata segments and everything after EOI removed, or null when it cannot be walked. */
export function stripJpegMetadata(jpeg: Uint8Array): Buffer | null {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== SOI) return null;
  const kept: Uint8Array[] = [jpeg.subarray(0, 2)];
  const end = () => Buffer.concat([...kept, Uint8Array.of(0xff, EOI)]);
  let i = 2;
  for (;;) {
    if (i >= jpeg.length || jpeg[i] !== 0xff) return null;
    while (i < jpeg.length && jpeg[i] === 0xff) i += 1; // fill bytes before a marker
    if (i >= jpeg.length) return null;
    const marker = jpeg[i];
    if (marker === EOI) return end();
    // Markers with no length (TEM, RSTn, SOI) or a stuffed zero do not belong outside a scan.
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= SOI)) return null;
    if (i + 2 >= jpeg.length) return null;
    const length = (jpeg[i + 1] << 8) | jpeg[i + 2];
    const next = i + 1 + length;
    if (length < 2 || next > jpeg.length) return null;
    if (!isMetadataMarker(marker)) kept.push(jpeg.subarray(i - 1, next));
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
    if (i >= jpeg.length) {
      kept.push(jpeg.subarray(from));
      return end();
    }
    kept.push(jpeg.subarray(from, i));
  }
}
