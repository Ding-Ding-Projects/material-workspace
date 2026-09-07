/**
 * PDF conformance.
 *
 * The byte-offset tests are the ones that matter. A cross-reference table
 * counted in characters rather than bytes produces a file that opens perfectly
 * until somebody types a non-ASCII character into it, and then opens as
 * damaged — so the offsets are checked against the real bytes.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  A4,
  type Page,
  measureText,
  unsupportedCharacters,
  wrapText,
  writePdf,
} from '../../app/engines/pdf/writer';
import {
  PdfError,
  containsText,
  extractText,
  metadata,
  objectsOfType,
  pageCount,
  readPdf,
  removeObjects,
} from '../../app/engines/pdf/reader';

const latin = new TextDecoder('latin1');

/**
 * Where the cross-reference table starts.
 *
 * NOT lastIndexOf("xref"): the trailer ends with "startxref", whose own last
 * four characters are "xref", so that finds the pointer rather than the table
 * it points at. Three tests failed on this and the writer was correct all
 * along — a reminder that a red test is a claim about the test as much as
 * about the code.
 */
const NEWLINE = String.fromCharCode(10);

function xrefStart(text: string): number {
  const at = text.lastIndexOf(NEWLINE + 'xref' + NEWLINE);
  assert.ok(at >= 0, 'no cross-reference table found');
  return at + 1;
}

function simplePage(text: string): Page {
  return {
    ...A4,
    runs: [{ text, x: 72, y: 700, size: 12, font: 'Helvetica' }],
  };
}

// ----------------------------------------------------------------- writing --

test('a written PDF has the right header, trailer and page count', () => {
  const bytes = writePdf([simplePage('Hello')], { title: 'Test' });
  const text = latin.decode(bytes);

  assert.ok(text.startsWith('%PDF-1.7'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));

  const document = readPdf(bytes);
  assert.equal(pageCount(document), 1);
  assert.equal(objectsOfType(document, 'Catalog').length, 1);
});

test('the binary comment is present, or a text-mode copy corrupts every offset', () => {
  const bytes = writePdf([simplePage('Hello')]);
  // Four bytes above 127 on the second line.
  assert.equal(bytes[9], 0x25);
  assert.ok((bytes[10] ?? 0) > 127);
  assert.ok((bytes[11] ?? 0) > 127);
});

test('every cross-reference offset points at its own object', () => {
  // The check that catches a table counted in characters. A file with any
  // non-ASCII text in it would open as damaged.
  const bytes = writePdf(
    [simplePage('Ordinary'), simplePage('Also ordinary')],
    { title: 'A title with a pound sign: £' },
  );
  const text = latin.decode(bytes);

  const xrefAt = xrefStart(text);

  const startxref = /startxref\s+(\d+)/.exec(text);
  assert.ok(startxref?.[1] !== undefined);
  assert.equal(Number(startxref[1]), xrefAt, 'startxref does not point at the table');

  const lines = text.slice(xrefAt).split('\n');
  const count = Number(lines[1]?.split(' ')[1]);
  assert.ok(count > 1);

  for (let number = 1; number < count; number += 1) {
    const entry = lines[2 + number];
    assert.ok(entry !== undefined, 'missing entry for object ' + number);
    // Twenty bytes exactly, including the newline this split removed.
    assert.equal(entry.length, 19, 'entry ' + number + ' is not twenty bytes');
    const offset = Number(entry.slice(0, 10));
    assert.ok(
      text.startsWith(number + ' 0 obj', offset),
      'offset for object ' + number + ' points at ' + JSON.stringify(text.slice(offset, offset + 12)),
    );
  }
});

test('object zero is the free-list head', () => {
  const text = latin.decode(writePdf([simplePage('x')]));
  const xrefAt = xrefStart(text);
  const lines = text.slice(xrefAt).split('\n');
  assert.equal(lines[2], '0000000000 65535 f ');
});

test('a parenthesis in the text is escaped, or the page renders blank', () => {
  // An unescaped closing parenthesis ends the string early and every byte
  // after it is read as operators.
  const bytes = writePdf([simplePage('a (nested) remark')]);
  const text = latin.decode(bytes);
  assert.ok(text.includes('\\(nested\\)'));

  const extracted = extractText(readPdf(bytes));
  assert.equal(extracted[0], 'a (nested) remark');
});

test('a stream declares its BYTE length, not its character count', () => {
  const bytes = writePdf([simplePage('cost: £50')]);
  const text = latin.decode(bytes);
  const match = /\/Length (\d+)\s*>>\s*stream\n/.exec(text);
  assert.ok(match?.[1] !== undefined);

  const declared = Number(match[1]);
  const start = (match.index ?? 0) + match[0].length;
  const endStream = text.indexOf('\nendstream', start);
  assert.equal(endStream - start, declared, 'the declared length does not match the real stream');
});

test('a character the standard fonts cannot render is reported, not silently mangled', () => {
  // Producing a page of question marks and letting somebody discover it is the
  // failure this exists to prevent.
  const pages = [simplePage('Hong Kong 茶樓')];
  assert.deepEqual(unsupportedCharacters(pages), ['茶', '樓']);
  assert.deepEqual(unsupportedCharacters([simplePage('plain ascii')]), []);
});

test('an empty document is refused rather than written as a broken file', () => {
  assert.throws(() => writePdf([]), /at least one page/);
});

// ------------------------------------------------------------- measurement --

test('text is measured from the real font metrics', () => {
  // Helvetica: i is 222 thousandths, W is 944. A table that got them equal
  // would wrap text in visibly wrong places.
  assert.ok(measureText('W', 12, 'Helvetica') > measureText('i', 12, 'Helvetica') * 3);
  // Courier is monospaced at exactly 600.
  assert.equal(measureText('iW', 10, 'Courier'), 12);
});

test('wrapping fits the width, and breaks CJK without spaces', () => {
  const lines = wrapText(
    'The quick brown fox jumps over the lazy dog and keeps going for a while',
    200,
    12,
    'Helvetica',
  );
  assert.ok(lines.length > 1);
  for (const line of lines) {
    assert.ok(
      measureText(line, 12, 'Helvetica') <= 200,
      'line too wide: ' + JSON.stringify(line),
    );
  }

  // A Chinese paragraph has no spaces and would otherwise be one unbreakable
  // token running straight off the page.
  const chinese = wrapText('香港茶樓'.repeat(20), 100, 12, 'Helvetica');
  assert.ok(chinese.length > 1, 'CJK text did not wrap at all');
});

test('an explicit newline starts a new line', () => {
  assert.deepEqual(wrapText('one\ntwo', 500, 12, 'Helvetica'), ['one', 'two']);
});

// ----------------------------------------------------------------- reading --

test('a file that is not a PDF is refused clearly', () => {
  assert.throws(() => readPdf(new TextEncoder().encode('hello')), PdfError);
});

test('metadata is read back', () => {
  const bytes = writePdf([simplePage('x')], { title: 'A Title', author: 'Ada' });
  const info = metadata(readPdf(bytes));
  assert.equal(info.title, 'A Title');
  assert.equal(info.author, 'Ada');
  assert.equal(info.producer, 'Material Workspace');
});

test('text is extracted per page', () => {
  const bytes = writePdf([simplePage('first page'), simplePage('second page')]);
  assert.deepEqual(extractText(readPdf(bytes)), ['first page', 'second page']);
});

test('objects are found by scanning, so a damaged table does not lose them', () => {
  // A file that has been appended to or damaged has offsets that no longer
  // point where they claim. A reader that trusts them reports a recoverable
  // file as broken.
  const bytes = writePdf([simplePage('still here')]);
  const text = latin.decode(bytes);
  const broken = new TextEncoder().encode(
    text.replace(/\n\d{10} 00000 n /g, '\n9999999999 00000 n '),
  );
  assert.deepEqual(extractText(readPdf(broken)), ['still here']);
});

// -------------------------------------------------------------- redaction --

test('redaction removes the BYTES, not just the appearance', () => {
  // Drawing a black rectangle over text leaves the text in the file, where
  // anybody can select it or read it in a text editor. That mistake has
  // exposed real secrets in real published documents, repeatedly.
  const secret = 'the account number is 12345';
  const bytes = writePdf([simplePage('public heading'), simplePage(secret)]);

  assert.ok(containsText(bytes, secret), 'the fixture does not contain the secret');

  const document = readPdf(bytes);
  const secretObject = document.objects.find(
    (object) => object.stream !== undefined && latin.decode(object.stream).includes(secret),
  );
  assert.ok(secretObject !== undefined, 'could not find the object holding the secret');

  const redacted = removeObjects(document, [secretObject.number]);
  assert.equal(
    containsText(redacted, secret),
    false,
    'the secret survived redaction',
  );
  // And the rest of the document is still there.
  assert.ok(containsText(redacted, 'public heading'));
});

test('a redacted file still parses, and its table marks the gap as free', () => {
  const bytes = writePdf([simplePage('one'), simplePage('two')]);
  const document = readPdf(bytes);
  const target = document.objects.find(
    (object) => object.stream !== undefined && latin.decode(object.stream).includes('two'),
  );
  assert.ok(target !== undefined);

  const redacted = removeObjects(document, [target.number]);
  const reread = readPdf(redacted);
  assert.deepEqual(extractText(reread), ['one']);

  // A removed object must be a FREE entry. A zero offset marked in-use points
  // every reader at the file header.
  const text = latin.decode(redacted);
  const xrefAt = xrefStart(text);
  const lines = text.slice(xrefAt).split('\n');
  assert.equal(lines[2 + target.number], '0000000000 65535 f ');
});

test('removing nothing returns the file unchanged', () => {
  const bytes = writePdf([simplePage('x')]);
  const document = readPdf(bytes);
  assert.equal(removeObjects(document, []), bytes);
  assert.equal(removeObjects(document, [9999]), bytes);
});
