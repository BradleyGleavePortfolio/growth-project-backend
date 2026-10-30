/**
 * PHOTO-GPS (agent 174): does a space photo carry a location?
 *
 * A pure reader over the whole JPEG (the upload check reads every byte; the
 * bucket's cap is IMAGE_MAX_BYTES, 10 MB). It answers true when a segment
 * or bytes it reads ("Where it looks", below) carry a location:
 *   - EXIF: a GPSInfo pointer (tag 0x8825) to a GPS IFD with at least one
 *     entry, in either byte order ("II" little or "MM" big endian), in any
 *     directory the TIFF reaches (FR-1189R2, LO-1189R2 B1, as exiftool reads
 *     them): IFD0 and the next-IFD chain after it (IFD1 and later), and the
 *     Exif IFD (0x8769), the Interop IFD (0xA005) and the SubIFDs (0x014A)
 *     of any of those; an IFD0 or GPSInfo pointer past the end answers true,
 *     and any other directory is read as far as the TIFF holds it (one past
 *     the end, or already read, holds nothing more: see exifLocated);
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
 *     answer true. A GPS record of zeros, or none, is no location; nor is
 *     one whose GPSValid is 0 and whose latitude and longitude are both
 *     exactly -1 (FLIR's "no fix"; FR-1189, LO-1189 C1).
 *   - FR-1189 (LO-1189 B2: each of these was refused at 436cf4bc behind a
 *     header past 256 KB, and posted after it), failing closed like EXIF:
 *     a Parrot thermal TIFF in APP1 ("PARROT\0" then a TIFF header, read as
 *     EXIF); EXIF in Photoshop's resources 1058 and 1059 ("8BIM" then the id,
 *     a TIFF with no "Exif\0\0" header); GoPro's GPMF in APP6 ("GoPro\0"):
 *     a GPS5 or GPS9 stream with a stored sample; XMP names in UTF-16 text
 *     (either byte order) and, FR-1189R2 (LO-1189R2 B1), UTF-32 text (either
 *     byte order); and an MP4 position (a "\xA9xyz"
 *     atom's ISO 6709 text, or Apple's location.ISO6709 key), as in a
 *     motion photo's appended video.
 *   - FR-1189 (LO-1189 B1): one check reads at most 200,000 IFD entries
 *     (each directory is charged its entries and one) over every EXIF it
 *     finds (a real photo reads tens); past that the photo is located, so
 *     many EXIF headers sharing one large IFD cannot hold the check for long.
 *   - FR-1189R2 (LO-1189R2 C1, LS-1189R2 B2): one check reads at most 1,000
 *     segments (every segment before the first SOS, every APPn after it);
 *     past that the photo is located (unreadable, fail closed), so a 10 MB
 *     file of tiny segments cannot hold the check for seconds. See
 *     SEGMENT_BUDGET for why 1,000.
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
 *     appended data, any trailing data), read as bytes;
 *   - the FLIR APP1 chunks up to the first EOI, also joined and walked as an
 *     FFF block (FLIR-GPS-BE);
 *   - FR-1189: what a writer splits over several APPn, joined before it is
 *     read as bytes: the Photoshop APP13 segments in order, and the APP11
 *     JUMBF (C2PA) segments in sequence order per box (a name or header cut
 *     over two segments is found). FR-1189R2 (LS-1189R2 B1): the Photoshop
 *     segments are read only once joined (one segment is its own join), so a
 *     resource a writer continues in the next APP13 is judged whole, and one
 *     that is still cut short once joined answers true; a JUMBF box is read
 *     once per segment and once joined only when it has two parts or more.
 * Read as bytes (bytesLocated, the one reader for all of these): any EXIF
 * header ("Exif\0\0" then a TIFF header) and any Photoshop 1058 or 1059
 * resource is read as EXIF above (unreadable = located), and the text is
 * matched for the XMP, ExtendedXMP and MP4 names above, so no structure
 * inside has to be walked.
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
 *   - a location in a non-JPEG format after EOI other than MP4's above,
 *     IPTC's own binary fields in APP13 (place names only, above), comments,
 *     an APP10 UTF-16 comment (place names), and bytes inside a scan's
 *     picture data;
 *   - binary maker records other than FLIR's, Parrot's and GoPro's above.
 */
import { walkJpeg } from './image-metadata';

const SOI = 0xd8;
const SOS = 0xda;
const APP0 = 0xe0;
const APP1 = 0xe1;
const APP6 = 0xe6;
const APP11 = 0xeb;
const APP13 = 0xed;
const APP15 = 0xef;
const GPS_INFO_TAG = 0x8825;
/** FR-1189R2 (LO-1189R2 B1): the pointers to more directories, read as exiftool reads them: Exif IFD, Interop IFD, SubIFDs. */
const EXIF_IFD_TAG = 0x8769;
const INTEROP_IFD_TAG = 0xa005;
const SUB_IFDS_TAG = 0x014a;
const EXIF_HEADER = Buffer.from('Exif\0', 'latin1'); // then one pad byte
/** An EXIF header and the TIFF header after it, in either byte order: "Exif\0\0" then "II*\0" or "MM\0*". */
const EXIF_IN_BYTES = [Buffer.from('Exif\0\0II*\0', 'latin1'), Buffer.from('Exif\0\0MM\0*', 'latin1')];
/** XMP that names a location, in any letter case (FR-1164R2): see the header for what it covers. */
const XMP_LOCATION_NAME = /latitude|longt?itude|lrftargetl(?:at|on)/i;
/** XMP that says part of it sits in ExtendedXMP (not read, so refused); unchanged since FR-1164R. */
const HAS_EXTENDED_XMP = /HasExtendedXMP/;
const EXTENDED_XMP = 'http://ns.adobe.com/xmp/extension/\0'; // an ExtendedXMP chunk's signature
/** FR-1189 (LO-1189 B2): an MP4 / QuickTime position, a "\xA9xyz" atom's ISO 6709 text or Apple's location key. */
const MP4_LOCATION = /\xa9xyz[\s\S]{0,8}[+-]\d|location\.ISO6709/;
const FLIR_HEADER = Buffer.from('FLIR\0', 'latin1'); // then a version byte, the chunk number, the last chunk number
const FLIR_GPS_RECORD = 0x2b; // FFF record type GPSInfo
const PARROT_HEADER = Buffer.from('PARROT\0', 'latin1'); // then a TIFF header (exiftool: JPEG APP1 "Parrot")
const GOPRO_HEADER = Buffer.from('GoPro\0', 'latin1'); // then GPMF (exiftool: GoPro::GPMF)
const GOPRO_GPS = [Buffer.from('GPS5', 'latin1'), Buffer.from('GPS9', 'latin1')];
const PHOTOSHOP_HEADER = Buffer.from('Photoshop 3.0\0', 'latin1');
/** Photoshop image resources 1058 (0x0422, EXIFInfo) and 1059 (0x0423, ExifInfo2): a TIFF with no "Exif\0\0" header. */
const PHOTOSHOP_EXIF = [Buffer.from('8BIM\x04\x22', 'latin1'), Buffer.from('8BIM\x04\x23', 'latin1')];
/** FR-1189 (LO-1189 B1): the IFD entries one check may read, over every EXIF it finds; past it the photo is located. */
const EXIF_ENTRY_BUDGET = 200_000;
/**
 * FR-1189R2 (LO-1189R2 C1, LS-1189R2 B2): the segments one check may read (every segment before the first SOS, every APPn
 * after it); past it the photo is located. The 524-photo corpus has at most 48 APPn segments in one photo (56 counted this
 * way); a 10 MB upload made only of full 64 KB segments has 159. 1,000 is 17 times the corpus and 6 times that.
 */
const SEGMENT_BUDGET = 1_000;

type Budget = { entries: number; segments: number };

const asBuffer = (bytes: Uint8Array): Buffer => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const startsWith = (b: Uint8Array, header: Buffer): boolean => b.length >= header.length && header.every((c, k) => b[k] === c);

/** True when the JPEG carries a location anywhere it is read (see the header), or cannot be read to its first SOS. */
export function carriesLocation(jpeg: Uint8Array): boolean {
  const budget: Budget = { entries: EXIF_ENTRY_BUDGET, segments: SEGMENT_BUDGET };
  const sos = headerScan(jpeg, budget);
  return sos === null || laterLocated(jpeg, sos, budget);
}

/**
 * The segments before the first SOS (PHOTO-GPS): where its marker sits, or null when one is located, the bytes are
 * not walkable to SOS, or (FR-1189R2) there are more segments than the check reads.
 */
function headerScan(b: Uint8Array, budget: Budget): number | null {
  if (b.length < 2 || b[0] !== 0xff || b[1] !== SOI) return null;
  let i = 2;
  for (;;) {
    if (i >= b.length || b[i] !== 0xff) return null;
    while (i < b.length && b[i] === 0xff) i += 1; // fill bytes before a marker
    if (i >= b.length) return null;
    const marker = b[i];
    if (marker === SOS) return i;
    // Markers with no length (TEM, RSTn, SOI, EOI) or a stuffed zero do not belong before SOS.
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) return null;
    if (i + 2 >= b.length) return null;
    const length = (b[i + 1] << 8) | b[i + 2];
    const end = i + 1 + length;
    if (length < 2 || end > b.length) return null;
    if ((budget.segments -= 1) < 0) return null;
    if (marker === APP1 && app1Located(b.subarray(i + 3, end), budget)) return null;
    i = end;
  }
}

/**
 * FR-1187R2 (LS-1187R2 B2), FR-1187R3 (LO-1187R3 N2): every APPn to the first EOI, then every byte after it.
 * FR-1189 (LO-1189 B2): also GoPro's APP6 GPS streams, and the APPn kinds a writer splits over several
 * segments joined before they are read: FLIR's FFF block, Photoshop's APP13 resources and APP11 JUMBF boxes.
 */
function laterLocated(jpeg: Uint8Array, sos: number, budget: Budget): boolean {
  let located = false;
  const flir: Uint8Array[] = [];
  const photoshop: Uint8Array[] = [];
  const jumbf: Buffer[] = [];
  const after = walkJpeg(jpeg, (part) => {
    if (located || part.kind !== 'segment' || part.marker < APP0 || part.marker > APP15) return;
    // FR-1189R2 (LO-1189R2 C1): a segment before the first SOS was counted, and its APP1 read, by headerScan.
    const before = part.start < sos;
    if (!before && (budget.segments -= 1) < 0) {
      located = true;
      return;
    }
    const payload = asBuffer(jpeg.subarray(part.start + 4, part.end));
    if (part.marker === APP1 && startsWith(payload, FLIR_HEADER)) flir.push(payload);
    if (part.marker === APP11 && payload.length >= 16 && payload[0] === 0x4a && payload[1] === 0x50) jumbf.push(payload); // "JP"
    // FR-1189R2 (LS-1189R2 B1): Photoshop's resources are read once joined, below, so one continued in the next APP13 is whole.
    if (part.marker === APP13 && startsWith(payload, PHOTOSHOP_HEADER)) photoshop.push(payload.subarray(PHOTOSHOP_HEADER.length));
    else if (part.marker === APP1) located = !before && app1Located(payload, budget);
    else located = (part.marker === APP6 && startsWith(payload, GOPRO_HEADER) && goProLocated(payload)) || bytesLocated(payload, budget);
  });
  // A walk that stops is refused by the photo check (the same walk; see the header).
  return (
    located ||
    (flir.length > 0 && flirLocated(flir, budget)) ||
    (photoshop.length > 0 && bytesLocated(Buffer.concat(photoshop), budget)) ||
    (jumbf.length > 0 && jumbfLocated(jumbf, budget)) ||
    (after !== null && bytesLocated(jpeg.subarray(after), budget))
  );
}

/**
 * FLIR-GPS-BE (LO-1187R4): the FLIR APP1 chunks, joined in order into one FFF block (header, record directory, records),
 * located when a GPS record (type 0x2B) stores a latitude or longitude, or when the joined bytes hold EXIF or XMP names
 * (bytesLocated: an embedded image's EXIF, a name split over two chunks). Chunks out of order or missing, an FFF header,
 * directory or record that does not fit, or a GPS record too short to hold a position answer true (fail closed).
 */
function flirLocated(chunks: Uint8Array[], budget: Budget): boolean {
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
    if (type === FLIR_GPS_RECORD && (length < 0x20 || flirPositionStored(fff.subarray(at, at + length), be))) return true;
  }
  return bytesLocated(fff, budget);
}

/**
 * A FLIR GPS record's latitude (0x10) and longitude (0x18), doubles: a stored value in either is a position. Not one:
 * both zero (every byte), or FR-1189 (LO-1189 C1) GPSValid (u32 at 0) of 0 with both exactly -1.0, FLIR's "no fix", read
 * in the record's byte order (little endian, as exiftool reads FLIR::GPSInfo) or the FFF block's.
 */
function flirPositionStored(record: Buffer, be: boolean): boolean {
  if (record.subarray(0x10, 0x20).every((x) => x === 0)) return false;
  const noFix = (le: boolean) =>
    (le ? record.readUInt32LE(0) : record.readUInt32BE(0)) === 0 &&
    (le ? record.readDoubleLE(0x10) : record.readDoubleBE(0x10)) === -1 &&
    (le ? record.readDoubleLE(0x18) : record.readDoubleBE(0x18)) === -1;
  return !(noFix(true) || noFix(!be));
}

/**
 * FR-1189 (LO-1189 B2): GoPro's GPMF in APP6. A GPS5 or GPS9 stream (a key, a type, a sample size, a u16 sample count,
 * then the samples) with any sample byte stored is a location; one of zeros, or with no samples, is not; one cut short
 * answers true. Each byte is checked once: a stream inside another's samples is only checked past them.
 */
function goProLocated(b: Buffer): boolean {
  for (const key of GOPRO_GPS) {
    let zeroTo = 0;
    for (let at = b.indexOf(key); at >= 0; at = b.indexOf(key, at + 1)) {
      if (at + 8 > b.length) return true;
      const end = at + 8 + b[at + 5] * b.readUInt16BE(at + 6);
      if (end > b.length) return true;
      for (let k = Math.max(at + 8, zeroTo); k < end; k += 1) if (b[k] !== 0) return true;
      zeroTo = Math.max(zeroTo, end);
    }
  }
  return false;
}

/**
 * FR-1189 (LO-1189 B2): APP11 JUMBF (C2PA). Each segment is "JP", the box instance En (2 bytes), a u32 sequence Z, then
 * the box header (LBox, TBox, and XLBox when LBox is 1) repeated, then the box's next bytes. They are joined in Z order
 * per box type (as exiftool joins them) and per En and type, the first segment of each Z kept, then read as bytes, so a
 * name or an EXIF header split over two segments is found. FR-1189R2 (LS-1189R2 B2): at most SEGMENT_BUDGET segments
 * reach here, and a box of one part is not read again (the walk read its whole segment).
 */
function jumbfLocated(segments: Buffer[], budget: Budget): boolean {
  const boxes = new Map<string, Map<number, Buffer>>();
  for (const s of segments) {
    const header = s.readUInt32BE(8) === 1 && s.length >= 24 ? 16 : 8;
    const type = s.toString('latin1', 12, 16);
    for (const key of [type, s.toString('latin1', 2, 4) + type]) {
      const parts = boxes.get(key) ?? new Map<number, Buffer>();
      if (!parts.has(s.readUInt32BE(4))) parts.set(s.readUInt32BE(4), s.subarray(8 + header));
      boxes.set(key, parts);
    }
  }
  for (const parts of boxes.values()) {
    if (parts.size < 2) continue;
    const ordered = [...parts.entries()].sort(([x], [y]) => x - y).map(([, part]) => part);
    if (bytesLocated(Buffer.concat(ordered), budget)) return true;
  }
  return false;
}

/** Bytes whose structure is not walked (a thumbnail, what follows EOI): any EXIF in them, or location text. */
function bytesLocated(bytes: Uint8Array, budget: Budget): boolean {
  if (bytes.length === 0) return false;
  const b = asBuffer(bytes);
  return exifInBytesLocated(b, budget) || photoshopExifLocated(b, budget) || textLocated(b.toString('latin1')) || utf16Located(b);
}

/**
 * FR-1189 (LO-1189 B2): XMP's location names (and the ExtendedXMP note) in UTF-16 text, little or big endian, at an even
 * or an odd offset: the bytes read as UTF-16LE from offset 0 and from offset 1 cover all four. FR-1189R2 (LO-1189R2 B1):
 * and UTF-32, either byte order: read that way each letter has a U+0000 after it, so the U+0000s are taken out first.
 */
function utf16Located(b: Buffer): boolean {
  if (b.length < 2 || !b.includes(0)) return false;
  return [b, b.subarray(1)].some((from) => {
    const text = from.toString('utf16le').replaceAll('\0', '');
    return HAS_EXTENDED_XMP.test(text) || XMP_LOCATION_NAME.test(text);
  });
}

/** Each EXIF header in the bytes, read as EXIF from its TIFF header to the end of the bytes. */
function exifInBytesLocated(b: Buffer, budget: Budget): boolean {
  for (const header of EXIF_IN_BYTES) {
    for (let at = b.indexOf(header); at >= 0; at = b.indexOf(header, at + 1)) {
      if (exifLocated(b.subarray(at + 6), budget)) return true;
    }
  }
  return false;
}

/**
 * FR-1189 (LO-1189 B2): each Photoshop resource 1058 or 1059 in the bytes ("8BIM", the id, a Pascal name padded to an
 * even length, a u32 size, then a TIFF), read as EXIF. A resource that runs past the bytes answers true.
 */
function photoshopExifLocated(b: Buffer, budget: Budget): boolean {
  for (const header of PHOTOSHOP_EXIF) {
    for (let at = b.indexOf(header); at >= 0; at = b.indexOf(header, at + 1)) {
      const name = at + header.length;
      const sizeAt = name + ((b[name] + 2) & ~1);
      if (name >= b.length || sizeAt + 4 > b.length) return true;
      const start = sizeAt + 4;
      const end = start + b.readUInt32BE(sizeAt);
      if (end > b.length || exifLocated(b.subarray(start, end), budget)) return true;
    }
  }
  return false;
}

function app1Located(payload: Uint8Array, budget: Budget): boolean {
  const b = asBuffer(payload);
  if (startsWith(b, EXIF_HEADER)) {
    // FR-1187R3 (LS-1187R3 B1): an EXIF thumbnail is a JPEG with segments of its own (EXIF, XMP,
    // ExtendedXMP); the bytes after the TIFF header are read as bytes, like every other thumbnail.
    const tiff = b.subarray(6);
    return exifLocated(tiff, budget) || bytesLocated(tiff.subarray(8), budget);
  }
  // A FLIR chunk alone can cut an embedded image's EXIF; its text is matched here, its bytes once joined (flirLocated).
  if (startsWith(b, FLIR_HEADER)) return textLocated(b.toString('latin1')) || utf16Located(b);
  // FR-1189 (LO-1189 B2): a Parrot thermal TIFF, read as EXIF as exiftool reads it, then its bytes.
  if (startsWith(b, PARROT_HEADER)) {
    const tiff = b.subarray(PARROT_HEADER.length);
    return exifLocated(tiff, budget) || bytesLocated(tiff.subarray(8), budget);
  }
  // XMP, and any other writer's APP1, read as bytes (FR-1189: an EXIF or Photoshop block inside is read too).
  return bytesLocated(b, budget);
}

/** XMP's location names, a note that part of it sits in ExtendedXMP, an ExtendedXMP chunk's signature, an MP4 position (FR-1189). */
function textLocated(text: string): boolean {
  return text.includes(EXTENDED_XMP) || HAS_EXTENDED_XMP.test(text) || XMP_LOCATION_NAME.test(text) || MP4_LOCATION.test(text);
}

/**
 * EXIF (a TIFF structure): a GPSInfo entry points at a GPS IFD with entries, in IFD0, the next-IFD chain after it (IFD1
 * and later), or (FR-1189R2, LO-1189R2 B1) the Exif, Interop and SubIFD directories any of them points at. Unreadable =
 * located: a TIFF header or IFD0 that is not all there, or a GPSInfo pointer past the end. Any other directory is read
 * as far as the TIFF holds it: one that starts past the end, or that was already read (a loop), holds nothing more, and
 * only the entries wholly inside are read (a reader cannot show one that is not there; exiftool warns and skips such a
 * directory, and real cameras write them: the corpus's Canon PowerShot S30, Kodak ProBack and FLIR T640). FR-1189
 * (LO-1189 B1): each directory is charged the entries it reads (and one) against the check's budget; a check past its
 * budget is located.
 */
function exifLocated(tiff: Uint8Array, budget: Budget): boolean {
  try {
    const v = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
    const order = v.getUint16(0);
    if (order !== 0x4949 && order !== 0x4d4d) return true;
    const le = order === 0x4949;
    if (v.getUint16(2, le) !== 42) return true;
    const ifd0 = v.getUint32(4, le);
    if (ifd0 + 2 + v.getUint16(ifd0, le) * 12 > tiff.length) return true;
    const read = new Set<number>();
    // Each directory to read, and whether its next-IFD offset is followed (IFD0's chain only, as exiftool reads it).
    const todo: Array<[number, boolean]> = [[ifd0, true]];
    for (let next = todo.pop(); next; next = todo.pop()) {
      const [ifd, chain] = next;
      if (read.has(ifd) || ifd + 2 > tiff.length) continue;
      read.add(ifd);
      const count = Math.min(v.getUint16(ifd, le), Math.floor((tiff.length - ifd - 2) / 12));
      budget.entries -= 1 + count;
      if (budget.entries < 0) return true;
      const end = ifd + 2 + count * 12;
      for (let entry = ifd + 2; entry < end; entry += 12) {
        const tag = v.getUint16(entry, le);
        if (tag === GPS_INFO_TAG && v.getUint16(v.getUint32(entry + 8, le), le) > 0) return true;
        if (tag === EXIF_IFD_TAG || tag === INTEROP_IFD_TAG) todo.push([v.getUint32(entry + 8, le), false]);
        if (tag === SUB_IFDS_TAG) {
          // SubIFDs: n offsets, inline when n is 1, else at the entry's value offset; each read is charged like an entry.
          const at = v.getUint32(entry + 4, le) === 1 ? entry + 8 : v.getUint32(entry + 8, le);
          const n = Math.min(v.getUint32(entry + 4, le), Math.max(0, Math.floor((tiff.length - at) / 4)));
          budget.entries -= n;
          if (budget.entries < 0) return true;
          for (let k = 0; k < n; k += 1) todo.push([v.getUint32(at + k * 4, le), false]);
        }
      }
      // An IFD whose next-IFD offset is not there has none (a writer may stop at its last entry).
      const after = chain && end + 4 <= tiff.length ? v.getUint32(end, le) : 0;
      if (after !== 0) todo.push([after, true]);
    }
    return false;
  } catch {
    // A read past the segment (RangeError): the TIFF header, IFD0 or a GPSInfo pointer is not there.
    return true;
  }
}
