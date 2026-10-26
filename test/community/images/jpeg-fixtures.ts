/**
 * PHOTO-GPS: JPEG files built byte by byte for the location reader
 * (src/community/images/image-location.ts) and the send check. Each is the
 * real segment layout (SOI, APPn segments, SOS, a little scan data, EOI);
 * only the picture data is fake, which the reader never looks at.
 */
export type ByteOrder = 'II' | 'MM';

const latin1 = (s: string): number[] => [...Buffer.from(s, 'latin1')];

/** One marker segment: FF, marker, 2-byte big-endian length (counting itself), payload. */
export const segment = (marker: number, payload: number[]): number[] => [
  0xff,
  marker,
  ((payload.length + 2) >> 8) & 0xff,
  (payload.length + 2) & 0xff,
  ...payload,
];

export const SOI = [0xff, 0xd8];
export const JFIF = segment(0xe0, [...latin1('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
/** SOS, some scan bytes (one stuffed FF 00), EOI. */
export const SCAN = [...segment(0xda, [1, 1, 0, 0, 0x3f, 0]), 0x12, 0xff, 0x00, 0x34, 0xff, 0xd9];

/** SOI, the given segments, then the scan. */
export const jpeg = (...segments: number[][]): number[] => [...SOI, ...segments.flat(), ...SCAN];

/**
 * A TIFF body as EXIF holds it: IFD0 with an Orientation entry and, when
 * `gps` is given, a GPSInfo (0x8825) pointer to a GPS IFD of that many entries.
 */
export function tiff(order: ByteOrder, gps?: number): number[] {
  const le = order === 'II';
  const u16 = (n: number) => (le ? [n & 0xff, (n >> 8) & 0xff] : [(n >> 8) & 0xff, n & 0xff]);
  const u32 = (n: number) => (le ? [...u16(n & 0xffff), ...u16(n >>> 16)] : [...u16(n >>> 16), ...u16(n & 0xffff)]);
  const count = gps === undefined ? 1 : 2;
  const gpsAt = 8 + 2 + count * 12 + 4;
  const entries = [[...u16(0x0112), ...u16(3), ...u32(1), ...u16(1), 0, 0]];
  if (gps !== undefined) entries.push([...u16(0x8825), ...u16(4), ...u32(1), ...u32(gpsAt)]);
  // GPS entries: ASCII refs, inline ("N", "E", ...), enough to say "this photo has a place".
  const gpsIfd =
    gps === undefined
      ? []
      : [...u16(gps), ...Array.from({ length: gps }, (_, k) => [...u16(k + 1), ...u16(2), ...u32(2), 0x4e, 0, 0, 0]).flat(), ...u32(0)];
  return [...latin1(order), ...u16(42), ...u32(8), ...u16(count), ...entries.flat(), ...u32(0), ...gpsIfd];
}

/** APP1 EXIF segment around a TIFF body. */
export const exifApp1 = (body: number[]): number[] => segment(0xe1, [...latin1('Exif'), 0, 0, ...body]);

/** APP1 XMP segment around a packet. */
export const xmpApp1 = (xml: string): number[] => segment(0xe1, [...latin1('http://ns.adobe.com/xap/1.0/'), 0, ...latin1(xml)]);

export const xmpPacket = (description: string): string =>
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
  `<rdf:Description rdf:about="" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" ${description}/>` +
  '</rdf:RDF></x:xmpmeta>';

/** FR-1164R (LS-1164 B1): ExtendedXMP, Adobe XMP Part 3 1.1.3.1: signature, GUID, full length and offset (big endian), a chunk. */
export const extendedXmpApp1 = (guid: string, full: number, offset: number, chunk: string): number[] => {
  const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  return segment(0xe1, [...latin1('http://ns.adobe.com/xmp/extension/'), 0, ...latin1(guid), ...u32(full), ...u32(offset), ...latin1(chunk)]);
};

export const EXTENDED_GUID = '2E3B9C6F0A4D4E1B8C7A5F9D3B1E6C04';
/** StandardXMP that says the rest of its packet is in ExtendedXMP chunks (xmpNote:HasExtendedXMP). */
export const HAS_EXTENDED_XMP = xmpApp1(xmpPacket(`xmlns:xmpNote="http://ns.adobe.com/xmp/note/" xmpNote:HasExtendedXMP="${EXTENDED_GUID}"`));
const EXTENDED = xmpPacket('exif:GPSLatitude="1,0.0N"');
const CUT = EXTENDED.indexOf('GPSLatitude') + 'GPSLati'.length;
/** The two ExtendedXMP chunks of a packet whose only GPS name is split between them: "GPSLati" | "tude". */
export const SPLIT_GPS_CHUNKS = [
  extendedXmpApp1(EXTENDED_GUID, EXTENDED.length, 0, EXTENDED.slice(0, CUT)),
  extendedXmpApp1(EXTENDED_GUID, EXTENDED.length, CUT, EXTENDED.slice(CUT)),
];

const DJI = 'xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/"';
const EARTH_POSE = 'xmlns:EarthPose="http://ns.google.com/photos/dd/1.0/earthpose/"';
/** FR-1164R2 (LS-1164R B1): XMP a photo carries with no location: editor, HDR, drone flight fields, a depth namespace. */
export const XMP_NO_LOCATION = xmpPacket(
  `xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" ${DJI} ${EARTH_POSE} ` +
    'xmp:CreatorTool="TGP" xmp:CreateDate="2026-01-01T00:00:00" hdrgm:Version="1.0" exif:SubjectLocation="1 1" ' +
    'drone-dji:RelativeAltitude="+1.00" drone-dji:FlightYawDegree="+1.00" drone-dji:RtkStdLat="0.01"',
);

/** The photos the send check must refuse, by what they carry. */
export const LOCATED: Record<string, number[]> = {
  'GPS in EXIF, little endian': jpeg(JFIF, exifApp1(tiff('II', 3))),
  'GPS in EXIF, big endian': jpeg(JFIF, exifApp1(tiff('MM', 3))),
  'GPS only in XMP': jpeg(JFIF, xmpApp1(xmpPacket('exif:GPSLatitude="1,0.0N" exif:GPSLongitude="2,0.0E"'))),
  // An APP1 whose length runs past the end of the file.
  'a truncated APP1': [...SOI, ...JFIF, 0xff, 0xe1, 0x40, 0x00, ...latin1('Exif'), 0, 0, ...tiff('II').slice(0, 12)],
  // FR-1164R (LS-1164 B1): ExtendedXMP is never read, so it is refused, with or without a GPS name in it.
  'a GPS name split across two ExtendedXMP chunks': jpeg(JFIF, HAS_EXTENDED_XMP, ...SPLIT_GPS_CHUNKS),
  'an ExtendedXMP chunk with no GPS name': jpeg(JFIF, extendedXmpApp1(EXTENDED_GUID, 40, 0, xmpPacket('xmp:CreatorTool="TGP"').slice(0, 40))),
  // FR-1164R2 (LS-1164R B1): other writers' location names in StandardXMP, any letter case, beside an EXIF with no GPS (an edited
  // photo that kept its XMP but not its EXIF GPS). Values are made up.
  "DJI's GpsLatitude and GpsLongitude in XMP": jpeg(
    JFIF,
    exifApp1(tiff('II')),
    xmpApp1(xmpPacket(`${DJI} drone-dji:GpsLatitude="+1.00000000" drone-dji:GpsLongitude="+2.00000000"`)),
  ),
  "Dynamic Depth's EarthPose Latitude and Longitude in XMP": jpeg(
    JFIF,
    xmpApp1(xmpPacket(`${EARTH_POSE} EarthPose:Latitude="1.0" EarthPose:Longitude="2.0"`)),
  ),
  'a GPS name in another letter case in XMP': jpeg(JFIF, xmpApp1(xmpPacket('exif:gpslatitude="1,0.0N" exif:GPSLONGITUDE="2,0.0E"'))),
};

/** Photos the send check must accept. */
export const CLEAN: Record<string, number[]> = {
  'EXIF without GPS': jpeg(JFIF, exifApp1(tiff('II'))),
  'no EXIF': jpeg(JFIF),
  'XMP with no location': jpeg(JFIF, exifApp1(tiff('II')), xmpApp1(XMP_NO_LOCATION)),
};
