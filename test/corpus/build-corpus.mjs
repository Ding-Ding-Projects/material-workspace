/**
 * Build the conformance corpus.
 *
 * Every fixture is a REAL file on disk - a real zip container with the real
 * parts inside it - written in the XML shape the real producer emits. The tests
 * read those committed binaries; they never rebuild them and then read what
 * they just wrote, because a round trip through one module's own output proves
 * only that the module agrees with itself.
 *
 * WHY GENERATED RATHER THAN COLLECTED. A file saved by Word or LibreOffice
 * carries that application's licence, its metadata, and often a person's name.
 * Committing one to a public repository is a licensing question and a privacy
 * question at once. Generating the same SHAPES, with the provenance of each
 * shape recorded beside it, gives a corpus that can be committed, reviewed in a
 * diff, and corrected when a shape turns out to be wrong.
 *
 * WHAT THAT COSTS, SAID PLAINLY. A generated fixture cannot surprise us the way
 * a real file does. It contains what somebody thought a producer emits, and
 * where that belief is wrong the corpus is wrong in the same direction as the
 * reader. That is a real limitation and it is why every entry records where its
 * shape came from - so a wrong belief is correctable rather than invisible.
 *
 *   node test/corpus/build-corpus.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'files');

const encoder = new TextEncoder();

/* ------------------------------------------------------------------ zip -- */

/**
 * A minimal zip writer.
 *
 * Deflate rather than store, because a reader that only handles stored entries
 * passes every test against a corpus that only contains stored entries and then
 * fails on the first real file - every real producer deflates.
 */
function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  const u16 = (value) => Uint8Array.of(value & 0xff, (value >> 8) & 0xff);
  const u32 = (value) =>
    Uint8Array.of(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff);

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[index] = value >>> 0;
    }
    return table;
  })();

  const crc32 = (bytes) => {
    let value = 0xffffffff;
    for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
  };

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const raw = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
    const deflated = new Uint8Array(zlib.deflateRawSync(Buffer.from(raw)));
    const crc = crc32(raw);

    const local = [
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(8),
      u16(0),
      u16(0),
      u32(crc),
      u32(deflated.length),
      u32(raw.length),
      u16(name.length),
      u16(0),
      name,
      deflated,
    ];
    for (const part of local) chunks.push(part);

    central.push([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(8),
      u16(0),
      u16(0),
      u32(crc),
      u32(deflated.length),
      u32(raw.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ]);

    let localSize = 0;
    for (const part of local) localSize += part.length;
    offset += localSize;
  }

  const centralStart = offset;
  for (const record of central) {
    for (const part of record) {
      chunks.push(part);
      offset += part.length;
    }
  }

  chunks.push(
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(central.length),
    u16(central.length),
    u32(offset - centralStart),
    u32(centralStart),
    u16(0),
  );

  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/* -------------------------------------------------------------- wrappers -- */

const CONTENT_TYPES_DOCX =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>';

const RELS_DOCX =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';

function docx(bodyXml, extra = []) {
  return zip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES_DOCX },
    { name: '_rels/.rels', data: RELS_DOCX },
    {
      name: 'word/document.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<w:body>' + bodyXml + '</w:body></w:document>',
    },
    ...extra,
  ]);
}

function xlsx(sheetXml, { sharedStrings = null, sheetName = 'Sheet1' } = {}) {
  const parts = [
    {
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        (sharedStrings === null
          ? ''
          : '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>') +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="' + sheetName + '" sheetId="1" r:id="rId1"/></sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        (sharedStrings === null
          ? ''
          : '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>') +
        '</Relationships>',
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<sheetData>' + sheetXml + '</sheetData></worksheet>',
    },
  ];

  if (sharedStrings !== null) {
    parts.push({
      name: 'xl/sharedStrings.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' +
        sharedStrings.length + '" uniqueCount="' + sharedStrings.length + '">' +
        sharedStrings.map((value) => '<si><t>' + value + '</t></si>').join('') +
        '</sst>',
    });
  }
  return zip(parts);
}

function odf(mimetype, bodyXml) {
  return zip([
    // The mimetype entry comes first in a real ODF package. Kept here for the
    // same reason: a reader that depends on the order should be tested against
    // a file that has it.
    { name: 'mimetype', data: mimetype },
    {
      name: 'META-INF/manifest.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">' +
        '<manifest:file-entry manifest:full-path="/" manifest:media-type="' + mimetype + '"/>' +
        '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>' +
        '</manifest:manifest>',
    },
    { name: 'content.xml', data: bodyXml },
  ]);
}

const ODF_NAMESPACES =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
  'xmlns:office-value="urn:oasis:names:tc:opendocument:xmlns:office:1.0"';

/* ------------------------------------------------------------ the corpus -- */

/**
 * Every fixture, with what it covers and where its shape came from.
 *
 * `expects` is what MUST survive. `loses` is what is knowingly not carried, and
 * every entry there is a promise the tests check too: a "loss" that turns out to
 * survive is a note that has gone stale, and a note that has gone stale is how
 * somebody comes to distrust all of them.
 */
export const CORPUS = [
  // ------------------------------------------------------------- docx --
  {
    file: 'docx/paragraphs.docx',
    format: 'docx',
    feature: 'paragraphs, runs, and a line break inside a paragraph',
    shape:
      'Word emits one <w:p> per paragraph and <w:br/> for a soft break inside ' +
      'one. Treating each <w:p> as a line loses the distinction entirely.',
    build: () =>
      docx(
        '<w:p><w:r><w:t>First paragraph.</w:t></w:r></w:p>' +
          '<w:p><w:r><w:t>Second</w:t><w:br/><w:t>after a break</w:t></w:r></w:p>',
      ),
    expects: { paragraphs: 2, text: ['First paragraph.', 'Second\nafter a break'] },
  },
  {
    file: 'docx/formatting.docx',
    format: 'docx',
    feature: 'bold, italic and underline, including an explicit OFF',
    shape:
      '<w:b/> is on, <w:b w:val="0"/> is explicitly off, and absent inherits. ' +
      'A reader that treats presence as on marks the second run bold.',
    build: () =>
      docx(
        '<w:p>' +
          '<w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r>' +
          '<w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>not bold</w:t></w:r>' +
          '<w:r><w:rPr><w:i/><w:u w:val="single"/></w:rPr><w:t>italic underlined</w:t></w:r>' +
          '</w:p>',
      ),
    expects: {
      runs: [
        { text: 'bold', bold: true },
        { text: 'not bold', bold: false },
        { text: 'italic underlined', italic: true, underline: true },
      ],
    },
  },
  {
    file: 'docx/styles.docx',
    format: 'docx',
    feature: 'a paragraph style reference',
    shape:
      '<w:pStyle w:val="Heading1"/> names a style ID, not a display name. The ' +
      'display name lives in styles.xml and is localised.',
    build: () =>
      docx(
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>A heading</w:t></w:r></w:p>' +
          '<w:p><w:r><w:t>Body text.</w:t></w:r></w:p>',
      ),
    expects: { styleOfFirst: 'Heading1', styleOfSecond: null },
  },
  {
    file: 'docx/lists.docx',
    format: 'docx',
    feature: 'a numbered list whose numbering part says it is ordered',
    shape:
      '<w:numPr> carries <w:ilvl> and <w:numId>, and the list TYPE lives in ' +
      'numbering.xml - numId points at an abstract definition whose numFmt is ' +
      'decimal for an ordered list and bullet for an unordered one. Note there ' +
      'is NO pStyle here: Word usually writes ListParagraph beside numPr, but ' +
      'it is not required to and Google Docs export and pandoc do not.',
    build: () =>
      docx(
        '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr>' +
          '<w:r><w:t>One</w:t></w:r></w:p>' +
          '<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="2"/></w:numPr></w:pPr>' +
          '<w:r><w:t>Nested</w:t></w:r></w:p>',
        [
          {
            name: 'word/numbering.xml',
            data:
              '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
              '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
              '<w:abstractNum w:abstractNumId="7">' +
              '<w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl>' +
              '</w:abstractNum>' +
              '<w:num w:numId="2"><w:abstractNumId w:val="7"/></w:num>' +
              '</w:numbering>',
          },
        ],
      ),
    expects: { kinds: ['numbered', 'numbered'] },
  },
  {
    file: 'docx/lists-unknown-numbering.docx',
    format: 'docx',
    feature: 'a list whose numbering part is absent, which cannot be known ordered',
    shape:
      'A document that references a numId with no numbering.xml to resolve it ' +
      'is common in fragments and in files written by tools that strip parts ' +
      'they do not understand. Bullet is the safe default: guessing ordered ' +
      'invents numbers the author never wrote.',
    build: () =>
      docx(
        '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="9"/></w:numPr></w:pPr>' +
          '<w:r><w:t>Unresolvable</w:t></w:r></w:p>',
      ),
    expects: { kinds: ['bullet'] },
  },
  {
    file: 'docx/tabs-and-entities.docx',
    format: 'docx',
    feature: 'tabs, and XML entities that must survive decoding',
    shape:
      'A tab is <w:tab/>, not a character. Ampersands and angle brackets arrive ' +
      'escaped and a reader that forgets to decode shows them raw.',
    build: () =>
      docx(
        '<w:p><w:r><w:t>Before</w:t><w:tab/><w:t>After</w:t></w:r></w:p>' +
          '<w:p><w:r><w:t>Tom &amp; Jerry &lt;here&gt;</w:t></w:r></w:p>',
      ),
    expects: { text: ['Before\tAfter', 'Tom & Jerry <here>'] },
  },
  {
    file: 'docx/preserved-space.docx',
    format: 'docx',
    feature: 'xml:space="preserve", which carries meaningful whitespace',
    shape:
      'Word marks a run whose leading or trailing space matters. A reader that ' +
      'trims every run silently joins words together.',
    build: () =>
      docx(
        '<w:p>' +
          '<w:r><w:t xml:space="preserve">one </w:t></w:r>' +
          '<w:r><w:t xml:space="preserve">two</w:t></w:r>' +
          '</w:p>',
      ),
    expects: { text: ['one two'] },
  },

  // ------------------------------------------------------------- xlsx --
  {
    file: 'xlsx/shared-strings.xlsx',
    format: 'xlsx',
    feature: 'shared strings, where the cell holds an INDEX',
    shape:
      'A cell marked t="s" holds an index into sharedStrings.xml. A reader that ' +
      'takes the value literally shows 0 and 1, which look plausible and are wrong.',
    build: () =>
      xlsx(
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>',
        { sharedStrings: ['Alpha', 'Beta'] },
      ),
    expects: { cells: { A1: 'Alpha', B1: 'Beta' } },
  },
  {
    file: 'xlsx/numbers-and-booleans.xlsx',
    format: 'xlsx',
    feature: 'numbers, and booleans that are 0 or 1',
    shape:
      'A number has no t attribute. A boolean is t="b" with 0 or 1, and a reader ' +
      'that treats it as a number shows 1 where the sheet says TRUE.',
    build: () =>
      xlsx(
        '<row r="1"><c r="A1"><v>42</v></c><c r="B1"><v>-3.5</v></c>' +
          '<c r="C1" t="b"><v>1</v></c><c r="D1" t="b"><v>0</v></c></row>',
      ),
    expects: { cells: { A1: 42, B1: -3.5, C1: true, D1: false } },
  },
  {
    file: 'xlsx/formulas.xlsx',
    format: 'xlsx',
    feature: 'a formula cell, which carries both the formula and its last value',
    shape:
      '<f> holds the formula and <v> the value the producing application last ' +
      'computed. Keeping only the value loses the sheet; keeping only the ' +
      'formula means an unopened file shows nothing.',
    build: () =>
      xlsx(
        '<row r="1"><c r="A1"><v>2</v></c><c r="B1"><v>3</v></c>' +
          '<c r="C1"><f>A1+B1</f><v>5</v></c></row>',
      ),
    expects: { formula: '=A1+B1', value: 5 },
  },
  {
    file: 'xlsx/inline-strings.xlsx',
    format: 'xlsx',
    feature: 'an inline string, which some producers emit instead of a shared one',
    shape:
      't="inlineStr" with <is><t>. Exporters that stream rows commonly emit ' +
      'these because they cannot build a shared table in one pass.',
    build: () =>
      xlsx('<row r="1"><c r="A1" t="inlineStr"><is><t>Inline</t></is></c></row>'),
    expects: { cells: { A1: 'Inline' } },
  },
  {
    file: 'xlsx/sparse-rows.xlsx',
    format: 'xlsx',
    feature: 'gaps: a sheet does not emit empty cells or empty rows',
    shape:
      'Real sheets skip empty cells entirely and jump row numbers. A reader ' +
      'that assumes cells arrive contiguously puts values in the wrong places.',
    build: () =>
      xlsx(
        '<row r="1"><c r="A1"><v>1</v></c><c r="D1"><v>4</v></c></row>' +
          '<row r="5"><c r="B5"><v>25</v></c></row>',
      ),
    expects: { cells: { A1: 1, D1: 4, B5: 25 }, empty: ['B1', 'A5'] },
  },

  // -------------------------------------------------------------- odf --
  {
    file: 'odt/paragraphs.odt',
    format: 'odt',
    feature: 'paragraphs and headings in an ODF text document',
    shape:
      'A heading is <text:h> with an outline level, NOT a styled paragraph. A ' +
      'reader that only handles <text:p> drops every heading in the document.',
    build: () =>
      odf(
        'application/vnd.oasis.opendocument.text',
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<office:document-content ' + ODF_NAMESPACES + '>' +
          '<office:body><office:text>' +
          '<text:h text:outline-level="1">A heading</text:h>' +
          '<text:p>Body text.</text:p>' +
          '</office:text></office:body></office:document-content>',
      ),
    expects: { paragraphs: 2, headingLevel: 1 },
  },
  {
    file: 'odt/spaces.odt',
    format: 'odt',
    feature: 'repeated spaces, which ODF encodes as an element',
    shape:
      'ODF collapses whitespace in XML and encodes runs of spaces as ' +
      '<text:s text:c="n"/>. A reader that ignores it silently squashes them.',
    build: () =>
      odf(
        'application/vnd.oasis.opendocument.text',
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<office:document-content ' + ODF_NAMESPACES + '>' +
          '<office:body><office:text>' +
          '<text:p>one<text:s text:c="3"/>two</text:p>' +
          '</office:text></office:body></office:document-content>',
      ),
    expects: { text: ['one   two'] },
  },
  {
    file: 'ods/values.ods',
    format: 'ods',
    feature: 'typed cell values in an ODF spreadsheet',
    shape:
      'A value lives in office:value-type plus its typed attribute, and the ' +
      'visible <text:p> is only a rendering. Reading the text gives a string ' +
      'where the sheet holds a number.',
    build: () =>
      odf(
        'application/vnd.oasis.opendocument.spreadsheet',
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<office:document-content ' + ODF_NAMESPACES + '>' +
          '<office:body><office:spreadsheet>' +
          '<table:table table:name="Sheet1">' +
          '<table:table-row>' +
          '<table:table-cell office:value-type="float" office:value="42"><text:p>42</text:p></table:table-cell>' +
          '<table:table-cell office:value-type="string"><text:p>Alpha</text:p></table:table-cell>' +
          '<table:table-cell office:value-type="boolean" office:boolean-value="true"><text:p>TRUE</text:p></table:table-cell>' +
          '</table:table-row>' +
          '</table:table>' +
          '</office:spreadsheet></office:body></office:document-content>',
      ),
    expects: { cells: { A1: 42, B1: 'Alpha', C1: true } },
  },
  {
    file: 'ods/repeated-cells.ods',
    format: 'ods',
    feature: 'table:number-columns-repeated, which ODF uses instead of repeating',
    shape:
      'A row of identical cells is emitted once with a repeat count, and a ' +
      'trailing empty repeat of 1000 columns is normal. A reader that expands ' +
      'blindly allocates a million cells for an empty sheet.',
    build: () =>
      odf(
        'application/vnd.oasis.opendocument.spreadsheet',
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<office:document-content ' + ODF_NAMESPACES + '>' +
          '<office:body><office:spreadsheet>' +
          '<table:table table:name="Sheet1">' +
          '<table:table-row>' +
          '<table:table-cell office:value-type="float" office:value="7" table:number-columns-repeated="3">' +
          '<text:p>7</text:p></table:table-cell>' +
          '<table:table-cell table:number-columns-repeated="1000"/>' +
          '</table:table-row>' +
          '</table:table>' +
          '</office:spreadsheet></office:body></office:document-content>',
      ),
    expects: { cells: { A1: 7, B1: 7, C1: 7 }, empty: ['D1'] },
  },
];

/* ------------------------------------------------------------------ main -- */

if (process.argv[1] && process.argv[1].endsWith('build-corpus.mjs')) {
  fs.rmSync(OUT, { recursive: true, force: true });

  for (const entry of CORPUS) {
    const target = path.join(OUT, entry.file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.build());
    process.stdout.write(
      '[corpus] ' + entry.file.padEnd(32) + fs.statSync(target).size + ' bytes\n',
    );
  }

  process.stdout.write('[corpus] ' + CORPUS.length + ' fixtures written to ' + OUT + '\n');
}
