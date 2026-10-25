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

/** The photos the send check must refuse, by what they carry. */
export const LOCATED: Record<string, number[]> = {
  'GPS in EXIF, little endian': jpeg(JFIF, exifApp1(tiff('II', 3))),
  'GPS in EXIF, big endian': jpeg(JFIF, exifApp1(tiff('MM', 3))),
  'GPS only in XMP': jpeg(JFIF, xmpApp1(xmpPacket('exif:GPSLatitude="37,46.5N" exif:GPSLongitude="122,25.1W"'))),
  // An APP1 whose length runs past the end of the file.
  'a truncated APP1': [...SOI, ...JFIF, 0xff, 0xe1, 0x40, 0x00, ...latin1('Exif'), 0, 0, ...tiff('II').slice(0, 12)],
};

/** Photos the send check must accept. */
export const CLEAN: Record<string, number[]> = {
  'EXIF without GPS': jpeg(JFIF, exifApp1(tiff('II'))),
  'no EXIF': jpeg(JFIF),
};
