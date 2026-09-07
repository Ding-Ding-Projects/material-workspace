/**
 * DOCX conformance.
 *
 * Read against hand-built XML in the shapes real writers emit, not only
 * against files this module wrote.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readDocx, writeDocx } from '../../app/engines/codec/docx';
import { writeZip } from '../../app/engines/codec/zip';

const encoder = new TextEncoder();

function handBuilt(bodyXml: string): Uint8Array {
  return writeZip([
    {
      name: 'word/document.xml',
      data: encoder.encode(
        '<?xml version="1.0"?>' +
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
          '<w:body>' +
          bodyXml +
          '</w:body></w:document>',
      ),
    },
  ]);
}

test('a paragraph of runs reads with its formatting', async () => {
  const document = await readDocx(
    handBuilt(
      '<w:p>' +
        '<w:r><w:t>plain </w:t></w:r>' +
        '<w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r>' +
        '<w:r><w:rPr><w:i/></w:rPr><w:t> italic</w:t></w:r>' +
        '</w:p>',
    ),
  );
  const runs = document.blocks[0]?.runs ?? [];
  assert.equal(runs.length, 3);
  assert.equal(runs[0]?.bold, undefined);
  assert.equal(runs[1]?.bold, true);
  assert.equal(runs[2]?.italic, true);
});

test('an explicitly-OFF toggle is off, not on', async () => {
  // The trap: treating the element's presence as truth makes explicitly
  // unbolded text bold, which is exactly the case the author used it for.
  const document = await readDocx(
    handBuilt(
      '<w:p>' +
        '<w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>not bold</w:t></w:r>' +
        '<w:r><w:rPr><w:b w:val="false"/></w:rPr><w:t>also not</w:t></w:r>' +
        '<w:r><w:rPr><w:b w:val="1"/></w:rPr><w:t>bold</w:t></w:r>' +
        '</w:p>',
    ),
  );
  const runs = document.blocks[0]?.runs ?? [];
  assert.equal(runs[0]?.bold, undefined);
  assert.equal(runs[1]?.bold, undefined);
  assert.equal(runs[2]?.bold, true);
});

test('underline is a style, so val="none" is not underlined', async () => {
  const document = await readDocx(
    handBuilt(
      '<w:p>' +
        '<w:r><w:rPr><w:u w:val="none"/></w:rPr><w:t>no</w:t></w:r>' +
        '<w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>yes</w:t></w:r>' +
        '</w:p>',
    ),
  );
  const runs = document.blocks[0]?.runs ?? [];
  assert.equal(runs[0]?.underline, undefined);
  assert.equal(runs[1]?.underline, true);
});

test('a break inside a paragraph is a line break, not a new paragraph', async () => {
  // Collapsing the two changes the document's structure rather than its
  // appearance, and the difference survives into every later edit.
  const document = await readDocx(
    handBuilt('<w:p><w:r><w:t>first</w:t><w:br/><w:t>second</w:t></w:r></w:p>'),
  );
  assert.equal(document.blocks.length, 1);
  assert.equal(document.blocks[0]?.runs[0]?.text, 'first\nsecond');
});

test('a heading is recognised by its style ID, not its visible name', async () => {
  // Matching the visible name works on English documents and fails on
  // documents produced by a localised application.
  const document = await readDocx(
    handBuilt(
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p>' +
        '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Sub</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Body</w:t></w:r></w:p>',
    ),
  );
  assert.deepEqual(
    document.blocks.map((block) => block.kind),
    ['heading1', 'heading2', 'body'],
  );
});

/**
 * A fixture with a numbering part, which every real file carrying a list has.
 *
 * The paragraph only names a numbering ID; whether that ID produces bullets or
 * numbers is defined here. A reader that guesses from the ID works on files it
 * wrote itself and is wrong on everything else.
 */
function handBuiltWithNumbering(bodyXml: string, numberingXml: string): Uint8Array {
  return writeZip([
    {
      name: 'word/document.xml',
      data: encoder.encode(
        '<?xml version="1.0"?>' +
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
          '<w:body>' +
          bodyXml +
          '</w:body></w:document>',
      ),
    },
    { name: 'word/numbering.xml', data: encoder.encode(numberingXml) },
  ]);
}

const NUMBERING_PART =
  '<?xml version="1.0"?>' +
  '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>' +
  '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>' +
  '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
  '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
  '</w:numbering>';

function listParagraph(numberId: string, text: string): string {
  return (
    '<w:p><w:pPr><w:pStyle w:val="ListParagraph"/>' +
    '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="' +
    numberId +
    '"/></w:numPr>' +
    '</w:pPr><w:r><w:t>' +
    text +
    '</w:t></w:r></w:p>'
  );
}

test('an ordered list is distinguished from an unordered one', async () => {
  const document = await readDocx(
    handBuiltWithNumbering(
      listParagraph('1', 'bulleted') + listParagraph('2', 'numbered'),
      NUMBERING_PART,
    ),
  );
  assert.deepEqual(
    document.blocks.map((block) => block.kind),
    ['bullet', 'numbered'],
  );
});

test('the list kind follows the numbering DEFINITION, not the id', async () => {
  // The same ids, with the definitions swapped. A reader that guesses from the
  // id returns the same answer as the test above and is wrong here.
  const swapped = NUMBERING_PART.replace(
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
      '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>',
    '<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>' +
      '<w:num w:numId="2"><w:abstractNumId w:val="0"/></w:num>',
  );
  const document = await readDocx(
    handBuiltWithNumbering(
      listParagraph('1', 'now numbered') + listParagraph('2', 'now bulleted'),
      swapped,
    ),
  );
  assert.deepEqual(
    document.blocks.map((block) => block.kind),
    ['numbered', 'bullet'],
  );
});

test('a list whose numbering definition is missing is treated as bullets', async () => {
  // The safer default: mislabelling a bullet as a number is the more visible
  // of the two errors, and a file with no numbering part is malformed anyway.
  const document = await readDocx(handBuilt(listParagraph('2', 'no definition')));
  assert.equal(document.blocks[0]?.kind, 'bullet');
});

test('a file that is not a docx is refused clearly', async () => {
  const notDocx = writeZip([{ name: 'random.txt', data: encoder.encode('hi') }]);
  await assert.rejects(() => readDocx(notDocx), /not a docx file/);
});

test('a document this module writes reads back with structure and formatting intact', async () => {
  const original = {
    blocks: [
      { kind: 'heading1' as const, runs: [{ text: 'Hong Kong tea houses' }] },
      {
        kind: 'body' as const,
        runs: [
          { text: 'A ' },
          { text: 'bold', bold: true },
          { text: ' and an ' },
          { text: 'italic', italic: true },
          { text: ' word.' },
        ],
      },
      { kind: 'bullet' as const, runs: [{ text: 'Har gow' }] },
      { kind: 'numbered' as const, runs: [{ text: 'Siu mai' }] },
      { kind: 'quote' as const, runs: [{ text: 'A quotation.' }] },
    ],
  };

  const read = await readDocx(writeDocx(original));
  assert.deepEqual(
    read.blocks.map((block) => block.kind),
    ['heading1', 'body', 'bullet', 'numbered', 'quote'],
  );
  assert.deepEqual(read.blocks[1]?.runs, original.blocks[1]?.runs);
});

test('leading and trailing spaces survive, because words must not run together', async () => {
  // Without xml:space="preserve" the reading application strips them and
  // "Hello " + "world" silently becomes "Helloworld".
  const read = await readDocx(
    writeDocx({
      blocks: [{ kind: 'body', runs: [{ text: 'Hello ' }, { text: 'world' }] }],
    }),
  );
  assert.equal(read.blocks[0]?.runs.map((run) => run.text).join(''), 'Hello world');
});

test('a line break survives a round trip as a break, not as a space', async () => {
  // A raw newline left in the text is legal XML and renders as a space, so
  // the break silently disappears from the document.
  const read = await readDocx(
    writeDocx({ blocks: [{ kind: 'body', runs: [{ text: 'first\nsecond' }] }] }),
  );
  assert.equal(read.blocks[0]?.runs[0]?.text, 'first\nsecond');
});

test('Cantonese text survives a round trip', async () => {
  const read = await readDocx(
    writeDocx({ blocks: [{ kind: 'body', runs: [{ text: '香港茶樓，飲茶食點心。' }] }] }),
  );
  assert.equal(read.blocks[0]?.runs[0]?.text, '香港茶樓，飲茶食點心。');
});

test('text containing XML metacharacters survives', async () => {
  const hostile = '1 < 2 & 3 > 0 ' + String.fromCharCode(34) + 'quoted' + String.fromCharCode(34);
  const read = await readDocx(
    writeDocx({ blocks: [{ kind: 'body', runs: [{ text: hostile }] }] }),
  );
  assert.equal(read.blocks[0]?.runs[0]?.text, hostile);
});
