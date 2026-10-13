/**
 * Owner NOLOCK-R2: "#NOLOCK-R2 - 100 per day, 3 file uploads, 5 client in-app
 * adjustments (logging food automatically, workout adjustment, ect.)", the
 * same for every client, never by plan, tier or subscription (NOLOCK-R).
 * Messages are counted today (roman.service.spec.ts, rate limiting). Roman
 * takes no file and its tools change nothing yet, so the other two limits have
 * nothing to count: these checks fail the day that changes, so the first
 * upload path or Roman action that writes lands with its limit.
 */
import 'reflect-metadata';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { getMetadataStorage } from 'class-validator';
import { SendMessageDto } from '../../src/roman/roman.dto';
import {
  ROMAN_ADJUSTMENTS_PER_DAY,
  ROMAN_FILE_UPLOADS_PER_DAY,
} from '../../src/roman/roman.constants';

const ROMAN = join(__dirname, '../../src/roman');
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sources(join(dir, e.name));
    return e.name.endsWith('.ts') ? [join(dir, e.name)] : [];
  });
const matching = (dir: string, re: RegExp) =>
  sources(dir).filter((file) => re.test(readFileSync(file, 'utf8')));

describe('NOLOCK-R2: the Roman limits that have nothing to count yet', () => {
  it('3 file uploads a day: a Roman turn is text only and no Roman route takes a file', () => {
    expect(ROMAN_FILE_UPLOADS_PER_DAY).toBe(3);
    // The global pipe refuses any body field the DTO does not declare.
    const fields = getMetadataStorage()
      .getTargetValidationMetadatas(SendMessageDto, '', false, false)
      .map((m) => m.propertyName);
    expect([...new Set(fields)]).toEqual(['content']);
    // No multipart route, signed storage upload or image/document block for the
    // model: the first must count each file against ROMAN_FILE_UPLOADS_PER_DAY.
    const files = /FilesInterceptor|FileInterceptor|UploadedFile|createSignedUpload|storage\.from\(|type: '(image|document)'/;
    expect(matching(ROMAN, files)).toEqual([]);
    expect(matching(join(ROMAN, '../community/voice'), files)).not.toEqual([]); // the scan works
  });

  it("5 adjustments a day: Roman's tools only read the client's data", () => {
    expect(ROMAN_ADJUSTMENTS_PER_DAY).toBe(5);
    // The first tool that changes it must count against ROMAN_ADJUSTMENTS_PER_DAY.
    const writes = /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw/;
    expect(matching(join(ROMAN, 'tools'), writes)).toEqual([]);
    expect(matching(join(ROMAN, 'memory'), writes)).not.toEqual([]); // the scan works
  });
});
