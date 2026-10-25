/**
 * PHOTO-GPS (agent 174): does a space photo carry a location?
 *
 * A pure reader over the first bytes of a JPEG (at most LOCATION_READ_BYTES).
 * It walks the marker segments from the start of the file up to the first
 * start-of-scan (SOS, 0xFFDA), where the picture data begins, and answers
 * true when any APP1 segment there carries a location:
 *   - EXIF: IFD0 has the GPSInfo pointer (tag 0x8825) to a GPS IFD with at
 *     least one entry, in either byte order ("II" little or "MM" big endian);
 *   - XMP (any other APP1): its text names GPSLatitude or GPSLongitude, as
 *     exif:GPSLatitude / exif:GPSLongitude do.
 *
 * It never guesses clean. Only a walk that reaches SOS with no location seen
 * answers false. A truncated or malformed APP1, a segment that runs past the
 * bytes read, a broken marker, or bytes that end before SOS all answer true.
 *
 * Not read (the phone, SC-M4, re-encodes every photo, which drops them):
 * anything after the first SOS (a later scan's segments, a second image after
 * EOI), IPTC (APP13), comments, UTF-16 or split extended XMP.
 */

/** How much of a photo is read for its location: 256 KB from the start. */
export const LOCATION_READ_BYTES = 256 * 1024;

const SOI = 0xd8;
const SOS = 0xda;
const APP1 = 0xe1;
const GPS_INFO_TAG = 0x8825;
const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00]; // "Exif\0" (then one pad byte)
const XMP_GPS = /GPS(?:Latitude|Longitude)/;

/** True when the JPEG's segments before its first SOS carry a location, or cannot be read to SOS. */
export function carriesLocation(jpeg: Uint8Array): boolean {
  const b = jpeg.subarray(0, LOCATION_READ_BYTES);
  if (b.length < 2 || b[0] !== 0xff || b[1] !== SOI) return true;
  let i = 2;
  for (;;) {
    if (i >= b.length || b[i] !== 0xff) return true;
    while (i < b.length && b[i] === 0xff) i += 1; // fill bytes before a marker
    if (i >= b.length) return true;
    const marker = b[i];
    if (marker === SOS) return false;
    // Markers with no length (TEM, RSTn, SOI, EOI) or a stuffed zero do not belong before SOS.
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) return true;
    if (i + 2 >= b.length) return true;
    const length = (b[i + 1] << 8) | b[i + 2];
    const end = i + 1 + length;
    if (length < 2 || end > b.length) return true;
    if (marker === APP1 && app1Located(b.subarray(i + 3, end))) return true;
    i = end;
  }
}

function app1Located(payload: Uint8Array): boolean {
  if (EXIF_HEADER.every((c, k) => payload[k] === c)) return exifLocated(payload.subarray(6));
  return XMP_GPS.test(Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString('latin1'));
}

/** EXIF (a TIFF structure): IFD0's GPSInfo entry points at a GPS IFD with entries. Unreadable = located. */
function exifLocated(tiff: Uint8Array): boolean {
  try {
    const v = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
    const order = v.getUint16(0);
    if (order !== 0x4949 && order !== 0x4d4d) return true;
    const le = order === 0x4949;
    if (v.getUint16(2, le) !== 42) return true;
    const ifd0 = v.getUint32(4, le);
    const count = v.getUint16(ifd0, le);
    if (ifd0 + 2 + count * 12 > tiff.length) return true;
    for (let n = 0; n < count; n += 1) {
      const entry = ifd0 + 2 + n * 12;
      if (v.getUint16(entry, le) !== GPS_INFO_TAG) continue;
      if (v.getUint16(v.getUint32(entry + 8, le), le) > 0) return true;
    }
    return false;
  } catch {
    // A read past the segment (RangeError): the EXIF is truncated or malformed.
    return true;
  }
}
