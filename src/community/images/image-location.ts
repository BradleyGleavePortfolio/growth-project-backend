/**
 * PHOTO-GPS (agent 174): does a space photo carry a location?
 *
 * A pure reader over the whole JPEG (the upload check reads every byte; the
 * bucket's cap is IMAGE_MAX_BYTES, 10 MB). It answers true when a segment
 * or bytes it reads ("Where it looks", below) carry a location:
 *   - EXIF: IFD0 has the GPSInfo pointer (tag 0x8825) to a GPS IFD with at
 *     least one entry, in either byte order ("II" little or "MM" big endian);
 *   - XMP (any other APP1): its text holds a location name, in any letter
 *     case (FR-1164R2, LS-1164R B1): a name with "latitude" or "longitude" in
 *     it, DJI's misspelt "Longtitude", or DJI's laser target LRFTargetLat /
 *     LRFTargetLon. That covers every documented StandardXMP location family
 *     found: EXIF's GPSLatitude, GPSLongitude, GPSDestLatitude and
 *     GPSDestLongitude (also inside IPTC Extension LocationCreated and
 *     LocationShown); DJI's drone-dji GpsLatitude, GpsLongitude,
 *     GpsLongtitude, Latitude, Longitude, LRFTargetLat and LRFTargetLon;
 *     Google Dynamic Depth's EarthPose Latitude and Longitude; and any other
 *     writer's *Latitude / *Longitude. It matches bytes, not parsed XML, so a
 *     caption that spells "latitude" is refused too (fail closed, rare).
 *   - ExtendedXMP (FR-1164R, LS-1164 B1): an APP1 that starts with its
 *     signature, or XMP that says it has some (xmpNote:HasExtendedXMP). Its
 *     chunks may split any name ("GPSLati" | "tude"; Adobe XMP Part 3,
 *     1.1.3.1), so it is never read and always refused.
 *   - FLIR (FLIR-GPS-BE, LO-1187R4): the "FLIR\0" APP1 chunks, joined in
 *     order into one FFF block, hold a GPS record (type 0x2B) whose latitude
 *     (0x10) or longitude (0x18) is stored (not zero), or EXIF or XMP names
 *     in the joined bytes (an embedded image's, a name split over two
 *     chunks). Chunks out of order or missing, an FFF header, directory or
 *     record that does not fit, or a GPS record too short for a position
 *     answer true. A GPS record of zeros, or none, is no location.
 *
 * Where it looks (FR-1187R2, LS-1187R2 B2: the bucket keeps every byte and
 * serves them to members, so every place a JPEG can hold a location is read):
 *   - every APP1 before the first start-of-scan (SOS, 0xFFDA): a walk that
 *     never guesses clean (a truncated or malformed APP1, a segment that runs
 *     past the end, a broken marker, or bytes that end before SOS all answer
 *     true);
 *   - every APP1 after it, between the scans of a progressive JPEG, by the
 *     same walk the photo check's copy for OpenAI uses (walkJpeg in
 *     image-metadata.ts);
 *   - inside an EXIF APP1, everything after its TIFF header (its IFDs, their
 *     values and the EXIF JPEG thumbnail), read as bytes (FR-1187R3,
 *     LS-1187R3 B1: XMP and ExtendedXMP in an EXIF thumbnail);
 *   - every other APPn (APP0 to APP15 but APP1: a JFXX JPEG thumbnail, ICC,
 *     MPF, Photoshop's IPTC and XMP in APP13, any writer's own), read as
 *     bytes (FR-1187R3, LO-1187R3 N2);
 *   - everything after the first EOI (MPF's extra images, a motion photo's
 *     appended data, any trailing data), read as bytes.
 *   - the FLIR APP1 chunks up to the first EOI, also joined and walked as an
 *     FFF block (FLIR-GPS-BE).
 * Read as bytes (bytesLocated, the one reader for all three): any EXIF header
 * ("Exif\0\0" then a TIFF header) is read as EXIF above (unreadable =
 * located), and the text is matched for the XMP and ExtendedXMP names above,
 * so no structure inside has to be walked.
 * A JPEG whose segments after the first SOS cannot be walked answers false
 * here: the photo check's copy for OpenAI is the same walk, answers null, and
 * the send is refused (503 PHOTO_CHECK_UNAVAILABLE) with nothing published
 * (whether that should be a lasting 422 is the owner's call, b#1187 LO-1187R2
 * C4).
 *
 * Not covered (b#1164 and b#1187 "Found, not fixed"; this reader does not
 * rely on the phone's re-encode, SC-M4, for anything it does cover):
 *   - place names as words (IPTC City, Sublocation, LocationName; Photoshop
 *     City, State, Country; GPSAreaInformation): text, not coordinates, with
 *     no marker a byte match can use without refusing photos that have no
 *     location ("City" sits inside "Velocity"; EXIF's SubjectLocation is a
 *     pixel spot, not a place);
 *   - GPS fields that are not a position (altitude, bearing, speed, time,
 *     DOP; DJI's RtkStdLat / RtkStdLon accuracy figures): no place alone;
 *   - abbreviated names other than DJI's LRFTarget ones ("Lat", "Lon" sit
 *     inside ordinary words: "Translate", "Colon");
 *   - a StandardXMP packet cut over two XMP APP1 segments (each segment is
 *     matched alone; Adobe XMP Part 3 keeps StandardXMP in one APP1);
 *   - a location in a non-JPEG format after EOI (an appended motion-photo
 *     video's own location box, MP4 "\xA9xyz"), IPTC's own binary fields
 *     in APP13 (place names only, above), EXIF in Photoshop's resource 1058
 *     (no "Exif\0\0" header to find), comments, UTF-16 XMP, and bytes
 *     inside a scan's picture data;
 *   - binary maker records other than FLIR's (FLIR-GPS-BE "Found, not
 *     fixed"): a Parrot thermal TIFF in APP1 ("PARROT\0", no EXIF header to
 *     find), GoPro's GPMF in APP6, and an APP10 UTF-16 comment.
 */
import { walkJpeg } from './image-metadata';

const SOI = 0xd8;
const SOS = 0xda;
const APP0 = 0xe0;
const APP1 = 0xe1;
const APP15 = 0xef;
const GPS_INFO_TAG = 0x8825;
const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00]; // "Exif\0" (then one pad byte)
/** An EXIF header and the TIFF header after it, in either byte order: "Exif\0\0" then "II*\0" or "MM\0*". */
const EXIF_IN_BYTES = [Buffer.from('Exif\0\0II*\0', 'latin1'), Buffer.from('Exif\0\0MM\0*', 'latin1')];
/** XMP that names a location, in any letter case (FR-1164R2): see the header for what it covers. */
const XMP_LOCATION_NAME = /latitude|longt?itude|lrftargetl(?:at|on)/i;
/** XMP that says part of it sits in ExtendedXMP (not read, so refused); unchanged since FR-1164R. */
const HAS_EXTENDED_XMP = /HasExtendedXMP/;
const EXTENDED_XMP = 'http://ns.adobe.com/xmp/extension/\0'; // an ExtendedXMP chunk's signature
const FLIR_HEADER = [0x46, 0x4c, 0x49, 0x52, 0x00]; // "FLIR\0" (then a version byte, the chunk number, the last chunk number)
const FLIR_GPS_RECORD = 0x2b; // FFF record type GPSInfo

/** True when the JPEG carries a location anywhere it is read (see the header), or cannot be read to its first SOS. */
export function carriesLocation(jpeg: Uint8Array): boolean {
  return headerLocated(jpeg) || laterLocated(jpeg);
}

/** The segments before the first SOS (PHOTO-GPS): located, or not walkable to SOS. */
function headerLocated(b: Uint8Array): boolean {
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

/** FR-1187R2 (LS-1187R2 B2), FR-1187R3 (LO-1187R3 N2): every APPn to the first EOI, then every byte after it. */
function laterLocated(jpeg: Uint8Array): boolean {
  let located = false;
  const flir: Uint8Array[] = [];
  const after = walkJpeg(jpeg, (part) => {
    if (located || part.kind !== 'segment' || part.marker < APP0 || part.marker > APP15) return;
    const payload = jpeg.subarray(part.start + 4, part.end);
    if (part.marker === APP1 && FLIR_HEADER.every((c, k) => payload[k] === c)) flir.push(payload);
    located = part.marker === APP1 ? app1Located(payload) : bytesLocated(payload);
  });
  // A walk that stops is refused by the photo check (the same walk; see the header).
  return located || (flir.length > 0 && flirLocated(flir)) || (after !== null && bytesLocated(jpeg.subarray(after)));
}

/**
 * FLIR-GPS-BE (LO-1187R4): the FLIR APP1 chunks, joined in order into one FFF block (header, record directory, records),
 * located when a GPS record (type 0x2B) stores a latitude or longitude, or when the joined bytes hold EXIF or XMP names
 * (bytesLocated: an embedded image's EXIF, a name split over two chunks). Chunks out of order or missing, an FFF header,
 * directory or record that does not fit, or a GPS record too short to hold a position answer true (fail closed).
 */
function flirLocated(chunks: Uint8Array[]): boolean {
  if (chunks.some((c, k) => c.length < 8 || c[6] !== k || c[7] !== chunks.length - 1)) return true;
  const fff = Buffer.concat(chunks.map((c) => c.subarray(8)));
  const magic = fff.toString('latin1', 0, 4);
  if (fff.length < 0x40 || (magic !== 'FFF\0' && magic !== 'AFF\0')) return true;
  // The byte order is the one in which the FFF version reads 100 to 199, as exiftool decides it.
  const be = fff.readUInt32BE(0x14) >= 100 && fff.readUInt32BE(0x14) < 200;
  if (!be && (fff.readUInt32LE(0x14) < 100 || fff.readUInt32LE(0x14) >= 200)) return true;
  const u32 = (at: number) => (be ? fff.readUInt32BE(at) : fff.readUInt32LE(at));
  const dir = u32(0x18);
  const count = u32(0x1c);
  if (dir + count * 0x20 > fff.length) return true;
  for (let n = 0; n < count; n += 1) {
    const entry = dir + n * 0x20;
    const type = be ? fff.readUInt16BE(entry) : fff.readUInt16LE(entry);
    if (type === 0) continue;
    const at = u32(entry + 0x0c);
    const length = u32(entry + 0x10);
    if (at + length > fff.length) return true;
    // GPSInfo: latitude at 0x10, longitude at 0x18 (doubles); a stored value in either is a position.
    if (type === FLIR_GPS_RECORD && (length < 0x20 || fff.subarray(at + 0x10, at + 0x20).some((x) => x !== 0))) return true;
  }
  return bytesLocated(fff);
}

/** Bytes whose structure is not walked (a thumbnail, what follows EOI): any EXIF in them, or XMP's location names. */
function bytesLocated(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return exifInBytesLocated(b) || xmpTextLocated(b.toString('latin1'));
}

/** Each EXIF header in the bytes, read as EXIF from its TIFF header to the end of the bytes. */
function exifInBytesLocated(b: Buffer): boolean {
  for (const header of EXIF_IN_BYTES) {
    for (let at = b.indexOf(header); at >= 0; at = b.indexOf(header, at + 1)) {
      if (exifLocated(b.subarray(at + 6))) return true;
    }
  }
  return false;
}

function app1Located(payload: Uint8Array): boolean {
  if (EXIF_HEADER.every((c, k) => payload[k] === c)) {
    // FR-1187R3 (LS-1187R3 B1): an EXIF thumbnail is a JPEG with segments of its own (EXIF, XMP,
    // ExtendedXMP); the bytes after the TIFF header are read as bytes, like every other thumbnail.
    const tiff = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).subarray(6);
    return exifLocated(tiff) || bytesLocated(tiff.subarray(8));
  }
  const text = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString('latin1');
  return xmpTextLocated(text);
}

/** XMP's location names, a note that part of it sits in ExtendedXMP, or an ExtendedXMP chunk's signature. */
function xmpTextLocated(text: string): boolean {
  return text.includes(EXTENDED_XMP) || HAS_EXTENDED_XMP.test(text) || XMP_LOCATION_NAME.test(text);
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
