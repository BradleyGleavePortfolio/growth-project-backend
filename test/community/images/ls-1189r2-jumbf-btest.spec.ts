import { carriesLocation } from '../../../src/community/images/image-location';
import { JFIF, SCAN, SOI } from './jpeg-fixtures';

describe('LS-1189R2 JUMBF bounded work', () => {
  it('LS-1189R2 B2: a 10 MB JPEG of tiny distinct APP11 boxes cannot hold the send check for seconds', () => {
    // A valid segment envelope, many unrelated box types; no location bytes.
    // Build the upload outside the timer. Each segment consumes exactly 21 bytes.
    const count = 450_000;
    const header = Buffer.concat([Buffer.from(SOI), Buffer.from(JFIF)]);
    const segments = Buffer.alloc(count * 21);
    for (let k = 0; k < count; k += 1) {
      const at = k * 21;
      segments.set([0xff, 0xeb, 0, 19, 0x4a, 0x50, 0, 1], at);
      segments.writeUInt32BE(1, at + 8);
      segments.writeUInt32BE(9, at + 12);
      segments.writeUInt32BE(k + 0x30303030, at + 16);
      segments[at + 20] = 0x7a;
    }
    const photo = Buffer.concat([header, segments, Buffer.from(SCAN)]);
    expect(photo.length).toBeLessThanOrEqual(10 * 1024 * 1024);
    const start = Date.now();
    const located = carriesLocation(photo);
    const elapsed = Date.now() - start;
    console.log('LS1189R2 tiny JUMBF bound', { bytes: photo.length, count, located, elapsed });
    expect(elapsed).toBeLessThan(1000);
  }, 30_000);
});
