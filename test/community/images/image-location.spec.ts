/**
 * PHOTO-GPS (agent 174): the location reader over a JPEG's first bytes
 * (src/community/images/image-location.ts). Every photo is built byte by
 * byte in jpeg-fixtures.ts; the send check is in community-images.e2e.spec.ts.
 */
import { carriesLocation, LOCATION_READ_BYTES } from '../../../src/community/images/image-location';
import {
  CLEAN,
  exifApp1,
  EXTENDED_GUID,
  extendedXmpApp1,
  HAS_EXTENDED_XMP,
  JFIF,
  jpeg,
  LOCATED,
  SCAN,
  segment,
  SOI,
  SPLIT_GPS_CHUNKS,
  tiff,
  xmpApp1,
  XMP_NO_LOCATION,
  xmpPacket,
} from './jpeg-fixtures';

const located = (bytes: number[]) => carriesLocation(Uint8Array.from(bytes));

describe('carriesLocation (PHOTO-GPS)', () => {
  it.each(Object.entries(LOCATED))('a photo with %s carries a location', (_name, bytes) => {
    expect(located(bytes)).toBe(true);
  });

  it.each(Object.entries(CLEAN))('a photo with %s carries none', (_name, bytes) => {
    expect(located(bytes)).toBe(false);
  });

  it('reads EXIF in both byte orders: a GPSInfo pointer to a GPS IFD with any entry is a location, an empty GPS IFD is not', () => {
    for (const order of ['II', 'MM'] as const) {
      expect(located(jpeg(JFIF, exifApp1(tiff(order, 1))))).toBe(true);
      expect(located(jpeg(JFIF, exifApp1(tiff(order, 0))))).toBe(false);
      expect(located(jpeg(JFIF, exifApp1(tiff(order))))).toBe(false);
    }
    // The EXIF APP1 straight after SOI, as cameras write it, and after other segments.
    expect(located([...SOI, ...exifApp1(tiff('MM', 2)), ...SCAN])).toBe(true);
    expect(located(jpeg(JFIF, segment(0xe2, [1, 2, 3]), exifApp1(tiff('II', 2))))).toBe(true);
  });

  it('reads XMP: GPSLatitude or GPSLongitude as an attribute or an element is a location; other XMP is not', () => {
    expect(located(jpeg(JFIF, xmpApp1(xmpPacket('exif:GPSLatitude="1,0.0N"'))))).toBe(true);
    expect(located(jpeg(JFIF, xmpApp1(xmpPacket('exif:GPSLongitude="2,0.0E"'))))).toBe(true);
    const element = xmpPacket('').replace('/>', '><exif:GPSLatitude>1,0.0N</exif:GPSLatitude></rdf:Description>');
    expect(located(jpeg(JFIF, xmpApp1(element)))).toBe(true);
    expect(located(jpeg(JFIF, xmpApp1(xmpPacket('xmp:CreatorTool="TGP"'))))).toBe(false);
    // XMP beside a clean EXIF still counts.
    expect(located(jpeg(JFIF, exifApp1(tiff('II')), xmpApp1(xmpPacket('exif:GPSLatitude="1,0N"'))))).toBe(true);
  });

  it('reads every documented XMP location name, in any letter case, as an attribute or an element (LS-1164R B1)', () => {
    const names = [
      // EXIF's GPS names in XMP
      ...['exif:GPSLatitude', 'exif:GPSLongitude', 'exif:GPSDestLatitude', 'exif:GPSDestLongitude'],
      // DJI: "Longtitude" [sic] is how some DJI drones write it; the older names; the laser range target
      ...['drone-dji:GpsLatitude', 'drone-dji:GpsLongitude', 'drone-dji:GpsLongtitude'],
      ...['drone-dji:Latitude', 'drone-dji:Longitude', 'drone-dji:LRFTargetLat', 'drone-dji:LRFTargetLon'],
      // Google Dynamic Depth's EarthPose
      ...['EarthPose:Latitude', 'EarthPose:Longitude'],
      // any letter case
      ...['exif:gpslatitude', 'exif:GPSLONGITUDE', 'drone-dji:gPsLaTiTuDe', 'drone-dji:gpslongtitude', 'drone-dji:lrftargetlon'],
    ];
    for (const name of names) {
      expect([name, located(jpeg(JFIF, xmpApp1(xmpPacket(`${name}="+1.0"`))))]).toEqual([name, true]);
      const element = xmpPacket('').replace('/>', `><${name}>+1.0</${name}></rdf:Description>`);
      expect([name, located(jpeg(JFIF, exifApp1(tiff('MM')), xmpApp1(element)))]).toEqual([name, true]);
    }
    expect(located(jpeg(JFIF, xmpApp1(xmpPacket('xmpNote:hasextendedxmp="1"'))))).toBe(true); // the ExtendedXMP advert, any case
  });

  it('XMP with no location stays clean: editor, HDR and drone flight fields, a depth namespace, a pixel SubjectLocation', () => {
    expect(located(jpeg(JFIF, xmpApp1(XMP_NO_LOCATION)))).toBe(false);
    expect(located(jpeg(JFIF, exifApp1(tiff('MM')), xmpApp1(XMP_NO_LOCATION)))).toBe(false);
  });

  it('refuses ExtendedXMP, which it never reads: its chunks can split a GPS name (LS-1164 B1)', () => {
    // The counterexample: no single segment names GPSLatitude; only the joined chunks do.
    const gpsName = (seg: number[]) => /latitude|longt?itude/i.test(Buffer.from(seg).toString('latin1'));
    expect([HAS_EXTENDED_XMP, ...SPLIT_GPS_CHUNKS].map(gpsName)).toEqual([false, false, false]);
    expect(located(jpeg(JFIF, HAS_EXTENDED_XMP, ...SPLIT_GPS_CHUNKS))).toBe(true);
    expect(located(jpeg(JFIF, ...SPLIT_GPS_CHUNKS))).toBe(true); // the chunks' signature alone
    expect(located(jpeg(JFIF, SPLIT_GPS_CHUNKS[1], exifApp1(tiff('II'))))).toBe(true); // one chunk, after a clean EXIF
    expect(located(jpeg(JFIF, HAS_EXTENDED_XMP))).toBe(true); // XMP that says it has ExtendedXMP, the chunks gone
    expect(located(jpeg(JFIF, extendedXmpApp1(EXTENDED_GUID, 3, 0, 'abc')))).toBe(true); // a chunk with no GPS name
    // Ordinary XMP stays clean, even with the note namespace declared; so does the signature text inside an XMP packet.
    expect(located(jpeg(JFIF, xmpApp1(xmpPacket('xmlns:xmpNote="http://ns.adobe.com/xmp/note/" xmp:CreatorTool="TGP"'))))).toBe(false);
    expect(located(jpeg(JFIF, xmpApp1(xmpPacket('xmp:Label="http://ns.adobe.com/xmp/extension/"'))))).toBe(false);
  });

  it('a truncated or malformed EXIF APP1 counts as a location', () => {
    const body = tiff('II', 2);
    const ii = (b: number[]) => located(jpeg(JFIF, exifApp1(b)));
    expect(ii(body.slice(0, 20))).toBe(true); // IFD0 runs past the segment
    expect(ii([...body.slice(0, 4), 0xff, 0xff, 0, 0])).toBe(true); // IFD0 offset past the segment
    expect(ii(body.slice(0, 38))).toBe(true); // the GPS IFD it points at is past the segment
    expect(ii([0x41, 0x41, ...body.slice(2)])).toBe(true); // no byte order
    expect(ii([0x49, 0x49, 43, 0, ...body.slice(4)])).toBe(true); // not TIFF
    expect(ii([])).toBe(true); // "Exif" and nothing after it
    expect(located([...SOI, ...JFIF, 0xff, 0xe1, 0x00, 0x01, ...SCAN])).toBe(true); // a length under 2
  });

  it('never guesses clean: bytes that end before SOS, a missing SOI, a broken or stray marker all count as a location', () => {
    const clean = jpeg(JFIF);
    expect(located(clean)).toBe(false);
    expect(located(clean.slice(0, clean.length - SCAN.length))).toBe(true); // no SOS in the bytes read
    expect(located([...SOI, ...JFIF.slice(0, 5)])).toBe(true); // a segment cut short
    expect(located([])).toBe(true);
    expect(located([0xff])).toBe(true);
    expect(located(clean.slice(2))).toBe(true); // no SOI
    expect(located([...SOI, 0x00, ...JFIF, ...SCAN])).toBe(true); // a byte that is not a marker
    expect(located([...SOI, 0xff, 0xd0, ...SCAN])).toBe(true); // RST before SOS
    expect(located([...SOI, 0xff, 0xd9])).toBe(true); // EOI before SOS
    expect(located([...SOI, 0xff, 0xff, 0xff, ...JFIF.slice(1), ...SCAN])).toBe(false); // fill bytes are allowed
  });

  it('stops at the first SOS: picture data that happens to spell GPSLatitude is not read', () => {
    const text = [...Buffer.from('GPSLatitude Exif', 'latin1')];
    expect(located([...jpeg(JFIF), ...text, ...exifApp1(tiff('II', 3))])).toBe(false);
  });

  it(`reads at most the first ${LOCATION_READ_BYTES / 1024} KB: a header that runs past it counts as a location`, () => {
    const filler = segment(0xe2, new Array(65533).fill(0)); // the largest segment there is (length 65535)
    const big = jpeg(JFIF, filler, filler, filler, filler, exifApp1(tiff('II')));
    expect(big.length).toBeGreaterThan(LOCATION_READ_BYTES);
    expect(located(big)).toBe(true);
    const three = jpeg(JFIF, filler, filler, filler);
    expect(three.length).toBeLessThan(LOCATION_READ_BYTES);
    expect(located(three)).toBe(false);
    expect(located([...three, ...new Array(LOCATION_READ_BYTES).fill(0), ...exifApp1(tiff('II', 3))])).toBe(false);
  });
});
