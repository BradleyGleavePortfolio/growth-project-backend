import {
  csvEscape,
  rowsToCsv,
  objectToKeyValueCsv,
} from '../src/admin/reports/csv';

describe('reports/csv — csvEscape', () => {
  it('returns empty string for null and undefined', () => {
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
  });

  it('passes plain values through unquoted', () => {
    expect(csvEscape('hello')).toBe('hello');
    expect(csvEscape(42)).toBe('42');
    expect(csvEscape(true)).toBe('true');
  });

  it('quotes fields with commas, quotes, CR or LF', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
    expect(csvEscape('cr\rlf')).toBe('"cr\rlf"');
  });

  it('serializes Date as ISO string', () => {
    const d = new Date('2026-04-28T12:34:56.000Z');
    expect(csvEscape(d)).toBe('2026-04-28T12:34:56.000Z');
  });

  it('JSON-encodes nested objects so the cell stays a single field', () => {
    expect(csvEscape({ a: 1, b: 'x' })).toBe('"{""a"":1,""b"":""x""}"');
  });
});

describe('reports/csv — rowsToCsv', () => {
  it('emits a header row plus one CRLF-terminated line per row', () => {
    const out = rowsToCsv(['a', 'b'], [
      { a: 1, b: 'x' },
      { a: 2, b: 'y' },
    ]);
    expect(out).toBe('a,b\r\n1,x\r\n2,y\r\n');
  });

  it('renders missing keys as empty cells', () => {
    const out = rowsToCsv(['a', 'b', 'c'], [{ a: 1 } as any]);
    expect(out).toBe('a,b,c\r\n1,,\r\n');
  });

  it('quotes header cells containing commas', () => {
    const out = rowsToCsv(['a,b', 'c'], [{ 'a,b': 1, c: 2 } as any]);
    expect(out).toBe('"a,b",c\r\n1,2\r\n');
  });

  it('produces a header-only CSV when there are no rows', () => {
    const out = rowsToCsv(['id', 'name'], []);
    expect(out).toBe('id,name\r\n');
  });
});

describe('reports/csv — objectToKeyValueCsv', () => {
  it('flattens nested objects into dotted-path key/value rows', () => {
    const out = objectToKeyValueCsv({
      a: 1,
      nested: { b: 2, deeper: { c: 3 } },
    });
    expect(out).toBe('key,value\r\na,1\r\nnested.b,2\r\nnested.deeper.c,3\r\n');
  });

  it('preserves arrays as JSON in a single cell', () => {
    const out = objectToKeyValueCsv({ list: [1, 2, 3] });
    expect(out).toBe('key,value\r\nlist,"[1,2,3]"\r\n');
  });
});
