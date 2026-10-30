/**
 * PHOTO-GPS (agent 174): the location reader over a JPEG
 * (src/community/images/image-location.ts). Every photo is built byte by
 * byte in jpeg-fixtures.ts; the send check is in community-images.e2e.spec.ts.
 * FR-1187R2 (LS-1187R2 B2): it reads the whole photo, every place a JPEG the
 * bucket keeps can hold a location (the placement table below).
 */
import { carriesLocation } from '../../../src/community/images/image-location';
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
import { REAL_PHOTOS } from './real-photos';

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

  it('reads segments, not picture data: a scan whose bytes spell GPSLatitude and Exif is not read', () => {
    const text = [...Buffer.from('GPSLatitude Exif\0\0II*\0', 'latin1')];
    expect(located([...SOI, ...JFIF, ...SCAN.slice(0, -2), ...text, 0xff, 0xd9])).toBe(false);
  });

  // FR-1187R2 (LS-1187R2 B2): every place a JPEG the bucket keeps can hold a location, for each kind of location block.
  const latin1 = (s: string): number[] => [...Buffer.from(s, 'latin1')];
  const jfxx = (thumbnail: number[]) => segment(0xe0, [...latin1('JFXX\0'), 0x10, ...thumbnail]);
  const FIRST_SCAN = SCAN.slice(0, -2); // SOS and its picture data, no EOI: another scan follows
  const places: Array<[string, (block: number[]) => number[]]> = [
    ['before the first scan', (b) => jpeg(JFIF, b)],
    ['between two scans', (b) => [...SOI, ...JFIF, ...FIRST_SCAN, ...b, ...SCAN]],
    ['in a JFXX JPEG thumbnail before the first scan', (b) => jpeg(JFIF, jfxx(jpeg(b)))],
    ['in a JFXX JPEG thumbnail between two scans', (b) => [...SOI, ...JFIF, ...FIRST_SCAN, ...jfxx(jpeg(b)), ...SCAN]],
    // FR-1187R3 (LS-1187R3 B1, LO-1187R3 C1): the JPEG thumbnail inside EXIF, read as bytes like the JFXX one.
    ['in an EXIF JPEG thumbnail before the first scan', (b) => jpeg(JFIF, exifApp1([...tiff('II'), ...jpeg(b)]))],
    ['in an EXIF JPEG thumbnail between two scans', (b) => [...SOI, ...JFIF, ...FIRST_SCAN, ...exifApp1([...tiff('MM'), ...jpeg(b)]), ...SCAN]],
    ['in a second image after EOI (MPF)', (b) => [...jpeg(JFIF), ...jpeg(JFIF, b)]],
    ['after EOI, the block with no segment around it', (b) => [...jpeg(JFIF), ...b.slice(4)]],
    ['after EOI, behind a second image', (b) => [...jpeg(JFIF), ...jpeg(JFIF), ...Array<number>(100).fill(0), ...b]],
  ];
  const locations: Array<[string, number[]]> = [
    ['GPS in EXIF, little endian', exifApp1(tiff('II', 3))],
    ['GPS in EXIF, big endian', exifApp1(tiff('MM', 3))],
    ['a GPS name in XMP', xmpApp1(xmpPacket('exif:GPSLatitude="1,0.0N" exif:GPSLongitude="2,0.0E"'))],
    ['an ExtendedXMP chunk', extendedXmpApp1(EXTENDED_GUID, 40, 0, xmpPacket('xmp:CreatorTool="TGP"').slice(0, 40))],
  ];
  const noLocation: Array<[string, number[]]> = [
    ['EXIF without GPS', exifApp1(tiff('II'))],
    ['XMP with no location', xmpApp1(XMP_NO_LOCATION)],
  ];
  const table = (blocks: Array<[string, number[]]>) =>
    places.flatMap(([place, put]) => blocks.map(([kind, block]): [string, string, number[]] => [kind, place, put(block)]));
  it.each(table(locations))('%s %s carries a location', (_kind, _place, bytes) => {
    expect(located(bytes)).toBe(true);
  });
  it.each(table(noLocation))('%s %s carries none', (_kind, _place, bytes) => {
    expect(located(bytes)).toBe(false);
  });
  it('GPS in EXIF inside the EXIF block (its thumbnail, a JPEG of its own) carries a location; the same thumbnail without GPS does not', () => {
    expect(located(jpeg(JFIF, exifApp1([...tiff('II'), ...jpeg(exifApp1(tiff('MM', 3)))])))).toBe(true);
    expect(located(jpeg(JFIF, exifApp1([...tiff('II'), ...jpeg(exifApp1(tiff('MM')))])))).toBe(false);
  });
  // FR-1187R3 (LO-1187R3 N2): every APPn but APP1 (APP0, APP2 to APP15) is read as bytes: EXIF with GPS behind an EXIF
  // header, XMP's location names, or ExtendedXMP in it is a location, wherever the segment sits; the same blocks with no
  // location are not.
  const OTHER_APPN = [0xe0, ...Array.from({ length: 14 }, (_, k) => 0xe2 + k)];
  const inAppn = (marker: number, app1: number[]) => segment(marker, app1.slice(4)); // the APP1's payload, in this APPn
  const appnPlaces: Array<[string, (block: number[]) => number[]]> = [
    ['before the first scan', (b) => jpeg(JFIF, b)],
    ['between two scans', (b) => [...SOI, ...JFIF, ...FIRST_SCAN, ...b, ...SCAN]],
  ];
  const appnTable = (blocks: Array<[string, number[]]>) =>
    OTHER_APPN.flatMap((marker) => appnPlaces.flatMap(([place, put]) =>
      blocks.map(([kind, block]): [string, string, string, number[]] => [
        kind, `0x${marker.toString(16)}`, place, put(inAppn(marker, block)),
      ])));
  const appnLocations: Array<[string, number[]]> = [...locations, ['HasExtendedXMP', HAS_EXTENDED_XMP]];
  it.each(appnTable(appnLocations))('%s in APPn %s %s carries a location', (_kind, _marker, _place, bytes) => {
    expect(located(bytes)).toBe(true);
  });
  it.each(appnTable(noLocation))('%s in APPn %s %s carries none', (_kind, _marker, _place, bytes) => {
    expect(located(bytes)).toBe(false);
  });

  it('an EXIF APP1 cut inside its header, at the very end of the bytes, counts as a location (no throw)', () => {
    const cut = [...SOI, ...segment(0xe1, [...Buffer.from('Exif\0', 'latin1')])];
    expect(located(cut)).toBe(true);
    expect(located([...SOI, ...JFIF, ...FIRST_SCAN, ...segment(0xe1, [...Buffer.from('Exif\0', 'latin1')])])).toBe(true);
  });
  it('after EOI, an EXIF header with no readable EXIF behind it counts as a location (unreadable = located)', () => {
    expect(located([...jpeg(JFIF), ...latin1('Exif\0\0II*\0'), 0xff, 0xff])).toBe(true);
    expect(located([...jpeg(JFIF), ...Array<number>(1000).fill(0)])).toBe(false); // zeros after EOI carry nothing
  });
  it('segments after the first scan it cannot walk: false here, refused by the photo check (the same walk; 503, nothing published)', () => {
    const broken = [0xff, 0xd8, 0x34]; // a stray SOI inside the picture data
    expect(located([...SOI, ...JFIF, ...FIRST_SCAN, ...broken, ...exifApp1(tiff('II', 3)), ...SCAN])).toBe(false);
    // A location the walk reaches before it stops is still found.
    expect(located([...SOI, ...JFIF, ...FIRST_SCAN, ...exifApp1(tiff('II', 3)), ...FIRST_SCAN, ...broken, ...SCAN])).toBe(true);
  });

  // FLIR-GPS-BE (LO-1187R4): a FLIR thermal camera writes an FFF block (a 64-byte header, a record directory of 32-byte
  // entries, then the records) across "FLIR\0" APP1 chunks, in order. Its GPS record (type 0x2B) holds latitude and
  // longitude as doubles at 0x10 and 0x18 (exiftool FLIR::GPSInfo; layout as in metadata-extractor-images jpg/FLIR
  // iPhone device.jpg). A stored position is a location; a GPS record of zeros, or no GPS record, is not.
  type FlirOpts = { le?: boolean; chunk?: number; magic?: string; version?: number; dirAt?: number; count?: number };
  const flirGps = (lat: number, lon: number, length = 184): Buffer => {
    const gps = Buffer.alloc(Math.max(length, 0x20));
    if (lat !== 0 || lon !== 0) gps.writeUInt32LE(1, 0); // GPSValid
    gps.write('NW', 8, 'latin1');
    gps.writeDoubleLE(lat, 0x10);
    gps.writeDoubleLE(lon, 0x18);
    return gps.subarray(0, length);
  };
  const fffBlock = (records: Array<[number, Buffer]>, o: FlirOpts = {}): Buffer => {
    const u32 = (n: number) => {
      const b = Buffer.alloc(4);
      if (o.le) b.writeUInt32LE(n);
      else b.writeUInt32BE(n);
      return b;
    };
    const u16 = (n: number) => {
      const b = Buffer.alloc(2);
      if (o.le) b.writeUInt16LE(n);
      else b.writeUInt16BE(n);
      return b;
    };
    const header = Buffer.concat([Buffer.from(o.magic ?? 'FFF\0', 'latin1'), Buffer.alloc(16), u32(o.version ?? 100),
      u32(o.dirAt ?? 0x40), u32(o.count ?? records.length), Buffer.alloc(32)]);
    let at = 0x40 + records.length * 0x20;
    const dir = records.map(([type, body]) => {
      const entry = Buffer.concat([u16(type), u16(1), u32(100), u32(1), u32(at), u32(body.length), Buffer.alloc(12)]);
      at += body.length;
      return entry;
    });
    return Buffer.concat([header, ...dir, ...records.map(([, body]) => body)]);
  };
  const flirChunks = (fff: Buffer, chunk = 65000): number[][] => {
    const count = Math.ceil(fff.length / chunk);
    return Array.from({ length: count }, (_, k) => segment(0xe1, [...latin1('FLIR\0'), 1, k, count - 1, ...fff.subarray(k * chunk, (k + 1) * chunk)]));
  };
  const flir = (records: Array<[number, Buffer]>, o: FlirOpts = {}): number[] => jpeg(JFIF, ...flirChunks(fffBlock(records, o), o.chunk));
  const RAW = (n: number): [number, Buffer] => [0x01, Buffer.alloc(n, 0x5a)]; // the raw thermal frame
  const CAMERA: [number, Buffer] = [0x20, Buffer.alloc(2476, 0x11)]; // CameraInfo

  it('FLIR-GPS-BE: a FLIR GPS record with a stored position is a location, in either FFF byte order and either hemisphere', () => {
    for (const le of [false, true]) {
      expect(located(flir([RAW(4000), CAMERA, [0x2b, flirGps(34.0754, 118.2543)]], { le }))).toBe(true);
      expect(located(flir([[0x2b, flirGps(-33.86, 151.21)]], { le }))).toBe(true);
      expect(located(flir([[0x2b, flirGps(0, -0.5)]], { le }))).toBe(true); // a longitude alone
      expect(located(flir([[0x2b, flirGps(51.5, 0)]], { le }))).toBe(true); // a latitude alone
    }
    expect(located(flir([[0x2b, flirGps(34.0754, 118.2543)]], { magic: 'AFF\0' }))).toBe(true);
    // Beside a clean EXIF, after an empty directory entry, and between two scans.
    const empty: [number, Buffer] = [0x00, Buffer.alloc(0)];
    expect(located(jpeg(JFIF, exifApp1(tiff('II')), ...flirChunks(fffBlock([empty, [0x2b, flirGps(1, 2)]]))))).toBe(true);
    const fff = fffBlock([[0x2b, flirGps(1, 2)]]);
    expect(located([...SOI, ...JFIF, ...FIRST_SCAN, ...flirChunks(fff).flat(), ...SCAN])).toBe(true);
  });

  it('FLIR-GPS-BE: a FLIR block with no position carries none: a GPS record of zeros, no GPS record, other records only', () => {
    for (const le of [false, true]) {
      expect(located(flir([RAW(4000), CAMERA, [0x2b, flirGps(0, 0)]], { le }))).toBe(false);
      expect(located(flir([RAW(4000), CAMERA], { le }))).toBe(false);
      expect(located(flir([], { le }))).toBe(false);
    }
    // A GPS record whose refs and version are set but whose position is zero (as FLIR Vue Pro 640 writes it).
    const refsOnly = flirGps(0, 0);
    refsOnly.writeUInt32BE(1, 0);
    refsOnly.write('2200SE', 4, 'latin1');
    expect(located(flir([[0x2b, refsOnly]]))).toBe(false);
    // Bytes after the position (altitude and the rest) are not a position.
    const altitude = flirGps(0, 0);
    altitude.writeFloatLE(120.5, 0x20);
    expect(located(flir([[0x2b, altitude]]))).toBe(false);
  });

  it('FLIR-GPS-BE: FFF data split across several APP1 chunks is joined in order, even when the GPS record straddles two chunks', () => {
    const fff = fffBlock([RAW(300 * 1024), CAMERA, [0x2b, flirGps(34.0754, 118.2543)]]);
    const gpsAt = fff.length - 184 + 0x10;
    for (const chunk of [65524, 4099, 1000]) {
      const chunks = flirChunks(fff, chunk);
      expect(chunks.length).toBeGreaterThan(1);
      expect(located(jpeg(JFIF, ...chunks))).toBe(true);
    }
    // The latitude's 8 bytes cut over a chunk boundary: no chunk alone holds the record.
    const cut = flirChunks(fff, gpsAt + 4);
    expect(cut.length).toBe(2);
    expect(located(jpeg(JFIF, ...cut))).toBe(true);
    expect(located(jpeg(JFIF, ...flirChunks(fffBlock([RAW(300 * 1024), CAMERA, [0x2b, flirGps(0, 0)]]), 65524)))).toBe(false);
    // An EXIF header or an XMP name split over two chunks (an embedded image's own metadata) is found in the joined bytes.
    const embedded = Buffer.from([...exifApp1(tiff('II', 3)).slice(4)]);
    const exifAt = 0x40 + 0x20;
    expect(located(jpeg(JFIF, ...flirChunks(fffBlock([[0x0e, embedded]]), exifAt + 3)))).toBe(true);
    const xmp = Buffer.from(xmpPacket('exif:GPSLatitude="1,0.0N"'), 'latin1');
    const nameAt = exifAt + xmp.indexOf('GPSLati') + 3;
    expect(located(jpeg(JFIF, ...flirChunks(fffBlock([[0x0e, xmp]]), nameAt)))).toBe(true);
  });

  it('FLIR-GPS-BE: a short or broken FLIR block counts as a location (fail closed)', () => {
    const gps: [number, Buffer] = [0x2b, flirGps(0, 0)];
    const fff = fffBlock([CAMERA, gps]);
    const chunks = flirChunks(fff, 1000);
    expect(located(jpeg(JFIF, ...chunks))).toBe(false); // the control: whole, in order, no position
    expect(located(jpeg(JFIF, ...chunks.slice(0, -1)))).toBe(true); // a chunk missing
    expect(located(jpeg(JFIF, chunks[1], chunks[0], ...chunks.slice(2)))).toBe(true); // chunks out of order
    expect(located(jpeg(JFIF, chunks[0], chunks[0], ...chunks.slice(2)))).toBe(true); // a chunk twice
    expect(located(jpeg(JFIF, segment(0xe1, [...latin1('FLIR\0'), 1])))).toBe(true); // a chunk shorter than its header
    expect(located(flir([[0x2b, flirGps(0, 0, 0x1f)]]))).toBe(true); // a GPS record too short to hold a position
    expect(located(flir([[0x2b, flirGps(0, 0, 0)]]))).toBe(true); // an empty GPS record
    expect(located(flir([CAMERA, gps], { magic: 'XYZ\0' }))).toBe(true); // not FFF or AFF
    expect(located(flir([CAMERA, gps], { version: 300 }))).toBe(true); // a version it does not know, in both orders
    expect(located(flir([CAMERA, gps], { dirAt: 0x10000 }))).toBe(true); // the directory past the end
    expect(located(flir([CAMERA, gps], { count: 50 }))).toBe(true); // more entries than fit
    expect(located(jpeg(JFIF, ...flirChunks(fff.subarray(0, fff.length - 10))))).toBe(true); // the last record cut short
    expect(located(jpeg(JFIF, ...flirChunks(fff.subarray(0, 0x30))))).toBe(true); // the header cut short
  });

  it.each(REAL_PHOTOS)('FR-1187R2: a real %s photo with no location carries none', (_label, { photo }) => {
    expect(carriesLocation(Buffer.from(photo, 'base64'))).toBe(false);
  });

  it('reads the whole photo: a location past the first 256 KB is found, a header past 256 KB is read, not refused', () => {
    const filler = segment(0xe2, new Array(65533).fill(0)); // the largest segment there is (length 65535)
    const big = jpeg(JFIF, filler, filler, filler, filler, exifApp1(tiff('II')));
    expect(big.length).toBeGreaterThan(256 * 1024);
    expect(located(big)).toBe(false);
    expect(located(jpeg(JFIF, filler, filler, filler, filler, exifApp1(tiff('II', 3))))).toBe(true);
    const three = jpeg(JFIF, filler, filler, filler);
    expect(located([...three, ...new Array(256 * 1024).fill(0), ...exifApp1(tiff('II', 3))])).toBe(true);
  });
});
