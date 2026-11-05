import { carriesLocation } from '../../../src/community/images/image-location';
import { stripJpegMetadata } from '../../../src/community/images/image-metadata';
import { JFIF, SCAN, SOI } from './jpeg-fixtures';
import { REAL_PHOTOS } from './real-photos';

const segment = (marker: number, body: Buffer): Buffer => {
  const header = Buffer.from([0xff, marker, 0, 0]);
  header.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([header, body]);
};
const jpeg = (...parts: Buffer[]): Buffer =>
  Buffer.concat([Buffer.from(SOI), Buffer.from(JFIF), ...parts, Buffer.from(SCAN)]);

/** Photoshop IRB records may continue in the following APP13, with its prefix repeated. */
const photoshop = (body: Buffer): Buffer =>
  segment(0xed, Buffer.concat([Buffer.from('Photoshop 3.0\0', 'latin1'), body]));

describe('LS-1189R2 Photoshop continuation regression', () => {
  it('LS-1189R2 B1: a complete location-free Photoshop EXIF resource split after its header stays publishable', () => {
    // TIFF with a zero-entry IFD, no GPSInfo and no location text.
    const tiff = Buffer.alloc(14);
    tiff.write('II*\0', 0, 'latin1');
    tiff.writeUInt32LE(8, 4);
    const resourceHeader = Buffer.from('8BIM\x04\x22\0\0\0\0\0\0', 'latin1');
    resourceHeader.writeUInt32BE(tiff.length, 8);
    const resource = Buffer.concat([resourceHeader, tiff]);
    const whole = jpeg(photoshop(resource));
    expect(carriesLocation(whole)).toBe(false);

    // Move only the APP13 boundary: the logical resource and resulting picture are identical.
    const split = jpeg(photoshop(resource.subarray(0, 16)), photoshop(resource.subarray(16)));
    expect(stripJpegMetadata(split)).toEqual(stripJpegMetadata(whole));
    expect(carriesLocation(split)).toBe(false);
  });

  it('LS-1189R2 B1: an ordinary decoded picture with a large location-free EXIFInfo resource is still publishable', () => {
    const picture = Buffer.from(REAL_PHOTOS[0][1].sent, 'base64');
    const description = Buffer.from('ordinary image notes '.repeat(3300) + '\0', 'ascii');
    const tiff = Buffer.alloc(26 + description.length);
    tiff.write('II*\0', 0, 'latin1');
    tiff.writeUInt32LE(8, 4);
    tiff.writeUInt16LE(1, 8);
    tiff.writeUInt16LE(0x010e, 10); // ImageDescription, not GPS.
    tiff.writeUInt16LE(2, 12);
    tiff.writeUInt32LE(description.length, 14);
    tiff.writeUInt32LE(26, 18);
    description.copy(tiff, 26);
    const resourceHeader = Buffer.from('8BIM\x04\x22\0\0\0\0\0\0', 'latin1');
    resourceHeader.writeUInt32BE(tiff.length, 8);
    const resource = Buffer.concat([resourceHeader, tiff, Buffer.alloc(tiff.length % 2)]);
    const parts: Buffer[] = [];
    for (let at = 0; at < resource.length; at += 65_519) parts.push(photoshop(resource.subarray(at, at + 65_519)));
    const photo = Buffer.concat([picture.subarray(0, 2), ...parts, picture.subarray(2)]);
    expect(stripJpegMetadata(photo)).toEqual(picture);
    expect(carriesLocation(photo)).toBe(false);
  });
});
